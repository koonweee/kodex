use std::collections::{HashMap, HashSet};

use chrono::Utc;
use serde_json::Value;
use sqlx::{QueryBuilder, Row, Sqlite};
use uuid::Uuid;

use crate::{app_server_api::TimelineSkillMention, error::ApiResult};

use super::{
    payload_has_terminal_turn_status, row_to_event, EventEnvelope, NewEvent, Store,
    EVENT_REPLAY_LIMIT,
};

impl Store {
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

    pub async fn insert_pending_timeline_skill_mentions(
        &self,
        thread_id: &str,
        text: &str,
        mentions: &[TimelineSkillMention],
    ) -> ApiResult<Option<String>> {
        if mentions.is_empty() {
            return Ok(None);
        }
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let mentions_json = serde_json::to_string(mentions)?;
        sqlx::query(
            r#"
            insert into pending_timeline_skill_mentions (
                id, thread_id, text, mentions_json, created_at
            )
            values (?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(thread_id)
        .bind(text)
        .bind(mentions_json)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(Some(id))
    }

    pub async fn delete_pending_timeline_skill_mentions(&self, id: &str) -> ApiResult<()> {
        sqlx::query("delete from pending_timeline_skill_mentions where id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn upsert_timeline_skill_mentions(
        &self,
        thread_id: &str,
        item_id: &str,
        mentions: &[TimelineSkillMention],
    ) -> ApiResult<()> {
        if mentions.is_empty() {
            return Ok(());
        }
        let now = Utc::now();
        let mentions_json = serde_json::to_string(mentions)?;
        sqlx::query(
            r#"
            insert into timeline_skill_mentions (
                thread_id, item_id, mentions_json, created_at, updated_at
            )
            values (?, ?, ?, ?, ?)
            on conflict(thread_id, item_id) do update set
                mentions_json = excluded.mentions_json,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(thread_id)
        .bind(item_id)
        .bind(mentions_json)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn commit_pending_timeline_skill_mentions(
        &self,
        thread_id: &str,
        item_id: &str,
        text: &str,
    ) -> ApiResult<Option<Vec<TimelineSkillMention>>> {
        let mut tx = self.pool.begin().await?;
        let pending = sqlx::query(
            r#"
            select id, mentions_json
            from pending_timeline_skill_mentions
            where thread_id = ? and text = ?
            order by created_at asc
            limit 1
            "#,
        )
        .bind(thread_id)
        .bind(text)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = pending else {
            tx.commit().await?;
            return Ok(None);
        };
        let id: String = row.try_get("id")?;
        let mentions_json: String = row.try_get("mentions_json")?;
        let mentions: Vec<TimelineSkillMention> = serde_json::from_str(&mentions_json)?;
        sqlx::query("delete from pending_timeline_skill_mentions where id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let now = Utc::now();
        sqlx::query(
            r#"
            insert into timeline_skill_mentions (
                thread_id, item_id, mentions_json, created_at, updated_at
            )
            values (?, ?, ?, ?, ?)
            on conflict(thread_id, item_id) do update set
                mentions_json = excluded.mentions_json,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(thread_id)
        .bind(item_id)
        .bind(mentions_json)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(mentions))
    }

    pub async fn timeline_skill_mentions_for_items(
        &self,
        thread_id: &str,
        item_ids: &[String],
    ) -> ApiResult<HashMap<String, Vec<TimelineSkillMention>>> {
        if item_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut builder = QueryBuilder::new(
            "select item_id, mentions_json from timeline_skill_mentions where thread_id = ",
        );
        builder.push_bind(thread_id);
        builder.push(" and item_id in (");
        let mut separated = builder.separated(", ");
        for item_id in item_ids {
            separated.push_bind(item_id);
        }
        separated.push_unseparated(")");
        let rows = builder.build().fetch_all(&self.pool).await?;
        let mut mentions_by_item_id = HashMap::new();
        for row in rows {
            let item_id: String = row.try_get("item_id")?;
            let mentions_json: String = row.try_get("mentions_json")?;
            mentions_by_item_id.insert(item_id, serde_json::from_str(&mentions_json)?);
        }
        Ok(mentions_by_item_id)
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

    pub async fn completed_agent_turn_event_count(&self, thread_id: &str) -> ApiResult<i64> {
        let rows = sqlx::query(
            r#"
            select turn_id, codex_method, payload_json
            from events
            where thread_id = ?
              and (
                codex_method in ('turn/completed', 'turn/upsert')
                or (
                  kind = 'thread_view.cursor'
                  and json_extract(payload_json, '$.sourceKind') in ('thread_view.turn_completed', 'timeline.turn_completed')
                )
              )
            "#,
        )
        .bind(thread_id)
        .fetch_all(&self.pool)
        .await?;
        let mut completed_turn_ids = HashSet::new();
        for row in rows {
            let payload_json: String = row.try_get("payload_json")?;
            let payload = serde_json::from_str::<Value>(&payload_json)?;
            let method: Option<String> = row.try_get("codex_method")?;
            let source_kind = payload.get("sourceKind").and_then(Value::as_str);
            if method.as_deref() == Some("turn/upsert")
                && !matches!(
                    source_kind,
                    Some("thread_view.turn_completed") | Some("timeline.turn_completed")
                )
                && !payload_has_terminal_turn_status(&payload)
            {
                continue;
            }
            let turn_id: Option<String> = row.try_get("turn_id")?;
            let turn_id = turn_id
                .or_else(|| {
                    payload
                        .get("turn")
                        .and_then(|turn| turn.get("id"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .or_else(|| {
                    payload
                        .get("turnId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            if let Some(turn_id) = turn_id {
                completed_turn_ids.insert(turn_id);
            }
        }
        Ok(completed_turn_ids.len() as i64)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{
        app_server_api::TimelineSkillMention,
        store::{NewEvent, Store},
    };

    #[tokio::test]
    async fn timeline_skill_mentions_commit_pending_and_reload_by_item() {
        let store = Store::in_memory().await.unwrap();
        let mentions = vec![TimelineSkillMention {
            start: 4,
            end: 18,
            name: "agent-browser".to_string(),
            path: "/skills/agent-browser/SKILL.md".to_string(),
            display_name: None,
            scope: None,
            short_description: None,
            brand_color: None,
            icon_small_url: None,
        }];
        let pending_id = store
            .insert_pending_timeline_skill_mentions("thread-1", "Use $agent-browser", &mentions)
            .await
            .unwrap();
        assert!(pending_id.is_some());

        let committed = store
            .commit_pending_timeline_skill_mentions("thread-1", "item-user-1", "Use $agent-browser")
            .await
            .unwrap();
        assert_eq!(committed.as_deref(), Some(mentions.as_slice()));
        assert!(store
            .commit_pending_timeline_skill_mentions("thread-1", "item-user-2", "Use $agent-browser")
            .await
            .unwrap()
            .is_none());

        let loaded = store
            .timeline_skill_mentions_for_items("thread-1", &["item-user-1".to_string()])
            .await
            .unwrap();
        assert_eq!(loaded.get("item-user-1"), Some(&mentions));
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
