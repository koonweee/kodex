use chrono::Utc;
use sqlx::{QueryBuilder, Sqlite};
use uuid::Uuid;

use crate::{error::ApiResult, events_replay::WORKSPACE_GLOBAL_THREAD_EVENT_KINDS};

use super::{row_to_event, EventEnvelope, NewEvent, Store, EVENT_REPLAY_LIMIT};

impl Store {
    /// Exact Control audit lookup; SSE replay windows are not idempotency state.
    pub(crate) async fn find_control_spawn_event(
        &self,
        kind: &str,
        key: &str,
    ) -> ApiResult<Option<EventEnvelope>> {
        let row = sqlx::query("select * from events where kind = ? and json_extract(payload_json, '$.idempotencyKey') = ? order by seq desc limit 1")
            .bind(kind).bind(key).fetch_optional(&self.pool).await?;
        row.map(row_to_event).transpose()
    }

    pub async fn append_event(&self, event: NewEvent) -> ApiResult<EventEnvelope> {
        let id = Uuid::new_v4().to_string();
        let received_at = Utc::now();
        let payload_json = serde_json::to_string(&event.payload)?;

        let result = sqlx::query(
            r#"
            insert into events (
                id, received_at, project_id, thread_id, turn_id, item_id,
                kind, codex_method, payload_json
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(received_at)
        .bind(&event.project_id)
        .bind(&event.thread_id)
        .bind(&event.turn_id)
        .bind(&event.item_id)
        .bind(&event.kind)
        .bind(&event.codex_method)
        .bind(payload_json)
        .execute(&self.pool)
        .await?;

        Ok(EventEnvelope {
            seq: result.last_insert_rowid(),
            id,
            received_at,
            project_id: event.project_id,
            thread_id: event.thread_id,
            turn_id: event.turn_id,
            item_id: event.item_id,
            kind: event.kind,
            codex_method: event.codex_method,
            payload: event.payload,
        })
    }

    pub async fn replay_events(
        &self,
        cursor: Option<i64>,
        project_id: Option<String>,
        thread_id: Option<String>,
    ) -> ApiResult<Vec<EventEnvelope>> {
        self.replay_events_page(
            cursor,
            project_id.as_deref(),
            thread_id.as_deref(),
            EVENT_REPLAY_LIMIT,
        )
        .await
    }

    pub async fn latest_event_seq(&self) -> ApiResult<i64> {
        let seq: Option<i64> = sqlx::query_scalar("select max(seq) from events")
            .fetch_one(&self.pool)
            .await?;
        Ok(seq.unwrap_or(0))
    }

    pub async fn replay_events_page(
        &self,
        cursor: Option<i64>,
        project_id: Option<&str>,
        thread_id: Option<&str>,
        limit: i64,
    ) -> ApiResult<Vec<EventEnvelope>> {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "select seq, id, received_at, project_id, thread_id, turn_id, item_id, kind, codex_method, payload_json from events where seq > ",
        );
        builder.push_bind(cursor.unwrap_or(0));

        if let Some(project_id) = project_id {
            builder.push(" and project_id = ");
            builder.push_bind(project_id);
        }
        if let Some(thread_id) = thread_id {
            builder.push(" and thread_id = ");
            builder.push_bind(thread_id);
        }
        builder.push(" order by seq asc limit ");
        builder.push_bind(limit);

        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.into_iter().map(row_to_event).collect()
    }

    pub async fn replay_events_page_for_threads(
        &self,
        cursor: Option<i64>,
        project_id: Option<&str>,
        thread_ids: &[String],
        include_global: bool,
        limit: i64,
    ) -> ApiResult<Vec<EventEnvelope>> {
        if thread_ids.is_empty() && !include_global {
            return Ok(Vec::new());
        }

        let mut builder = QueryBuilder::<Sqlite>::new(
            "select seq, id, received_at, project_id, thread_id, turn_id, item_id, kind, codex_method, payload_json from events where seq > ",
        );
        builder.push_bind(cursor.unwrap_or(0));

        if let Some(project_id) = project_id {
            builder.push(" and project_id = ");
            builder.push_bind(project_id);
        }

        builder.push(" and (");
        let mut needs_or = false;
        if include_global {
            builder.push("thread_id is null");
            needs_or = true;
            if !WORKSPACE_GLOBAL_THREAD_EVENT_KINDS.is_empty() {
                builder.push(" or kind in (");
                let mut separated = builder.separated(", ");
                for kind in WORKSPACE_GLOBAL_THREAD_EVENT_KINDS {
                    separated.push_bind(kind);
                }
                separated.push_unseparated(")");
            }
        }
        if !thread_ids.is_empty() {
            if needs_or {
                builder.push(" or ");
            }
            builder.push("thread_id in (");
            let mut separated = builder.separated(", ");
            for thread_id in thread_ids {
                separated.push_bind(thread_id);
            }
            separated.push_unseparated(")");
        }
        builder.push(") order by seq asc limit ");
        builder.push_bind(limit);

        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.into_iter().map(row_to_event).collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::store::{NewEvent, Store};

    #[tokio::test]
    async fn replay_events_page_for_threads_filters_in_store() {
        let store = Store::in_memory().await.unwrap();

        append_test_event(&store, "workspace.updated", None).await;
        append_test_event(&store, "approval.changed", Some("thread-2")).await;
        append_test_event(&store, "thread_view.patch", Some("thread-1")).await;
        append_test_event(&store, "thread_view.patch", Some("thread-2")).await;
        append_test_event(&store, "thread_view.patch", Some("thread-3")).await;

        let replay = store
            .replay_events_page_for_threads(
                Some(0),
                None,
                &["thread-1".to_string(), "thread-3".to_string()],
                true,
                500,
            )
            .await
            .unwrap();

        assert_eq!(
            replay
                .iter()
                .map(|event| (event.kind.as_str(), event.thread_id.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                ("workspace.updated", None),
                ("approval.changed", Some("thread-2")),
                ("thread_view.patch", Some("thread-1")),
                ("thread_view.patch", Some("thread-3")),
            ]
        );
    }

    async fn append_test_event(store: &Store, kind: &str, thread_id: Option<&str>) {
        store
            .append_event(NewEvent {
                project_id: None,
                thread_id: thread_id.map(ToOwned::to_owned),
                turn_id: None,
                item_id: None,
                kind: kind.to_string(),
                codex_method: None,
                payload: json!({}),
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn appending_events_assigns_monotonic_seq() {
        let store = Store::in_memory().await.unwrap();

        let first = store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "thread_view.cursor".to_string(),
                codex_method: Some("thread_view/cursor".to_string()),
                payload: json!({"ok": true}),
            })
            .await
            .unwrap();
        let second = store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "gateway.warning".to_string(),
                codex_method: None,
                payload: json!({"warning": "test"}),
            })
            .await
            .unwrap();

        assert!(second.seq > first.seq);
        let replay = store
            .replay_events(Some(first.seq), None, Some("thread-1".to_string()))
            .await
            .unwrap();
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].seq, second.seq);
    }
}
