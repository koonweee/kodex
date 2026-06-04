use sqlx::Row;

use crate::error::{ApiError, ApiResult};

use super::Store;

impl Store {
    pub async fn migrate(&self) -> ApiResult<()> {
        sqlx::query("pragma journal_mode = wal")
            .execute(&self.pool)
            .await?;
        sqlx::query(
            r#"
            create table if not exists events (
                seq integer primary key autoincrement,
                id text not null unique,
                received_at text not null,
                project_id text,
                thread_id text,
                turn_id text,
                item_id text,
                kind text not null,
                codex_method text,
                payload_json text not null
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists projects (
                id text primary key,
                name text not null,
                cwd text not null unique,
                created_at text not null,
                updated_at text not null
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists project_preview_services (
                id text primary key,
                project_id text not null,
                name text not null,
                protocol text not null,
                local_port integer not null,
                health_path text not null,
                created_at text not null,
                updated_at text not null,
                foreign key (project_id) references projects(id)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists project_previews (
                id text primary key,
                project_id text not null,
                name text not null,
                public_port integer not null unique,
                root_service_id text not null,
                enabled integer not null,
                created_at text not null,
                updated_at text not null,
                foreign key (project_id) references projects(id),
                foreign key (root_service_id) references project_preview_services(id)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists project_preview_routes (
                id text primary key,
                preview_id text not null,
                path_pattern text not null,
                service_id text not null,
                strip_prefix integer not null,
                sort_order integer not null,
                created_at text not null,
                updated_at text not null,
                foreign key (preview_id) references project_previews(id),
                foreign key (service_id) references project_preview_services(id)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists generated_ui_sessions (
                id text primary key,
                thread_id text not null unique,
                title text not null,
                html text not null,
                revision integer not null,
                status text not null,
                submitted_revision integer,
                submitted_message text,
                submitted_metadata_json text,
                created_at text not null,
                updated_at text not null,
                submitted_at text,
                archived_at text
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists approvals (
                id text primary key,
                request_id text not null,
                thread_id text,
                turn_id text,
                item_id text,
                method text not null,
                status text not null,
                payload_json text not null,
                response_json text,
                created_at text not null,
                resolved_at text
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists thread_reads (
                thread_id text primary key,
                seen_completed_agent_turn_seq integer not null default 0,
                updated_at text not null
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists push_subscriptions (
                id text primary key,
                endpoint text not null unique,
                p256dh text not null,
                auth text not null,
                user_agent text,
                enabled integer not null default 1,
                created_at text not null,
                updated_at text not null
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists notification_deliveries (
                id text primary key,
                kind text not null,
                thread_id text,
                turn_id text,
                payload_json text,
                delivered_subscription_ids_json text not null default '[]',
                status text not null,
                attempt_count integer not null default 0,
                available_at text not null,
                processing_started_at text,
                sent_at text,
                last_error text,
                created_at text not null,
                updated_at text not null
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        self.add_column_if_missing(
            "notification_deliveries",
            "delivered_subscription_ids_json",
            "text not null default '[]'",
        )
        .await?;
        sqlx::query(
            r#"
            create table if not exists thread_notification_settings (
                thread_id text primary key,
                notifications_enabled integer not null default 1,
                updated_at text not null
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        self.migrate_thread_local_settings_overlay().await?;
        sqlx::query(
            r#"
            create table if not exists thread_pins (
                thread_id text primary key,
                pinned_at text not null,
                updated_at text not null
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists pending_timeline_skill_mentions (
                id text primary key,
                thread_id text not null,
                text text not null,
                mentions_json text not null,
                created_at text not null
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists timeline_skill_mentions (
                thread_id text not null,
                item_id text not null,
                mentions_json text not null,
                created_at text not null,
                updated_at text not null,
                primary key (thread_id, item_id)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists queued_turn_inputs (
                id text primary key,
                thread_id text not null,
                input_json text not null,
                attachments_json text not null default '[]',
                options_json text not null,
                status text not null,
                priority text not null default 'normal',
                attempt_count integer not null default 0,
                last_error text,
                accepted_turn_id text,
                accepted_at text,
                accepted_event_seq integer,
                pending_skill_mentions_id text,
                created_at text not null,
                updated_at text not null,
                deleted_at text
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        self.add_column_if_missing("queued_turn_inputs", "accepted_turn_id", "text")
            .await?;
        self.add_column_if_missing("queued_turn_inputs", "accepted_at", "text")
            .await?;
        self.add_column_if_missing("queued_turn_inputs", "accepted_event_seq", "integer")
            .await?;
        self.add_column_if_missing("queued_turn_inputs", "pending_skill_mentions_id", "text")
            .await?;
        self.add_column_if_missing("queued_turn_inputs", "source_type", "text")
            .await?;
        self.add_column_if_missing("queued_turn_inputs", "source_id", "text")
            .await?;
        self.add_column_if_missing(
            "queued_turn_inputs",
            "attachments_json",
            "text not null default '[]'",
        )
        .await?;
        sqlx::query(
            r#"
            create table if not exists thread_runtime_state (
                thread_id text primary key,
                status text not null,
                active_turn_id text,
                updated_at text not null,
                last_event_seq integer
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists automations (
                id text primary key,
                name text not null,
                prompt text not null,
                target_thread_id text not null,
                start_at text not null,
                repeat_every_seconds integer not null,
                next_run_at text not null,
                status text not null,
                paused_reason text,
                last_run_at text,
                last_queued_input_id text,
                last_error text,
                consecutive_failure_count integer not null default 0,
                created_at text not null,
                updated_at text not null,
                deleted_at text
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        self.add_column_if_missing("automations", "provenance", "text")
            .await?;
        sqlx::query(
            r#"
            create table if not exists automation_runs (
                id text primary key,
                automation_id text not null,
                scheduled_for text not null,
                status text not null,
                queued_input_id text,
                error text,
                created_at text not null,
                updated_at text not null,
                unique (automation_id, scheduled_for)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "create index if not exists queued_turn_inputs_active_idx on queued_turn_inputs (thread_id, deleted_at, status, priority, created_at)"
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "create index if not exists queued_turn_inputs_source_idx on queued_turn_inputs (source_type, source_id)"
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "create index if not exists automations_due_idx on automations (status, deleted_at, next_run_at)",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "create index if not exists automation_runs_pending_idx on automation_runs (automation_id, status, created_at)",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "create index if not exists notification_deliveries_due_idx on notification_deliveries (status, available_at, processing_started_at, created_at)",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "create index if not exists thread_pins_pinned_at_idx on thread_pins (pinned_at desc, thread_id)",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "create index if not exists pending_timeline_skill_mentions_match_idx on pending_timeline_skill_mentions (thread_id, text, created_at)",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn add_column_if_missing(
        &self,
        table: &str,
        column: &str,
        definition: &str,
    ) -> ApiResult<()> {
        let pragma = format!("pragma table_info({table})");
        let columns = sqlx::query(&pragma).fetch_all(&self.pool).await?;
        let exists = columns.iter().any(|row| {
            row.try_get::<String, _>("name")
                .is_ok_and(|name| name == column)
        });
        if !exists {
            let statement = format!("alter table {table} add column {column} {definition}");
            sqlx::query(&statement).execute(&self.pool).await?;
        }
        Ok(())
    }

    async fn migrate_thread_local_settings_overlay(&self) -> ApiResult<()> {
        sqlx::query(
            r#"
            create table if not exists thread_local_settings_overlays (
                thread_id text primary key,
                model text,
                reasoning_effort text,
                service_tier text,
                approval_policy text,
                approvals_reviewer text,
                permissions text,
                sandbox_json text,
                created_at text not null,
                updated_at text not null
            )
            "#,
        )
        .execute(&self.pool)
        .await?;

        self.add_column_if_missing("thread_local_settings_overlays", "model", "text")
            .await?;
        self.add_column_if_missing("thread_local_settings_overlays", "reasoning_effort", "text")
            .await?;
        self.add_column_if_missing("thread_local_settings_overlays", "service_tier", "text")
            .await?;

        if self.table_exists("thread_composer_settings").await? {
            self.add_column_if_missing("thread_composer_settings", "permissions", "text")
                .await?;
            sqlx::query(
                r#"
                insert or replace into thread_local_settings_overlays (
                    thread_id, approval_policy, approvals_reviewer, permissions,
                    sandbox_json, created_at, updated_at
                )
                select thread_id, approval_policy, approvals_reviewer, permissions,
                    sandbox_json, created_at, updated_at
                from thread_composer_settings
                "#,
            )
            .execute(&self.pool)
            .await?;
            sqlx::query("drop table thread_composer_settings")
                .execute(&self.pool)
                .await?;
        }

        Ok(())
    }

    pub(crate) async fn table_exists(&self, table: &str) -> ApiResult<bool> {
        let exists: Option<String> =
            sqlx::query_scalar("select name from sqlite_master where type = 'table' and name = ?")
                .bind(table)
                .fetch_optional(&self.pool)
                .await?;
        Ok(exists.is_some())
    }

    pub async fn assert_wal(&self) -> ApiResult<()> {
        let mode: String = sqlx::query_scalar("pragma journal_mode")
            .fetch_one(&self.pool)
            .await?;
        if mode.eq_ignore_ascii_case("wal") || mode.eq_ignore_ascii_case("memory") {
            Ok(())
        } else {
            Err(ApiError::Other(anyhow::anyhow!(
                "sqlite journal_mode is {mode}, expected wal"
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use tempfile::tempdir;

    use crate::store::{NewEvent, Store};

    #[tokio::test]
    async fn file_database_migration_creates_tables_and_enables_wal() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("gateway.db");
        let store = Store::connect(&path).await.unwrap();

        store.assert_wal().await.unwrap();
        let tables: Vec<String> = sqlx::query_scalar(
            "select name from sqlite_master where type = 'table' and name in ('events', 'projects', 'project_preview_services', 'project_previews', 'project_preview_routes', 'generated_ui_sessions', 'approvals', 'thread_reads', 'push_subscriptions', 'notification_deliveries', 'thread_notification_settings', 'thread_local_settings_overlays', 'thread_pins', 'queued_turn_inputs', 'thread_runtime_state', 'automations', 'automation_runs', 'pending_timeline_skill_mentions', 'timeline_skill_mentions') order by name",
        )
        .fetch_all(store.pool())
        .await
        .unwrap();
        assert_eq!(
            tables,
            vec![
                "approvals",
                "automation_runs",
                "automations",
                "events",
                "generated_ui_sessions",
                "notification_deliveries",
                "pending_timeline_skill_mentions",
                "project_preview_routes",
                "project_preview_services",
                "project_previews",
                "projects",
                "push_subscriptions",
                "queued_turn_inputs",
                "thread_local_settings_overlays",
                "thread_notification_settings",
                "thread_pins",
                "thread_reads",
                "thread_runtime_state",
                "timeline_skill_mentions"
            ]
        );
    }

    #[tokio::test]
    async fn migration_keeps_thread_reads_independent_from_event_replay() {
        let store = Store::in_memory().await.unwrap();
        store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: None,
                kind: "thread_view.cursor".to_string(),
                codex_method: Some("thread_view/cursor".to_string()),
                payload: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "reason": "agent_turn_completed",
                    "sourceKind": "timeline.turn_completed",
                    "sourceMethod": "turn/completed"
                }),
            })
            .await
            .unwrap();

        sqlx::query("drop table thread_reads")
            .execute(store.pool())
            .await
            .unwrap();
        store.migrate().await.unwrap();

        let thread_ids = vec!["thread-1".to_string()];
        let states = store.thread_read_states(&thread_ids).await.unwrap();
        assert!(!states.contains_key("thread-1"));
    }

    #[tokio::test]
    async fn migration_moves_legacy_thread_composer_settings_without_model_fields() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("gateway.db");
        let url = format!("sqlite://{}?mode=rwc", path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        sqlx::query(
            r#"
            create table thread_composer_settings (
                thread_id text primary key,
                model text,
                reasoning_effort text,
                service_tier text,
                approval_policy text,
                approvals_reviewer text,
                permissions text,
                sandbox_json text,
                created_at text not null,
                updated_at text not null
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            insert into thread_composer_settings (
                thread_id, model, reasoning_effort, service_tier, approval_policy,
                approvals_reviewer, permissions, sandbox_json, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind("thread-1")
        .bind("gpt-5.5")
        .bind("xhigh")
        .bind("fast")
        .bind("on-request")
        .bind("auto_review")
        .bind("auto-review")
        .bind(r#"{"type":"workspaceWrite"}"#)
        .bind("2026-06-01T00:00:00Z")
        .bind("2026-06-01T01:00:00Z")
        .execute(&pool)
        .await
        .unwrap();
        drop(pool);

        let store = Store::connect(&path).await.unwrap();
        assert!(!store
            .table_exists("thread_composer_settings")
            .await
            .unwrap());
        assert!(store
            .table_exists("thread_local_settings_overlays")
            .await
            .unwrap());
        let settings = store
            .thread_local_settings_overlays(&["thread-1".to_string()])
            .await
            .unwrap();
        let settings = settings.get("thread-1").unwrap();
        assert!(settings.model.is_none());
        assert!(settings.reasoning_effort.is_none());
        assert!(settings.service_tier.is_none());
        assert_eq!(settings.approval_policy.as_deref(), Some("on-request"));
        assert_eq!(settings.approvals_reviewer.as_deref(), Some("auto_review"));
        assert_eq!(settings.permissions.as_deref(), Some("auto-review"));
        assert_eq!(
            settings.sandbox.as_ref(),
            Some(&json!({"type": "workspaceWrite"}))
        );
    }
}
