use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use crate::error::{ApiError, ApiResult};

mod client;

mod timeline;
pub(crate) use client::is_thread_not_materialized_before_first_user_message;
pub use client::{client, CodexClient};
#[cfg(test)]
pub(crate) use timeline::TIMELINE_PREVIEW_STRING_LIMIT;
pub(crate) use timeline::{
    canonical_timeline_item_id, compact_timeline_item_payload, thread_timeline_rows_from_items,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
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
            payload["serviceTier"] = Value::String(service_tier);
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
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpAuthStatus {
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
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceReadResponse {
    pub contents: Vec<Value>,
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

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpReloadResponse {
    pub reloaded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredMcpServerListResponse {
    pub servers: Vec<ConfiguredMcpServer>,
}

impl ConfiguredMcpServerListResponse {
    fn from_config_payload(payload: Value) -> ApiResult<Self> {
        let entries = payload
            .get("config")
            .and_then(|config| config.get("mcp_servers"))
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|servers| servers.iter())
            .filter_map(|(name, value)| ConfiguredMcpServer::from_config(name, value))
            .collect();
        Ok(Self { servers: entries })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredMcpServer {
    pub name: String,
    pub enabled: bool,
    #[serde(default)]
    pub required: Option<bool>,
    #[serde(default)]
    pub startup_timeout_sec: Option<i64>,
    #[serde(default)]
    pub tool_timeout_sec: Option<i64>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub enabled_tools: Vec<String>,
    pub has_stored_secrets: bool,
    pub transport: ConfiguredMcpTransport,
}

impl ConfiguredMcpServer {
    fn from_config(name: &str, value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let transport = if object.get("url").and_then(Value::as_str).is_some() {
            ConfiguredMcpTransport::StreamableHttp {
                url: optional_string(value, "url").unwrap_or_default(),
                bearer_token_env_var: optional_string(value, "bearer_token_env_var"),
                oauth_resource: optional_string(value, "oauth_resource"),
                http_headers: masked_secret_map(value.get("http_headers")),
                env_http_headers: string_map(value.get("env_http_headers")),
            }
        } else if object.get("command").and_then(Value::as_str).is_some() {
            ConfiguredMcpTransport::Stdio {
                command: optional_string(value, "command").unwrap_or_default(),
                args: string_vec(value.get("args")),
                cwd: optional_string(value, "cwd"),
                env: masked_secret_map(value.get("env")),
                env_vars: env_var_names(value.get("env_vars")),
            }
        } else {
            ConfiguredMcpTransport::Unknown
        };
        let has_stored_secrets = match &transport {
            ConfiguredMcpTransport::Stdio { env, .. } => !env.is_empty(),
            ConfiguredMcpTransport::StreamableHttp { http_headers, .. } => !http_headers.is_empty(),
            ConfiguredMcpTransport::Unknown => false,
        };
        Some(Self {
            name: name.to_string(),
            enabled: value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            required: value.get("required").and_then(Value::as_bool),
            startup_timeout_sec: optional_i64(value, "startup_timeout_sec"),
            tool_timeout_sec: optional_i64(value, "tool_timeout_sec"),
            scopes: string_vec(value.get("scopes")),
            enabled_tools: string_vec(value.get("enabled_tools")),
            has_stored_secrets,
            transport,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConfiguredMcpTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: BTreeMap<String, ConfiguredMcpSecret>,
        #[serde(default, rename = "envVars")]
        env_vars: Vec<String>,
    },
    StreamableHttp {
        url: String,
        #[serde(default, rename = "bearerTokenEnvVar")]
        bearer_token_env_var: Option<String>,
        #[serde(default, rename = "oauthResource")]
        oauth_resource: Option<String>,
        #[serde(default, rename = "httpHeaders")]
        http_headers: BTreeMap<String, ConfiguredMcpSecret>,
        #[serde(default, rename = "envHttpHeaders")]
        env_http_headers: BTreeMap<String, String>,
    },
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredMcpSecret {
    pub configured: bool,
    pub masked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInstallRequest {
    pub name: String,
    pub transport: McpServerTransportRequest,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub required: Option<bool>,
    #[serde(default)]
    pub startup_timeout_sec: Option<i64>,
    #[serde(default)]
    pub tool_timeout_sec: Option<i64>,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    #[serde(default)]
    pub enabled_tools: Option<Vec<String>>,
}

impl McpServerInstallRequest {
    fn config_value(&self) -> Value {
        self.config_value_with_existing(None)
    }

    fn config_value_with_existing(&self, existing: Option<&Value>) -> Value {
        let mut value = match &self.transport {
            McpServerTransportRequest::Stdio {
                command,
                args,
                cwd,
                env,
                env_vars,
                clear_env,
            } => json!({
                "command": command,
                "args": args,
                "cwd": cwd,
                "env": merged_secret_object(existing.and_then(|value| value.get("env")), env, clear_env),
                "env_vars": env_vars,
            }),
            McpServerTransportRequest::StreamableHttp {
                url,
                bearer_token_env_var,
                oauth_resource,
                http_headers,
                env_http_headers,
                clear_http_headers,
            } => json!({
                "url": url,
                "bearer_token_env_var": bearer_token_env_var,
                "oauth_resource": oauth_resource,
                "http_headers": merged_secret_object(existing.and_then(|value| value.get("http_headers")), http_headers, clear_http_headers),
                "env_http_headers": env_http_headers,
            }),
        };
        if let Some(enabled) = self.enabled {
            value["enabled"] = Value::Bool(enabled);
        }
        if let Some(required) = self.required {
            value["required"] = Value::Bool(required);
        }
        if let Some(timeout) = self.startup_timeout_sec {
            value["startup_timeout_sec"] = Value::Number(timeout.into());
        } else {
            preserve_existing_field(existing, &mut value, "startup_timeout_sec");
        }
        if let Some(timeout) = self.tool_timeout_sec {
            value["tool_timeout_sec"] = Value::Number(timeout.into());
        } else {
            preserve_existing_field(existing, &mut value, "tool_timeout_sec");
        }
        match &self.scopes {
            Some(scopes) => value["scopes"] = json!(scopes),
            None => preserve_existing_field(existing, &mut value, "scopes"),
        }
        match &self.enabled_tools {
            Some(enabled_tools) => value["enabled_tools"] = json!(enabled_tools),
            None => preserve_existing_field(existing, &mut value, "enabled_tools"),
        }
        prune_nulls(&mut value);
        value
    }

    fn into_configured(self, name: String) -> ConfiguredMcpServer {
        let value = self.config_value();
        ConfiguredMcpServer::from_config(&name, &value).unwrap_or(ConfiguredMcpServer {
            name,
            enabled: true,
            required: None,
            startup_timeout_sec: None,
            tool_timeout_sec: None,
            scopes: Vec::new(),
            enabled_tools: Vec::new(),
            has_stored_secrets: false,
            transport: ConfiguredMcpTransport::Unknown,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpServerTransportRequest {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default, rename = "clearEnv")]
        clear_env: Vec<String>,
        #[serde(default, rename = "envVars")]
        env_vars: Vec<String>,
    },
    StreamableHttp {
        url: String,
        #[serde(default, rename = "bearerTokenEnvVar")]
        bearer_token_env_var: Option<String>,
        #[serde(default, rename = "oauthResource")]
        oauth_resource: Option<String>,
        #[serde(default, rename = "httpHeaders")]
        http_headers: BTreeMap<String, String>,
        #[serde(default, rename = "clearHttpHeaders")]
        clear_http_headers: Vec<String>,
        #[serde(default, rename = "envHttpHeaders")]
        env_http_headers: BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerToggleRequest {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigMutationResponse {
    #[serde(default)]
    pub configured_server: Option<ConfiguredMcpServer>,
    pub reload: McpReloadResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSettingsResponse {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub service_tier: Option<String>,
    pub permission_profile_id: Option<String>,
    pub approval_policy: Option<String>,
    pub approvals_reviewer: Option<String>,
    pub permissions_preset: Option<ComposerPermissionsPreset>,
}

impl ComposerSettingsResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let config = payload
            .get("config")
            .ok_or_else(|| bad_gateway("config/read response missing config"))?;
        Ok(Self {
            model: optional_string(config, "model"),
            effort: optional_string(config, "model_reasoning_effort"),
            service_tier: optional_string(config, "service_tier"),
            permission_profile_id: optional_string(config, "default_permissions"),
            approval_policy: optional_string(config, "approval_policy"),
            approvals_reviewer: optional_string(config, "approvals_reviewer"),
            permissions_preset: composer_permissions_preset(config),
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ComposerPermissionsPreset {
    Default,
    AutoReview,
    FullAccess,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSettingsUpdateRequest {
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
    pub permission_profile_id: Option<Option<String>>,
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
}

impl ComposerSettingsUpdateRequest {
    fn config_edits(self) -> Vec<Value> {
        let mut edits = Vec::new();
        if let Some(model) = self.model {
            edits.push(config_edit("model", option_string_value(model)));
        }
        if let Some(effort) = self.effort {
            edits.push(config_edit(
                "model_reasoning_effort",
                option_string_value(effort),
            ));
        }
        if let Some(service_tier) = self.service_tier {
            edits.push(config_edit(
                "service_tier",
                option_string_value(service_tier),
            ));
        }
        if let Some(permission_profile_id) = self.permission_profile_id {
            edits.push(config_edit(
                "default_permissions",
                option_string_value(permission_profile_id),
            ));
        }
        if let Some(approval_policy) = self.approval_policy {
            edits.push(config_edit(
                "approval_policy",
                option_string_value(approval_policy),
            ));
        }
        if let Some(approvals_reviewer) = self.approvals_reviewer {
            edits.push(config_edit(
                "approvals_reviewer",
                option_string_value(approvals_reviewer),
            ));
        }
        edits
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSettingsUpdateResponse {
    pub saved: bool,
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
    pub pinned_at: Option<DateTime<Utc>>,
    pub preview: Option<Value>,
    pub last_completed_agent_turn_seq: Option<i64>,
    pub seen_completed_agent_turn_seq: i64,
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
            pinned_at: None,
            preview: payload.get("preview").cloned(),
            last_completed_agent_turn_seq: None,
            seen_completed_agent_turn_seq: 0,
            unread_completed_agent_turn: false,
            notifications_enabled: true,
            raw_payload: payload.clone(),
        })
    }

    pub fn apply_completed_agent_turn_read_state(
        &mut self,
        last_completed_agent_turn_seq: Option<i64>,
        seen_completed_agent_turn_seq: i64,
    ) {
        self.last_completed_agent_turn_seq = last_completed_agent_turn_seq;
        self.seen_completed_agent_turn_seq = seen_completed_agent_turn_seq.max(0);
        self.unread_completed_agent_turn = last_completed_agent_turn_seq
            .is_some_and(|seq| seq > self.seen_completed_agent_turn_seq);
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
    pub pinned_at: Option<DateTime<Utc>>,
    pub preview: Option<Value>,
    pub last_completed_agent_turn_seq: Option<i64>,
    pub seen_completed_agent_turn_seq: i64,
    pub unread_completed_agent_turn: bool,
    pub notifications_enabled: bool,
}

impl From<ThreadSummary> for ThreadViewThreadSummary {
    fn from(thread: ThreadSummary) -> Self {
        Self {
            id: thread.id,
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
            pinned_at: thread.pinned_at,
            preview: thread.preview,
            last_completed_agent_turn_seq: thread.last_completed_agent_turn_seq,
            seen_completed_agent_turn_seq: thread.seen_completed_agent_turn_seq,
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
        let last_completed_agent_turn_seq = completed_turn_count(&turns);
        let mut thread = ThreadSummary::from_payload(thread)?;
        thread.apply_completed_agent_turn_read_state(last_completed_agent_turn_seq, 0);
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

    fn from_thread_payload_and_turns(
        payload: Value,
        turns: Vec<ThreadTurnSnapshot>,
    ) -> ApiResult<Self> {
        Self::from_thread_payload_turns_and_history(payload, turns, None, None)
    }

    fn from_thread_payload_turns_and_history(
        mut payload: Value,
        turns: Vec<ThreadTurnSnapshot>,
        history_page: Option<ThreadTimelineWindowPage>,
        last_completed_agent_turn_seq: Option<i64>,
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
        if last_completed_agent_turn_seq.is_some() {
            response
                .thread
                .apply_completed_agent_turn_read_state(last_completed_agent_turn_seq, 0);
        }
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
            item_type: required_string(payload, "type")?,
            skill_mentions: skill_mentions_from_thread_item(payload),
            file_attachments: file_attachments_from_thread_item(payload),
            raw_payload: payload.clone(),
        })
    }
}

pub(crate) fn timeline_skill_mentions_from_user_input(
    input: &[UserInput],
    skills: &[SkillMetadata],
) -> Option<(String, Vec<TimelineSkillMention>)> {
    let content = serde_json::to_value(input).ok()?;
    let content = content.as_array()?;
    let text = visible_text_from_user_content(content)?;
    Some((text, skill_mentions_from_user_content(content, skills)))
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

pub(crate) fn timeline_skill_mentions_from_text(
    text: &str,
    catalog: &[SkillMetadata],
) -> Vec<TimelineSkillMention> {
    let skills = unambiguous_enabled_catalog_skills_by_name(catalog);
    if skills.is_empty() {
        return Vec::new();
    }
    let bytes = text.as_bytes();
    let mut mentions = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'$' {
            index += 1;
            continue;
        }
        let name_start = index + 1;
        let Some(first) = bytes.get(name_start) else {
            index += 1;
            continue;
        };
        if !is_skill_name_char(*first) {
            index += 1;
            continue;
        }
        let mut name_end = name_start + 1;
        while bytes
            .get(name_end)
            .is_some_and(|next| is_skill_name_char(*next))
        {
            name_end += 1;
        }
        let name = &text[name_start..name_end];
        if let Some(skill) = skills.get(name) {
            let mention = TimelineSkillMention {
                start: text[..index].encode_utf16().count() as u32,
                end: text[..name_end].encode_utf16().count() as u32,
                name: name.to_string(),
                path: skill.path.clone(),
                display_name: None,
                scope: None,
                short_description: None,
                brand_color: None,
                icon_small_url: None,
            };
            mentions.push(enrich_timeline_skill_mention(mention, catalog));
        }
        index = name_end;
    }
    mentions
}

fn skill_mentions_from_thread_item(item: &Value) -> Vec<TimelineSkillMention> {
    if item.get("type").and_then(Value::as_str) != Some("userMessage") {
        return Vec::new();
    }
    let Some(content) = item.get("content").and_then(Value::as_array) else {
        return Vec::new();
    };
    skill_mentions_from_user_content(content, &[])
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

fn file_attachments_from_user_content(content: &[Value]) -> Vec<TimelineFileAttachment> {
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

fn unambiguous_enabled_catalog_skills_by_name(
    catalog: &[SkillMetadata],
) -> HashMap<String, &SkillMetadata> {
    let mut skills_by_name: HashMap<String, Option<&SkillMetadata>> = HashMap::new();
    for skill in catalog.iter().filter(|skill| skill.enabled) {
        skills_by_name
            .entry(skill.name.clone())
            .and_modify(|existing| {
                if existing
                    .as_ref()
                    .is_some_and(|existing| existing.path != skill.path)
                {
                    *existing = None;
                }
            })
            .or_insert_with(|| Some(skill));
    }
    skills_by_name
        .into_iter()
        .filter_map(|(name, skill)| skill.map(|skill| (name, skill)))
        .collect()
}

fn is_skill_name_char(byte: u8) -> bool {
    matches!(byte, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'-' | b':')
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

fn skill_mentions_from_user_content(
    content: &[Value],
    catalog: &[SkillMetadata],
) -> Vec<TimelineSkillMention> {
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
                mentions.push(enrich_timeline_skill_mention(mention, catalog));
            }
        }
        display_offset = display_offset.saturating_add(text.encode_utf16().count() as u32);
    }
    mentions
}

pub(crate) fn enrich_timeline_skill_mentions(
    mentions: Vec<TimelineSkillMention>,
    catalog: &[SkillMetadata],
) -> Vec<TimelineSkillMention> {
    mentions
        .into_iter()
        .map(|mention| enrich_timeline_skill_mention(mention, catalog))
        .collect()
}

fn enrich_timeline_skill_mention(
    mut mention: TimelineSkillMention,
    catalog: &[SkillMetadata],
) -> TimelineSkillMention {
    let Some(skill) = matching_enabled_skill_for_mention(&mention, catalog) else {
        mention.display_name = None;
        mention.scope = None;
        mention.short_description = None;
        mention.brand_color = None;
        mention.icon_small_url = None;
        return mention;
    };

    mention.display_name = skill
        .interface
        .as_ref()
        .and_then(|interface| trimmed_optional(interface.display_name.as_deref()));
    mention.scope = trimmed_optional(Some(&skill.scope));
    mention.short_description = skill
        .interface
        .as_ref()
        .and_then(|interface| trimmed_optional(interface.short_description.as_deref()))
        .or_else(|| trimmed_optional(skill.short_description.as_deref()))
        .or_else(|| trimmed_optional(Some(&skill.description)));
    mention.brand_color = skill
        .interface
        .as_ref()
        .and_then(|interface| trimmed_optional(interface.brand_color.as_deref()));
    mention.icon_small_url = skill
        .interface
        .as_ref()
        .and_then(|interface| trimmed_optional(interface.icon_small.as_deref()))
        .map(|path| format!("/v1/skills/icon?path={}", percent_encode_query_value(&path)));
    mention
}

fn matching_enabled_skill_for_mention<'a>(
    mention: &TimelineSkillMention,
    catalog: &'a [SkillMetadata],
) -> Option<&'a SkillMetadata> {
    catalog
        .iter()
        .find(|skill| skill.enabled && skill.path == mention.path && skill.name == mention.name)
}

fn trimmed_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn percent_encode_query_value(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                output.push(byte as char);
            }
            _ => {
                output.push('%');
                output.push_str(&format!("{byte:02X}"));
            }
        }
    }
    output
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
    pub login_id: Option<String>,
    pub auth_url: Option<String>,
    pub user_code: Option<String>,
    pub verification_url: Option<String>,
    pub raw_payload: Value,
}

impl LoginStartResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        Ok(Self {
            login_type: required_string(&payload, "type")?,
            login_id: optional_string(&payload, "loginId"),
            auth_url: optional_string(&payload, "authUrl"),
            user_code: optional_string(&payload, "userCode"),
            verification_url: optional_string(&payload, "verificationUrl"),
            raw_payload: payload,
        })
    }
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

fn require_extended_history(mut payload: Value) -> Value {
    payload["persistExtendedHistory"] = Value::Bool(true);
    payload
}

fn require_metadata_only_resume(mut payload: Value) -> Value {
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

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
        .collect()
}

fn masked_secret_map(value: Option<&Value>) -> BTreeMap<String, ConfiguredMcpSecret> {
    value
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(key, _)| {
            (
                key.clone(),
                ConfiguredMcpSecret {
                    configured: true,
                    masked: true,
                },
            )
        })
        .collect()
}

fn merged_secret_object(
    existing: Option<&Value>,
    replacements: &BTreeMap<String, String>,
    clear: &[String],
) -> BTreeMap<String, Value> {
    let mut merged = existing
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();
    for key in clear {
        merged.remove(key);
    }
    for (key, value) in replacements {
        merged.insert(key.clone(), Value::String(value.clone()));
    }
    merged
}

fn preserve_existing_field(existing: Option<&Value>, value: &mut Value, field: &str) {
    if let Some(existing_value) = existing.and_then(|existing| existing.get(field)) {
        value[field] = existing_value.clone();
    }
}

fn env_var_names(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            value.as_str().map(str::to_string).or_else(|| {
                value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        })
        .collect()
}

fn prune_nulls(value: &mut Value) {
    if let Value::Object(map) = value {
        let keys = map
            .iter()
            .filter_map(|(key, value)| {
                if value.is_null() {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        for key in keys {
            map.remove(&key);
        }
    }
}

fn validate_mcp_server_name(name: &str) -> ApiResult<()> {
    if name.is_empty()
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(ApiError::BadRequest(
            "MCP server name must contain only ASCII letters, digits, '-' or '_'".to_string(),
        ));
    }
    Ok(())
}

fn config_edit(key_path: &str, value: Value) -> Value {
    json!({
        "keyPath": key_path,
        "mergeStrategy": "replace",
        "value": value,
    })
}

fn option_string_value(value: Option<String>) -> Value {
    value.map(Value::String).unwrap_or(Value::Null)
}

fn deserialize_optional_string_update<'de, D>(
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

fn completed_turn_count(turns: &[ThreadTurnSnapshot]) -> Option<i64> {
    if turns.is_empty() {
        return None;
    }
    Some(
        turns
            .iter()
            .filter(|turn| is_terminal_turn_status(&turn.status))
            .count() as i64,
    )
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
