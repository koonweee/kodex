use std::{collections::HashMap, path::Path};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{sqlite::SqlitePoolOptions, Pool, QueryBuilder, Row, Sqlite};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    app_server_api::{TimelineSkillMention, TurnStartOptions, UserInput},
    error::{ApiError, ApiResult},
};

const EVENT_REPLAY_LIMIT: i64 = 500;

#[derive(Debug, Clone)]
pub struct Store {
    pool: Pool<Sqlite>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub seq: i64,
    pub id: String,
    pub received_at: DateTime<Utc>,
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub kind: String,
    pub codex_method: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct NewEvent {
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub kind: String,
    pub codex_method: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPreviewService {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub protocol: String,
    pub local_port: i64,
    pub health_path: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewProjectPreviewService {
    pub project_id: String,
    pub name: String,
    pub protocol: String,
    pub local_port: i64,
    pub health_path: String,
}

#[derive(Debug, Clone, Default)]
pub struct ProjectPreviewServiceUpdate {
    pub name: Option<String>,
    pub protocol: Option<String>,
    pub local_port: Option<i64>,
    pub health_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPreview {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub public_port: i64,
    pub root_service_id: String,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewProjectPreview {
    pub project_id: String,
    pub name: String,
    pub public_port: i64,
    pub root_service_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ProjectPreviewUpdate {
    pub name: Option<String>,
    pub public_port: Option<i64>,
    pub root_service_id: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPreviewRoute {
    pub id: String,
    pub preview_id: String,
    pub path_pattern: String,
    pub service_id: String,
    pub strip_prefix: bool,
    pub sort_order: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewProjectPreviewRoute {
    pub preview_id: String,
    pub path_pattern: String,
    pub service_id: String,
    pub strip_prefix: bool,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Default)]
pub struct ProjectPreviewRouteUpdate {
    pub path_pattern: Option<String>,
    pub service_id: Option<String>,
    pub strip_prefix: Option<bool>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub request_id: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub method: String,
    pub status: String,
    pub payload: Value,
    pub response: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRead {
    pub thread_id: String,
    pub seen_completed_agent_turn_seq: i64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPin {
    pub thread_id: String,
    pub pinned_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushSubscription {
    pub id: String,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub user_agent: Option<String>,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewPushSubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ThreadReadState {
    pub seen_completed_agent_turn_seq: i64,
}

#[derive(Debug, Clone, Default)]
pub struct ThreadComposerSettings {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub approval_policy: Option<String>,
    pub approvals_reviewer: Option<String>,
    pub sandbox: Option<Value>,
}

impl ThreadComposerSettings {
    pub fn has_any_setting(&self) -> bool {
        self.model.is_some()
            || self.reasoning_effort.is_some()
            || self.service_tier.is_some()
            || self.approval_policy.is_some()
            || self.approvals_reviewer.is_some()
            || self.sandbox.is_some()
    }

    pub fn from_turn_options(options: &TurnStartOptions) -> Self {
        Self {
            model: options.model.clone(),
            reasoning_effort: options.effort.clone(),
            service_tier: options.service_tier.clone(),
            approval_policy: options.approval_policy.clone(),
            approvals_reviewer: options.approvals_reviewer.clone(),
            sandbox: options.sandbox_policy.clone(),
        }
    }

    pub fn to_turn_options(&self) -> TurnStartOptions {
        TurnStartOptions {
            model: self.model.clone(),
            effort: self.reasoning_effort.clone(),
            service_tier: self.service_tier.clone(),
            approval_policy: self.approval_policy.clone(),
            approvals_reviewer: self.approvals_reviewer.clone(),
            sandbox_policy: self.sandbox.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum QueuedInputStatus {
    Queued,
    Submitting,
    Steering,
    PendingCommit,
    Failed,
}

impl QueuedInputStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Submitting => "submitting",
            Self::Steering => "steering",
            Self::PendingCommit => "pendingCommit",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum QueuedInputPriority {
    Normal,
    RejectedSteer,
}

impl QueuedInputPriority {
    fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::RejectedSteer => "rejectedSteer",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueuedInput {
    pub id: String,
    pub thread_id: String,
    pub input: Vec<UserInput>,
    pub options: TurnStartOptions,
    pub source_type: Option<String>,
    pub source_id: Option<String>,
    pub status: QueuedInputStatus,
    pub priority: QueuedInputPriority,
    pub attempt_count: i64,
    pub last_error: Option<String>,
    pub accepted_turn_id: Option<String>,
    pub accepted_at: Option<DateTime<Utc>>,
    pub accepted_event_seq: Option<i64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum AutomationStatus {
    Active,
    Paused,
}

impl AutomationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub target_thread_id: String,
    pub start_at: DateTime<Utc>,
    pub repeat_every_seconds: i64,
    pub next_run_at: DateTime<Utc>,
    pub status: AutomationStatus,
    pub paused_reason: Option<String>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub last_queued_input_id: Option<String>,
    pub last_error: Option<String>,
    pub consecutive_failure_count: i64,
    pub provenance: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewAutomation {
    pub name: String,
    pub prompt: String,
    pub target_thread_id: String,
    pub start_at: DateTime<Utc>,
    pub repeat_every_seconds: i64,
    pub next_run_at: DateTime<Utc>,
    pub status: AutomationStatus,
    pub paused_reason: Option<String>,
    pub provenance: Option<Value>,
}

#[derive(Debug, Clone, Default)]
pub struct AutomationUpdate {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub target_thread_id: Option<String>,
    pub start_at: Option<DateTime<Utc>>,
    pub repeat_every_seconds: Option<i64>,
    pub next_run_at: Option<DateTime<Utc>>,
    pub status: Option<AutomationStatus>,
    pub paused_reason: Option<Option<String>>,
    pub provenance: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub scheduled_for: DateTime<Utc>,
    pub status: String,
    pub queued_input_id: Option<String>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct ThreadRuntimeState {
    pub thread_id: String,
    pub status: String,
    pub active_turn_id: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub last_event_seq: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct NewApproval {
    pub request_id: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub method: String,
    pub payload: Value,
}

impl Store {
    pub async fn connect(path: &Path) -> ApiResult<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let url = format!("sqlite://{}?mode=rwc", path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await?;
        let store = Self { pool };
        store.migrate().await?;
        store.assert_wal().await?;
        Ok(store)
    }

    pub async fn in_memory() -> ApiResult<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        let store = Self { pool };
        store.migrate().await?;
        Ok(store)
    }

    pub fn pool(&self) -> &Pool<Sqlite> {
        &self.pool
    }

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
            create table if not exists thread_composer_settings (
                thread_id text primary key,
                model text,
                reasoning_effort text,
                service_tier text,
                approval_policy text,
                approvals_reviewer text,
                sandbox_json text,
                created_at text not null,
                updated_at text not null
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
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

    pub async fn create_project(&self, name: String, cwd: String) -> ApiResult<Project> {
        let now = Utc::now();
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name,
            cwd,
            created_at: now,
            updated_at: now,
        };

        sqlx::query(
            "insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)",
        )
        .bind(&project.id)
        .bind(&project.name)
        .bind(&project.cwd)
        .bind(project.created_at)
        .bind(project.updated_at)
        .execute(&self.pool)
        .await?;

        Ok(project)
    }

    pub async fn list_projects(&self) -> ApiResult<Vec<Project>> {
        let rows = sqlx::query(
            "select id, name, cwd, created_at, updated_at from projects order by created_at desc",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_project).collect()
    }

    pub async fn get_project(&self, id: &str) -> ApiResult<Project> {
        let row =
            sqlx::query("select id, name, cwd, created_at, updated_at from projects where id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;

        row.map(row_to_project)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("project {id}")))
    }

    pub async fn create_project_preview_service(
        &self,
        service: NewProjectPreviewService,
    ) -> ApiResult<ProjectPreviewService> {
        self.get_project(&service.project_id).await?;
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            insert into project_preview_services
                (id, project_id, name, protocol, local_port, health_path, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&service.project_id)
        .bind(service.name)
        .bind(service.protocol)
        .bind(service.local_port)
        .bind(service.health_path)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_project_preview_service(&service.project_id, &id)
            .await
    }

    pub async fn list_project_preview_services(
        &self,
        project_id: &str,
    ) -> ApiResult<Vec<ProjectPreviewService>> {
        self.get_project(project_id).await?;
        let rows = sqlx::query(
            r#"
            select id, project_id, name, protocol, local_port, health_path, created_at, updated_at
            from project_preview_services
            where project_id = ?
            order by created_at asc, id asc
            "#,
        )
        .bind(project_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(row_to_project_preview_service)
            .collect()
    }

    pub async fn get_project_preview_service(
        &self,
        project_id: &str,
        service_id: &str,
    ) -> ApiResult<ProjectPreviewService> {
        let row = sqlx::query(
            r#"
            select id, project_id, name, protocol, local_port, health_path, created_at, updated_at
            from project_preview_services
            where project_id = ? and id = ?
            "#,
        )
        .bind(project_id)
        .bind(service_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_project_preview_service)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("preview service {service_id}")))
    }

    pub async fn update_project_preview_service(
        &self,
        project_id: &str,
        service_id: &str,
        update: ProjectPreviewServiceUpdate,
    ) -> ApiResult<ProjectPreviewService> {
        let existing = self
            .get_project_preview_service(project_id, service_id)
            .await?;
        let referenced = self
            .preview_service_reference_count(project_id, service_id)
            .await?
            > 0;
        if referenced && (update.protocol.is_some() || update.local_port.is_some()) {
            return Err(ApiError::BadRequest(
                "referenced preview services cannot change protocol or port".to_string(),
            ));
        }

        let name = update.name.unwrap_or(existing.name);
        let protocol = update.protocol.unwrap_or(existing.protocol);
        let local_port = update.local_port.unwrap_or(existing.local_port);
        let health_path = update.health_path.unwrap_or(existing.health_path);
        let now = Utc::now();
        let affected = sqlx::query(
            r#"
            update project_preview_services
            set name = ?, protocol = ?, local_port = ?, health_path = ?, updated_at = ?
            where project_id = ? and id = ?
            "#,
        )
        .bind(name)
        .bind(protocol)
        .bind(local_port)
        .bind(health_path)
        .bind(now)
        .bind(project_id)
        .bind(service_id)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if affected == 0 {
            return Err(ApiError::NotFound(format!("preview service {service_id}")));
        }
        self.get_project_preview_service(project_id, service_id)
            .await
    }

    pub async fn delete_project_preview_service(
        &self,
        project_id: &str,
        service_id: &str,
    ) -> ApiResult<()> {
        self.get_project_preview_service(project_id, service_id)
            .await?;
        if self
            .preview_service_reference_count(project_id, service_id)
            .await?
            > 0
        {
            return Err(ApiError::BadRequest(
                "preview service is referenced by a preview".to_string(),
            ));
        }
        let affected =
            sqlx::query("delete from project_preview_services where project_id = ? and id = ?")
                .bind(project_id)
                .bind(service_id)
                .execute(&self.pool)
                .await?
                .rows_affected();
        if affected == 0 {
            return Err(ApiError::NotFound(format!("preview service {service_id}")));
        }
        Ok(())
    }

    pub async fn allocate_project_preview_public_port(
        &self,
        preferred_port: i64,
        start: i64,
        end: i64,
    ) -> ApiResult<i64> {
        if start > end {
            return Err(ApiError::BadRequest(
                "invalid preview port range".to_string(),
            ));
        }
        if preferred_port >= start
            && preferred_port <= end
            && !self
                .project_preview_public_port_exists(preferred_port, None)
                .await?
        {
            return Ok(preferred_port);
        }
        for port in start..=end {
            if !self.project_preview_public_port_exists(port, None).await? {
                return Ok(port);
            }
        }
        Err(ApiError::BadRequest(
            "no available preview public ports".to_string(),
        ))
    }

    pub async fn create_project_preview(
        &self,
        preview: NewProjectPreview,
    ) -> ApiResult<ProjectPreview> {
        self.get_project(&preview.project_id).await?;
        self.get_project_preview_service(&preview.project_id, &preview.root_service_id)
            .await?;
        if self
            .project_preview_public_port_exists(preview.public_port, None)
            .await?
        {
            return Err(ApiError::BadRequest(
                "preview public port is already in use".to_string(),
            ));
        }

        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            insert into project_previews
                (id, project_id, name, public_port, root_service_id, enabled, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&preview.project_id)
        .bind(preview.name)
        .bind(preview.public_port)
        .bind(preview.root_service_id)
        .bind(bool_to_i64(preview.enabled))
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_project_preview(&preview.project_id, &id).await
    }

    pub async fn list_project_previews(&self, project_id: &str) -> ApiResult<Vec<ProjectPreview>> {
        self.get_project(project_id).await?;
        let rows = sqlx::query(
            r#"
            select id, project_id, name, public_port, root_service_id, enabled, created_at, updated_at
            from project_previews
            where project_id = ?
            order by created_at asc, id asc
            "#,
        )
        .bind(project_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_project_preview).collect()
    }

    pub async fn list_all_project_previews(&self) -> ApiResult<Vec<ProjectPreview>> {
        let rows = sqlx::query(
            r#"
            select id, project_id, name, public_port, root_service_id, enabled, created_at, updated_at
            from project_previews
            order by created_at asc, id asc
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_project_preview).collect()
    }

    pub async fn get_project_preview(
        &self,
        project_id: &str,
        preview_id: &str,
    ) -> ApiResult<ProjectPreview> {
        let row = sqlx::query(
            r#"
            select id, project_id, name, public_port, root_service_id, enabled, created_at, updated_at
            from project_previews
            where project_id = ? and id = ?
            "#,
        )
        .bind(project_id)
        .bind(preview_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_project_preview)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("project preview {preview_id}")))
    }

    pub async fn update_project_preview(
        &self,
        project_id: &str,
        preview_id: &str,
        update: ProjectPreviewUpdate,
    ) -> ApiResult<ProjectPreview> {
        let existing = self.get_project_preview(project_id, preview_id).await?;
        let root_service_id = update.root_service_id.unwrap_or(existing.root_service_id);
        self.get_project_preview_service(project_id, &root_service_id)
            .await?;
        let public_port = update.public_port.unwrap_or(existing.public_port);
        if self
            .project_preview_public_port_exists(public_port, Some(preview_id))
            .await?
        {
            return Err(ApiError::BadRequest(
                "preview public port is already in use".to_string(),
            ));
        }
        let name = update.name.unwrap_or(existing.name);
        let enabled = update.enabled.unwrap_or(existing.enabled);
        let now = Utc::now();
        let affected = sqlx::query(
            r#"
            update project_previews
            set name = ?, public_port = ?, root_service_id = ?, enabled = ?, updated_at = ?
            where project_id = ? and id = ?
            "#,
        )
        .bind(name)
        .bind(public_port)
        .bind(root_service_id)
        .bind(bool_to_i64(enabled))
        .bind(now)
        .bind(project_id)
        .bind(preview_id)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if affected == 0 {
            return Err(ApiError::NotFound(format!("project preview {preview_id}")));
        }
        self.get_project_preview(project_id, preview_id).await
    }

    pub async fn delete_project_preview(
        &self,
        project_id: &str,
        preview_id: &str,
    ) -> ApiResult<()> {
        self.get_project_preview(project_id, preview_id).await?;
        sqlx::query("delete from project_preview_routes where preview_id = ?")
            .bind(preview_id)
            .execute(&self.pool)
            .await?;
        let affected = sqlx::query("delete from project_previews where project_id = ? and id = ?")
            .bind(project_id)
            .bind(preview_id)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if affected == 0 {
            return Err(ApiError::NotFound(format!("project preview {preview_id}")));
        }
        Ok(())
    }

    pub async fn create_project_preview_route(
        &self,
        project_id: &str,
        route: NewProjectPreviewRoute,
    ) -> ApiResult<ProjectPreviewRoute> {
        self.get_project_preview(project_id, &route.preview_id)
            .await?;
        self.get_project_preview_service(project_id, &route.service_id)
            .await?;
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            insert into project_preview_routes
                (id, preview_id, path_pattern, service_id, strip_prefix, sort_order, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&route.preview_id)
        .bind(route.path_pattern)
        .bind(route.service_id)
        .bind(bool_to_i64(route.strip_prefix))
        .bind(route.sort_order)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_project_preview_route(project_id, &route.preview_id, &id)
            .await
    }

    pub async fn list_project_preview_routes(
        &self,
        preview_id: &str,
    ) -> ApiResult<Vec<ProjectPreviewRoute>> {
        let rows = sqlx::query(
            r#"
            select id, preview_id, path_pattern, service_id, strip_prefix, sort_order, created_at, updated_at
            from project_preview_routes
            where preview_id = ?
            order by sort_order asc, created_at asc, id asc
            "#,
        )
        .bind(preview_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_project_preview_route).collect()
    }

    pub async fn list_all_project_preview_routes(&self) -> ApiResult<Vec<ProjectPreviewRoute>> {
        let rows = sqlx::query(
            r#"
            select id, preview_id, path_pattern, service_id, strip_prefix, sort_order, created_at, updated_at
            from project_preview_routes
            order by sort_order asc, created_at asc, id asc
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_project_preview_route).collect()
    }

    pub async fn get_project_preview_route(
        &self,
        project_id: &str,
        preview_id: &str,
        route_id: &str,
    ) -> ApiResult<ProjectPreviewRoute> {
        self.get_project_preview(project_id, preview_id).await?;
        let row = sqlx::query(
            r#"
            select id, preview_id, path_pattern, service_id, strip_prefix, sort_order, created_at, updated_at
            from project_preview_routes
            where preview_id = ? and id = ?
            "#,
        )
        .bind(preview_id)
        .bind(route_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_project_preview_route)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("preview route {route_id}")))
    }

    pub async fn update_project_preview_route(
        &self,
        project_id: &str,
        preview_id: &str,
        route_id: &str,
        update: ProjectPreviewRouteUpdate,
    ) -> ApiResult<ProjectPreviewRoute> {
        let existing = self
            .get_project_preview_route(project_id, preview_id, route_id)
            .await?;
        let service_id = update.service_id.unwrap_or(existing.service_id);
        self.get_project_preview_service(project_id, &service_id)
            .await?;
        let path_pattern = update.path_pattern.unwrap_or(existing.path_pattern);
        let strip_prefix = update.strip_prefix.unwrap_or(existing.strip_prefix);
        let sort_order = update.sort_order.unwrap_or(existing.sort_order);
        let now = Utc::now();
        let affected = sqlx::query(
            r#"
            update project_preview_routes
            set path_pattern = ?, service_id = ?, strip_prefix = ?, sort_order = ?, updated_at = ?
            where preview_id = ? and id = ?
            "#,
        )
        .bind(path_pattern)
        .bind(service_id)
        .bind(bool_to_i64(strip_prefix))
        .bind(sort_order)
        .bind(now)
        .bind(preview_id)
        .bind(route_id)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if affected == 0 {
            return Err(ApiError::NotFound(format!("preview route {route_id}")));
        }
        self.get_project_preview_route(project_id, preview_id, route_id)
            .await
    }

    pub async fn delete_project_preview_route(
        &self,
        project_id: &str,
        preview_id: &str,
        route_id: &str,
    ) -> ApiResult<()> {
        self.get_project_preview_route(project_id, preview_id, route_id)
            .await?;
        let affected =
            sqlx::query("delete from project_preview_routes where preview_id = ? and id = ?")
                .bind(preview_id)
                .bind(route_id)
                .execute(&self.pool)
                .await?
                .rows_affected();
        if affected == 0 {
            return Err(ApiError::NotFound(format!("preview route {route_id}")));
        }
        Ok(())
    }

    pub(crate) async fn preview_service_reference_count(
        &self,
        project_id: &str,
        service_id: &str,
    ) -> ApiResult<i64> {
        let root_count: i64 = sqlx::query_scalar(
            "select count(*) from project_previews where project_id = ? and root_service_id = ?",
        )
        .bind(project_id)
        .bind(service_id)
        .fetch_one(&self.pool)
        .await?;
        let route_count: i64 = sqlx::query_scalar(
            r#"
            select count(*)
            from project_preview_routes routes
            join project_previews previews on previews.id = routes.preview_id
            where previews.project_id = ? and routes.service_id = ?
            "#,
        )
        .bind(project_id)
        .bind(service_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(root_count + route_count)
    }

    pub(crate) async fn project_preview_public_port_exists(
        &self,
        public_port: i64,
        except_preview_id: Option<&str>,
    ) -> ApiResult<bool> {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "select count(*) from project_previews where public_port = ",
        );
        builder.push_bind(public_port);
        if let Some(except_preview_id) = except_preview_id {
            builder.push(" and id <> ");
            builder.push_bind(except_preview_id);
        }
        let count: i64 = builder.build_query_scalar().fetch_one(&self.pool).await?;
        Ok(count > 0)
    }

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

    pub async fn save_thread_composer_settings(
        &self,
        thread_id: &str,
        settings: &ThreadComposerSettings,
    ) -> ApiResult<()> {
        let now = Utc::now();
        let sandbox_json = settings
            .sandbox
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        sqlx::query(
            r#"
            insert into thread_composer_settings (
                thread_id, model, reasoning_effort, service_tier, approval_policy,
                approvals_reviewer, sandbox_json, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(thread_id) do update set
                model = excluded.model,
                reasoning_effort = excluded.reasoning_effort,
                service_tier = excluded.service_tier,
                approval_policy = excluded.approval_policy,
                approvals_reviewer = excluded.approvals_reviewer,
                sandbox_json = excluded.sandbox_json,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(thread_id)
        .bind(&settings.model)
        .bind(&settings.reasoning_effort)
        .bind(&settings.service_tier)
        .bind(&settings.approval_policy)
        .bind(&settings.approvals_reviewer)
        .bind(sandbox_json)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    pub async fn save_thread_turn_options(
        &self,
        thread_id: &str,
        options: &TurnStartOptions,
    ) -> ApiResult<()> {
        self.save_thread_composer_settings(
            thread_id,
            &ThreadComposerSettings::from_turn_options(options),
        )
        .await
    }

    pub async fn thread_composer_settings(
        &self,
        thread_ids: &[String],
    ) -> ApiResult<HashMap<String, ThreadComposerSettings>> {
        if thread_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let mut builder = QueryBuilder::<Sqlite>::new(
            "select thread_id, model, reasoning_effort, service_tier, approval_policy, approvals_reviewer, sandbox_json from thread_composer_settings where thread_id in (",
        );
        {
            let mut separated = builder.separated(", ");
            for thread_id in thread_ids {
                separated.push_bind(thread_id);
            }
        }
        builder.push(")");

        let mut settings = HashMap::new();
        for row in builder.build().fetch_all(&self.pool).await? {
            let thread_id: String = row.try_get("thread_id")?;
            let sandbox_json: Option<String> = row.try_get("sandbox_json")?;
            settings.insert(
                thread_id,
                ThreadComposerSettings {
                    model: row.try_get("model")?,
                    reasoning_effort: row.try_get("reasoning_effort")?,
                    service_tier: row.try_get("service_tier")?,
                    approval_policy: row.try_get("approval_policy")?,
                    approvals_reviewer: row.try_get("approvals_reviewer")?,
                    sandbox: sandbox_json
                        .map(|value| serde_json::from_str(&value))
                        .transpose()?,
                },
            );
        }

        Ok(settings)
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

    pub async fn upsert_push_subscription(
        &self,
        subscription: NewPushSubscription,
    ) -> ApiResult<PushSubscription> {
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            insert into push_subscriptions (
                id, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, 1, ?, ?)
            on conflict(endpoint) do update set
                p256dh = excluded.p256dh,
                auth = excluded.auth,
                user_agent = excluded.user_agent,
                enabled = 1,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(id)
        .bind(&subscription.endpoint)
        .bind(&subscription.p256dh)
        .bind(&subscription.auth)
        .bind(&subscription.user_agent)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;

        self.get_push_subscription_by_endpoint(&subscription.endpoint)
            .await
    }

    pub async fn get_push_subscription_by_endpoint(
        &self,
        endpoint: &str,
    ) -> ApiResult<PushSubscription> {
        let row = sqlx::query(
            r#"
            select id, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at
            from push_subscriptions
            where endpoint = ?
            "#,
        )
        .bind(endpoint)
        .fetch_optional(&self.pool)
        .await?;

        row.map(row_to_push_subscription)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("push subscription endpoint {endpoint}")))
    }

    pub async fn list_enabled_push_subscriptions(&self) -> ApiResult<Vec<PushSubscription>> {
        let rows = sqlx::query(
            r#"
            select id, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at
            from push_subscriptions
            where enabled = 1
            order by created_at, id
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_push_subscription).collect()
    }

    pub async fn disable_push_subscription(&self, id: &str) -> ApiResult<Option<PushSubscription>> {
        let now = Utc::now();
        sqlx::query(
            r#"
            update push_subscriptions
            set enabled = 0, updated_at = ?
            where id = ?
            "#,
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;

        let row = sqlx::query(
            r#"
            select id, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at
            from push_subscriptions
            where id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_push_subscription).transpose()
    }

    pub async fn create_queued_input(
        &self,
        thread_id: &str,
        input: Vec<UserInput>,
        options: TurnStartOptions,
    ) -> ApiResult<QueuedInput> {
        self.create_queued_input_with_source(thread_id, input, options, None, None)
            .await
    }

    pub async fn create_queued_input_with_source(
        &self,
        thread_id: &str,
        input: Vec<UserInput>,
        options: TurnStartOptions,
        source_type: Option<&str>,
        source_id: Option<&str>,
    ) -> ApiResult<QueuedInput> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let input_json = serde_json::to_string(&input)?;
        let options_json = serde_json::to_string(&options)?;
        sqlx::query(
            r#"
            insert into queued_turn_inputs (
                id, thread_id, input_json, options_json, status, priority,
                attempt_count, source_type, source_id, created_at, updated_at
            )
            values (?, ?, ?, ?, 'queued', 'normal', 0, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(thread_id)
        .bind(input_json)
        .bind(options_json)
        .bind(source_type)
        .bind(source_id)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_queued_input(thread_id, &id).await
    }

    pub async fn list_queued_inputs(&self, thread_id: &str) -> ApiResult<Vec<QueuedInput>> {
        let rows = sqlx::query(
            r#"
            select id, thread_id, input_json, options_json, source_type, source_id, status, priority,
                   attempt_count, last_error, accepted_turn_id, accepted_at,
                   accepted_event_seq, created_at, updated_at
            from queued_turn_inputs
            where thread_id = ? and deleted_at is null
            order by case priority when 'rejectedSteer' then 0 else 1 end, created_at asc
            "#,
        )
        .bind(thread_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_queued_input).collect()
    }

    pub async fn queued_thread_ids(&self) -> ApiResult<Vec<String>> {
        let thread_ids = sqlx::query_scalar::<_, String>(
            r#"
            select distinct thread_id from queued_turn_inputs
            where deleted_at is null and status = 'queued'
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(thread_ids)
    }

    pub async fn get_queued_input(&self, thread_id: &str, id: &str) -> ApiResult<QueuedInput> {
        let row = sqlx::query(
            r#"
            select id, thread_id, input_json, options_json, source_type, source_id, status, priority,
                   attempt_count, last_error, accepted_turn_id, accepted_at,
                   accepted_event_seq, created_at, updated_at
            from queued_turn_inputs
            where thread_id = ? and id = ? and deleted_at is null
            "#,
        )
        .bind(thread_id)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_queued_input)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("queued input {id}")))
    }

    pub async fn find_queued_input_by_source(
        &self,
        source_type: &str,
        source_id: &str,
    ) -> ApiResult<Option<QueuedInput>> {
        let row = sqlx::query(
            r#"
            select id, thread_id, input_json, options_json, source_type, source_id, status, priority,
                   attempt_count, last_error, accepted_turn_id, accepted_at,
                   accepted_event_seq, created_at, updated_at
            from queued_turn_inputs
            where source_type = ?
              and source_id = ?
            order by created_at asc
            limit 1
            "#,
        )
        .bind(source_type)
        .bind(source_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_queued_input).transpose()
    }

    pub async fn claim_next_queued_input(&self, thread_id: &str) -> ApiResult<Option<QueuedInput>> {
        let now = Utc::now();
        let Some(id) = sqlx::query_scalar::<_, String>(
            r#"
            select id from queued_turn_inputs
            where thread_id = ? and deleted_at is null and status = 'queued'
            order by case priority when 'rejectedSteer' then 0 else 1 end, created_at asc
            limit 1
            "#,
        )
        .bind(thread_id)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        let result = sqlx::query(
            r#"
            update queued_turn_inputs
            set status = 'submitting', attempt_count = attempt_count + 1,
                last_error = null, updated_at = ?
            where thread_id = ? and id = ? and status = 'queued' and deleted_at is null
            "#,
        )
        .bind(now)
        .bind(thread_id)
        .bind(&id)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            return Ok(None);
        }

        self.get_queued_input(thread_id, &id).await.map(Some)
    }

    pub async fn claim_queued_input_for_steering(
        &self,
        thread_id: &str,
        id: &str,
    ) -> ApiResult<QueuedInput> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update queued_turn_inputs
            set status = 'steering',
                attempt_count = attempt_count + 1,
                last_error = null,
                accepted_turn_id = null,
                accepted_at = null,
                accepted_event_seq = null,
                pending_skill_mentions_id = null,
                updated_at = ?
            where thread_id = ? and id = ? and status = 'queued' and deleted_at is null
            "#,
        )
        .bind(now)
        .bind(thread_id)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            self.require_existing_queued_input(thread_id, id).await?;
            return Err(ApiError::BadRequest(format!(
                "queued input {id} is not ready to steer"
            )));
        }
        self.get_queued_input(thread_id, id).await
    }

    pub async fn mark_queued_input_pending_commit(
        &self,
        thread_id: &str,
        id: &str,
        accepted_turn_id: &str,
        accepted_event_seq: Option<i64>,
        pending_skill_mentions_id: Option<&str>,
    ) -> ApiResult<QueuedInput> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update queued_turn_inputs
            set status = 'pendingCommit',
                priority = 'normal',
                last_error = null,
                accepted_turn_id = ?,
                accepted_at = ?,
                accepted_event_seq = ?,
                pending_skill_mentions_id = ?,
                updated_at = ?
            where thread_id = ? and id = ? and status = 'steering' and deleted_at is null
            "#,
        )
        .bind(accepted_turn_id)
        .bind(now)
        .bind(accepted_event_seq)
        .bind(pending_skill_mentions_id)
        .bind(now)
        .bind(thread_id)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            self.require_existing_queued_input(thread_id, id).await?;
            return Err(ApiError::BadRequest(format!(
                "queued input {id} is not waiting for steer acceptance"
            )));
        }
        self.get_queued_input(thread_id, id).await
    }

    pub async fn mark_queued_input_failed(
        &self,
        thread_id: &str,
        id: &str,
        error: String,
    ) -> ApiResult<QueuedInput> {
        self.transition_queued_input(
            thread_id,
            id,
            QueuedInputStatus::Failed,
            Some(QueuedInputPriority::Normal),
            Some(error),
        )
        .await
    }

    pub async fn mark_queued_input_rejected_steer(
        &self,
        thread_id: &str,
        id: &str,
        error: String,
    ) -> ApiResult<QueuedInput> {
        self.transition_queued_input(
            thread_id,
            id,
            QueuedInputStatus::Queued,
            Some(QueuedInputPriority::RejectedSteer),
            Some(error),
        )
        .await
    }

    pub async fn requeue_queued_input(&self, thread_id: &str, id: &str) -> ApiResult<QueuedInput> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update queued_turn_inputs
            set status = 'queued',
                priority = 'normal',
                last_error = null,
                accepted_turn_id = null,
                accepted_at = null,
                accepted_event_seq = null,
                pending_skill_mentions_id = null,
                updated_at = ?
            where thread_id = ? and id = ? and status = 'failed' and deleted_at is null
            "#,
        )
        .bind(now)
        .bind(thread_id)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            self.require_existing_queued_input(thread_id, id).await?;
            return Err(ApiError::BadRequest(format!(
                "queued input {id} is not failed"
            )));
        }
        self.get_queued_input(thread_id, id).await
    }

    pub async fn oldest_pending_commit_input(
        &self,
        thread_id: &str,
        accepted_turn_id: &str,
    ) -> ApiResult<Option<QueuedInput>> {
        let row = sqlx::query(
            r#"
            select id, thread_id, input_json, options_json, source_type, source_id, status, priority,
                   attempt_count, last_error, accepted_turn_id, accepted_at,
                   accepted_event_seq, created_at, updated_at
            from queued_turn_inputs
            where thread_id = ?
              and accepted_turn_id = ?
              and deleted_at is null
              and status = 'pendingCommit'
            order by updated_at asc, created_at asc
            limit 1
            "#,
        )
        .bind(thread_id)
        .bind(accepted_turn_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_queued_input).transpose()
    }

    pub async fn requeue_pending_commit_inputs_for_turn(
        &self,
        thread_id: &str,
        accepted_turn_id: &str,
        error: &str,
    ) -> ApiResult<Vec<QueuedInput>> {
        self.requeue_pending_commit_inputs(
            "thread_id = ? and accepted_turn_id = ?",
            &[thread_id, accepted_turn_id],
            error,
        )
        .await
    }

    pub async fn requeue_pending_commit_inputs_for_thread(
        &self,
        thread_id: &str,
        error: &str,
    ) -> ApiResult<Vec<QueuedInput>> {
        self.requeue_pending_commit_inputs("thread_id = ?", &[thread_id], error)
            .await
    }

    async fn requeue_pending_commit_inputs(
        &self,
        predicate: &str,
        binds: &[&str],
        error: &str,
    ) -> ApiResult<Vec<QueuedInput>> {
        let select = format!(
            r#"
            select id, thread_id, input_json, options_json, source_type, source_id, status, priority,
                   attempt_count, last_error, accepted_turn_id, accepted_at,
                   accepted_event_seq, created_at, updated_at
            from queued_turn_inputs
            where deleted_at is null and status = 'pendingCommit' and {predicate}
            order by updated_at asc, created_at asc
            "#
        );
        let mut query = sqlx::query(&select);
        for bind in binds {
            query = query.bind(*bind);
        }
        let pending = query
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(row_to_queued_input)
            .collect::<ApiResult<Vec<_>>>()?;
        if pending.is_empty() {
            return Ok(Vec::new());
        }
        self.delete_pending_timeline_skill_mentions_for_queued_rows(&pending)
            .await?;

        let now = Utc::now();
        let update = format!(
            r#"
            update queued_turn_inputs
            set status = 'queued',
                priority = 'rejectedSteer',
                last_error = ?,
                accepted_turn_id = null,
                accepted_at = null,
                accepted_event_seq = null,
                pending_skill_mentions_id = null,
                updated_at = ?
            where deleted_at is null and status = 'pendingCommit' and {predicate}
            "#
        );
        let mut query = sqlx::query(&update).bind(error).bind(now);
        for bind in binds {
            query = query.bind(*bind);
        }
        query.execute(&self.pool).await?;

        let mut requeued = Vec::with_capacity(pending.len());
        for row in pending {
            requeued.push(self.get_queued_input(&row.thread_id, &row.id).await?);
        }
        Ok(requeued)
    }

    async fn delete_pending_timeline_skill_mentions_for_queued_rows(
        &self,
        queued_inputs: &[QueuedInput],
    ) -> ApiResult<()> {
        if queued_inputs.is_empty() {
            return Ok(());
        }
        let mut builder = QueryBuilder::<Sqlite>::new(
            "select pending_skill_mentions_id from queued_turn_inputs where pending_skill_mentions_id is not null and id in (",
        );
        let mut separated = builder.separated(", ");
        for queued_input in queued_inputs {
            separated.push_bind(&queued_input.id);
        }
        separated.push_unseparated(")");
        let pending_ids = builder
            .build_query_scalar::<String>()
            .fetch_all(&self.pool)
            .await?;
        for pending_id in pending_ids {
            self.delete_pending_timeline_skill_mentions(&pending_id)
                .await?;
        }
        Ok(())
    }

    async fn transition_queued_input(
        &self,
        thread_id: &str,
        id: &str,
        status: QueuedInputStatus,
        priority: Option<QueuedInputPriority>,
        error: Option<String>,
    ) -> ApiResult<QueuedInput> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update queued_turn_inputs
            set status = ?,
                priority = coalesce(?, priority),
                last_error = ?,
                accepted_turn_id = null,
                accepted_at = null,
                accepted_event_seq = null,
                pending_skill_mentions_id = null,
                updated_at = ?
            where thread_id = ? and id = ? and deleted_at is null
            "#,
        )
        .bind(status.as_str())
        .bind(priority.map(QueuedInputPriority::as_str))
        .bind(error)
        .bind(now)
        .bind(thread_id)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::NotFound(format!("queued input {id}")));
        }
        self.get_queued_input(thread_id, id).await
    }

    pub async fn delete_queued_input(&self, thread_id: &str, id: &str) -> ApiResult<()> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update queued_turn_inputs
            set deleted_at = ?, updated_at = ?
            where thread_id = ?
                and id = ?
                and deleted_at is null
                and status not in ('submitting', 'steering', 'pendingCommit')
            "#,
        )
        .bind(now)
        .bind(now)
        .bind(thread_id)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            let existing = sqlx::query_scalar::<_, String>(
                "select status from queued_turn_inputs where thread_id = ? and id = ? and deleted_at is null",
            )
            .bind(thread_id)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
            match existing.as_deref() {
                Some("submitting" | "steering" | "pendingCommit") => {
                    return Err(ApiError::BadRequest(
                        "in-flight queued inputs cannot be deleted".to_string(),
                    ));
                }
                Some(_) => {}
                None => return Err(ApiError::NotFound(format!("queued input {id}"))),
            }
        }
        Ok(())
    }

    pub async fn delete_queued_input_for_gateway(
        &self,
        thread_id: &str,
        id: &str,
    ) -> ApiResult<()> {
        let now = Utc::now();
        let result = sqlx::query(
            "update queued_turn_inputs set deleted_at = ?, updated_at = ? where thread_id = ? and id = ? and deleted_at is null",
        )
        .bind(now)
        .bind(now)
        .bind(thread_id)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            let existing = sqlx::query_scalar::<_, String>(
                "select id from queued_turn_inputs where thread_id = ? and id = ? and deleted_at is null",
            )
            .bind(thread_id)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
            if existing.is_none() {
                return Err(ApiError::NotFound(format!("queued input {id}")));
            }
        }
        Ok(())
    }

    async fn require_existing_queued_input(&self, thread_id: &str, id: &str) -> ApiResult<()> {
        let existing = sqlx::query_scalar::<_, String>(
            "select id from queued_turn_inputs where thread_id = ? and id = ? and deleted_at is null",
        )
        .bind(thread_id)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        if existing.is_none() {
            return Err(ApiError::NotFound(format!("queued input {id}")));
        }
        Ok(())
    }

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
        .bind(state.status)
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
        .bind(state.status)
        .bind(state.active_turn_id)
        .bind(state.updated_at)
        .bind(state.last_event_seq)
        .execute(&self.pool)
        .await?;
        self.get_thread_runtime_state(&thread_id)
            .await?
            .ok_or_else(|| ApiError::NotFound(format!("thread runtime state {thread_id}")))
    }

    pub async fn set_thread_runtime_pending(&self, thread_id: &str, status: &str) -> ApiResult<()> {
        self.upsert_thread_runtime_state(ThreadRuntimeState {
            thread_id: thread_id.to_string(),
            status: status.to_string(),
            active_turn_id: None,
            updated_at: Utc::now(),
            last_event_seq: None,
        })
        .await
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
            where thread_id = ? and status = 'idle'
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

    pub async fn create_automation(&self, automation: NewAutomation) -> ApiResult<Automation> {
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            insert into automations (
                id, name, prompt, target_thread_id, start_at, repeat_every_seconds,
                next_run_at, status, paused_reason, provenance, consecutive_failure_count,
                created_at, updated_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(automation.name)
        .bind(automation.prompt)
        .bind(automation.target_thread_id)
        .bind(automation.start_at)
        .bind(automation.repeat_every_seconds)
        .bind(automation.next_run_at)
        .bind(automation.status.as_str())
        .bind(automation.paused_reason)
        .bind(automation.provenance.map(|value| value.to_string()))
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_automation(&id).await
    }

    pub async fn list_automations(
        &self,
        target_thread_id: Option<&str>,
    ) -> ApiResult<Vec<Automation>> {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "select id, name, prompt, target_thread_id, start_at, repeat_every_seconds, next_run_at, status, paused_reason, last_run_at, last_queued_input_id, last_error, consecutive_failure_count, provenance, created_at, updated_at from automations where deleted_at is null",
        );
        if let Some(target_thread_id) = target_thread_id {
            builder.push(" and target_thread_id = ");
            builder.push_bind(target_thread_id);
        }
        builder.push(" order by created_at desc, id");
        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.into_iter().map(row_to_automation).collect()
    }

    pub async fn get_automation(&self, id: &str) -> ApiResult<Automation> {
        let row = sqlx::query(
            r#"
            select id, name, prompt, target_thread_id, start_at, repeat_every_seconds,
                   next_run_at, status, paused_reason, last_run_at, last_queued_input_id,
                   last_error, consecutive_failure_count, provenance, created_at, updated_at
            from automations
            where id = ? and deleted_at is null
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_automation)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("automation {id}")))
    }

    pub async fn update_automation(
        &self,
        id: &str,
        update: AutomationUpdate,
    ) -> ApiResult<Automation> {
        let existing = self.get_automation(id).await?;
        let now = Utc::now();
        sqlx::query(
            r#"
            update automations
            set name = ?,
                prompt = ?,
                target_thread_id = ?,
                start_at = ?,
                repeat_every_seconds = ?,
                next_run_at = ?,
                status = ?,
                paused_reason = ?,
                provenance = ?,
                updated_at = ?
            where id = ? and deleted_at is null
            "#,
        )
        .bind(update.name.unwrap_or(existing.name))
        .bind(update.prompt.unwrap_or(existing.prompt))
        .bind(update.target_thread_id.unwrap_or(existing.target_thread_id))
        .bind(update.start_at.unwrap_or(existing.start_at))
        .bind(
            update
                .repeat_every_seconds
                .unwrap_or(existing.repeat_every_seconds),
        )
        .bind(update.next_run_at.unwrap_or(existing.next_run_at))
        .bind(update.status.unwrap_or(existing.status).as_str())
        .bind(update.paused_reason.unwrap_or(existing.paused_reason))
        .bind(
            update
                .provenance
                .or(existing.provenance)
                .map(|value| value.to_string()),
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.get_automation(id).await
    }

    pub async fn pause_automation(
        &self,
        id: &str,
        paused_reason: Option<&str>,
    ) -> ApiResult<Automation> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update automations
            set status = 'paused', paused_reason = ?, updated_at = ?
            where id = ? and deleted_at is null
            "#,
        )
        .bind(paused_reason)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::NotFound(format!("automation {id}")));
        }
        self.get_automation(id).await
    }

    pub async fn resume_automation(&self, id: &str) -> ApiResult<Automation> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update automations
            set status = 'active', paused_reason = null, updated_at = ?
            where id = ? and deleted_at is null
            "#,
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::NotFound(format!("automation {id}")));
        }
        self.get_automation(id).await
    }

    pub async fn delete_automation(&self, id: &str) -> ApiResult<()> {
        let now = Utc::now();
        let result = sqlx::query(
            "update automations set deleted_at = ?, updated_at = ? where id = ? and deleted_at is null",
        )
        .bind(now)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::NotFound(format!("automation {id}")));
        }
        Ok(())
    }

    pub async fn claim_due_automation_runs(
        &self,
        now: DateTime<Utc>,
        limit: i64,
    ) -> ApiResult<Vec<AutomationRun>> {
        let rows = sqlx::query(
            r#"
            select id, name, prompt, target_thread_id, start_at, repeat_every_seconds,
                   next_run_at, status, paused_reason, last_run_at, last_queued_input_id,
                   last_error, consecutive_failure_count, provenance, created_at, updated_at
            from automations
            where deleted_at is null and status = 'active' and next_run_at <= ?
            order by next_run_at asc, created_at asc
            limit ?
            "#,
        )
        .bind(now)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let mut claimed = Vec::new();
        for row in rows {
            let automation = row_to_automation(row)?;
            let scheduled_for = automation.next_run_at;
            let next_run_at = next_automation_run_after(
                automation.start_at,
                automation.repeat_every_seconds,
                now,
            );
            let mut tx = self.pool.begin().await?;

            let pending_count: i64 = sqlx::query_scalar(
                r#"
                select count(*)
                from automation_runs runs
                left join queued_turn_inputs queue on queue.id = runs.queued_input_id
                where runs.automation_id = ?
                  and (
                    runs.status = 'pending'
                    or (
                      runs.status = 'queued'
                      and queue.deleted_at is null
                      and queue.status in ('queued', 'submitting', 'steering', 'pendingCommit')
                    )
                  )
                "#,
            )
            .bind(&automation.id)
            .fetch_one(&mut *tx)
            .await?;

            let update = sqlx::query(
                r#"
                update automations
                set next_run_at = ?, updated_at = ?
                where id = ?
                  and deleted_at is null
                  and status = 'active'
                  and next_run_at = ?
                "#,
            )
            .bind(next_run_at)
            .bind(now)
            .bind(&automation.id)
            .bind(scheduled_for)
            .execute(&mut *tx)
            .await?;

            if update.rows_affected() == 0 {
                tx.rollback().await?;
                continue;
            }

            if pending_count > 0 {
                tx.commit().await?;
                continue;
            }

            let run_id = Uuid::new_v4().to_string();
            let result = sqlx::query(
                r#"
                insert or ignore into automation_runs (
                    id, automation_id, scheduled_for, status, created_at, updated_at
                )
                values (?, ?, ?, 'pending', ?, ?)
                "#,
            )
            .bind(&run_id)
            .bind(&automation.id)
            .bind(scheduled_for)
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            if result.rows_affected() > 0 {
                claimed.push(self.get_automation_run(&run_id).await?);
            }
        }
        Ok(claimed)
    }

    pub async fn get_automation_run(&self, id: &str) -> ApiResult<AutomationRun> {
        let row = sqlx::query(
            r#"
            select id, automation_id, scheduled_for, status, queued_input_id,
                   error, created_at, updated_at
            from automation_runs
            where id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_automation_run)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("automation run {id}")))
    }

    pub async fn automation_for_run(&self, run_id: &str) -> ApiResult<Automation> {
        let automation_id: String =
            sqlx::query_scalar("select automation_id from automation_runs where id = ?")
                .bind(run_id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or_else(|| ApiError::NotFound(format!("automation run {run_id}")))?;
        self.get_automation(&automation_id).await
    }

    pub async fn mark_automation_run_queued(
        &self,
        run_id: &str,
        queued_input_id: &str,
    ) -> ApiResult<Automation> {
        let now = Utc::now();
        let run = self.get_automation_run(run_id).await?;
        let result = sqlx::query(
            r#"
            update automation_runs
            set status = 'queued', queued_input_id = ?, error = null, updated_at = ?
            where id = ? and status = 'pending'
            "#,
        )
        .bind(queued_input_id)
        .bind(now)
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::BadRequest(format!(
                "automation run {run_id} is not pending"
            )));
        }
        sqlx::query(
            r#"
            update automations
            set last_run_at = ?,
                last_queued_input_id = ?,
                last_error = null,
                consecutive_failure_count = 0,
                updated_at = ?
            where id = ? and deleted_at is null
            "#,
        )
        .bind(run.scheduled_for)
        .bind(queued_input_id)
        .bind(now)
        .bind(&run.automation_id)
        .execute(&self.pool)
        .await?;
        self.get_automation(&run.automation_id).await
    }

    pub async fn mark_automation_run_failed(
        &self,
        run_id: &str,
        error: String,
        auto_pause_after_failures: i64,
    ) -> ApiResult<Automation> {
        let now = Utc::now();
        let run = self.get_automation_run(run_id).await?;
        let result = sqlx::query(
            r#"
            update automation_runs
            set status = 'failed', error = ?, updated_at = ?
            where id = ? and status = 'pending'
            "#,
        )
        .bind(&error)
        .bind(now)
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::BadRequest(format!(
                "automation run {run_id} is not pending"
            )));
        }
        sqlx::query(
            r#"
            update automations
            set last_run_at = ?,
                last_error = ?,
                consecutive_failure_count = consecutive_failure_count + 1,
                updated_at = ?
            where id = ? and deleted_at is null
            "#,
        )
        .bind(run.scheduled_for)
        .bind(&error)
        .bind(now)
        .bind(&run.automation_id)
        .execute(&self.pool)
        .await?;
        let automation = self.get_automation(&run.automation_id).await?;
        if automation.consecutive_failure_count >= auto_pause_after_failures
            && automation.status == AutomationStatus::Active
        {
            return self
                .pause_automation(&run.automation_id, Some("tooManyFailures"))
                .await;
        }
        Ok(automation)
    }

    pub async fn recover_pending_automation_runs_after_restart(
        &self,
        source_type: &str,
        auto_pause_after_failures: i64,
    ) -> ApiResult<Vec<Automation>> {
        let run_ids = sqlx::query_scalar::<_, String>(
            "select id from automation_runs where status = 'pending' order by created_at asc",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut automations = Vec::with_capacity(run_ids.len());
        for run_id in run_ids {
            if let Some(queued_input) = self
                .find_queued_input_by_source(source_type, &run_id)
                .await?
            {
                automations.push(
                    self.mark_automation_run_queued(&run_id, &queued_input.id)
                        .await?,
                );
            } else {
                automations.push(
                    self.mark_automation_run_failed(
                        &run_id,
                        "Gateway restarted before this automation run could queue input."
                            .to_string(),
                        auto_pause_after_failures,
                    )
                    .await?,
                );
            }
        }
        Ok(automations)
    }

    pub async fn insert_approval(&self, approval: NewApproval) -> ApiResult<Approval> {
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        let payload_json = serde_json::to_string(&approval.payload)?;

        sqlx::query(
            r#"
            insert into approvals (
                id, request_id, thread_id, turn_id, item_id, method,
                status, payload_json, created_at
            )
            values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&approval.request_id)
        .bind(&approval.thread_id)
        .bind(&approval.turn_id)
        .bind(&approval.item_id)
        .bind(&approval.method)
        .bind(payload_json)
        .bind(now)
        .execute(&self.pool)
        .await?;

        self.get_approval(&id).await
    }

    pub async fn list_approvals(
        &self,
        status: Option<String>,
        thread_id: Option<String>,
    ) -> ApiResult<Vec<Approval>> {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "select id, request_id, thread_id, turn_id, item_id, method, status, payload_json, response_json, created_at, resolved_at from approvals where 1 = 1",
        );
        if let Some(status) = status {
            builder.push(" and status = ");
            builder.push_bind(status);
        }
        if let Some(thread_id) = thread_id {
            builder.push(" and thread_id = ");
            builder.push_bind(thread_id);
        }
        builder.push(" order by created_at desc");

        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.into_iter().map(row_to_approval).collect()
    }

    pub async fn get_approval(&self, id: &str) -> ApiResult<Approval> {
        let row = sqlx::query(
            r#"
            select id, request_id, thread_id, turn_id, item_id, method, status,
                   payload_json, response_json, created_at, resolved_at
            from approvals
            where id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        row.map(row_to_approval)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("approval {id}")))
    }

    pub async fn resolve_approval(&self, id: &str, response: Value) -> ApiResult<Approval> {
        self.claim_approval_resolution(id, response).await?;
        self.finish_approval_resolution(id).await
    }

    pub async fn claim_approval_resolution(
        &self,
        id: &str,
        response: Value,
    ) -> ApiResult<Approval> {
        let response_json = serde_json::to_string(&response)?;
        let resolved_at = Utc::now();
        let result = sqlx::query(
            "update approvals set status = 'resolving', response_json = ?, resolved_at = ? where id = ? and status = 'pending'",
        )
        .bind(response_json)
        .bind(resolved_at)
        .bind(id)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            let existing = self.get_approval(id).await?;
            return Err(ApiError::BadRequest(format!(
                "approval {id} is not pending; current status is {}",
                existing.status
            )));
        }

        self.get_approval(id).await
    }

    pub async fn finish_approval_resolution(&self, id: &str) -> ApiResult<Approval> {
        let result = sqlx::query(
            "update approvals set status = 'resolved' where id = ? and status = 'resolving'",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            let existing = self.get_approval(id).await?;
            return Err(ApiError::BadRequest(format!(
                "approval {id} is not resolving; current status is {}",
                existing.status
            )));
        }

        self.get_approval(id).await
    }

    pub async fn reset_approval_resolution(&self, id: &str) -> ApiResult<()> {
        sqlx::query(
            "update approvals set status = 'pending', response_json = null, resolved_at = null where id = ? and status = 'resolving'",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

fn row_to_event(row: sqlx::sqlite::SqliteRow) -> ApiResult<EventEnvelope> {
    let payload_json: String = row.try_get("payload_json")?;
    Ok(EventEnvelope {
        seq: row.try_get("seq")?,
        id: row.try_get("id")?,
        received_at: row.try_get("received_at")?,
        project_id: row.try_get("project_id")?,
        thread_id: row.try_get("thread_id")?,
        turn_id: row.try_get("turn_id")?,
        item_id: row.try_get("item_id")?,
        kind: row.try_get("kind")?,
        codex_method: row.try_get("codex_method")?,
        payload: serde_json::from_str(&payload_json)?,
    })
}

fn row_to_project(row: sqlx::sqlite::SqliteRow) -> ApiResult<Project> {
    Ok(Project {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        cwd: row.try_get("cwd")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_project_preview_service(
    row: sqlx::sqlite::SqliteRow,
) -> ApiResult<ProjectPreviewService> {
    Ok(ProjectPreviewService {
        id: row.try_get("id")?,
        project_id: row.try_get("project_id")?,
        name: row.try_get("name")?,
        protocol: row.try_get("protocol")?,
        local_port: row.try_get("local_port")?,
        health_path: row.try_get("health_path")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_project_preview(row: sqlx::sqlite::SqliteRow) -> ApiResult<ProjectPreview> {
    let enabled: i64 = row.try_get("enabled")?;
    Ok(ProjectPreview {
        id: row.try_get("id")?,
        project_id: row.try_get("project_id")?,
        name: row.try_get("name")?,
        public_port: row.try_get("public_port")?,
        root_service_id: row.try_get("root_service_id")?,
        enabled: enabled != 0,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_project_preview_route(row: sqlx::sqlite::SqliteRow) -> ApiResult<ProjectPreviewRoute> {
    let strip_prefix: i64 = row.try_get("strip_prefix")?;
    Ok(ProjectPreviewRoute {
        id: row.try_get("id")?,
        preview_id: row.try_get("preview_id")?,
        path_pattern: row.try_get("path_pattern")?,
        service_id: row.try_get("service_id")?,
        strip_prefix: strip_prefix != 0,
        sort_order: row.try_get("sort_order")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_automation(row: sqlx::sqlite::SqliteRow) -> ApiResult<Automation> {
    let status: String = row.try_get("status")?;
    let provenance_json: Option<String> = row.try_get("provenance")?;
    let provenance = provenance_json
        .map(|value| serde_json::from_str(&value))
        .transpose()
        .map_err(|error| ApiError::BadGateway(format!("invalid automation provenance: {error}")))?;
    Ok(Automation {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        prompt: row.try_get("prompt")?,
        target_thread_id: row.try_get("target_thread_id")?,
        start_at: row.try_get("start_at")?,
        repeat_every_seconds: row.try_get("repeat_every_seconds")?,
        next_run_at: row.try_get("next_run_at")?,
        status: automation_status(&status)?,
        paused_reason: row.try_get("paused_reason")?,
        last_run_at: row.try_get("last_run_at")?,
        last_queued_input_id: row.try_get("last_queued_input_id")?,
        last_error: row.try_get("last_error")?,
        consecutive_failure_count: row.try_get("consecutive_failure_count")?,
        provenance,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_automation_run(row: sqlx::sqlite::SqliteRow) -> ApiResult<AutomationRun> {
    Ok(AutomationRun {
        id: row.try_get("id")?,
        automation_id: row.try_get("automation_id")?,
        scheduled_for: row.try_get("scheduled_for")?,
        status: row.try_get("status")?,
        queued_input_id: row.try_get("queued_input_id")?,
        error: row.try_get("error")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_queued_input(row: sqlx::sqlite::SqliteRow) -> ApiResult<QueuedInput> {
    let input_json: String = row.try_get("input_json")?;
    let options_json: String = row.try_get("options_json")?;
    let status: String = row.try_get("status")?;
    let priority: String = row.try_get("priority")?;
    let accepted_at: Option<String> = row.try_get("accepted_at")?;
    Ok(QueuedInput {
        id: row.try_get("id")?,
        thread_id: row.try_get("thread_id")?,
        input: serde_json::from_str(&input_json)?,
        options: serde_json::from_str(&options_json)?,
        source_type: row.try_get("source_type")?,
        source_id: row.try_get("source_id")?,
        status: queued_input_status(&status)?,
        priority: queued_input_priority(&priority)?,
        attempt_count: row.try_get("attempt_count")?,
        last_error: row.try_get("last_error")?,
        accepted_turn_id: row.try_get("accepted_turn_id")?,
        accepted_at: accepted_at
            .map(|value| value.parse::<DateTime<Utc>>())
            .transpose()
            .map_err(|error| {
                ApiError::BadGateway(format!("invalid queued input accepted_at: {error}"))
            })?,
        accepted_event_seq: row.try_get("accepted_event_seq")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn queued_input_status(status: &str) -> ApiResult<QueuedInputStatus> {
    match status {
        "queued" => Ok(QueuedInputStatus::Queued),
        "submitting" => Ok(QueuedInputStatus::Submitting),
        "steering" => Ok(QueuedInputStatus::Steering),
        "pendingCommit" => Ok(QueuedInputStatus::PendingCommit),
        "failed" => Ok(QueuedInputStatus::Failed),
        other => Err(ApiError::BadGateway(format!(
            "unknown queued input status {other}"
        ))),
    }
}

fn queued_input_priority(priority: &str) -> ApiResult<QueuedInputPriority> {
    match priority {
        "normal" => Ok(QueuedInputPriority::Normal),
        "rejectedSteer" => Ok(QueuedInputPriority::RejectedSteer),
        other => Err(ApiError::BadGateway(format!(
            "unknown queued input priority {other}"
        ))),
    }
}

fn automation_status(status: &str) -> ApiResult<AutomationStatus> {
    match status {
        "active" => Ok(AutomationStatus::Active),
        "paused" => Ok(AutomationStatus::Paused),
        other => Err(ApiError::BadGateway(format!(
            "unknown automation status {other}"
        ))),
    }
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

pub fn next_automation_run_after(
    start_at: DateTime<Utc>,
    repeat_every_seconds: i64,
    now: DateTime<Utc>,
) -> DateTime<Utc> {
    if now < start_at {
        return start_at;
    }
    let elapsed = now.signed_duration_since(start_at).num_seconds();
    let interval = repeat_every_seconds.max(1);
    let intervals_elapsed = elapsed.div_euclid(interval) + 1;
    start_at + chrono::Duration::seconds(intervals_elapsed * interval)
}

fn row_to_thread_runtime_state(row: sqlx::sqlite::SqliteRow) -> ApiResult<ThreadRuntimeState> {
    Ok(ThreadRuntimeState {
        thread_id: row.try_get("thread_id")?,
        status: row.try_get("status")?,
        active_turn_id: row.try_get("active_turn_id")?,
        updated_at: row.try_get("updated_at")?,
        last_event_seq: row.try_get("last_event_seq")?,
    })
}

fn row_to_thread_read(row: sqlx::sqlite::SqliteRow) -> ApiResult<ThreadRead> {
    Ok(ThreadRead {
        thread_id: row.try_get("thread_id")?,
        seen_completed_agent_turn_seq: row.try_get("seen_completed_agent_turn_seq")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_thread_pin(row: sqlx::sqlite::SqliteRow) -> ApiResult<ThreadPin> {
    Ok(ThreadPin {
        thread_id: row.try_get("thread_id")?,
        pinned_at: row.try_get("pinned_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_push_subscription(row: sqlx::sqlite::SqliteRow) -> ApiResult<PushSubscription> {
    Ok(PushSubscription {
        id: row.try_get("id")?,
        endpoint: row.try_get("endpoint")?,
        p256dh: row.try_get("p256dh")?,
        auth: row.try_get("auth")?,
        user_agent: row.try_get("user_agent")?,
        enabled: row.try_get::<i64, _>("enabled")? != 0,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_approval(row: sqlx::sqlite::SqliteRow) -> ApiResult<Approval> {
    let payload_json: String = row.try_get("payload_json")?;
    let response_json: Option<String> = row.try_get("response_json")?;
    Ok(Approval {
        id: row.try_get("id")?,
        request_id: row.try_get("request_id")?,
        thread_id: row.try_get("thread_id")?,
        turn_id: row.try_get("turn_id")?,
        item_id: row.try_get("item_id")?,
        method: row.try_get("method")?,
        status: row.try_get("status")?,
        payload: serde_json::from_str(&payload_json)?,
        response: response_json
            .map(|json| serde_json::from_str(&json))
            .transpose()?,
        created_at: row.try_get("created_at")?,
        resolved_at: row.try_get("resolved_at")?,
    })
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    #[tokio::test]
    async fn file_database_migration_creates_tables_and_enables_wal() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("gateway.db");
        let store = Store::connect(&path).await.unwrap();

        store.assert_wal().await.unwrap();
        let tables: Vec<String> = sqlx::query_scalar(
            "select name from sqlite_master where type = 'table' and name in ('events', 'projects', 'project_preview_services', 'project_previews', 'project_preview_routes', 'approvals', 'thread_reads', 'push_subscriptions', 'thread_composer_settings', 'thread_pins', 'queued_turn_inputs', 'thread_runtime_state', 'automations', 'automation_runs', 'pending_timeline_skill_mentions', 'timeline_skill_mentions') order by name",
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
                "pending_timeline_skill_mentions",
                "project_preview_routes",
                "project_preview_services",
                "project_previews",
                "projects",
                "push_subscriptions",
                "queued_turn_inputs",
                "thread_composer_settings",
                "thread_pins",
                "thread_reads",
                "thread_runtime_state",
                "timeline_skill_mentions"
            ]
        );
    }

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
    async fn requeue_pending_commit_cleans_up_pending_skill_mentions() {
        let store = Store::in_memory().await.unwrap();
        let queued = store
            .create_queued_input(
                "thread-1",
                vec![UserInput::Text {
                    text: "Use $agent-browser".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions::default(),
            )
            .await
            .unwrap();
        store
            .claim_queued_input_for_steering("thread-1", &queued.id)
            .await
            .unwrap();
        let mentions = vec![TimelineSkillMention {
            start: 4,
            end: 18,
            name: "agent-browser".to_string(),
            path: "/skills/agent-browser/SKILL.md".to_string(),
            display_name: Some("Agent Browser".to_string()),
            scope: None,
            short_description: None,
            brand_color: None,
            icon_small_url: None,
        }];
        let pending_id = store
            .insert_pending_timeline_skill_mentions("thread-1", "Use $agent-browser", &mentions)
            .await
            .unwrap();
        store
            .mark_queued_input_pending_commit(
                "thread-1",
                &queued.id,
                "turn-1",
                None,
                pending_id.as_deref(),
            )
            .await
            .unwrap();

        let requeued = store
            .requeue_pending_commit_inputs_for_turn("thread-1", "turn-1", "not committed")
            .await
            .unwrap();
        assert_eq!(requeued[0].status, QueuedInputStatus::Queued);
        let committed = store
            .commit_pending_timeline_skill_mentions("thread-1", "item-later", "Use $agent-browser")
            .await
            .unwrap();
        assert!(committed.is_none());
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
                kind: "codex.notification".to_string(),
                codex_method: Some("turn/completed".to_string()),
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

    #[tokio::test]
    async fn migration_keeps_thread_reads_independent_from_event_replay() {
        let store = Store::in_memory().await.unwrap();
        store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("turn/completed".to_string()),
                payload: json!({"threadId": "thread-1"}),
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
    async fn push_subscription_upsert_is_idempotent_by_endpoint() {
        let store = Store::in_memory().await.unwrap();
        let first = store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/sub-1".to_string(),
                p256dh: "public-1".to_string(),
                auth: "auth-1".to_string(),
                user_agent: Some("first browser".to_string()),
            })
            .await
            .unwrap();
        let second = store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/sub-1".to_string(),
                p256dh: "public-2".to_string(),
                auth: "auth-2".to_string(),
                user_agent: Some("second browser".to_string()),
            })
            .await
            .unwrap();

        assert_eq!(second.id, first.id);
        assert_eq!(second.p256dh, "public-2");
        assert_eq!(second.auth, "auth-2");
        assert_eq!(second.user_agent.as_deref(), Some("second browser"));
        assert!(second.enabled);
        let enabled = store.list_enabled_push_subscriptions().await.unwrap();
        assert_eq!(enabled.len(), 1);
    }

    #[tokio::test]
    async fn disabled_push_subscription_is_removed_from_enabled_lookup() {
        let store = Store::in_memory().await.unwrap();
        let subscription = store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/stale".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();

        let disabled = store
            .disable_push_subscription(&subscription.id)
            .await
            .unwrap()
            .unwrap();

        assert!(!disabled.enabled);
        assert!(store
            .list_enabled_push_subscriptions()
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn thread_composer_settings_round_trip_by_thread_id() {
        let store = Store::in_memory().await.unwrap();
        store
            .save_thread_composer_settings(
                "thread-1",
                &ThreadComposerSettings {
                    model: Some("gpt-5.4-mini".to_string()),
                    reasoning_effort: Some("high".to_string()),
                    service_tier: Some("fast".to_string()),
                    approval_policy: Some("on-request".to_string()),
                    approvals_reviewer: Some("auto_review".to_string()),
                    sandbox: Some(json!("workspace-write")),
                },
            )
            .await
            .unwrap();

        let thread_ids = vec!["thread-1".to_string(), "missing-thread".to_string()];
        let settings = store.thread_composer_settings(&thread_ids).await.unwrap();
        let settings = settings.get("thread-1").unwrap();

        assert_eq!(settings.model.as_deref(), Some("gpt-5.4-mini"));
        assert_eq!(settings.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(settings.service_tier.as_deref(), Some("fast"));
        assert_eq!(settings.approval_policy.as_deref(), Some("on-request"));
        assert_eq!(settings.approvals_reviewer.as_deref(), Some("auto_review"));
        assert_eq!(settings.sandbox.as_ref(), Some(&json!("workspace-write")));

        store
            .save_thread_turn_options("thread-1", &TurnStartOptions::default())
            .await
            .unwrap();
        let settings = store.thread_composer_settings(&thread_ids).await.unwrap();
        let settings = settings.get("thread-1").unwrap();

        assert!(settings.model.is_none());
        assert!(settings.reasoning_effort.is_none());
        assert!(settings.service_tier.is_none());
        assert!(settings.approval_policy.is_none());
        assert!(settings.approvals_reviewer.is_none());
        assert!(settings.sandbox.is_none());
    }

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

    #[tokio::test]
    async fn queued_inputs_round_trip_order_and_restart_recovery() {
        let store = Store::in_memory().await.unwrap();
        let first = store
            .create_queued_input(
                "thread-1",
                vec![UserInput::Text {
                    text: "normal".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions::default(),
            )
            .await
            .unwrap();
        let second = store
            .create_queued_input(
                "thread-1",
                vec![UserInput::Text {
                    text: "rejected".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions {
                    model: Some("gpt-5.4".to_string()),
                    ..TurnStartOptions::default()
                },
            )
            .await
            .unwrap();

        let rejected = store
            .mark_queued_input_rejected_steer("thread-1", &second.id, "not steerable".to_string())
            .await
            .unwrap();
        assert_eq!(rejected.priority, QueuedInputPriority::RejectedSteer);

        let listed = store.list_queued_inputs("thread-1").await.unwrap();
        assert_eq!(
            listed.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec![second.id.as_str(), first.id.as_str()]
        );
        assert_eq!(listed[0].options.model.as_deref(), Some("gpt-5.4"));

        let claimed = store
            .claim_next_queued_input("thread-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claimed.id, second.id);
        assert_eq!(claimed.status, QueuedInputStatus::Submitting);
        store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: "active".to_string(),
                active_turn_id: Some("turn-1".to_string()),
                updated_at: Utc::now(),
                last_event_seq: Some(10),
            })
            .await
            .unwrap();
        store.recover_queued_inputs_after_restart().await.unwrap();

        let recovered = store
            .get_queued_input("thread-1", &second.id)
            .await
            .unwrap();
        assert_eq!(recovered.status, QueuedInputStatus::Failed);
        assert!(recovered.last_error.unwrap().contains("Gateway restarted"));
        let runtime = store
            .get_thread_runtime_state("thread-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(runtime.status, "unknown");
        assert_eq!(runtime.active_turn_id, None);

        let draining = ThreadRuntimeState {
            thread_id: "thread-1".to_string(),
            status: "draining".to_string(),
            active_turn_id: None,
            updated_at: Utc::now(),
            last_event_seq: None,
        };
        store
            .upsert_thread_runtime_state(draining.clone())
            .await
            .unwrap();
        let preserved = store
            .upsert_thread_runtime_state_unless_draining(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: "idle".to_string(),
                active_turn_id: None,
                updated_at: Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        assert_eq!(preserved.status, "draining");

        let failed = store
            .mark_queued_input_failed("thread-1", &first.id, "start failed".to_string())
            .await
            .unwrap();
        assert_eq!(failed.status, QueuedInputStatus::Failed);
        let retried = store
            .requeue_queued_input("thread-1", &first.id)
            .await
            .unwrap();
        assert_eq!(retried.status, QueuedInputStatus::Queued);
        assert!(matches!(
            store.requeue_queued_input("thread-1", &first.id).await,
            Err(ApiError::BadRequest(_))
        ));
        let steered = store
            .claim_queued_input_for_steering("thread-1", &first.id)
            .await
            .unwrap();
        assert_eq!(steered.status, QueuedInputStatus::Steering);
        assert_eq!(steered.attempt_count, 1);
        assert!(matches!(
            store
                .claim_queued_input_for_steering("thread-1", &first.id)
                .await,
            Err(ApiError::BadRequest(_))
        ));

        let pending = store
            .create_queued_input(
                "thread-1",
                vec![UserInput::Text {
                    text: "pending".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions::default(),
            )
            .await
            .unwrap();
        store
            .claim_queued_input_for_steering("thread-1", &pending.id)
            .await
            .unwrap();
        store
            .mark_queued_input_pending_commit("thread-1", &pending.id, "turn-1", Some(42), None)
            .await
            .unwrap();
        let recovered = store.recover_queued_inputs_after_restart().await.unwrap();
        let recovered_pending = recovered
            .iter()
            .find(|row| row.id == pending.id)
            .expect("pendingCommit row should be recovered");
        assert_eq!(recovered_pending.status, QueuedInputStatus::Failed);
        assert!(recovered_pending.accepted_turn_id.is_none());
        assert!(recovered_pending.accepted_at.is_none());
        assert!(recovered_pending.accepted_event_seq.is_none());
        assert!(recovered_pending
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("Gateway restarted"));
    }

    #[tokio::test]
    async fn queued_inputs_preserve_nullable_source_labels() {
        let store = Store::in_memory().await.unwrap();
        let manual = store
            .create_queued_input(
                "thread-1",
                vec![UserInput::Text {
                    text: "manual".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions::default(),
            )
            .await
            .unwrap();
        assert!(manual.source_type.is_none());
        assert!(manual.source_id.is_none());

        let automation = store
            .create_queued_input_with_source(
                "thread-1",
                vec![UserInput::Text {
                    text: "automated".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions::default(),
                Some("automation"),
                Some("run-1"),
            )
            .await
            .unwrap();
        assert_eq!(automation.source_type.as_deref(), Some("automation"));
        assert_eq!(automation.source_id.as_deref(), Some("run-1"));
    }

    #[tokio::test]
    async fn project_preview_store_enforces_ports_and_service_references() {
        let store = Store::in_memory().await.unwrap();
        let project = store
            .create_project("Kodex".to_string(), "/workspace/kodex".to_string())
            .await
            .unwrap();
        let frontend = store
            .create_project_preview_service(NewProjectPreviewService {
                project_id: project.id.clone(),
                name: "Frontend".to_string(),
                protocol: "http".to_string(),
                local_port: 3000,
                health_path: "/".to_string(),
            })
            .await
            .unwrap();
        let backend = store
            .create_project_preview_service(NewProjectPreviewService {
                project_id: project.id.clone(),
                name: "Backend".to_string(),
                protocol: "http".to_string(),
                local_port: 4000,
                health_path: "/health".to_string(),
            })
            .await
            .unwrap();

        let allocated = store
            .allocate_project_preview_public_port(13000, 10000, 19999)
            .await
            .unwrap();
        assert_eq!(allocated, 13000);
        let preview = store
            .create_project_preview(NewProjectPreview {
                project_id: project.id.clone(),
                name: "App".to_string(),
                public_port: allocated,
                root_service_id: frontend.id.clone(),
                enabled: true,
            })
            .await
            .unwrap();

        let next_allocated = store
            .allocate_project_preview_public_port(13000, 10000, 19999)
            .await
            .unwrap();
        assert_eq!(next_allocated, 10000);
        assert!(matches!(
            store
                .create_project_preview(NewProjectPreview {
                    project_id: project.id.clone(),
                    name: "Conflict".to_string(),
                    public_port: 13000,
                    root_service_id: backend.id.clone(),
                    enabled: true,
                })
                .await,
            Err(ApiError::BadRequest(_))
        ));

        let route = store
            .create_project_preview_route(
                &project.id,
                NewProjectPreviewRoute {
                    preview_id: preview.id.clone(),
                    path_pattern: "/api/*".to_string(),
                    service_id: backend.id.clone(),
                    strip_prefix: true,
                    sort_order: 0,
                },
            )
            .await
            .unwrap();
        assert_eq!(route.path_pattern, "/api/*");

        assert!(matches!(
            store
                .delete_project_preview_service(&project.id, &frontend.id)
                .await,
            Err(ApiError::BadRequest(_))
        ));
        assert!(matches!(
            store
                .update_project_preview_service(
                    &project.id,
                    &backend.id,
                    ProjectPreviewServiceUpdate {
                        local_port: Some(4001),
                        ..ProjectPreviewServiceUpdate::default()
                    },
                )
                .await,
            Err(ApiError::BadRequest(_))
        ));
        let renamed = store
            .update_project_preview_service(
                &project.id,
                &backend.id,
                ProjectPreviewServiceUpdate {
                    name: Some("API".to_string()),
                    ..ProjectPreviewServiceUpdate::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(renamed.name, "API");

        store
            .delete_project_preview(&project.id, &preview.id)
            .await
            .unwrap();
        store
            .delete_project_preview_service(&project.id, &frontend.id)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn automation_due_claims_coalesce_and_advance_wall_clock_cadence() {
        let store = Store::in_memory().await.unwrap();
        let start_at = Utc.with_ymd_and_hms(2026, 5, 7, 9, 0, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 5, 7, 9, 2, 5).unwrap();
        let automation = store
            .create_automation(NewAutomation {
                name: "status".to_string(),
                prompt: "summarize".to_string(),
                target_thread_id: "thread-1".to_string(),
                start_at,
                repeat_every_seconds: 60,
                next_run_at: start_at,
                status: AutomationStatus::Active,
                paused_reason: None,
                provenance: None,
            })
            .await
            .unwrap();

        let runs = store.claim_due_automation_runs(now, 10).await.unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].scheduled_for, start_at);
        let advanced = store.get_automation(&automation.id).await.unwrap();
        assert_eq!(
            advanced.next_run_at,
            Utc.with_ymd_and_hms(2026, 5, 7, 9, 3, 0).unwrap()
        );

        let repeated_tick = store.claim_due_automation_runs(now, 10).await.unwrap();
        assert!(repeated_tick.is_empty());

        let queued = store
            .create_queued_input_with_source(
                "thread-1",
                vec![UserInput::Text {
                    text: "summarize".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions::default(),
                Some("automation"),
                Some(&runs[0].id),
            )
            .await
            .unwrap();
        store
            .mark_automation_run_queued(&runs[0].id, &queued.id)
            .await
            .unwrap();
        let future = Utc.with_ymd_and_hms(2026, 5, 7, 9, 4, 0).unwrap();
        assert!(store
            .claim_due_automation_runs(future, 10)
            .await
            .unwrap()
            .is_empty());

        store
            .delete_queued_input_for_gateway("thread-1", &queued.id)
            .await
            .unwrap();
        let after_delete = store
            .claim_due_automation_runs(future + chrono::Duration::minutes(1), 10)
            .await
            .unwrap();
        assert_eq!(after_delete.len(), 1);
    }

    #[tokio::test]
    async fn automation_failures_auto_pause_after_threshold() {
        let store = Store::in_memory().await.unwrap();
        let start_at = Utc.with_ymd_and_hms(2026, 5, 7, 9, 0, 0).unwrap();
        let automation = store
            .create_automation(NewAutomation {
                name: "status".to_string(),
                prompt: "summarize".to_string(),
                target_thread_id: "thread-1".to_string(),
                start_at,
                repeat_every_seconds: 30,
                next_run_at: start_at,
                status: AutomationStatus::Active,
                paused_reason: None,
                provenance: None,
            })
            .await
            .unwrap();

        for index in 0..5 {
            let now = start_at + chrono::Duration::seconds(30 * index);
            let run = store.claim_due_automation_runs(now, 10).await.unwrap();
            assert_eq!(run.len(), 1);
            store
                .mark_automation_run_failed(&run[0].id, "thread missing".to_string(), 5)
                .await
                .unwrap();
        }

        let paused = store.get_automation(&automation.id).await.unwrap();
        assert_eq!(paused.status, AutomationStatus::Paused);
        assert_eq!(paused.paused_reason.as_deref(), Some("tooManyFailures"));
        assert_eq!(paused.consecutive_failure_count, 5);
        assert!(store
            .claim_due_automation_runs(start_at + chrono::Duration::minutes(5), 10)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn pending_automation_run_recovery_marks_failed_or_links_existing_queue_row() {
        let store = Store::in_memory().await.unwrap();
        let start_at = Utc.with_ymd_and_hms(2026, 5, 7, 9, 0, 0).unwrap();
        let failed_automation = store
            .create_automation(NewAutomation {
                name: "missing queue".to_string(),
                prompt: "summarize".to_string(),
                target_thread_id: "thread-1".to_string(),
                start_at,
                repeat_every_seconds: 30,
                next_run_at: start_at,
                status: AutomationStatus::Active,
                paused_reason: None,
                provenance: None,
            })
            .await
            .unwrap();
        let failed_run = store.claim_due_automation_runs(start_at, 10).await.unwrap();
        assert_eq!(failed_run.len(), 1);

        let queued_automation = store
            .create_automation(NewAutomation {
                name: "existing queue".to_string(),
                prompt: "summarize".to_string(),
                target_thread_id: "thread-2".to_string(),
                start_at,
                repeat_every_seconds: 30,
                next_run_at: start_at,
                status: AutomationStatus::Active,
                paused_reason: None,
                provenance: None,
            })
            .await
            .unwrap();
        let queued_run = store.claim_due_automation_runs(start_at, 10).await.unwrap();
        assert_eq!(queued_run.len(), 1);
        let queued_input = store
            .create_queued_input_with_source(
                "thread-2",
                vec![UserInput::Text {
                    text: "summarize".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions::default(),
                Some("automation"),
                Some(&queued_run[0].id),
            )
            .await
            .unwrap();
        store
            .claim_next_queued_input("thread-2")
            .await
            .unwrap()
            .unwrap();
        let recovered_queue_rows = store.recover_queued_inputs_after_restart().await.unwrap();
        assert!(recovered_queue_rows
            .iter()
            .any(|row| row.id == queued_input.id && row.status == QueuedInputStatus::Failed));
        store
            .delete_queued_input_for_gateway("thread-2", &queued_input.id)
            .await
            .unwrap();

        let recovered = store
            .recover_pending_automation_runs_after_restart("automation", 5)
            .await
            .unwrap();
        assert_eq!(recovered.len(), 2);

        let failed = store.get_automation(&failed_automation.id).await.unwrap();
        assert_eq!(failed.consecutive_failure_count, 1);
        assert!(failed
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("Gateway restarted"));

        let queued = store.get_automation(&queued_automation.id).await.unwrap();
        assert_eq!(
            queued.last_queued_input_id.as_deref(),
            Some(queued_input.id.as_str())
        );
        assert_eq!(queued.consecutive_failure_count, 0);
        let recovered_run = store.get_automation_run(&queued_run[0].id).await.unwrap();
        assert_eq!(recovered_run.status, "queued");
    }

    #[tokio::test]
    async fn approval_resolve_is_single_use() {
        let store = Store::in_memory().await.unwrap();
        let approval = store
            .insert_approval(NewApproval {
                request_id: "1".to_string(),
                thread_id: None,
                turn_id: None,
                item_id: None,
                method: "item/permissions/requestApproval".to_string(),
                payload: json!({"kind": "test"}),
            })
            .await
            .unwrap();

        let resolved = store
            .resolve_approval(&approval.id, json!({"decision": "approved"}))
            .await
            .unwrap();
        assert_eq!(resolved.status, "resolved");

        let duplicate = store
            .resolve_approval(&approval.id, json!({"decision": "approved"}))
            .await;
        assert!(matches!(duplicate, Err(ApiError::BadRequest(_))));

        let unknown = store
            .resolve_approval("missing", json!({"decision": "approved"}))
            .await;
        assert!(matches!(unknown, Err(ApiError::NotFound(_))));
    }
}
