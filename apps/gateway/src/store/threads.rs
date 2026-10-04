use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx::{QueryBuilder, Row, Sqlite};

use crate::error::{ApiError, ApiResult};

use super::{row_to_thread_pin, row_to_thread_read, Store, ThreadPin, ThreadRead, ThreadReadState};

impl Store {
    pub async fn thread_read_states(
        &self,
        thread_ids: &[String],
    ) -> ApiResult<HashMap<String, ThreadReadState>> {
        if thread_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let mut states = HashMap::new();

        let mut read_builder = QueryBuilder::<Sqlite>::new(
            "select thread_id, seen_completed_agent_turn_seq from thread_reads where thread_id in (",
        );
        {
            let mut separated = read_builder.separated(", ");
            for thread_id in thread_ids {
                separated.push_bind(thread_id);
            }
        }
        read_builder.push(")");

        for row in read_builder.build().fetch_all(&self.pool).await? {
            let thread_id: String = row.try_get("thread_id")?;
            states
                .entry(thread_id)
                .or_insert_with(ThreadReadState::default)
                .seen_completed_agent_turn_seq = row.try_get("seen_completed_agent_turn_seq")?;
        }

        Ok(states)
    }

    pub async fn pin_thread(&self, thread_id: &str) -> ApiResult<ThreadPin> {
        let now = Utc::now();
        sqlx::query(
            r#"
            insert into thread_pins (thread_id, pinned_at, updated_at)
            values (?, ?, ?)
            on conflict(thread_id) do update set
                pinned_at = thread_pins.pinned_at,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(thread_id)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;

        self.get_thread_pin(thread_id).await
    }

    pub async fn unpin_thread(&self, thread_id: &str) -> ApiResult<()> {
        sqlx::query("delete from thread_pins where thread_id = ?")
            .bind(thread_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn get_thread_pin(&self, thread_id: &str) -> ApiResult<ThreadPin> {
        let row = sqlx::query(
            "select thread_id, pinned_at, updated_at from thread_pins where thread_id = ?",
        )
        .bind(thread_id)
        .fetch_optional(&self.pool)
        .await?;

        row.map(row_to_thread_pin)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("thread pin {thread_id}")))
    }

    pub async fn list_thread_pins(&self) -> ApiResult<Vec<ThreadPin>> {
        let rows = sqlx::query(
            "select thread_id, pinned_at, updated_at from thread_pins order by pinned_at desc, thread_id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_thread_pin).collect()
    }

    pub async fn pinned_at_for_thread_ids(
        &self,
        thread_ids: &[String],
    ) -> ApiResult<HashMap<String, DateTime<Utc>>> {
        if thread_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let mut builder = QueryBuilder::<Sqlite>::new(
            "select thread_id, pinned_at from thread_pins where thread_id in (",
        );
        {
            let mut separated = builder.separated(", ");
            for thread_id in thread_ids {
                separated.push_bind(thread_id);
            }
        }
        builder.push(")");

        let mut pins = HashMap::new();
        for row in builder.build().fetch_all(&self.pool).await? {
            let thread_id: String = row.try_get("thread_id")?;
            let pinned_at: DateTime<Utc> = row.try_get("pinned_at")?;
            pins.insert(thread_id, pinned_at);
        }

        Ok(pins)
    }

    pub async fn mark_thread_seen_completed_agent_turns(
        &self,
        thread_id: &str,
        seen_completed_agent_turn_seq: i64,
    ) -> ApiResult<ThreadRead> {
        let updated_at = Utc::now();
        sqlx::query(
            r#"
            insert into thread_reads (thread_id, seen_completed_agent_turn_seq, updated_at)
            values (?, ?, ?)
            on conflict(thread_id) do update set
                seen_completed_agent_turn_seq = max(
                    thread_reads.seen_completed_agent_turn_seq,
                    excluded.seen_completed_agent_turn_seq
                ),
                updated_at = excluded.updated_at
            "#,
        )
        .bind(thread_id)
        .bind(seen_completed_agent_turn_seq.max(0))
        .bind(updated_at)
        .execute(&self.pool)
        .await?;

        self.get_thread_read(thread_id).await
    }

    pub async fn get_thread_read(&self, thread_id: &str) -> ApiResult<ThreadRead> {
        let row = sqlx::query(
            "select thread_id, seen_completed_agent_turn_seq, updated_at from thread_reads where thread_id = ?",
        )
        .bind(thread_id)
        .fetch_optional(&self.pool)
        .await?;

        row.map(row_to_thread_read)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("thread read state {thread_id}")))
    }
}

#[cfg(test)]
mod tests {
    use crate::store::Store;

    #[tokio::test]
    async fn thread_pins_round_trip_idempotently_and_order_by_pinned_at() {
        let store = Store::in_memory().await.unwrap();

        let first = store.pin_thread("thread-1").await.unwrap();
        let second = store.pin_thread("thread-2").await.unwrap();
        let repinned_first = store.pin_thread("thread-1").await.unwrap();

        assert_eq!(repinned_first.pinned_at, first.pinned_at);
        assert!(repinned_first.updated_at >= first.updated_at);

        let listed = store.list_thread_pins().await.unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|pin| pin.thread_id.as_str())
                .collect::<Vec<_>>(),
            vec!["thread-2", "thread-1"]
        );
        assert!(listed[0].pinned_at >= second.pinned_at);

        let thread_ids = vec!["thread-1".to_string(), "missing".to_string()];
        let pinned_at = store.pinned_at_for_thread_ids(&thread_ids).await.unwrap();
        assert_eq!(pinned_at.get("thread-1"), Some(&first.pinned_at));
        assert!(!pinned_at.contains_key("missing"));

        store.unpin_thread("thread-1").await.unwrap();
        assert!(store.get_thread_pin("thread-1").await.is_err());
    }
}
