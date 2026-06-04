use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{sqlite::SqlitePoolOptions, Pool, Row, Sqlite};
use utoipa::ToSchema;

use crate::{
    app_server_api::{TimelineFileAttachment, TurnStartOptions, UserInput},
    error::{ApiError, ApiResult},
};

mod approvals;
mod automations;
mod events;
mod generated_ui;
mod migrations;
mod notifications;
mod projects;
mod queued_inputs;
mod runtime;
mod threads;

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum GeneratedUiSessionStatus {
    Interactive,
    Submitting,
    Submitted,
    Archived,
}

impl GeneratedUiSessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Interactive => "interactive",
            Self::Submitting => "submitting",
            Self::Submitted => "submitted",
            Self::Archived => "archived",
        }
    }

    fn from_str(value: &str) -> ApiResult<Self> {
        match value {
            "interactive" => Ok(Self::Interactive),
            "submitting" => Ok(Self::Submitting),
            "submitted" => Ok(Self::Submitted),
            "archived" => Ok(Self::Archived),
            _ => Err(ApiError::Other(anyhow::anyhow!(
                "unknown generated UI session status {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedUiSession {
    pub id: String,
    pub thread_id: String,
    pub title: String,
    pub html: String,
    pub revision: i64,
    pub status: GeneratedUiSessionStatus,
    pub submitted_revision: Option<i64>,
    pub submitted_message: Option<String>,
    pub submitted_metadata: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub submitted_at: Option<DateTime<Utc>>,
    pub archived_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct GeneratedUiSessionUpsert {
    pub thread_id: String,
    pub title: String,
    pub html: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PushSubscriptionStatus {
    pub subscription: Option<PushSubscription>,
    pub subscribed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum NotificationDeliveryStatus {
    Pending,
    Processing,
    Sent,
    Failed,
}

impl NotificationDeliveryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Processing => "processing",
            Self::Sent => "sent",
            Self::Failed => "failed",
        }
    }

    fn from_str(value: &str) -> ApiResult<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "processing" => Ok(Self::Processing),
            "sent" => Ok(Self::Sent),
            "failed" => Ok(Self::Failed),
            _ => Err(ApiError::Other(anyhow::anyhow!(
                "unknown notification delivery status {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationDelivery {
    pub id: String,
    pub kind: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub payload: Option<Value>,
    pub delivered_subscription_ids: Vec<String>,
    pub status: NotificationDeliveryStatus,
    pub attempt_count: i64,
    pub available_at: DateTime<Utc>,
    pub processing_started_at: Option<DateTime<Utc>>,
    pub sent_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct NewNotificationDelivery {
    pub kind: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub payload: Option<Value>,
    pub available_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default)]
pub struct ThreadReadState {
    pub seen_completed_agent_turn_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadNotificationSetting {
    pub thread_id: String,
    pub notifications_enabled: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default)]
pub struct ThreadLocalSettingsOverlay {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub approval_policy: Option<String>,
    pub approvals_reviewer: Option<String>,
    pub permissions: Option<String>,
    pub sandbox: Option<Value>,
}

impl ThreadLocalSettingsOverlay {
    pub fn has_any_setting(&self) -> bool {
        self.model.is_some()
            || self.reasoning_effort.is_some()
            || self.service_tier.is_some()
            || self.approval_policy.is_some()
            || self.approvals_reviewer.is_some()
            || self.permissions.is_some()
            || self.sandbox.is_some()
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<TimelineFileAttachment>,
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
    pub status: ThreadRuntimeStatus,
    pub active_turn_id: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub last_event_seq: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadRuntimeStatus {
    Starting,
    Draining,
    Syncing,
    Active,
    Streaming,
    Idle,
    Unknown,
}

impl ThreadRuntimeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Draining => "draining",
            Self::Syncing => "syncing",
            Self::Active => "active",
            Self::Streaming => "streaming",
            Self::Idle => "idle",
            Self::Unknown => "unknown",
        }
    }

    fn from_persisted(value: &str) -> Self {
        match value {
            "starting" => Self::Starting,
            "draining" => Self::Draining,
            "syncing" => Self::Syncing,
            "active" => Self::Active,
            "streaming" => Self::Streaming,
            "idle" => Self::Idle,
            "unknown" => Self::Unknown,
            _ => Self::Unknown,
        }
    }
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

fn row_to_generated_ui_session(row: sqlx::sqlite::SqliteRow) -> ApiResult<GeneratedUiSession> {
    let submitted_metadata_json: Option<String> = row.try_get("submitted_metadata_json")?;
    Ok(GeneratedUiSession {
        id: row.try_get("id")?,
        thread_id: row.try_get("thread_id")?,
        title: row.try_get("title")?,
        html: row.try_get("html")?,
        revision: row.try_get("revision")?,
        status: GeneratedUiSessionStatus::from_str(&row.try_get::<String, _>("status")?)?,
        submitted_revision: row.try_get("submitted_revision")?,
        submitted_message: row.try_get("submitted_message")?,
        submitted_metadata: submitted_metadata_json
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        submitted_at: row.try_get("submitted_at")?,
        archived_at: row.try_get("archived_at")?,
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
    let attachments_json: String = row
        .try_get::<Option<String>, _>("attachments_json")?
        .unwrap_or_else(|| "[]".to_string());
    let options_json: String = row.try_get("options_json")?;
    let status: String = row.try_get("status")?;
    let priority: String = row.try_get("priority")?;
    let accepted_at: Option<String> = row.try_get("accepted_at")?;
    Ok(QueuedInput {
        id: row.try_get("id")?,
        thread_id: row.try_get("thread_id")?,
        input: serde_json::from_str(&input_json)?,
        attachments: serde_json::from_str(&attachments_json)?,
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

fn row_to_thread_read(row: sqlx::sqlite::SqliteRow) -> ApiResult<ThreadRead> {
    Ok(ThreadRead {
        thread_id: row.try_get("thread_id")?,
        seen_completed_agent_turn_seq: row.try_get("seen_completed_agent_turn_seq")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_thread_notification_setting(
    row: sqlx::sqlite::SqliteRow,
) -> ApiResult<ThreadNotificationSetting> {
    Ok(ThreadNotificationSetting {
        thread_id: row.try_get("thread_id")?,
        notifications_enabled: row.try_get::<i64, _>("notifications_enabled")? != 0,
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

fn notification_delivery_select_sql(suffix: &str) -> String {
    format!(
        r#"
        select id, kind, thread_id, turn_id, payload_json, delivered_subscription_ids_json,
               status, attempt_count,
               available_at, processing_started_at, sent_at, last_error, created_at, updated_at
        from notification_deliveries
        {suffix}
        "#
    )
}

fn row_to_notification_delivery(row: sqlx::sqlite::SqliteRow) -> ApiResult<NotificationDelivery> {
    let payload_json: Option<String> = row.try_get("payload_json")?;
    let delivered_subscription_ids_json: String = row.try_get("delivered_subscription_ids_json")?;
    let status: String = row.try_get("status")?;
    Ok(NotificationDelivery {
        id: row.try_get("id")?,
        kind: row.try_get("kind")?,
        thread_id: row.try_get("thread_id")?,
        turn_id: row.try_get("turn_id")?,
        payload: payload_json
            .map(|json| serde_json::from_str(&json))
            .transpose()?,
        delivered_subscription_ids: serde_json::from_str(&delivered_subscription_ids_json)?,
        status: NotificationDeliveryStatus::from_str(&status)?,
        attempt_count: row.try_get("attempt_count")?,
        available_at: row.try_get("available_at")?,
        processing_started_at: row.try_get("processing_started_at")?,
        sent_at: row.try_get("sent_at")?,
        last_error: row.try_get("last_error")?,
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

fn payload_has_terminal_turn_status(payload: &Value) -> bool {
    payload
        .get("turn")
        .and_then(|turn| turn.get("status"))
        .and_then(|status| status.get("type"))
        .and_then(Value::as_str)
        .is_some_and(|status| {
            matches!(
                status.to_ascii_lowercase().as_str(),
                "completed" | "failed" | "cancelled" | "canceled" | "interrupted"
            )
        })
}
