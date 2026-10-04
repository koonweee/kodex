use chrono::Utc;
use sqlx::Row;

use crate::error::ApiResult;

use super::{Store, ThreadRuntimeState, ThreadRuntimeStatus};

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
