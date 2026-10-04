use std::collections::{HashMap, HashSet};

use chrono::Utc;
use sqlx::{QueryBuilder, Row, Sqlite, SqliteConnection};

use crate::error::{ApiError, ApiResult};

use super::{row_to_thread_read, Store, ThreadRead, ThreadReadState};

impl Store {
    pub async fn get_thread_read(&self, thread_id: &str) -> ApiResult<ThreadRead> {
        let mut connection = self.pool.acquire().await?;
        read_thread(&mut connection, thread_id).await
    }

    pub async fn thread_read_states(
        &self,
        thread_ids: &[String],
    ) -> ApiResult<HashMap<String, ThreadReadState>> {
        if thread_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let mut query =
            QueryBuilder::<Sqlite>::new("select * from thread_reads where thread_id in (");
        {
            let mut ids = query.separated(", ");
            for id in thread_ids {
                ids.push_bind(id);
            }
        }
        query.push(")");
        query
            .build()
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(|row| {
                let state = row_to_thread_read(row)?;
                Ok((state.thread_id.clone(), state))
            })
            .collect()
    }

    pub async fn reconcile_thread_completion_head(
        &self,
        thread_id: &str,
        expected_revision: i64,
        head: Option<&str>,
    ) -> ApiResult<ThreadRead> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut state = read_thread(&mut tx, thread_id).await?;
        if state.read_revision == expected_revision
            && (!state.read_state_known || state.latest_completed_turn_id.as_deref() != head)
        {
            state.latest_completed_turn_id = head.map(str::to_owned);
            state.read_state_known = true;
            state = write_thread(&mut tx, state).await?;
        }
        tx.commit().await?;
        Ok(state)
    }

    #[cfg(test)]
    pub async fn record_thread_completion(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> ApiResult<ThreadRead> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut state = read_thread(&mut tx, thread_id).await?;
        if !state.read_state_known || state.latest_completed_turn_id.as_deref() != Some(turn_id) {
            state.latest_completed_turn_id = Some(turn_id.to_owned());
            state.read_state_known = true;
            state = write_thread(&mut tx, state).await?;
        }
        tx.commit().await?;
        Ok(state)
    }

    pub async fn invalidate_thread_completion_head(
        &self,
        thread_id: &str,
    ) -> ApiResult<ThreadRead> {
        self.invalidate_completion_head(thread_id, None).await
    }

    pub async fn invalidate_thread_completion_head_if_revision(
        &self,
        thread_id: &str,
        expected_revision: i64,
    ) -> ApiResult<ThreadRead> {
        self.invalidate_completion_head(thread_id, Some(expected_revision))
            .await
    }

    async fn invalidate_completion_head(
        &self,
        thread_id: &str,
        expected_revision: Option<i64>,
    ) -> ApiResult<ThreadRead> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut state = read_thread(&mut tx, thread_id).await?;
        let should_invalidate = match expected_revision {
            Some(revision) => revision == state.read_revision && state.read_state_known,
            None => true,
        };
        if should_invalidate {
            state.latest_completed_turn_id = None;
            state.read_state_known = false;
            // Native event invalidation always fences older reads; repeated
            // ordinary reads of an unknown head must not generate new state.
            state = write_thread(&mut tx, state).await?;
        }
        tx.commit().await?;
        Ok(state)
    }

    pub async fn mark_thread_seen(
        &self,
        thread_id: &str,
        completed_turn_id: &str,
        expected_revision: i64,
    ) -> ApiResult<ThreadRead> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut state = read_thread(&mut tx, thread_id).await?;
        if !state.read_state_known
            || state.read_revision != expected_revision
            || state.latest_completed_turn_id.as_deref() != Some(completed_turn_id)
        {
            return Err(ApiError::Conflict(
                "Chat completion changed; refresh before marking it seen".into(),
            ));
        }
        if state.seen_completed_turn_id.as_deref() != Some(completed_turn_id) {
            state.seen_completed_turn_id = Some(completed_turn_id.to_owned());
            state = write_thread(&mut tx, state).await?;
        }
        tx.commit().await?;
        Ok(state)
    }

    /// Count only the supplied native inventory in one SQL snapshot. Unknown
    /// heads cannot silently turn into a zero badge after an intervening reset.
    pub async fn unread_badge_snapshot(
        &self,
        thread_ids: &[String],
        expected_membership_revision: i64,
    ) -> ApiResult<(i64, i64)> {
        let unique: HashSet<&String> = thread_ids.iter().collect();
        let mut query = QueryBuilder::<Sqlite>::new(
            "select r.revision, r.membership_revision, count(t.thread_id) as known_count, coalesce(sum(case when t.latest_completed_turn_id is not null and t.latest_completed_turn_id is not t.seen_completed_turn_id then 1 else 0 end), 0) as unread_count from thread_read_revision r left join thread_reads t on t.read_state_known = 1 and t.thread_id in (",
        );
        {
            let mut ids = query.separated(", ");
            for id in &unique {
                ids.push_bind(*id);
            }
            // A known empty inventory is still fenced against native catalog
            // changes and returns the same global revision as any other read.
            if unique.is_empty() {
                ids.push("null");
            }
        }
        query.push(") where r.id = 1 group by r.revision, r.membership_revision");
        let row = query.build().fetch_one(&self.pool).await?;
        let membership_revision: i64 = row.try_get("membership_revision")?;
        if membership_revision != expected_membership_revision {
            return Err(ApiError::Conflict(
                "Chat inventory changed; refresh unread state".into(),
            ));
        }
        let known: i64 = row.try_get("known_count")?;
        if known != unique.len() as i64 {
            return Err(ApiError::Conflict(
                "Chat completion state is unknown; refresh the unread inventory".into(),
            ));
        }
        Ok((row.try_get("unread_count")?, row.try_get("revision")?))
    }

    pub async fn thread_read_membership_revision(&self) -> ApiResult<i64> {
        Ok(
            sqlx::query_scalar("select membership_revision from thread_read_revision where id = 1")
                .fetch_one(&self.pool)
                .await?,
        )
    }

    pub async fn bump_thread_read_membership_revision(&self) -> ApiResult<i64> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let revision = sqlx::query_scalar("update thread_read_revision set revision = revision + 1, membership_revision = membership_revision + 1 where id = 1 returning revision")
            .fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok(revision)
    }
}

async fn read_thread(connection: &mut SqliteConnection, thread_id: &str) -> ApiResult<ThreadRead> {
    let row = sqlx::query("select * from thread_reads where thread_id = ?")
        .bind(thread_id)
        .fetch_optional(connection)
        .await?;
    match row {
        Some(row) => row_to_thread_read(row),
        None => Ok(ThreadRead {
            thread_id: thread_id.to_owned(),
            ..ThreadRead::default()
        }),
    }
}

async fn next_revision(connection: &mut SqliteConnection) -> ApiResult<i64> {
    Ok(sqlx::query_scalar(
        "update thread_read_revision set revision = revision + 1 where id = 1 returning revision",
    )
    .fetch_one(connection)
    .await?)
}

async fn write_thread(
    connection: &mut SqliteConnection,
    mut state: ThreadRead,
) -> ApiResult<ThreadRead> {
    state.read_revision = next_revision(connection).await?;
    state.updated_at = Utc::now();
    state.unread_completed_agent_turn = state.read_state_known
        && state.latest_completed_turn_id.is_some()
        && state.latest_completed_turn_id != state.seen_completed_turn_id;
    sqlx::query(
        "insert into thread_reads (thread_id, latest_completed_turn_id, seen_completed_turn_id, read_revision, read_state_known, updated_at) values (?, ?, ?, ?, ?, ?) on conflict(thread_id) do update set latest_completed_turn_id = excluded.latest_completed_turn_id, seen_completed_turn_id = excluded.seen_completed_turn_id, read_revision = excluded.read_revision, read_state_known = excluded.read_state_known, updated_at = excluded.updated_at",
    )
        .bind(&state.thread_id).bind(&state.latest_completed_turn_id).bind(&state.seen_completed_turn_id)
        .bind(state.read_revision).bind(state.read_state_known).bind(state.updated_at)
        .execute(connection).await?;
    Ok(state)
}

#[cfg(test)]
mod tests;
