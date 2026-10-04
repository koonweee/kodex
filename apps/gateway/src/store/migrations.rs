use sqlx::Row;

use crate::error::{ApiError, ApiResult};

use super::Store;

impl Store {
    pub async fn migrate(&self) -> ApiResult<()> {
        sqlx::query("pragma journal_mode = wal")
            .execute(&self.pool)
            .await?;
        self.install_queue_transfer_schema().await?;
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
            create table if not exists app_surface_sessions (
                id text primary key,
                thread_id text not null unique,
                bridge_token text not null,
                provider text not null,
                title text not null,
                resource_uri text not null,
                resource_mime_type text not null,
                fallback_content text not null,
                revision integer not null,
                status text not null,
                display_modes_json text not null,
                csp_json text not null,
                permissions_json text not null default '{}',
                grants_json text not null,
                provenance_json text not null,
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
        self.add_column_if_missing(
            "app_surface_sessions",
            "bridge_token",
            "text not null default ''",
        )
        .await?;
        self.add_column_if_missing(
            "app_surface_sessions",
            "permissions_json",
            "text not null default '{}'",
        )
        .await?;
        sqlx::query(
            "update app_surface_sessions set bridge_token = lower(hex(randomblob(16))) where bridge_token = ''",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists app_surface_resources (
                session_id text not null,
                revision integer not null,
                uri text not null,
                mime_type text not null,
                text text not null,
                created_at text not null,
                primary key (session_id, revision),
                foreign key (session_id) references app_surface_sessions(id)
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
                method text not null check (method = 'appSurface/bridge/requestApproval'),
                status text not null check (status in ('pending', 'resolved')),
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
                latest_completed_turn_id text,
                seen_completed_turn_id text,
                read_revision integer not null,
                read_state_known integer not null,
                updated_at text not null
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists thread_read_revision (
                id integer primary key check (id = 1),
                revision integer not null,
                membership_revision integer not null default 0
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query("insert into thread_read_revision (id, revision) values (1, 0) on conflict(id) do nothing")
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
                last_native_queue_id text,
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
                target_thread_id text not null,
                scheduled_for text,
                phase text not null check (phase in ('admitting', 'queued', 'startRequested', 'dispatched', 'rejected', 'uncertain', 'removed')),
                native_queue_id text,
                turn_id text,
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
            "create index if not exists automations_due_idx on automations (status, deleted_at, next_run_at)",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "create unique index if not exists automation_runs_pending_idx on automation_runs (automation_id) where scheduled_for is not null and phase in ('admitting', 'queued', 'startRequested', 'uncertain')",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "create unique index if not exists automation_runs_native_row_idx on automation_runs (target_thread_id, native_queue_id) where native_queue_id is not null",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "create index if not exists notification_deliveries_due_idx on notification_deliveries (status, available_at, processing_started_at, created_at)",
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
    use tempfile::tempdir;

    use crate::store::{NewEvent, Store};

    #[tokio::test]
    async fn fresh_database_has_no_thread_settings_authority() {
        let store = Store::in_memory().await.unwrap();
        let tables: Vec<String> = sqlx::query_scalar(
            "select name from sqlite_master where type = 'table' and name in ('thread_composer_settings', 'thread_local_settings_overlays') order by name",
        )
        .fetch_all(store.pool())
        .await
        .unwrap();

        assert!(
            tables.is_empty(),
            "superseded thread settings tables: {tables:?}"
        );
    }

    #[tokio::test]
    async fn fresh_database_has_no_sidebar_organization_authority() {
        let store = Store::in_memory().await.unwrap();
        let tables: Vec<String> = sqlx::query_scalar(
            "select name from sqlite_master where type = 'table' and name in ('thread_pins', 'thread_sections', 'thread_section_order') order by name",
        )
        .fetch_all(store.pool())
        .await
        .unwrap();

        assert!(tables.is_empty(), "superseded sidebar tables: {tables:?}");
    }

    #[tokio::test]
    async fn file_database_migration_creates_tables_and_enables_wal() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("gateway.db");
        let store = Store::connect(&path).await.unwrap();

        store.assert_wal().await.unwrap();
        let tables: Vec<String> = sqlx::query_scalar(
            "select name from sqlite_master where type = 'table' and name in ('events', 'app_surface_sessions', 'app_surface_resources', 'approvals', 'thread_reads', 'thread_read_revision', 'push_subscriptions', 'notification_deliveries', 'thread_notification_settings', 'queue_transfers', 'thread_runtime_state', 'automations', 'automation_runs', 'pending_timeline_skill_mentions', 'timeline_skill_mentions') order by name",
        )
        .fetch_all(store.pool())
        .await
        .unwrap();
        assert_eq!(
            tables,
            vec![
                "app_surface_resources",
                "app_surface_sessions",
                "approvals",
                "automation_runs",
                "automations",
                "events",
                "notification_deliveries",
                "push_subscriptions",
                "queue_transfers",
                "thread_notification_settings",
                "thread_read_revision",
                "thread_reads",
                "thread_runtime_state"
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
}
