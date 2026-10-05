use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use crate::error::{ApiError, ApiResult};

mod client;
mod config;
mod items;
mod mcp_apps;
#[cfg(test)]
mod mcp_apps_tests;
mod mcp_config;
mod pins;
mod projects;
mod queue;
#[cfg(test)]
mod queue_tests;
mod subagents;

mod timeline;
pub use client::{client, CodexClient};
pub(crate) use client::{
    is_thread_not_loaded_error, is_thread_not_materialized_before_first_user_message,
    is_thread_read_missing_error,
};
pub use config::*;
pub use items::{ThreadItemEntry, ThreadItemsListPage};
pub(crate) use mcp_apps::mcp_result_text;
pub use mcp_apps::{McpResourceReadRequest, McpResourceReadTarget, McpServerConnectionStatus};
pub use mcp_config::*;
pub use pins::PINNED_THREAD_SECTION_ID;
pub use projects::{Project, ProjectPage, ProjectRoot};
pub use queue::{NativeQueuePage, NativeQueuedSubmission};
pub use subagents::{ThreadSubagentListResponse, ThreadSubagentSummary};
#[cfg(test)]
pub(crate) use timeline::TIMELINE_PREVIEW_STRING_LIMIT;
pub(crate) use timeline::{
    canonical_timeline_item_id, compact_timeline_item_payload, thread_live_state_from_turn_status,
    thread_timeline_rows_from_items,
};
pub use timeline::{
    PendingTimelineRequestSummary, ThreadTimelineFileChangeEntry, ThreadTimelineRow,
    ThreadTimelineSnapshot, ThreadTimelineSnapshotItem, ThreadTimelineSnapshotTurn,
    ThreadTimelineWindowPage, ThreadTimelineWorkDetailRow, ThreadTimelineWorkSummary,
    TimelineDisplayItemPayload,
};

#[derive(Debug, Default, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub service_tier: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_policy: Option<Value>,
}

impl TurnStartOptions {
    pub fn validate(&self) -> ApiResult<()> {
        if self.permissions.is_some()
            && self
                .sandbox_policy
                .as_ref()
                .is_some_and(|sandbox_policy| !sandbox_policy.is_null())
        {
            return Err(ApiError::BadRequest(
                "permissions and sandboxPolicy cannot be combined".to_string(),
            ));
        }
        Ok(())
    }

    fn apply_to_payload(self, payload: &mut Value) {
        if let Some(model) = self.model {
            payload["model"] = Value::String(model);
        }
        if let Some(effort) = self.effort {
            payload["effort"] = Value::String(effort);
        }
        if let Some(service_tier) = self.service_tier {
            payload["serviceTier"] = option_string_value(service_tier);
        }
        if let Some(approval_policy) = self.approval_policy {
            payload["approvalPolicy"] = Value::String(approval_policy);
        }
        if let Some(approvals_reviewer) = self.approvals_reviewer {
            payload["approvalsReviewer"] = Value::String(approvals_reviewer);
        }
        if let Some(permissions) = self.permissions {
            payload["permissions"] = Value::String(permissions);
        }
        if let Some(sandbox_policy) = self.sandbox_policy {
            payload["sandboxPolicy"] = sandbox_policy;
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSettingsUpdateRequest {
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub model: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub effort: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub service_tier: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub approval_policy: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub approvals_reviewer: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub permissions: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_value_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub sandbox_policy: Option<Value>,
}

impl ThreadSettingsUpdateRequest {
    pub fn validate(&self) -> ApiResult<()> {
        let selects_permissions = self
            .permissions
            .as_ref()
            .is_some_and(|permissions| permissions.is_some());
        let selects_sandbox = self
            .sandbox_policy
            .as_ref()
            .is_some_and(|sandbox_policy| !sandbox_policy.is_null());
        if selects_permissions && selects_sandbox {
            return Err(ApiError::BadRequest(
                "permissions and sandboxPolicy cannot be combined".to_string(),
            ));
        }
        Ok(())
    }

    fn into_app_server_payload(self, thread_id: String) -> Value {
        let mut payload = json!({ "threadId": thread_id });
        if let Some(model) = self.model {
            payload["model"] = option_string_value(model);
        }
        if let Some(effort) = self.effort {
            payload["effort"] = option_string_value(effort);
        }
        if let Some(service_tier) = self.service_tier {
            payload["serviceTier"] = option_string_value(service_tier);
        }
        if let Some(approval_policy) = self.approval_policy {
            payload["approvalPolicy"] = option_string_value(approval_policy);
        }
        if let Some(approvals_reviewer) = self.approvals_reviewer {
            payload["approvalsReviewer"] = option_string_value(approvals_reviewer);
        }
        if let Some(permissions) = self.permissions {
            payload["permissions"] = option_string_value(permissions);
        }
        if let Some(sandbox_policy) = self.sandbox_policy {
            payload["sandboxPolicy"] = sandbox_policy;
        }
        payload
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RawAppServerResponse {
    pub payload: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpServerStatusDetail {
    Full,
    ToolsAndAuthOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerListResponse {
    pub servers: Vec<McpServerStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpServerStatusPage {
    data: Vec<McpServerStatus>,
    next_cursor: Option<String>,
}

impl McpServerStatusPage {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("mcpServerStatus/list response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    pub auth_status: McpAuthStatus,
    pub tools: BTreeMap<String, McpTool>,
    pub resources: Vec<McpResource>,
    pub resource_templates: Vec<McpResourceTemplate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_status: Option<McpServerConnectionStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_capabilities: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_info: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpAuthStatus {
    Unknown,
    Unsupported,
    NotLoggedIn,
    BearerToken,
    #[serde(rename = "oAuth")]
    OAuth,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub input_schema: Value,
    #[serde(default)]
    pub output_schema: Option<Value>,
    #[serde(default)]
    pub annotations: Option<Value>,
    #[serde(default)]
    pub icons: Option<Value>,
    #[serde(default, rename = "_meta")]
    pub meta: Option<Value>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpResource {
    pub name: String,
    pub uri: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub size: Option<i64>,
    #[serde(default)]
    pub annotations: Option<Value>,
    #[serde(default)]
    pub icons: Option<Value>,
    #[serde(default, rename = "_meta")]
    pub meta: Option<Value>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceTemplate {
    pub name: String,
    pub uri_template: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub annotations: Option<Value>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceReadResponse {
    pub contents: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_call_id: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl McpResourceReadResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("mcpServer/resource/read response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerToolCallRequest {
    pub server: String,
    pub thread_id: String,
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Value>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerToolCallResponse {
    pub content: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(default, rename = "_meta", skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl McpServerToolCallResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("mcpServer/tool/call response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthLoginRequest {
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    #[serde(default)]
    pub timeout_secs: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthLoginResponse {
    pub authorization_url: String,
}

impl McpOAuthLoginResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("mcpServer/oauth/login response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivePermissionProfile {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProfileSummary {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProfileListResponse {
    pub profiles: Vec<PermissionProfileSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProfileListPage {
    pub data: Vec<PermissionProfileSummary>,
    pub next_cursor: Option<String>,
}

impl PermissionProfileListPage {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let data = payload
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("permissionProfile/list response missing data array"))?
            .iter()
            .map(permission_profile_summary_from_payload)
            .collect::<ApiResult<Vec<_>>>()?;
        Ok(Self {
            data,
            next_cursor: optional_string(&payload, "nextCursor"),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListResponse {
    pub data: Vec<SkillsListEntry>,
}

impl SkillsListResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("skills/list response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListEntry {
    pub cwd: String,
    pub skills: Vec<SkillMetadata>,
    pub errors: Vec<SkillErrorInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillMetadata {
    pub name: String,
    pub path: String,
    pub description: String,
    pub enabled: bool,
    #[serde(default = "default_skill_scope")]
    pub scope: String,
    #[serde(default)]
    pub short_description: Option<String>,
    #[serde(default)]
    pub interface: Option<SkillInterface>,
}

fn default_skill_scope() -> String {
    "user".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillInterface {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub short_description: Option<String>,
    #[serde(default)]
    pub brand_color: Option<String>,
    #[serde(default)]
    pub default_prompt: Option<String>,
    #[serde(default)]
    pub icon_small: Option<String>,
    #[serde(default)]
    pub icon_large: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillErrorInfo {
    pub message: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceAddResponse {
    pub already_added: bool,
    pub installed_root: String,
    pub marketplace_name: String,
}

impl MarketplaceAddResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("marketplace/add response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginListResponse {
    #[serde(default)]
    pub featured_plugin_ids: Vec<String>,
    #[serde(default)]
    pub marketplace_load_errors: Vec<MarketplaceLoadErrorInfo>,
    pub marketplaces: Vec<PluginMarketplaceEntry>,
}

impl PluginListResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("plugin/list response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceLoadErrorInfo {
    pub marketplace_path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarketplaceEntry {
    pub name: String,
    pub path: Option<String>,
    pub plugins: Vec<PluginSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub enabled: bool,
    pub install_policy: String,
    pub auth_policy: String,
    pub source: Value,
    #[serde(default)]
    pub interface: Option<PluginInterface>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginInterface {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub short_description: Option<String>,
    #[serde(default)]
    pub long_description: Option<String>,
    #[serde(default)]
    pub developer_name: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub brand_color: Option<String>,
    #[serde(default)]
    pub default_prompt: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginReadResponse {
    pub plugin: PluginDetail,
}

impl PluginReadResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("plugin/read response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetail {
    pub summary: PluginSummary,
    pub marketplace_name: String,
    pub marketplace_path: Option<String>,
    #[serde(default)]
    pub skills: Vec<SkillMetadata>,
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    #[serde(default)]
    pub apps: Vec<AppSummary>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallResponse {
    pub apps_needing_auth: Vec<AppSummary>,
    pub auth_policy: String,
}

impl PluginInstallResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("plugin/install response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSummary {
    pub id: String,
    pub name: String,
    pub needs_auth: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub install_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsCatalogResponse {
    pub cwd: Option<String>,
    pub skills: Vec<SkillMetadata>,
    pub errors: Vec<SkillErrorInfo>,
    pub invalidation_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UserInput {
    Text {
        text: String,
        #[serde(
            default,
            rename = "text_elements",
            skip_serializing_if = "Vec::is_empty"
        )]
        text_elements: Vec<TextElement>,
    },
    Image {
        url: String,
    },
    LocalImage {
        path: String,
    },
    Skill {
        name: String,
        path: String,
    },
    Mention {
        name: String,
        path: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineFileAttachment {
    pub id: String,
    pub file_name: String,
    pub extension: String,
    pub relative_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absolute_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextElement {
    #[serde(rename = "byteRange")]
    pub byte_range: ByteRange,
    pub placeholder: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ByteRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSkillMention {
    pub start: u32,
    pub end: u32,
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brand_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_small_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListResponse {
    pub threads: Vec<ThreadSummary>,
    pub next_cursor: Option<String>,
    pub backwards_cursor: Option<String>,
    pub raw_payload: Value,
}

impl ThreadListResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let threads = payload
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("thread/list response missing data array"))?
            .iter()
            .map(ThreadSummary::from_payload)
            .collect::<ApiResult<Vec<_>>>()?;

        Ok(Self {
            threads,
            next_cursor: optional_string(&payload, "nextCursor"),
            backwards_cursor: optional_string(&payload, "backwardsCursor"),
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadLoadedListResponse {
    pub thread_ids: Vec<String>,
    pub next_cursor: Option<String>,
    pub raw_payload: Value,
}

impl ThreadLoadedListResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let thread_ids = payload
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("thread/loaded/list response missing data array"))?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| bad_gateway("thread/loaded/list data item is not a string"))
            })
            .collect::<ApiResult<Vec<_>>>()?;

        Ok(Self {
            thread_ids,
            next_cursor: optional_string(&payload, "nextCursor"),
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    #[schema(required = true)]
    pub parent_thread_id: Option<String>,
    #[schema(required = true)]
    pub can_accept_direct_input: Option<bool>,
    pub project_id: Option<String>,
    pub name: Option<String>,
    pub cwd: String,
    pub status: ThreadStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub source: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub approval_policy: Option<String>,
    pub approvals_reviewer: Option<String>,
    pub active_permission_profile: Option<ActivePermissionProfile>,
    pub agent_nickname: Option<String>,
    pub agent_role: Option<String>,
    pub sandbox: Option<Value>,
    pub git_info: Option<GitInfo>,
    pub pinned: bool,
    pub preview: Option<Value>,
    #[schema(required = true)]
    pub latest_completed_turn_id: Option<String>,
    #[schema(required = true)]
    pub seen_completed_turn_id: Option<String>,
    pub read_revision: i64,
    pub read_state_known: bool,
    pub unread_completed_agent_turn: bool,
    pub notifications_enabled: bool,
    pub raw_payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub branch: Option<String>,
    pub origin_url: Option<String>,
    pub sha: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitInfoPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_url: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha: Option<Option<String>>,
}

impl ThreadSummary {
    pub(crate) fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            id: required_string(payload, "id")?,
            parent_thread_id: optional_string(payload, "parentThreadId"),
            can_accept_direct_input: serde_json::from_value(
                payload
                    .get("canAcceptDirectInput")
                    .cloned()
                    .unwrap_or(Value::Null),
            )
            .map_err(|error| bad_gateway(format!("thread input capability: {error}")))?,
            project_id: optional_string(payload, "projectId"),
            name: optional_string(payload, "name"),
            cwd: required_string(payload, "cwd")?,
            status: required_thread_status(payload)?,
            created_at: required_i64(payload, "createdAt")?,
            updated_at: required_i64(payload, "updatedAt")?,
            source: optional_string(payload, "source"),
            model: optional_string(payload, "model"),
            reasoning_effort: optional_string(payload, "reasoningEffort"),
            service_tier: optional_string(payload, "serviceTier"),
            approval_policy: optional_string(payload, "approvalPolicy"),
            approvals_reviewer: optional_string(payload, "approvalsReviewer"),
            active_permission_profile: active_permission_profile_from_payload(payload)?,
            agent_nickname: optional_string(payload, "agentNickname"),
            agent_role: optional_string(payload, "agentRole"),
            sandbox: optional_value(payload, "sandbox"),
            git_info: optional_git_info(payload)?,
            pinned: payload
                .get("section")
                .and_then(|section| section.get("id"))
                .and_then(Value::as_str)
                == Some(PINNED_THREAD_SECTION_ID),
            preview: payload.get("preview").cloned(),
            latest_completed_turn_id: None,
            seen_completed_turn_id: None,
            read_revision: 0,
            read_state_known: false,
            unread_completed_agent_turn: false,
            notifications_enabled: true,
            raw_payload: payload.clone(),
        })
    }

    pub fn apply_read_state(&mut self, read: &crate::store::ThreadRead) {
        self.latest_completed_turn_id = read.latest_completed_turn_id.clone();
        self.seen_completed_turn_id = read.seen_completed_turn_id.clone();
        self.read_revision = read.read_revision;
        self.read_state_known = read.read_state_known;
        self.unread_completed_agent_turn = read.unread_completed_agent_turn;
    }
}

pub(crate) fn optional_git_info(payload: &Value) -> ApiResult<Option<GitInfo>> {
    let Some(value) = payload.get("gitInfo") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let object = value
        .as_object()
        .ok_or_else(|| bad_gateway("thread gitInfo field is not an object"))?;
    Ok(Some(GitInfo {
        branch: object
            .get("branch")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        origin_url: object
            .get("originUrl")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        sha: object
            .get("sha")
            .and_then(Value::as_str)
            .map(ToString::to_string),
    }))
}

pub(crate) fn optional_git_info_patch(payload: &Value) -> ApiResult<Option<GitInfoPatch>> {
    let Some(value) = payload.get("gitInfo") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let object = value
        .as_object()
        .ok_or_else(|| bad_gateway("thread gitInfo field is not an object"))?;
    Ok(Some(GitInfoPatch {
        branch: optional_patch_string(object, "branch")?,
        origin_url: optional_patch_string(object, "originUrl")?,
        sha: optional_patch_string(object, "sha")?,
    }))
}

fn optional_patch_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> ApiResult<Option<Option<String>>> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(Some(None));
    }
    let value = value
        .as_str()
        .ok_or_else(|| bad_gateway("thread gitInfo patch field is not a string"))?;
    Ok(Some(Some(value.to_string())))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThreadStatus {
    NotLoaded,
    Idle,
    SystemError,
    Active,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetailResponse {
    pub thread: ThreadSummary,
    pub turns: Vec<ThreadTurnSnapshot>,
    pub live_state: ThreadLiveState,
    pub timeline: ThreadTimelineSnapshot,
    pub history_page: Option<ThreadTimelineWindowPage>,
    pub raw_payload: Value,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadViewResponse {
    pub thread: ThreadViewThreadSummary,
    pub live_state: ThreadLiveState,
    pub timeline: ThreadTimelineSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_page: Option<ThreadTimelineWindowPage>,
}

impl ThreadViewResponse {
    pub(crate) fn from_detail(detail: ThreadDetailResponse) -> Self {
        Self {
            thread: ThreadViewThreadSummary::from(detail.thread),
            live_state: detail.live_state,
            timeline: detail.timeline,
            history_page: detail.history_page,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadViewThreadSummary {
    pub id: String,
    #[schema(required = true)]
    pub parent_thread_id: Option<String>,
    #[schema(required = true)]
    pub can_accept_direct_input: Option<bool>,
    pub project_id: Option<String>,
    pub name: Option<String>,
    pub cwd: String,
    pub status: ThreadStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub source: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub approval_policy: Option<String>,
    pub approvals_reviewer: Option<String>,
    pub active_permission_profile: Option<ActivePermissionProfile>,
    pub agent_nickname: Option<String>,
    pub agent_role: Option<String>,
    pub sandbox: Option<Value>,
    pub git_info: Option<GitInfo>,
    pub pinned: bool,
    pub preview: Option<Value>,
    #[schema(required = true)]
    pub latest_completed_turn_id: Option<String>,
    #[schema(required = true)]
    pub seen_completed_turn_id: Option<String>,
    pub read_revision: i64,
    pub read_state_known: bool,
    pub unread_completed_agent_turn: bool,
    pub notifications_enabled: bool,
}

impl From<ThreadSummary> for ThreadViewThreadSummary {
    fn from(thread: ThreadSummary) -> Self {
        Self {
            id: thread.id,
            parent_thread_id: thread.parent_thread_id,
            can_accept_direct_input: thread.can_accept_direct_input,
            project_id: thread.project_id,
            name: thread.name,
            cwd: thread.cwd,
            status: thread.status,
            created_at: thread.created_at,
            updated_at: thread.updated_at,
            source: thread.source,
            model: thread.model,
            reasoning_effort: thread.reasoning_effort,
            service_tier: thread.service_tier,
            approval_policy: thread.approval_policy,
            approvals_reviewer: thread.approvals_reviewer,
            active_permission_profile: thread.active_permission_profile,
            agent_nickname: thread.agent_nickname,
            agent_role: thread.agent_role,
            sandbox: thread.sandbox,
            git_info: thread.git_info,
            pinned: thread.pinned,
            preview: thread.preview,
            latest_completed_turn_id: thread.latest_completed_turn_id,
            seen_completed_turn_id: thread.seen_completed_turn_id,
            read_revision: thread.read_revision,
            read_state_known: thread.read_state_known,
            unread_completed_agent_turn: thread.unread_completed_agent_turn,
            notifications_enabled: thread.notifications_enabled,
        }
    }
}

impl ThreadDetailResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let thread = payload
            .get("thread")
            .ok_or_else(|| bad_gateway("thread/read response missing thread"))?;
        let turns = thread
            .get("turns")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("thread/read response thread missing turns array"))?
            .iter()
            .map(ThreadTurnSnapshot::from_payload)
            .collect::<ApiResult<Vec<_>>>()?;
        let live_state = live_state_from_thread(thread);
        let thread = ThreadSummary::from_payload(thread)?;
        let timeline = ThreadTimelineSnapshot::from_turns(&thread.id, &turns);
        Ok(Self {
            thread,
            turns,
            live_state,
            timeline,
            history_page: None,
            raw_payload: payload,
        })
    }

    fn from_thread_payload_turns_and_history(
        mut payload: Value,
        turns: Vec<ThreadTurnSnapshot>,
        history_page: Option<ThreadTimelineWindowPage>,
    ) -> ApiResult<Self> {
        let thread = payload
            .get_mut("thread")
            .ok_or_else(|| bad_gateway("thread/read response missing thread"))?;
        if let Some(thread) = thread.as_object_mut() {
            thread.insert(
                "turns".to_string(),
                Value::Array(turns.iter().map(|turn| turn.raw_payload.clone()).collect()),
            );
        } else {
            return Err(bad_gateway("thread/read response thread is not an object"));
        }

        let mut response = Self::from_payload(payload)?;
        response.history_page = history_page;

        Ok(response)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDirection {
    Asc,
    Desc,
}

impl SortDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Asc => "asc",
            Self::Desc => "desc",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadTurnItemsView {
    NotLoaded,
    Summary,
    Full,
}

impl ThreadTurnItemsView {
    fn as_str(self) -> &'static str {
        match self {
            Self::NotLoaded => "notLoaded",
            Self::Summary => "summary",
            Self::Full => "full",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ThreadTurnsListPage {
    pub data: Vec<ThreadTurnSnapshot>,
    pub next_cursor: Option<String>,
    pub backwards_cursor: Option<String>,
    pub raw_payload: Value,
}

impl ThreadTurnsListPage {
    fn empty() -> Self {
        Self {
            data: Vec::new(),
            next_cursor: None,
            backwards_cursor: None,
            raw_payload: json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
        }
    }

    fn from_payload(payload: Value) -> ApiResult<Self> {
        let data = payload
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("thread/turns/list response missing data array"))?
            .iter()
            .map(ThreadTurnSnapshot::from_payload)
            .collect::<ApiResult<Vec<_>>>()?;
        let next_cursor = payload
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        let backwards_cursor = payload
            .get("backwardsCursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        Ok(Self {
            data,
            next_cursor,
            backwards_cursor,
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTurnSnapshot {
    pub id: String,
    pub status: String,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub items: Vec<ThreadItemSnapshot>,
    pub raw_payload: Value,
}

impl ThreadTurnSnapshot {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        let items = payload
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("turn missing items array"))?
            .iter()
            .map(ThreadItemSnapshot::from_payload)
            .collect::<ApiResult<Vec<_>>>()?;
        Ok(Self {
            id: required_string(payload, "id")?,
            status: status_type(payload.get("status")).unwrap_or_else(|| "unknown".to_string()),
            started_at: optional_i64(payload, "startedAt"),
            completed_at: optional_i64(payload, "completedAt"),
            items,
            raw_payload: payload.clone(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadItemSnapshot {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    pub item_type: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skill_mentions: Vec<TimelineSkillMention>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub file_attachments: Vec<TimelineFileAttachment>,
    #[schema(ignore)]
    #[serde(default, skip_serializing)]
    pub raw_payload: Value,
}

impl ThreadItemSnapshot {
    pub(crate) fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            id: required_string(payload, "id")?,
            client_id: payload
                .get("clientId")
                .and_then(Value::as_str)
                .map(str::to_string),
            item_type: required_string(payload, "type")?,
            skill_mentions: skill_mentions_from_thread_item(payload),
            file_attachments: file_attachments_from_thread_item(payload),
            raw_payload: payload.clone(),
        })
    }
}

pub(crate) fn visible_text_from_user_input(input: &[UserInput]) -> Option<String> {
    let content = serde_json::to_value(input).ok()?;
    let content = content.as_array()?;
    visible_text_from_user_content(content)
}

pub(crate) fn visible_text_from_thread_item(item: &Value) -> Option<String> {
    if item.get("type").and_then(Value::as_str) != Some("userMessage") {
        return None;
    }
    let content = item.get("content").and_then(Value::as_array)?;
    visible_text_from_user_content(content)
}

pub(crate) fn append_file_attachment_envelope(
    mut input: Vec<UserInput>,
    attachments: &[TimelineFileAttachment],
) -> Vec<UserInput> {
    if attachments.is_empty() {
        return input;
    }

    let envelope = file_attachment_envelope(attachments);
    if let Some(UserInput::Text { text, .. }) = input
        .iter_mut()
        .rev()
        .find(|input| matches!(input, UserInput::Text { .. }))
    {
        if text.is_empty() {
            *text = envelope;
        } else {
            text.push_str("\n\n");
            text.push_str(&envelope);
        }
    } else {
        input.push(UserInput::Text {
            text: envelope,
            text_elements: Vec::new(),
        });
    }
    input
}

pub(crate) fn validate_file_attachments_for_thread(
    thread_id: &str,
    attachments: Vec<TimelineFileAttachment>,
) -> ApiResult<Vec<TimelineFileAttachment>> {
    let thread_component = safe_path_component(thread_id);
    let expected_prefix = format!(".kodex/uploads/{thread_component}/");
    attachments
        .into_iter()
        .map(|attachment| validate_file_attachment(&expected_prefix, attachment))
        .collect()
}

fn validate_file_attachment(
    expected_prefix: &str,
    mut attachment: TimelineFileAttachment,
) -> ApiResult<TimelineFileAttachment> {
    let path = attachment.relative_path.trim();
    if path != attachment.relative_path
        || path.contains('\\')
        || path.contains('\n')
        || path.contains('\r')
        || path.contains('\0')
        || path.contains("```")
        || path.starts_with('/')
        || !path.starts_with(expected_prefix)
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(ApiError::BadRequest(
            "invalid file attachment path".to_string(),
        ));
    }
    if attachment.file_name.trim().is_empty()
        || attachment.file_name.contains('/')
        || attachment.file_name.contains('\\')
        || attachment.file_name.contains('\n')
        || attachment.file_name.contains('\r')
        || attachment.file_name.contains('\0')
    {
        return Err(ApiError::BadRequest(
            "invalid file attachment name".to_string(),
        ));
    }
    attachment.absolute_path = None;
    attachment.extension = attachment
        .file_name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    Ok(attachment)
}

pub(crate) fn strip_file_attachment_envelope(text: &str) -> String {
    let trimmed = text.trim_end();
    let Some(start) = trimmed.rfind("```kodex-attachments\n") else {
        return text.to_string();
    };
    let block = &trimmed[start..];
    if !block.ends_with("\n```") {
        return text.to_string();
    }
    let body = &block["```kodex-attachments\n".len()..block.len() - "\n```".len()];
    if body
        .lines()
        .filter(|line| !line.trim().is_empty())
        .all(|line| line.starts_with("- "))
    {
        trimmed[..start].trim_end_matches('\n').to_string()
    } else {
        text.to_string()
    }
}

fn safe_path_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('.')
        .to_string();
    if sanitized.is_empty() {
        "file".to_string()
    } else {
        sanitized
    }
}

fn file_attachment_envelope(attachments: &[TimelineFileAttachment]) -> String {
    let mut block = String::from("```kodex-attachments\n");
    for attachment in attachments {
        block.push_str("- ");
        block.push_str(&attachment.relative_path);
        block.push('\n');
    }
    block.push_str("```");
    block
}

fn skill_mentions_from_thread_item(item: &Value) -> Vec<TimelineSkillMention> {
    if item.get("type").and_then(Value::as_str) != Some("userMessage") {
        return Vec::new();
    }
    let Some(content) = item.get("content").and_then(Value::as_array) else {
        return Vec::new();
    };
    skill_mentions_from_user_content(content)
}

fn file_attachments_from_thread_item(item: &Value) -> Vec<TimelineFileAttachment> {
    let explicit: Vec<TimelineFileAttachment> = item
        .get("fileAttachments")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    if !explicit.is_empty() {
        return explicit;
    }
    if item.get("type").and_then(Value::as_str) != Some("userMessage") {
        return Vec::new();
    }
    let Some(content) = item.get("content").and_then(Value::as_array) else {
        return Vec::new();
    };
    file_attachments_from_user_content(content)
}

pub(crate) fn file_attachments_from_user_content(content: &[Value]) -> Vec<TimelineFileAttachment> {
    let parts = content
        .iter()
        .filter_map(|input| {
            if input.get("type").and_then(Value::as_str) != Some("text") {
                return None;
            }
            input
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
        })
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return Vec::new();
    }
    file_attachment_paths_from_text(&parts.join("\n"))
        .into_iter()
        .map(file_attachment_from_path)
        .collect()
}

fn file_attachment_paths_from_text(text: &str) -> Vec<String> {
    let trimmed = text.trim_end();
    let Some(start) = trimmed.rfind("```kodex-attachments\n") else {
        return Vec::new();
    };
    let block = &trimmed[start..];
    if !block.ends_with("\n```") {
        return Vec::new();
    }
    let body = &block["```kodex-attachments\n".len()..block.len() - "\n```".len()];
    let lines = body
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    if lines.is_empty() || !lines.iter().all(|line| line.starts_with("- ")) {
        return Vec::new();
    }
    lines
        .into_iter()
        .map(|line| line.trim_start_matches("- ").trim().to_string())
        .filter(|path| !path.is_empty())
        .collect()
}

fn file_attachment_from_path(path: String) -> TimelineFileAttachment {
    let file_name = path
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("file")
        .to_string();
    let extension = file_name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    TimelineFileAttachment {
        id: path.clone(),
        file_name,
        extension,
        relative_path: path,
        absolute_path: None,
        mime_type: None,
        size_bytes: 0,
    }
}

fn visible_text_from_user_content(content: &[Value]) -> Option<String> {
    let parts = content
        .iter()
        .filter_map(|input| {
            if input.get("type").and_then(Value::as_str) != Some("text") {
                return None;
            }
            input
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
        })
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        let text = parts.join("\n");
        let text = strip_file_attachment_envelope(&text);
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

fn skill_mentions_from_user_content(content: &[Value]) -> Vec<TimelineSkillMention> {
    let skills = skills_by_unambiguous_name(content);
    if skills.is_empty() {
        return Vec::new();
    }

    let mut mentions = Vec::new();
    let mut display_offset = 0u32;
    let mut first_visible_text = true;
    for input in content {
        if input.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(text) = input.get("text").and_then(Value::as_str) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        if first_visible_text {
            first_visible_text = false;
        } else {
            display_offset = display_offset.saturating_add(1);
        }
        let Some(elements) = input.get("text_elements").and_then(Value::as_array) else {
            display_offset = display_offset.saturating_add(text.encode_utf16().count() as u32);
            continue;
        };
        for element in elements {
            if let Some(mention) =
                skill_mention_from_text_element(text, display_offset, element, &skills)
            {
                mentions.push(mention);
            }
        }
        display_offset = display_offset.saturating_add(text.encode_utf16().count() as u32);
    }
    mentions
}

fn skills_by_unambiguous_name(content: &[Value]) -> HashMap<String, String> {
    let mut paths_by_name: HashMap<String, Option<String>> = HashMap::new();
    for input in content {
        if input.get("type").and_then(Value::as_str) != Some("skill") {
            continue;
        }
        let (Some(name), Some(path)) = (
            input.get("name").and_then(Value::as_str),
            input.get("path").and_then(Value::as_str),
        ) else {
            continue;
        };
        paths_by_name
            .entry(name.to_string())
            .and_modify(|existing| {
                if existing.as_deref() != Some(path) {
                    *existing = None;
                }
            })
            .or_insert_with(|| Some(path.to_string()));
    }
    paths_by_name
        .into_iter()
        .filter_map(|(name, path)| path.map(|path| (name, path)))
        .collect()
}

fn skill_mention_from_text_element(
    text: &str,
    display_offset: u32,
    element: &Value,
    skills_by_name: &HashMap<String, String>,
) -> Option<TimelineSkillMention> {
    let range = element.get("byteRange")?;
    let start_byte = range.get("start")?.as_u64()? as usize;
    let end_byte = range.get("end")?.as_u64()? as usize;
    if start_byte >= end_byte
        || end_byte > text.len()
        || !text.is_char_boundary(start_byte)
        || !text.is_char_boundary(end_byte)
    {
        return None;
    }
    let token = &text[start_byte..end_byte];
    let name = token.strip_prefix('$')?;
    let path = skills_by_name.get(name)?;
    let start = text[..start_byte].encode_utf16().count() as u32;
    let end = start + token.encode_utf16().count() as u32;
    Some(TimelineSkillMention {
        start: display_offset + start,
        end: display_offset + end,
        name: name.to_string(),
        path: path.clone(),
        display_name: None,
        scope: None,
        short_description: None,
        brand_color: None,
        icon_small_url: None,
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum TimelineUpdateSource {
    GatewayStream,
    AppServerSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTurnUpsertPayload {
    pub source: TimelineUpdateSource,
    pub turn: ThreadTurnSnapshot,
    pub live_state: ThreadLiveState,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItemUpsertPayload {
    pub source: TimelineUpdateSource,
    pub turn_id: String,
    pub item_id: String,
    pub item: TimelineDisplayItemPayload,
    pub item_snapshot: ThreadItemSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItemDeltaPayload {
    pub source: TimelineUpdateSource,
    pub delta: String,
    pub raw_payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimelineThreadStatusPayload {
    pub source: TimelineUpdateSource,
    pub status: ThreadStatus,
    pub live_state: ThreadLiveState,
    pub raw_payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimelineThreadMetadataPayload {
    pub source: TimelineUpdateSource,
    pub thread_id: String,
    pub thread: Option<ThreadSummary>,
    pub git_info: Option<GitInfoPatch>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThreadLiveState {
    Idle,
    Streaming,
    Syncing,
    NotLoaded,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCommandResponse {
    pub thread: ThreadSummary,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub approval_policy: Option<String>,
    pub approvals_reviewer: Option<String>,
    pub active_permission_profile: Option<ActivePermissionProfile>,
    pub sandbox: Option<Value>,
    pub raw_payload: Value,
}

impl ThreadCommandResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let thread = payload
            .get("thread")
            .ok_or_else(|| bad_gateway("thread command response missing thread"))?;
        let mut thread = ThreadSummary::from_payload(thread)?;
        overlay_thread_composer_state(&mut thread, &payload);
        Ok(Self {
            thread,
            cwd: optional_string(&payload, "cwd"),
            model: optional_string(&payload, "model"),
            model_provider: optional_string(&payload, "modelProvider"),
            reasoning_effort: optional_string(&payload, "reasoningEffort"),
            service_tier: optional_string(&payload, "serviceTier"),
            approval_policy: optional_string(&payload, "approvalPolicy"),
            approvals_reviewer: optional_string(&payload, "approvalsReviewer"),
            active_permission_profile: active_permission_profile_from_payload(&payload)?,
            sandbox: optional_value(&payload, "sandbox"),
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountResponse {
    pub requires_openai_auth: bool,
    pub account: Option<AccountSummary>,
    pub raw_payload: Value,
}

impl AccountResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let requires_openai_auth = payload
            .get("requiresOpenaiAuth")
            .and_then(Value::as_bool)
            .ok_or_else(|| bad_gateway("account/read response missing requiresOpenaiAuth"))?;
        let account = payload
            .get("account")
            .filter(|account| !account.is_null())
            .map(AccountSummary::from_payload)
            .transpose()?;
        Ok(Self {
            requires_openai_auth,
            account,
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub account_type: String,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub raw_payload: Value,
}

impl AccountSummary {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            account_type: required_string(payload, "type")?,
            email: optional_string(payload, "email"),
            plan_type: optional_string(payload, "planType"),
            raw_payload: payload.clone(),
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartResponse {
    pub login_type: String,
    pub login_id: String,
    pub user_code: String,
    pub verification_url: String,
}

impl LoginStartResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let login_type = required_string(&payload, "type")?;
        if login_type != "chatgptDeviceCode" {
            return Err(bad_gateway(
                "account/login/start returned an unexpected login type",
            ));
        }
        Ok(Self {
            login_type,
            login_id: required_string(&payload, "loginId")?,
            user_code: required_string(&payload, "userCode")?,
            verification_url: required_string(&payload, "verificationUrl")?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountLoginCompleted {
    pub login_id: Option<String>,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelListResponse {
    pub models: Vec<ModelSummary>,
    pub next_cursor: Option<String>,
    pub raw_payload: Value,
}

impl ModelListResponse {
    fn from_payload(payload: Value, include_hidden: bool) -> ApiResult<Self> {
        let models = payload
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("model/list response missing data array"))?
            .iter()
            .map(ModelSummary::from_payload)
            .filter_map(|model| match model {
                Ok(model) if include_hidden || !model.hidden => Some(Ok(model)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<ApiResult<Vec<_>>>()?;

        Ok(Self {
            models,
            next_cursor: optional_string(&payload, "nextCursor"),
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub hidden: bool,
    pub is_default: bool,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<ReasoningEffortOption>,
    pub input_modalities: Vec<String>,
    pub upgrade: Option<String>,
    pub raw_payload: Value,
}

impl ModelSummary {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            id: required_string(payload, "id")?,
            model: required_string(payload, "model")?,
            display_name: required_string(payload, "displayName")?,
            description: required_string(payload, "description")?,
            hidden: required_bool(payload, "hidden")?,
            is_default: required_bool(payload, "isDefault")?,
            default_reasoning_effort: required_string(payload, "defaultReasoningEffort")?,
            supported_reasoning_efforts: payload
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .ok_or_else(|| bad_gateway("model missing supportedReasoningEfforts"))?
                .iter()
                .map(ReasoningEffortOption::from_payload)
                .collect::<ApiResult<Vec<_>>>()?,
            input_modalities: payload
                .get("inputModalities")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_else(|| vec!["text".to_string(), "image".to_string()]),
            upgrade: optional_string(payload, "upgrade"),
            raw_payload: payload.clone(),
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEffortOption {
    pub reasoning_effort: String,
    pub description: String,
}

impl ReasoningEffortOption {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            reasoning_effort: required_string(payload, "reasoningEffort")?,
            description: required_string(payload, "description")?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitsResponse {
    pub rate_limits: Option<RateLimitSnapshot>,
    pub rate_limits_by_limit_id: Option<BTreeMap<String, RateLimitSnapshot>>,
    pub raw_payload: Value,
}

impl RateLimitsResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        if payload.get("rateLimits").is_none() {
            return Err(bad_gateway(
                "account/rateLimits/read response missing rateLimits",
            ));
        }
        let rate_limits = payload
            .get("rateLimits")
            .filter(|value| !value.is_null())
            .map(RateLimitSnapshot::from_payload)
            .transpose()?;
        let rate_limits_by_limit_id = payload
            .get("rateLimitsByLimitId")
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .map(|(key, value)| Ok((key.clone(), RateLimitSnapshot::from_payload(value)?)))
                    .collect::<ApiResult<BTreeMap<_, _>>>()
            })
            .transpose()?;
        Ok(Self {
            rate_limits,
            rate_limits_by_limit_id,
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitSnapshot {
    pub limit_id: Option<String>,
    pub limit_name: Option<String>,
    pub plan_type: Option<String>,
    pub rate_limit_reached_type: Option<String>,
    pub primary: Option<RateLimitWindow>,
    pub secondary: Option<RateLimitWindow>,
    pub credits: Option<CreditsSnapshot>,
}

impl RateLimitSnapshot {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            limit_id: optional_string(payload, "limitId"),
            limit_name: optional_string(payload, "limitName"),
            plan_type: optional_string(payload, "planType"),
            rate_limit_reached_type: optional_string(payload, "rateLimitReachedType"),
            primary: payload
                .get("primary")
                .filter(|value| !value.is_null())
                .map(RateLimitWindow::from_payload)
                .transpose()?,
            secondary: payload
                .get("secondary")
                .filter(|value| !value.is_null())
                .map(RateLimitWindow::from_payload)
                .transpose()?,
            credits: payload
                .get("credits")
                .filter(|value| !value.is_null())
                .map(CreditsSnapshot::from_payload)
                .transpose()?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    pub used_percent: i64,
    pub resets_at: Option<i64>,
    pub window_duration_mins: Option<i64>,
}

impl RateLimitWindow {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            used_percent: required_i64(payload, "usedPercent")?,
            resets_at: optional_i64(payload, "resetsAt"),
            window_duration_mins: optional_i64(payload, "windowDurationMins"),
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreditsSnapshot {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<String>,
}

impl CreditsSnapshot {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            has_credits: required_bool(payload, "hasCredits")?,
            unlimited: required_bool(payload, "unlimited")?,
            balance: optional_string(payload, "balance"),
        })
    }
}

fn merge_path_payload(field: &str, value: String, payload: Value) -> Value {
    let mut payload = match payload {
        Value::Object(map) => Value::Object(map),
        other => json!({ "payload": other }),
    };
    payload[field] = Value::String(value);
    payload
}

fn require_paginated_history(mut payload: Value) -> Value {
    payload["historyMode"] = Value::String("paginated".to_string());
    payload
}

fn require_metadata_only_thread(mut payload: Value) -> Value {
    payload["excludeTurns"] = Value::Bool(true);
    payload
}

fn required_string(payload: &Value, field: &str) -> ApiResult<String> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| bad_gateway(format!("missing string field {field}")))
}

// A malformed continuation is unknown, never proof that a native page ended.
// Missing/null cursors are valid; opaque strings are forwarded unchanged.
pub(crate) fn validate_native_next_cursor(payload: &Value) -> ApiResult<()> {
    if payload
        .get("nextCursor")
        .is_some_and(|cursor| !cursor.is_null() && !cursor.is_string())
    {
        return Err(bad_gateway("native page has an invalid nextCursor"));
    }
    Ok(())
}

fn optional_string(payload: &Value, field: &str) -> Option<String> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn optional_value(payload: &Value, field: &str) -> Option<Value> {
    payload.get(field).filter(|value| !value.is_null()).cloned()
}

fn active_permission_profile_from_payload(
    payload: &Value,
) -> ApiResult<Option<ActivePermissionProfile>> {
    let Some(profile) = payload
        .get("activePermissionProfile")
        .filter(|value| !value.is_null())
    else {
        return Ok(None);
    };
    Ok(Some(ActivePermissionProfile {
        id: required_string(profile, "id")?,
        extends: optional_string(profile, "extends"),
    }))
}

fn permission_profile_summary_from_payload(payload: &Value) -> ApiResult<PermissionProfileSummary> {
    let id = required_string(payload, "id")?;
    Ok(PermissionProfileSummary {
        label: optional_string(payload, "label").unwrap_or_else(|| id.clone()),
        description: optional_string(payload, "description"),
        id,
    })
}

fn string_vec(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn option_string_value(value: Option<String>) -> Value {
    value.map(Value::String).unwrap_or(Value::Null)
}

pub(crate) fn deserialize_optional_string_update<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

fn deserialize_optional_value_update<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

fn composer_permissions_preset(payload: &Value) -> Option<ComposerPermissionsPreset> {
    let approval_policy = optional_string(payload, "approval_policy");
    let approvals_reviewer = optional_string(payload, "approvals_reviewer");
    let sandbox_mode = optional_string(payload, "sandbox_mode");

    if approval_policy.as_deref() == Some("never")
        || sandbox_mode.as_deref() == Some("danger-full-access")
    {
        return Some(ComposerPermissionsPreset::FullAccess);
    }

    if matches!(
        approvals_reviewer.as_deref(),
        Some("auto_review" | "guardian_subagent")
    ) {
        return Some(ComposerPermissionsPreset::AutoReview);
    }

    if approval_policy.is_some() || approvals_reviewer.is_some() || sandbox_mode.is_some() {
        return Some(ComposerPermissionsPreset::Default);
    }

    None
}

fn overlay_thread_composer_state(thread: &mut ThreadSummary, payload: &Value) {
    if let Some(model) = optional_string(payload, "model") {
        thread.model = Some(model);
    }
    if let Some(reasoning_effort) = optional_string(payload, "reasoningEffort") {
        thread.reasoning_effort = Some(reasoning_effort);
    }
    if let Some(service_tier) = optional_string(payload, "serviceTier") {
        thread.service_tier = Some(service_tier);
    }
    if let Some(approval_policy) = optional_string(payload, "approvalPolicy") {
        thread.approval_policy = Some(approval_policy);
    }
    if let Some(approvals_reviewer) = optional_string(payload, "approvalsReviewer") {
        thread.approvals_reviewer = Some(approvals_reviewer);
    }
    if let Ok(Some(active_permission_profile)) = active_permission_profile_from_payload(payload) {
        thread.active_permission_profile = Some(active_permission_profile);
    }
    if let Some(sandbox) = optional_value(payload, "sandbox") {
        thread.sandbox = Some(sandbox);
    }
}

fn is_terminal_turn_status(status: &str) -> bool {
    matches!(
        status.to_lowercase().as_str(),
        "completed" | "failed" | "cancelled" | "canceled" | "interrupted"
    )
}

fn live_state_from_thread(thread: &Value) -> ThreadLiveState {
    if thread
        .get("turns")
        .and_then(Value::as_array)
        .is_some_and(|turns| turns.iter().any(turn_is_active))
    {
        return ThreadLiveState::Streaming;
    }

    match status_type(thread.get("status")).as_deref() {
        Some("notLoaded") => ThreadLiveState::NotLoaded,
        Some("active" | "idle" | "systemError") => ThreadLiveState::Idle,
        _ => ThreadLiveState::NotLoaded,
    }
}

fn turn_is_active(turn: &Value) -> bool {
    match status_type(turn.get("status")).as_deref() {
        Some("completed" | "failed" | "cancelled" | "canceled" | "interrupted") => false,
        Some(_) => true,
        None => false,
    }
}

fn status_type(value: Option<&Value>) -> Option<String> {
    value.and_then(|status| {
        status.as_str().map(str::to_string).or_else(|| {
            status
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
    })
}

fn required_bool(payload: &Value, field: &str) -> ApiResult<bool> {
    payload
        .get(field)
        .and_then(Value::as_bool)
        .ok_or_else(|| bad_gateway(format!("missing boolean field {field}")))
}

fn required_thread_status(payload: &Value) -> ApiResult<ThreadStatus> {
    let status_type = payload
        .get("status")
        .and_then(|status| status.get("type"))
        .and_then(Value::as_str)
        .ok_or_else(|| bad_gateway("missing thread status type"))?;

    match status_type {
        "notLoaded" => Ok(ThreadStatus::NotLoaded),
        "idle" => Ok(ThreadStatus::Idle),
        "systemError" => Ok(ThreadStatus::SystemError),
        "active" => Ok(ThreadStatus::Active),
        other => Err(bad_gateway(format!("unknown thread status type {other}"))),
    }
}

fn required_i64(payload: &Value, field: &str) -> ApiResult<i64> {
    payload
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| bad_gateway(format!("missing integer field {field}")))
}

fn optional_i64(payload: &Value, field: &str) -> Option<i64> {
    payload.get(field).and_then(Value::as_i64)
}

fn bad_gateway(message: impl Into<String>) -> ApiError {
    ApiError::BadGateway(format!("unexpected app-server payload: {}", message.into()))
}

#[cfg(test)]
mod tests;
