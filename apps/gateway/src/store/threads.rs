use std::collections::HashMap;

use chrono::Utc;
use sqlx::{QueryBuilder, Row, Sqlite};

use crate::error::{ApiError, ApiResult};

use super::{row_to_thread_read, Store, ThreadRead, ThreadReadState};

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
