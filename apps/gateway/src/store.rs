use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Connection, Pool, Row, Sqlite,
};
use utoipa::ToSchema;

use crate::error::{ApiError, ApiResult};

mod app_surfaces;
mod approvals;
mod automations;
mod events;
mod migrations;
mod notifications;
mod queue_transfers;
mod threads;

pub use queue_transfers::{QueueTransfer, QueueTransferPhase};

pub(crate) const EVENT_REPLAY_LIMIT: i64 = 500;

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum AppSurfaceProvider {
    Mcp,
    Generated,
}

impl AppSurfaceProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mcp => "mcp",
            Self::Generated => "generated",
        }
    }

    fn from_str(value: &str) -> ApiResult<Self> {
        match value {
            "mcp" => Ok(Self::Mcp),
            "generated" => Ok(Self::Generated),
            _ => Err(ApiError::Other(anyhow::anyhow!(
                "unknown app surface provider {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum AppSurfaceSessionStatus {
    Active,
    Archived,
}

impl AppSurfaceSessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
        }
    }

    fn from_str(value: &str) -> ApiResult<Self> {
        match value {
            "active" => Ok(Self::Active),
            "archived" => Ok(Self::Archived),
            _ => Err(ApiError::Other(anyhow::anyhow!(
                "unknown app surface session status {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceCsp {
    #[serde(default, alias = "connect_domains")]
    pub connect_domains: Vec<String>,
    #[serde(default, alias = "resource_domains")]
    pub resource_domains: Vec<String>,
    #[serde(default, alias = "frame_domains")]
    pub frame_domains: Vec<String>,
    #[serde(default, alias = "base_uri_domains")]
    pub base_uri_domains: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfacePermissions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geolocation: Option<Value>,
    #[serde(
        default,
        alias = "clipboard_write",
        skip_serializing_if = "Option::is_none"
    )]
    pub clipboard_write: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceToolGrant {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub server: String,
    pub tool: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceResourceGrant {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    pub uri: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceGrants {
    #[serde(default)]
    pub tools: Vec<AppSurfaceToolGrant>,
    #[serde(default)]
    pub resources: Vec<AppSurfaceResourceGrant>,
    #[serde(default, alias = "can_send_message")]
    pub can_send_message: bool,
    #[serde(default, alias = "can_update_model_context")]
    pub can_update_model_context: bool,
    #[serde(default, alias = "can_open_links")]
    pub can_open_links: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceSession {
    pub id: String,
    pub thread_id: String,
    pub bridge_token: String,
    pub provider: AppSurfaceProvider,
    pub title: String,
    pub resource_uri: String,
    pub resource_mime_type: String,
    pub html: String,
    pub fallback_content: String,
    pub revision: i64,
    pub status: AppSurfaceSessionStatus,
    pub display_modes: Vec<String>,
    pub csp: AppSurfaceCsp,
    pub permissions: AppSurfacePermissions,
    pub grants: AppSurfaceGrants,
    pub provenance: Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
pub struct AppSurfaceSessionUpsert {
    pub thread_id: String,
    pub provider: AppSurfaceProvider,
    pub title: String,
    pub resource_uri: Option<String>,
    pub resource_mime_type: String,
    pub html: String,
    pub fallback_content: String,
    pub display_modes: Vec<String>,
    pub csp: AppSurfaceCsp,
    pub permissions: AppSurfacePermissions,
    pub grants: AppSurfaceGrants,
    pub provenance: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub source: ApprovalSource,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalSource {
    Native,
    GeneratedApp,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRead {
    pub thread_id: String,
    #[schema(required = true)]
    pub latest_completed_turn_id: Option<String>,
    #[schema(required = true)]
    pub seen_completed_turn_id: Option<String>,
    pub read_revision: i64,
    pub read_state_known: bool,
    pub unread_completed_agent_turn: bool,
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

pub type ThreadReadState = ThreadRead;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadNotificationSetting {
    pub thread_id: String,
    pub notifications_enabled: bool,
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
    pub last_native_queue_id: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum AutomationRunPhase {
    Admitting,
    Queued,
    StartRequested,
    Dispatched,
    Rejected,
    Uncertain,
    Removed,
}

impl AutomationRunPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admitting => "admitting",
            Self::Queued => "queued",
            Self::StartRequested => "startRequested",
            Self::Dispatched => "dispatched",
            Self::Rejected => "rejected",
            Self::Uncertain => "uncertain",
            Self::Removed => "removed",
        }
    }

    fn from_persisted(value: &str) -> ApiResult<Self> {
        match value {
            "admitting" => Ok(Self::Admitting),
            "queued" => Ok(Self::Queued),
            "startRequested" => Ok(Self::StartRequested),
            "dispatched" => Ok(Self::Dispatched),
            "rejected" => Ok(Self::Rejected),
            "uncertain" => Ok(Self::Uncertain),
            "removed" => Ok(Self::Removed),
            _ => Err(ApiError::BadGateway("invalid automation run phase".into())),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub target_thread_id: String,
    pub scheduled_for: Option<DateTime<Utc>>,
    pub phase: AutomationRunPhase,
    pub native_queue_id: Option<String>,
    pub turn_id: Option<String>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
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

        let pool = pool_options(5)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true),
            )
            .await?;
        let store = Self { pool };
        store.migrate().await?;
        store.assert_wal().await?;
        Ok(store)
    }

    pub async fn in_memory() -> ApiResult<Self> {
        let pool = pool_options(1).connect("sqlite::memory:").await?;
        let store = Self { pool };
        store.migrate().await?;
        Ok(store)
    }

    pub fn pool(&self) -> &Pool<Sqlite> {
        &self.pool
    }
}

fn pool_options(max_connections: u32) -> SqlitePoolOptions {
    SqlitePoolOptions::new()
        .max_connections(max_connections)
        .after_release(|connection, _| {
            Box::pin(async move {
                // SQLx 0.8 custom BEGIN has a cancellation window after the
                // worker acknowledges BEGIN, before a Transaction guard exists.
                // Flush ordinary guard-drop rollbacks before checking depth;
                // discard only connections whose transaction remains open.
                connection.ping().await?;
                Ok(!connection.is_in_transaction())
            })
        })
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
        last_native_queue_id: row.try_get("last_native_queue_id")?,
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
        target_thread_id: row.try_get("target_thread_id")?,
        scheduled_for: row.try_get("scheduled_for")?,
        phase: AutomationRunPhase::from_persisted(&row.try_get::<String, _>("phase")?)?,
        native_queue_id: row.try_get("native_queue_id")?,
        turn_id: row.try_get("turn_id")?,
        error: row.try_get("error")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
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
    let latest_completed_turn_id: Option<String> = row.try_get("latest_completed_turn_id")?;
    let seen_completed_turn_id: Option<String> = row.try_get("seen_completed_turn_id")?;
    let read_state_known: bool = row.try_get("read_state_known")?;
    let unread_completed_agent_turn = read_state_known
        && latest_completed_turn_id.is_some()
        && latest_completed_turn_id != seen_completed_turn_id;
    Ok(ThreadRead {
        thread_id: row.try_get("thread_id")?,
        latest_completed_turn_id,
        seen_completed_turn_id,
        read_revision: row.try_get("read_revision")?,
        read_state_known,
        unread_completed_agent_turn,
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
        source: ApprovalSource::GeneratedApp,
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
mod path_tests {
    use super::*;
    #[tokio::test]
    async fn database_path_is_a_literal_filename_not_a_sqlite_url() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gateway?mode=ro#native.db");
        let store = Store::connect(&path).await.unwrap();
        assert!(path.is_file());
        sqlx::query("CREATE TABLE filename_fixture (value TEXT)")
            .execute(store.pool())
            .await
            .unwrap();
        store.pool().close().await;
        let reopened = Store::connect(&path).await.unwrap();
        let table: String =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE name='filename_fixture'")
                .fetch_one(reopened.pool())
                .await
                .unwrap();
        assert_eq!(table, "filename_fixture");
    }
}
