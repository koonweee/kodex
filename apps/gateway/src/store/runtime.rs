use chrono::Utc;
use sqlx::Row;

use crate::error::{ApiError, ApiResult};

use super::{row_to_queued_input, QueuedInput, Store, ThreadRuntimeState, ThreadRuntimeStatus};

impl Store {
    pub async fn upsert_thread_runtime_state(&self, state: ThreadRuntimeState) -> ApiResult<()> {
        sqlx::query(
            r#"
            insert into thread_runtime_state (
                thread_id, status, active_turn_id, updated_at, last_event_seq
            )
            values (?, ?, ?, ?, ?)
            on conflict(thread_id) do update set
                status = excluded.status,
                active_turn_id = excluded.active_turn_id,
                updated_at = excluded.updated_at,
                last_event_seq = excluded.last_event_seq
            "#,
        )
        .bind(state.thread_id)
        .bind(state.status.as_str())
        .bind(state.active_turn_id)
        .bind(state.updated_at)
        .bind(state.last_event_seq)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn upsert_thread_runtime_state_unless_draining(
        &self,
        state: ThreadRuntimeState,
    ) -> ApiResult<ThreadRuntimeState> {
        let thread_id = state.thread_id.clone();
        sqlx::query(
            r#"
            insert into thread_runtime_state (
                thread_id, status, active_turn_id, updated_at, last_event_seq
            )
            values (?, ?, ?, ?, ?)
            on conflict(thread_id) do update set
                status = excluded.status,
                active_turn_id = excluded.active_turn_id,
                updated_at = excluded.updated_at,
                last_event_seq = excluded.last_event_seq
            where thread_runtime_state.status != 'draining'
            "#,
        )
        .bind(state.thread_id)
        .bind(state.status.as_str())
        .bind(state.active_turn_id)
        .bind(state.updated_at)
        .bind(state.last_event_seq)
        .execute(&self.pool)
        .await?;
        self.get_thread_runtime_state(&thread_id)
            .await?
            .ok_or_else(|| ApiError::NotFound(format!("thread runtime state {thread_id}")))
    }

    pub async fn set_thread_runtime_pending(
        &self,
        thread_id: &str,
        status: ThreadRuntimeStatus,
    ) -> ApiResult<()> {
        self.upsert_thread_runtime_state(ThreadRuntimeState {
            thread_id: thread_id.to_string(),
            status,
            active_turn_id: None,
            updated_at: Utc::now(),
            last_event_seq: None,
        })
        .await
    }

    pub async fn insert_idle_thread_runtime_if_absent(&self, thread_id: &str) -> ApiResult<()> {
        let now = Utc::now();
        sqlx::query(
            r#"
            insert into thread_runtime_state (
                thread_id, status, active_turn_id, updated_at, last_event_seq
            )
            values (?, 'idle', null, ?, null)
            on conflict(thread_id) do nothing
            "#,
        )
        .bind(thread_id)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn claim_idle_thread_runtime_for_queue_drain(
        &self,
        thread_id: &str,
    ) -> ApiResult<bool> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update thread_runtime_state
            set status = 'draining',
                active_turn_id = null,
                updated_at = ?
            where thread_id = ?
              and status not in ('draining', 'starting', 'syncing')
              and not (
                status in ('active', 'streaming', 'syncing')
                and active_turn_id is not null
              )
            "#,
        )
        .bind(now)
        .bind(thread_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn clear_queue_drain_runtime_claim(&self, thread_id: &str) -> ApiResult<()> {
        let now = Utc::now();
        sqlx::query(
            r#"
            update thread_runtime_state
            set status = 'idle',
                active_turn_id = null,
                updated_at = ?
            where thread_id = ? and status = 'draining'
            "#,
        )
        .bind(now)
        .bind(thread_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_thread_runtime_state(
        &self,
        thread_id: &str,
    ) -> ApiResult<Option<ThreadRuntimeState>> {
        let row = sqlx::query(
            "select thread_id, status, active_turn_id, updated_at, last_event_seq from thread_runtime_state where thread_id = ?",
        )
        .bind(thread_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_thread_runtime_state).transpose()
    }

    pub async fn recover_queued_inputs_after_restart(&self) -> ApiResult<Vec<QueuedInput>> {
        let now = Utc::now();
        let rows = sqlx::query(
            r#"
            select id, thread_id, input_json, options_json, source_type, source_id, status, priority,
                   attempt_count, last_error, accepted_turn_id, accepted_at,
                   accepted_event_seq, created_at, updated_at
            from queued_turn_inputs
            where deleted_at is null and status in ('submitting', 'steering', 'pendingCommit')
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        let recovering = rows
            .into_iter()
            .map(row_to_queued_input)
            .collect::<ApiResult<Vec<_>>>()?;
        self.delete_pending_timeline_skill_mentions_for_queued_rows(&recovering)
            .await?;
        sqlx::query(
            r#"
            update queued_turn_inputs
            set status = 'failed',
                last_error = 'Gateway restarted before this queued input could be confirmed. Retry manually to avoid duplicate sends.',
                accepted_turn_id = null,
                accepted_at = null,
                accepted_event_seq = null,
                pending_skill_mentions_id = null,
                updated_at = ?
            where deleted_at is null and status in ('submitting', 'steering', 'pendingCommit')
            "#,
        )
        .bind(now)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "update thread_runtime_state set status = 'unknown', active_turn_id = null, updated_at = ?",
        )
        .bind(now)
        .execute(&self.pool)
        .await?;
        let mut recovered = Vec::with_capacity(recovering.len());
        for row in recovering {
            recovered.push(self.get_queued_input(&row.thread_id, &row.id).await?);
        }
        Ok(recovered)
    }
}

fn row_to_thread_runtime_state(row: sqlx::sqlite::SqliteRow) -> ApiResult<ThreadRuntimeState> {
    let status: String = row.try_get("status")?;
    Ok(ThreadRuntimeState {
        thread_id: row.try_get("thread_id")?,
        status: ThreadRuntimeStatus::from_persisted(&status),
        active_turn_id: row.try_get("active_turn_id")?,
        updated_at: row.try_get("updated_at")?,
        last_event_seq: row.try_get("last_event_seq")?,
    })
}

#[cfg(test)]
mod tests {
    use crate::store::ThreadRuntimeStatus;

    #[test]
    fn thread_runtime_status_parses_known_and_unknown_persisted_values() {
        assert_eq!(
            ThreadRuntimeStatus::from_persisted("starting"),
            ThreadRuntimeStatus::Starting
        );
        assert_eq!(
            ThreadRuntimeStatus::from_persisted("draining"),
            ThreadRuntimeStatus::Draining
        );
        assert_eq!(
            ThreadRuntimeStatus::from_persisted("syncing"),
            ThreadRuntimeStatus::Syncing
        );
        assert_eq!(
            ThreadRuntimeStatus::from_persisted("active"),
            ThreadRuntimeStatus::Active
        );
        assert_eq!(
            ThreadRuntimeStatus::from_persisted("streaming"),
            ThreadRuntimeStatus::Streaming
        );
        assert_eq!(
            ThreadRuntimeStatus::from_persisted("idle"),
            ThreadRuntimeStatus::Idle
        );
        assert_eq!(
            ThreadRuntimeStatus::from_persisted("unknown"),
            ThreadRuntimeStatus::Unknown
        );
        assert_eq!(
            ThreadRuntimeStatus::from_persisted("future-status"),
            ThreadRuntimeStatus::Unknown
        );
    }
}
