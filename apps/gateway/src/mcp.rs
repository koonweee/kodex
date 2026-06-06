use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars, tool, tool_handler, tool_router, ErrorData as McpError, RoleServer, ServerHandler,
    ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::time::{sleep, Duration, Instant};

const MCP_TOOL_THREAD_ID_META_KEY: &str = "threadId";

#[derive(Clone)]
pub struct KodexControlMcp {
    gateway_url: String,
    client: reqwest::Client,
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

impl KodexControlMcp {
    pub fn from_env() -> Result<Self, McpError> {
        let gateway_url = std::env::var("KODEX_GATEWAY_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8787".to_string());
        validate_gateway_url(&gateway_url).map_err(|error| {
            McpError::invalid_params("invalid KODEX_GATEWAY_URL", Some(json!({ "error": error })))
        })?;
        Ok(Self {
            gateway_url: gateway_url.trim_end_matches('/').to_string(),
            client: reqwest::Client::new(),
            tool_router: Self::tool_router(),
        })
    }

    async fn get_json(&self, path: &str) -> Result<Value, McpError> {
        self.request_json(reqwest::Method::GET, path, None).await
    }

    async fn post_json(&self, path: &str, body: Value) -> Result<Value, McpError> {
        self.request_json(reqwest::Method::POST, path, Some(body))
            .await
    }

    async fn patch_json(&self, path: &str, body: Value) -> Result<Value, McpError> {
        self.request_json(reqwest::Method::PATCH, path, Some(body))
            .await
    }

    async fn delete_json(&self, path: &str, body: Option<Value>) -> Result<Value, McpError> {
        self.request_json(reqwest::Method::DELETE, path, body).await
    }

    async fn request_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, McpError> {
        let url = format!("{}{}", self.gateway_url, path);
        let mut request = self.client.request(method, url);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| {
            McpError::internal_error(
                "gateway request failed",
                Some(json!({ "error": error.to_string() })),
            )
        })?;
        let status = response.status();
        let body = response.text().await.map_err(|error| {
            McpError::internal_error(
                "failed to read gateway response body",
                Some(json!({ "error": error.to_string() })),
            )
        })?;
        if !status.is_success() {
            let body = serde_json::from_str::<Value>(&body).unwrap_or(Value::String(body));
            return Err(McpError::internal_error(
                "gateway returned an error",
                Some(json!({ "status": status.as_u16(), "body": body })),
            ));
        }
        let value = serde_json::from_str::<Value>(&body).map_err(|error| {
            McpError::internal_error(
                "gateway returned invalid JSON",
                Some(json!({
                    "status": status.as_u16(),
                    "body": body,
                    "error": error.to_string()
                })),
            )
        })?;
        Ok(value)
    }

    fn resource(uri: &str, name: &str) -> Resource {
        RawResource::new(uri, name.to_string())
            .with_mime_type("application/json")
            .no_annotation()
    }

    fn template(uri_template: &str, name: &str) -> ResourceTemplate {
        RawResourceTemplate::new(uri_template, name.to_string())
            .with_mime_type("application/json")
            .no_annotation()
    }

    #[cfg(test)]
    pub fn for_test(gateway_url: String) -> Self {
        Self {
            gateway_url,
            client: reqwest::Client::new(),
            tool_router: Self::tool_router(),
        }
    }

    async fn thread_post_tool(
        &self,
        params: ThreadMutationToolParams,
        action: &str,
    ) -> Result<CallToolResult, McpError> {
        let thread_id = params.thread_id.clone();
        let mut body = json_object(params)?;
        body.remove("threadId");
        Ok(json_tool_result(
            self.post_json(
                &format!(
                    "/v1/self-control/threads/{}/{}",
                    path_segment(&thread_id),
                    action
                ),
                Value::Object(body),
            )
            .await?,
        ))
    }
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewApplyToolParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_project: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub services: Vec<PreviewServiceToolParams>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub previews: Vec<PreviewToolParams>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(default, flatten, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewServiceToolParams {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    pub local_port: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_path: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewToolParams {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_port: Option<i64>,
    pub root_service_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub routes: Vec<PreviewRouteToolParams>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRouteToolParams {
    pub path_pattern: String,
    pub service_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strip_prefix: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadToolParams {
    #[serde(alias = "project_id")]
    pub project_id: String,
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
    pub sandbox: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_self_control_depth: Option<u8>,
    #[serde(default, flatten, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SendThreadInputToolParams {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    pub input: Vec<Value>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_self_control_depth: Option<u8>,
    #[serde(default, flatten, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateAutomationToolParams {
    pub name: String,
    pub prompt: String,
    pub target_thread_id: String,
    pub schedule: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(default, flatten, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAutomationToolParams {
    #[serde(alias = "automation_id")]
    pub automation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(default, flatten, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationIdToolParams {
    #[serde(alias = "automation_id")]
    pub automation_id: String,
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListThreadsToolParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIdToolParams {
    #[serde(alias = "project_id")]
    pub project_id: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadIdToolParams {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMutationToolParams {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedUiToolParams {
    #[serde(default, alias = "thread_id", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub title: String,
    pub html: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<AppSurfacePresentationAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_self_control_depth: Option<u8>,
    #[serde(default, flatten, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedUiThreadToolParams {
    #[serde(default, alias = "thread_id", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedUiMutationToolParams {
    #[serde(default, alias = "thread_id", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceToolParams {
    #[serde(default, alias = "thread_id", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub title: String,
    pub html: String,
    pub fallback_content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<AppSurfacePresentationAction>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub display_modes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub csp: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grants: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_self_control_depth: Option<u8>,
    #[serde(default, flatten, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceThreadToolParams {
    #[serde(default, alias = "thread_id", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AppSurfacePresentationAction {
    Open,
    Focus,
}

fn default_app_surface_presentation_action() -> AppSurfacePresentationAction {
    AppSurfacePresentationAction::Focus
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfacePresentationToolParams {
    #[serde(default, alias = "thread_id", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default = "default_app_surface_presentation_action")]
    pub action: AppSurfacePresentationAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_self_control_depth: Option<u8>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceMutationToolParams {
    #[serde(default, alias = "thread_id", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineToolParams {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    pub cursor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenameThreadToolParams {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateThreadSettingsToolParams {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    pub settings: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkThreadSeenToolParams {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen_completed_agent_turn_seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpawnThreadToolParams {
    #[serde(alias = "project_id")]
    pub project_id: String,
    pub input: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_options: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_self_control_depth: Option<u8>,
    #[serde(default, flatten, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListAutomationsToolParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AutomationMutationToolParams {
    #[serde(alias = "automation_id")]
    pub automation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ValidateAutomationToolParams {
    pub name: String,
    pub prompt: String,
    pub target_thread_id: String,
    pub schedule: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(default, flatten, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListApprovalsToolParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalIdToolParams {
    #[serde(alias = "approval_id")]
    pub approval_id: String,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DenyApprovalToolParams {
    #[serde(alias = "approval_id")]
    pub approval_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecideApprovalWithPolicyToolParams {
    #[serde(alias = "approval_id")]
    pub approval_id: String,
    pub decision: Value,
    pub requested_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

#[derive(Debug, Default, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListEventsToolParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude_thread_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WaitForThreadIdleToolParams {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    pub timeout_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poll_interval_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WaitForThreadEventToolParams {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    pub kind: String,
    pub timeout_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poll_interval_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WaitForAutomationRunToolParams {
    #[serde(alias = "automation_id")]
    pub automation_id: String,
    pub timeout_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_last_queued_input_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poll_interval_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WaitForApprovalToolParams {
    pub timeout_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poll_interval_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WaitForQueueEmptyToolParams {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    pub timeout_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poll_interval_ms: Option<u64>,
}

#[tool_router]
impl KodexControlMcp {
    #[tool(description = "Return Kodex self-control gateway status and capability flags")]
    async fn get_status(&self) -> Result<CallToolResult, McpError> {
        Ok(json_tool_result(
            self.get_json("/v1/self-control/status").await?,
        ))
    }

    #[tool(
        description = "Dry-run or apply a project preview configuration through Kodex self-control"
    )]
    async fn apply_project_preview_config(
        &self,
        Parameters(params): Parameters<PreviewApplyToolParams>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_tool_result(
            self.post_json(
                "/v1/self-control/project-previews/apply",
                serde_json::to_value(params).map_err(json_encode_error)?,
            )
            .await?,
        ))
    }

    #[tool(description = "List Kodex projects through self-control discovery")]
    async fn list_projects(&self) -> Result<CallToolResult, McpError> {
        Ok(json_tool_result(
            self.get_json("/v1/self-control/projects").await?,
        ))
    }

    #[tool(description = "Read a Kodex project through self-control discovery")]
    async fn get_project(
        &self,
        Parameters(params): Parameters<ProjectIdToolParams>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_tool_result(
            self.get_json(&format!(
                "/v1/self-control/projects/{}",
                path_segment(&params.project_id)
            ))
            .await?,
        ))
    }

    #[tool(description = "List Kodex threads through self-control discovery")]
    async fn list_threads(
        &self,
        Parameters(params): Parameters<ListThreadsToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let path = append_query(
            "/v1/self-control/threads",
            [
                ("projectId", params.project_id),
                ("cursor", params.cursor),
                ("limit", params.limit.map(|limit| limit.to_string())),
            ],
        );
        Ok(json_tool_result(self.get_json(&path).await?))
    }

    #[tool(description = "List compact sidebar threads through self-control discovery")]
    async fn list_sidebar_threads(&self) -> Result<CallToolResult, McpError> {
        Ok(json_tool_result(
            self.get_json("/v1/self-control/sidebar/threads").await?,
        ))
    }

    #[tool(description = "Read a Kodex thread through self-control discovery")]
    async fn get_thread(
        &self,
        Parameters(params): Parameters<ThreadIdToolParams>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_tool_result(
            self.get_json(&format!(
                "/v1/self-control/threads/{}",
                path_segment(&params.thread_id)
            ))
            .await?,
        ))
    }

    #[tool(description = "Read a page of a Kodex thread timeline through self-control")]
    async fn get_thread_timeline(
        &self,
        Parameters(params): Parameters<ThreadTimelineToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let path = append_query(
            &format!(
                "/v1/self-control/threads/{}/timeline/pages",
                path_segment(&params.thread_id)
            ),
            [
                ("cursor", Some(params.cursor)),
                ("limit", params.limit.map(|limit| limit.to_string())),
            ],
        );
        Ok(json_tool_result(self.get_json(&path).await?))
    }

    #[tool(description = "List subagents for a Kodex thread through self-control")]
    async fn list_thread_subagents(
        &self,
        Parameters(params): Parameters<ThreadIdToolParams>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_tool_result(
            self.get_json(&format!(
                "/v1/self-control/threads/{}/subagents",
                path_segment(&params.thread_id)
            ))
            .await?,
        ))
    }

    #[tool(description = "List queued inputs for a Kodex thread through self-control")]
    async fn list_thread_queue(
        &self,
        Parameters(params): Parameters<ThreadIdToolParams>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_tool_result(
            self.get_json(&format!(
                "/v1/self-control/threads/{}/queued-inputs",
                path_segment(&params.thread_id)
            ))
            .await?,
        ))
    }

    #[tool(description = "Create a project-scoped Kodex thread through self-control")]
    async fn create_thread(
        &self,
        Parameters(params): Parameters<CreateThreadToolParams>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_tool_result(
            self.post_json(
                "/v1/self-control/threads",
                serde_json::to_value(params).map_err(json_encode_error)?,
            )
            .await?,
        ))
    }

    #[tool(description = "Send input to a Kodex thread through self-control queue routing")]
    async fn send_thread_input(
        &self,
        Parameters(params): Parameters<SendThreadInputToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let thread_id = params.thread_id.clone();
        let mut body = json_object(params)?;
        body.remove("threadId");
        Ok(json_tool_result(
            self.post_json(
                &format!(
                    "/v1/self-control/threads/{}/input",
                    path_segment(&thread_id)
                ),
                Value::Object(body),
            )
            .await?,
        ))
    }

    #[tool(
        description = "Open a generated app surface in the invoking Kodex thread by default, or an explicit threadId. App surfaces render MCP App-compatible HTML in the shared pane and may use the JSON-RPC bridge according to declared grants. Use when visual layout, direct manipulation, branching choices, comparison, preview, questionnaires, dashboards, or repeated actions are clearer than chat alone. Provide meaningful fallbackContent for text-only hosts. Optional presentation controls whether the browser should open the pane without switching focus (\"open\") or switch focus to it (\"focus\") when this revision arrives; omit presentation for a non-disruptive content update only."
    )]
    async fn open_app_surface(
        &self,
        Parameters(params): Parameters<AppSurfaceToolParams>,
        meta: Meta,
    ) -> Result<CallToolResult, McpError> {
        upsert_app_surface_tool(self, params, meta).await
    }

    #[tool(
        description = "Replace the latest generated app-surface revision for the invoking Kodex thread by default, or an explicit threadId. Use when the pane needs new embedded data, revised controls, or the next step of a workflow. Provide meaningful fallbackContent and declare any bridge grants explicitly. Optional presentation controls whether the browser should open the pane without switching focus (\"open\") or switch focus to it (\"focus\") when this revision arrives; omit presentation for a non-disruptive content update only."
    )]
    async fn update_app_surface(
        &self,
        Parameters(params): Parameters<AppSurfaceToolParams>,
        meta: Meta,
    ) -> Result<CallToolResult, McpError> {
        upsert_app_surface_tool(self, params, meta).await
    }

    #[tool(
        description = "Read the latest app-surface metadata for the invoking Kodex thread by default, or for an explicit threadId override"
    )]
    async fn get_app_surface(
        &self,
        Parameters(params): Parameters<AppSurfaceThreadToolParams>,
        meta: Meta,
    ) -> Result<CallToolResult, McpError> {
        let thread_id = resolve_app_surface_thread_id(params.thread_id, &meta)?;
        Ok(json_tool_result(
            self.get_json(&format!(
                "/v1/self-control/threads/{}/app-surface",
                path_segment(&thread_id)
            ))
            .await?,
        ))
    }

    #[tool(
        description = "Open or focus the latest app-surface pane for the invoking Kodex thread by default, or an explicit threadId. Use action \"open\" to make the pane available without switching focus, or \"focus\" to switch the user's workspace to it."
    )]
    async fn show_app_surface(
        &self,
        Parameters(params): Parameters<AppSurfacePresentationToolParams>,
        meta: Meta,
    ) -> Result<CallToolResult, McpError> {
        show_app_surface_tool(self, params, meta).await
    }

    #[tool(
        description = "Archive the latest app surface for the invoking Kodex thread by default, or for an explicit threadId override"
    )]
    async fn archive_app_surface(
        &self,
        Parameters(params): Parameters<AppSurfaceMutationToolParams>,
        meta: Meta,
    ) -> Result<CallToolResult, McpError> {
        let thread_id = resolve_app_surface_thread_id(params.thread_id.clone(), &meta)?;
        let mut body = json_object(params)?;
        body.remove("threadId");
        Ok(json_tool_result(
            self.delete_json(
                &format!(
                    "/v1/self-control/threads/{}/app-surface",
                    path_segment(&thread_id)
                ),
                Some(Value::Object(body)),
            )
            .await?,
        ))
    }

    #[tool(
        description = "Open a generated UI pane for the invoking Kodex thread by default, or for an explicit threadId override when intentionally targeting another thread. Use only when it creates a richer experience than chat alone through visual grouping, branching choices, comparison, preview, direct manipulation, progressive disclosure, or repeated actions. Optional presentation controls whether the browser should open the pane without switching focus (\"open\") or switch focus to it (\"focus\") when this revision arrives; omit presentation for a non-disruptive content update only. Generated UI may include both local UI interactions and conversational actions. Buttons are not inherently prompts: prefer local UI interactions when behavior can be handled inside the HTML with already-available data, such as modals, row expansion, tabs, chart filters or toggles, unit switches, breakdowns, or visualization views; these should not submit messages. Use conversational actions when interaction requires Codex, tools, external data, persistence, workflow continuation, or an explicit user decision, such as questionnaire answers, plan approval, investigation, visualization regeneration, automation updates, or follow-up artifacts. When an action is intended to involve Codex again, submit a standalone human-readable message plus optional compact JSON metadata. In iframe HTML, prefer the injected helper `window.kodex.submitMessage(message, metadata)`. The raw postMessage contract is `{ type: \"kodex.generatedUi.submit\", message: \"human-readable message\", metadata: { ... } }`; the host also sends `kodex.generatedUi.submit.result` ack/error messages. Pair every open with a short assistant message. Strongly prefer a theme-native UI unless the user explicitly asks for a distinct visual style: use Kodex semantic CSS variables for body, surfaces, cards, text, borders, buttons, charts, status colors, shadows, focus rings, and radii; avoid inventing custom palettes, gradients, stock dashboard chrome, or hard-coded color schemes for ordinary generated UIs. Keep the UI responsive, and keep HTML self-contained because v1 blocks external network by default."
    )]
    async fn open_generated_ui(
        &self,
        Parameters(params): Parameters<GeneratedUiToolParams>,
        meta: Meta,
    ) -> Result<CallToolResult, McpError> {
        upsert_generated_ui_tool(self, params, meta).await
    }

    #[tool(
        description = "Replace the latest generated UI pane revision for the invoking Kodex thread by default, or for an explicit threadId override when intentionally targeting another thread. Use this after a local UI view needs new embedded data, the user submits a conversational action, asks a follow-up, requests a revised mockup, or needs the next step of a workflow. Optional presentation controls whether the browser should open the pane without switching focus (\"open\") or switch focus to it (\"focus\") when this revision arrives; omit presentation for a non-disruptive content update only. Generated UI may include both local UI interactions and conversational actions. Buttons are not inherently prompts: prefer local UI interactions for embedded-data behavior such as modals, tabs, filters, chart toggles, unit switches, drilldowns, or progressive disclosure; these should not submit messages. Use conversational actions when interaction requires Codex, tools, external data, persistence, workflow continuation, or an explicit user decision, such as submitting answers, approving a plan, investigating, regenerating a visualization, updating automation, or creating a follow-up artifact. When an action is intended to involve Codex again, submit a standalone human-readable message plus optional compact JSON metadata. In iframe HTML, prefer the injected helper `window.kodex.submitMessage(message, metadata)`. The raw postMessage contract is `{ type: \"kodex.generatedUi.submit\", message: \"human-readable message\", metadata: { ... } }`; the host also sends `kodex.generatedUi.submit.result` ack/error messages. Strongly prefer a theme-native UI unless the user explicitly asks for a distinct visual style: use Kodex semantic CSS variables for body, surfaces, cards, text, borders, buttons, charts, status colors, shadows, focus rings, and radii; avoid inventing custom palettes, gradients, stock dashboard chrome, or hard-coded color schemes for ordinary generated UIs. Keep HTML self-contained, responsive, and bounded."
    )]
    async fn update_generated_ui(
        &self,
        Parameters(params): Parameters<GeneratedUiToolParams>,
        meta: Meta,
    ) -> Result<CallToolResult, McpError> {
        upsert_generated_ui_tool(self, params, meta).await
    }

    #[tool(
        description = "Read the latest generated UI pane metadata for the invoking Kodex thread by default, or for an explicit threadId override"
    )]
    async fn get_generated_ui(
        &self,
        Parameters(params): Parameters<GeneratedUiThreadToolParams>,
        meta: Meta,
    ) -> Result<CallToolResult, McpError> {
        let thread_id = resolve_app_surface_thread_id(params.thread_id, &meta)?;
        Ok(json_tool_result(
            self.get_json(&format!(
                "/v1/self-control/threads/{}/app-surface",
                path_segment(&thread_id)
            ))
            .await?,
        ))
    }

    #[tool(
        description = "Open or focus the latest generated UI pane for the invoking Kodex thread by default, or an explicit threadId. This is a compatibility alias for show_app_surface."
    )]
    async fn show_generated_ui(
        &self,
        Parameters(params): Parameters<AppSurfacePresentationToolParams>,
        meta: Meta,
    ) -> Result<CallToolResult, McpError> {
        show_app_surface_tool(self, params, meta).await
    }

    #[tool(
        description = "Archive the latest generated UI pane for the invoking Kodex thread by default, or for an explicit threadId override"
    )]
    async fn archive_generated_ui(
        &self,
        Parameters(params): Parameters<GeneratedUiMutationToolParams>,
        meta: Meta,
    ) -> Result<CallToolResult, McpError> {
        let thread_id = resolve_app_surface_thread_id(params.thread_id.clone(), &meta)?;
        let mut body = json_object(params)?;
        body.remove("threadId");
        Ok(json_tool_result(
            self.delete_json(
                &format!(
                    "/v1/self-control/threads/{}/app-surface",
                    path_segment(&thread_id)
                ),
                Some(Value::Object(body)),
            )
            .await?,
        ))
    }

    #[tool(
        description = "Create a thread and send its first input atomically through self-control"
    )]
    async fn spawn_thread(
        &self,
        Parameters(params): Parameters<SpawnThreadToolParams>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_tool_result(
            self.post_json(
                "/v1/self-control/thread-spawns",
                Value::Object(spawn_thread_body(params)?),
            )
            .await?,
        ))
    }

    #[tool(description = "Attach a Kodex thread through self-control lifecycle handling")]
    async fn attach_thread(
        &self,
        Parameters(params): Parameters<ThreadMutationToolParams>,
    ) -> Result<CallToolResult, McpError> {
        self.thread_post_tool(params, "attach").await
    }

    #[tool(description = "Resume a Kodex thread through self-control lifecycle handling")]
    async fn resume_thread(
        &self,
        Parameters(params): Parameters<ThreadMutationToolParams>,
    ) -> Result<CallToolResult, McpError> {
        self.thread_post_tool(params, "resume").await
    }

    #[tool(description = "Fork a Kodex thread through self-control lifecycle handling")]
    async fn fork_thread(
        &self,
        Parameters(params): Parameters<ThreadMutationToolParams>,
    ) -> Result<CallToolResult, McpError> {
        self.thread_post_tool(params, "fork").await
    }

    #[tool(description = "Rename a Kodex thread through self-control lifecycle handling")]
    async fn rename_thread(
        &self,
        Parameters(params): Parameters<RenameThreadToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let thread_id = params.thread_id.clone();
        let mut body = json_object(params)?;
        body.remove("threadId");
        Ok(json_tool_result(
            self.patch_json(
                &format!("/v1/self-control/threads/{}/name", path_segment(&thread_id)),
                Value::Object(body),
            )
            .await?,
        ))
    }

    #[tool(description = "Update Kodex thread settings through self-control lifecycle handling")]
    async fn update_thread_settings(
        &self,
        Parameters(params): Parameters<UpdateThreadSettingsToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let thread_id = params.thread_id;
        let mut body = match params.settings {
            Value::Object(settings) => settings,
            _ => {
                return Err(McpError::invalid_params(
                    "settings must be a JSON object",
                    Some(json!({ "field": "settings" })),
                ))
            }
        };
        if let Some(source) = params.source {
            body.insert("source".to_string(), source);
        }
        Ok(json_tool_result(
            self.patch_json(
                &format!(
                    "/v1/self-control/threads/{}/settings",
                    path_segment(&thread_id)
                ),
                Value::Object(body),
            )
            .await?,
        ))
    }

    #[tool(description = "Archive a Kodex thread through self-control lifecycle handling")]
    async fn archive_thread(
        &self,
        Parameters(params): Parameters<ThreadMutationToolParams>,
    ) -> Result<CallToolResult, McpError> {
        self.thread_post_tool(params, "archive").await
    }

    #[tool(description = "Pin a Kodex thread through self-control lifecycle handling")]
    async fn pin_thread(
        &self,
        Parameters(params): Parameters<ThreadMutationToolParams>,
    ) -> Result<CallToolResult, McpError> {
        self.thread_post_tool(params, "pin").await
    }

    #[tool(description = "Unpin a Kodex thread through self-control lifecycle handling")]
    async fn unpin_thread(
        &self,
        Parameters(params): Parameters<ThreadMutationToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let thread_id = params.thread_id.clone();
        let mut body = json_object(params)?;
        body.remove("threadId");
        Ok(json_tool_result(
            self.delete_json(
                &format!("/v1/self-control/threads/{}/pin", path_segment(&thread_id)),
                Some(Value::Object(body)),
            )
            .await?,
        ))
    }

    #[tool(description = "Mark a Kodex thread seen through self-control lifecycle handling")]
    async fn mark_thread_seen(
        &self,
        Parameters(params): Parameters<MarkThreadSeenToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let thread_id = params.thread_id.clone();
        let mut body = json_object(params)?;
        body.remove("threadId");
        Ok(json_tool_result(
            self.post_json(
                &format!("/v1/self-control/threads/{}/seen", path_segment(&thread_id)),
                Value::Object(body),
            )
            .await?,
        ))
    }

    #[tool(description = "Start Kodex thread compaction through self-control lifecycle handling")]
    async fn compact_thread(
        &self,
        Parameters(params): Parameters<ThreadMutationToolParams>,
    ) -> Result<CallToolResult, McpError> {
        self.thread_post_tool(params, "compact").await
    }

    #[tool(description = "Interrupt the current turn in a Kodex thread through self-control")]
    async fn interrupt_thread(
        &self,
        Parameters(params): Parameters<ThreadMutationToolParams>,
    ) -> Result<CallToolResult, McpError> {
        self.thread_post_tool(params, "interrupt-current").await
    }

    #[tool(description = "Create a Kodex automation through self-control")]
    async fn create_automation(
        &self,
        Parameters(params): Parameters<CreateAutomationToolParams>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_tool_result(
            self.post_json(
                "/v1/self-control/automations",
                serde_json::to_value(params).map_err(json_encode_error)?,
            )
            .await?,
        ))
    }

    #[tool(description = "List Kodex automations through self-control")]
    async fn list_automations(
        &self,
        Parameters(params): Parameters<ListAutomationsToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let path = append_query(
            "/v1/self-control/automations",
            [("threadId", params.thread_id)],
        );
        Ok(json_tool_result(self.get_json(&path).await?))
    }

    #[tool(description = "Read a Kodex automation through self-control")]
    async fn get_automation(
        &self,
        Parameters(params): Parameters<AutomationIdToolParams>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_tool_result(
            self.get_json(&format!(
                "/v1/self-control/automations/{}",
                path_segment(&params.automation_id)
            ))
            .await?,
        ))
    }

    #[tool(description = "Update a Kodex automation through self-control")]
    async fn update_automation(
        &self,
        Parameters(params): Parameters<UpdateAutomationToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let automation_id = params.automation_id.clone();
        let mut body = json_object(params)?;
        body.remove("automationId");
        Ok(json_tool_result(
            self.patch_json(
                &format!(
                    "/v1/self-control/automations/{}",
                    path_segment(&automation_id)
                ),
                Value::Object(body),
            )
            .await?,
        ))
    }

    #[tool(description = "Delete a Kodex automation through self-control")]
    async fn delete_automation(
        &self,
        Parameters(params): Parameters<AutomationMutationToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let automation_id = params.automation_id.clone();
        let mut body = json_object(params)?;
        body.remove("automationId");
        Ok(json_tool_result(
            self.delete_json(
                &format!(
                    "/v1/self-control/automations/{}",
                    path_segment(&automation_id)
                ),
                Some(Value::Object(body)),
            )
            .await?,
        ))
    }

    #[tool(description = "Run a Kodex automation immediately through self-control")]
    async fn run_automation_now(
        &self,
        Parameters(params): Parameters<AutomationMutationToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let automation_id = params.automation_id.clone();
        let mut body = json_object(params)?;
        body.remove("automationId");
        Ok(json_tool_result(
            self.post_json(
                &format!(
                    "/v1/self-control/automations/{}/run-now",
                    path_segment(&automation_id)
                ),
                Value::Object(body),
            )
            .await?,
        ))
    }

    #[tool(description = "Validate a Kodex automation request through self-control")]
    async fn validate_automation(
        &self,
        Parameters(params): Parameters<ValidateAutomationToolParams>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_tool_result(
            self.post_json(
                "/v1/self-control/automations/validate",
                serde_json::to_value(params).map_err(json_encode_error)?,
            )
            .await?,
        ))
    }

    #[tool(description = "Pause a Kodex automation through self-control")]
    async fn pause_automation(
        &self,
        Parameters(params): Parameters<AutomationIdToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let automation_id = params.automation_id;
        Ok(json_tool_result(
            self.post_json(
                &format!(
                    "/v1/self-control/automations/{}/pause",
                    path_segment(&automation_id)
                ),
                json!({}),
            )
            .await?,
        ))
    }

    #[tool(description = "Resume a Kodex automation through self-control")]
    async fn resume_automation(
        &self,
        Parameters(params): Parameters<AutomationIdToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let automation_id = params.automation_id;
        Ok(json_tool_result(
            self.post_json(
                &format!(
                    "/v1/self-control/automations/{}/resume",
                    path_segment(&automation_id)
                ),
                json!({}),
            )
            .await?,
        ))
    }

    #[tool(description = "List pending or historical approvals through self-control")]
    async fn list_approvals(
        &self,
        Parameters(params): Parameters<ListApprovalsToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let path = append_query(
            "/v1/self-control/approvals",
            [("status", params.status), ("threadId", params.thread_id)],
        );
        Ok(json_tool_result(self.get_json(&path).await?))
    }

    #[tool(description = "Read an approval through self-control")]
    async fn get_approval(
        &self,
        Parameters(params): Parameters<ApprovalIdToolParams>,
    ) -> Result<CallToolResult, McpError> {
        Ok(json_tool_result(
            self.get_json(&format!(
                "/v1/self-control/approvals/{}",
                path_segment(&params.approval_id)
            ))
            .await?,
        ))
    }

    #[tool(
        description = "Send a standard decline decision through conservative self-control policy; approval schemas that need a different denial payload fail closed"
    )]
    async fn deny_approval(
        &self,
        Parameters(params): Parameters<DenyApprovalToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let mut body = Map::new();
        body.insert("decision".to_string(), json!({"decision": "decline"}));
        body.insert("requestedBy".to_string(), json!("agent"));
        if let Some(reason) = params.reason {
            body.insert("reason".to_string(), json!(reason));
        }
        if let Some(source) = params.source {
            body.insert("source".to_string(), source);
        }
        Ok(json_tool_result(
            self.post_json(
                &format!(
                    "/v1/self-control/approvals/{}/decision",
                    path_segment(&params.approval_id)
                ),
                Value::Object(body),
            )
            .await?,
        ))
    }

    #[tool(description = "Apply an approval decision through self-control policy checks")]
    async fn decide_approval_with_policy(
        &self,
        Parameters(params): Parameters<DecideApprovalWithPolicyToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let approval_id = params.approval_id.clone();
        let mut body = json_object(params)?;
        body.remove("approvalId");
        Ok(json_tool_result(
            self.post_json(
                &format!(
                    "/v1/self-control/approvals/{}/decision",
                    path_segment(&approval_id)
                ),
                Value::Object(body),
            )
            .await?,
        ))
    }

    #[tool(description = "Replay gateway-owned self-control events")]
    async fn list_events(
        &self,
        Parameters(params): Parameters<ListEventsToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let path = append_query(
            "/v1/self-control/events",
            [
                ("cursor", params.cursor.map(|cursor| cursor.to_string())),
                ("projectId", params.project_id),
                ("threadId", params.thread_id),
                ("excludeThreadId", params.exclude_thread_id),
            ],
        );
        Ok(json_tool_result(self.get_json(&path).await?))
    }

    #[tool(description = "Wait with bounded polling until a thread is idle")]
    async fn wait_for_thread_idle(
        &self,
        Parameters(params): Parameters<WaitForThreadIdleToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let deadline = wait_deadline(params.timeout_ms);
        let poll = poll_interval(params.poll_interval_ms);
        let path = format!(
            "/v1/self-control/threads/{}",
            path_segment(&params.thread_id)
        );
        loop {
            let response = self.get_json(&path).await?;
            if thread_is_idle(&response) {
                return Ok(json_tool_result(json!({
                    "status": "matched",
                    "condition": "threadIdle",
                    "threadId": params.thread_id,
                    "response": response,
                })));
            }
            if Instant::now() >= deadline {
                return Ok(json_tool_result(wait_timeout_json(
                    "threadIdle",
                    params.timeout_ms,
                    Some(params.thread_id),
                    response,
                )));
            }
            sleep(poll).await;
        }
    }

    #[tool(description = "Wait with bounded polling until a thread event kind is replayed")]
    async fn wait_for_thread_event(
        &self,
        Parameters(params): Parameters<WaitForThreadEventToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let deadline = wait_deadline(params.timeout_ms);
        let poll = poll_interval(params.poll_interval_ms);
        let mut cursor = params.cursor;
        let event_kind = allowed_wait_event_kind(&params.kind)?;
        loop {
            let path = append_query(
                "/v1/self-control/events",
                [
                    ("cursor", cursor.map(|cursor| cursor.to_string())),
                    ("threadId", Some(params.thread_id.clone())),
                ],
            );
            let response = self.get_json(&path).await?;
            if let Some(event) = find_event_kind(&response, event_kind) {
                return Ok(json_tool_result(json!({
                    "status": "matched",
                    "condition": "threadEvent",
                    "threadId": params.thread_id,
                    "kind": event_kind,
                    "requestedKind": params.kind,
                    "event": event,
                })));
            }
            cursor = max_event_seq(&response).or(cursor);
            if Instant::now() >= deadline {
                return Ok(json_tool_result(json!({
                    "status": "timeout",
                    "condition": "threadEvent",
                    "timeoutMs": params.timeout_ms,
                    "threadId": params.thread_id,
                    "kind": event_kind,
                    "requestedKind": params.kind,
                    "cursor": cursor,
                    "lastResponse": response,
                })));
            }
            sleep(poll).await;
        }
    }

    #[tool(description = "Wait with bounded polling until an automation records a new run")]
    async fn wait_for_automation_run(
        &self,
        Parameters(params): Parameters<WaitForAutomationRunToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let deadline = wait_deadline(params.timeout_ms);
        let poll = poll_interval(params.poll_interval_ms);
        let path = format!(
            "/v1/self-control/automations/{}",
            path_segment(&params.automation_id)
        );
        loop {
            let response = self.get_json(&path).await?;
            if automation_run_changed(
                &response,
                params.after_last_run_at.as_deref(),
                params.after_last_queued_input_id.as_deref(),
            ) {
                return Ok(json_tool_result(json!({
                    "status": "matched",
                    "condition": "automationRun",
                    "automationId": params.automation_id,
                    "response": response,
                })));
            }
            if Instant::now() >= deadline {
                return Ok(json_tool_result(json!({
                    "status": "timeout",
                    "condition": "automationRun",
                    "timeoutMs": params.timeout_ms,
                    "automationId": params.automation_id,
                    "lastResponse": response,
                })));
            }
            sleep(poll).await;
        }
    }

    #[tool(description = "Wait with bounded polling until an approval appears or reaches a status")]
    async fn wait_for_approval(
        &self,
        Parameters(params): Parameters<WaitForApprovalToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let deadline = wait_deadline(params.timeout_ms);
        let poll = poll_interval(params.poll_interval_ms);
        let status = params.status.as_deref().unwrap_or("pending");
        loop {
            let response = if let Some(approval_id) = &params.approval_id {
                self.get_json(&format!(
                    "/v1/self-control/approvals/{}",
                    path_segment(approval_id)
                ))
                .await?
            } else {
                self.get_json(&append_query(
                    "/v1/self-control/approvals",
                    [
                        ("status", Some(status.to_string())),
                        ("threadId", params.thread_id.clone()),
                    ],
                ))
                .await?
            };
            if approval_matches(&response, status, params.approval_id.is_some()) {
                return Ok(json_tool_result(json!({
                    "status": "matched",
                    "condition": "approval",
                    "approvalId": params.approval_id,
                    "threadId": params.thread_id,
                    "response": response,
                })));
            }
            if Instant::now() >= deadline {
                return Ok(json_tool_result(json!({
                    "status": "timeout",
                    "condition": "approval",
                    "timeoutMs": params.timeout_ms,
                    "approvalId": params.approval_id,
                    "threadId": params.thread_id,
                    "lastResponse": response,
                })));
            }
            sleep(poll).await;
        }
    }

    #[tool(description = "Wait with bounded polling until a thread queue is empty")]
    async fn wait_for_queue_empty(
        &self,
        Parameters(params): Parameters<WaitForQueueEmptyToolParams>,
    ) -> Result<CallToolResult, McpError> {
        let deadline = wait_deadline(params.timeout_ms);
        let poll = poll_interval(params.poll_interval_ms);
        let path = format!(
            "/v1/self-control/threads/{}/queued-inputs",
            path_segment(&params.thread_id)
        );
        loop {
            let response = self.get_json(&path).await?;
            if queue_is_empty(&response) {
                return Ok(json_tool_result(json!({
                    "status": "matched",
                    "condition": "queueEmpty",
                    "threadId": params.thread_id,
                    "response": response,
                })));
            }
            if Instant::now() >= deadline {
                return Ok(json_tool_result(wait_timeout_json(
                    "queueEmpty",
                    params.timeout_ms,
                    Some(params.thread_id),
                    response,
                )));
            }
            sleep(poll).await;
        }
    }
}

#[tool_handler]
impl ServerHandler for KodexControlMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(
            Implementation::new("kodex-control", env!("CARGO_PKG_VERSION"))
                .with_title("Kodex Control"),
        )
        .with_instructions(
            "Guarded tools and read-only resources for controlling the local Kodex gateway."
                .to_string(),
        )
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        Ok(ListResourcesResult {
            resources: vec![
                Self::resource("kodex://status", "Kodex status"),
                Self::resource("kodex://projects", "Kodex projects"),
                Self::resource("kodex://threads", "Kodex threads"),
                Self::resource("kodex://sidebar/threads", "Kodex sidebar threads"),
                Self::resource("kodex://automations", "Kodex automations"),
                Self::resource("kodex://approvals", "Kodex approvals"),
                Self::resource("kodex://events", "Kodex events"),
            ],
            next_cursor: None,
            meta: None,
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: rmcp::service::RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, McpError> {
        let value = match request.uri.as_str() {
            "kodex://status" => self.get_json("/v1/self-control/status").await?,
            "kodex://projects" => self.get_json("/v1/self-control/projects").await?,
            "kodex://threads" => self.get_json("/v1/self-control/threads").await?,
            "kodex://sidebar/threads" => self.get_json("/v1/self-control/sidebar/threads").await?,
            "kodex://automations" => self.get_json("/v1/self-control/automations").await?,
            "kodex://approvals" => self.get_json("/v1/self-control/approvals").await?,
            "kodex://events" => self.get_json("/v1/self-control/events").await?,
            uri if uri.starts_with("kodex://projects/") && uri.ends_with("/previews") => {
                let project_id = uri
                    .trim_start_matches("kodex://projects/")
                    .trim_end_matches("/previews");
                self.get_json(&format!(
                    "/v1/self-control/projects/{}/previews",
                    path_segment(project_id)
                ))
                .await?
            }
            uri if uri.starts_with("kodex://projects/") => {
                let project_id = uri.trim_start_matches("kodex://projects/");
                self.get_json(&format!(
                    "/v1/self-control/projects/{}",
                    path_segment(project_id)
                ))
                .await?
            }
            uri if uri.starts_with("kodex://threads?") => {
                let query = uri.trim_start_matches("kodex://threads?");
                self.get_json(&format!("/v1/self-control/threads?{query}"))
                    .await?
            }
            uri if uri.starts_with("kodex://threads/") && uri.ends_with("/timeline") => {
                let thread_id = uri
                    .trim_start_matches("kodex://threads/")
                    .trim_end_matches("/timeline");
                self.get_json(&format!(
                    "/v1/self-control/threads/{}/timeline/pages",
                    path_segment(thread_id)
                ))
                .await?
            }
            uri if uri.starts_with("kodex://threads/") && uri.ends_with("/subagents") => {
                let thread_id = uri
                    .trim_start_matches("kodex://threads/")
                    .trim_end_matches("/subagents");
                self.get_json(&format!(
                    "/v1/self-control/threads/{}/subagents",
                    path_segment(thread_id)
                ))
                .await?
            }
            uri if uri.starts_with("kodex://threads/") && uri.ends_with("/queued-inputs") => {
                let thread_id = uri
                    .trim_start_matches("kodex://threads/")
                    .trim_end_matches("/queued-inputs");
                self.get_json(&format!(
                    "/v1/self-control/threads/{}/queued-inputs",
                    path_segment(thread_id)
                ))
                .await?
            }
            uri if uri.starts_with("kodex://threads/") && uri.ends_with("/app-surface") => {
                let thread_id = uri
                    .trim_start_matches("kodex://threads/")
                    .trim_end_matches("/app-surface");
                self.get_json(&format!(
                    "/v1/self-control/threads/{}/app-surface",
                    path_segment(thread_id)
                ))
                .await?
            }
            uri if uri.starts_with("kodex://threads/") && uri.ends_with("/generated-ui") => {
                let thread_id = uri
                    .trim_start_matches("kodex://threads/")
                    .trim_end_matches("/generated-ui");
                self.get_json(&format!(
                    "/v1/self-control/threads/{}/app-surface",
                    path_segment(thread_id)
                ))
                .await?
            }
            uri if uri.starts_with("kodex://threads/") => {
                let thread_id = uri.trim_start_matches("kodex://threads/");
                self.get_json(&format!(
                    "/v1/self-control/threads/{}",
                    path_segment(thread_id)
                ))
                .await?
            }
            uri if uri.starts_with("kodex://automations/") => {
                let automation_id = uri.trim_start_matches("kodex://automations/");
                self.get_json(&format!(
                    "/v1/self-control/automations/{}",
                    path_segment(automation_id)
                ))
                .await?
            }
            uri if uri.starts_with("kodex://approvals/") => {
                let approval_id = uri.trim_start_matches("kodex://approvals/");
                self.get_json(&format!(
                    "/v1/self-control/approvals/{}",
                    path_segment(approval_id)
                ))
                .await?
            }
            uri => {
                return Err(McpError::resource_not_found(
                    "resource not found",
                    Some(json!({ "uri": uri })),
                ));
            }
        };
        Ok(ReadResourceResult::new(vec![ResourceContents::text(
            value.to_string(),
            request.uri,
        )]))
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: rmcp::service::RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, McpError> {
        Ok(ListResourceTemplatesResult {
            resource_templates: vec![
                Self::template("kodex://projects/{projectId}", "Kodex project"),
                Self::template(
                    "kodex://projects/{projectId}/previews",
                    "Kodex project previews",
                ),
                Self::template(
                    "kodex://threads?projectId={projectId}",
                    "Kodex project threads",
                ),
                Self::template("kodex://threads/{threadId}", "Kodex thread"),
                Self::template(
                    "kodex://threads/{threadId}/timeline",
                    "Kodex thread timeline",
                ),
                Self::template(
                    "kodex://threads/{threadId}/subagents",
                    "Kodex thread subagents",
                ),
                Self::template(
                    "kodex://threads/{threadId}/queued-inputs",
                    "Kodex queued thread inputs",
                ),
                Self::template(
                    "kodex://threads/{threadId}/app-surface",
                    "Kodex app surface pane",
                ),
                Self::template("kodex://automations/{automationId}", "Kodex automation"),
                Self::template("kodex://approvals/{approvalId}", "Kodex approval"),
                Self::template("kodex://events?threadId={threadId}", "Kodex thread events"),
            ],
            next_cursor: None,
            meta: None,
        })
    }
}

pub async fn run_kodex_control_stdio() -> anyhow::Result<()> {
    let service = KodexControlMcp::from_env().map_err(|error| anyhow::anyhow!(error))?;
    let server = service.serve(rmcp::transport::stdio()).await?;
    server.waiting().await?;
    Ok(())
}

pub fn validate_gateway_url(value: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(value).map_err(|error| error.to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("gateway URL must use http or https".to_string());
    }
    let Some(host) = parsed.host_str() else {
        return Err("gateway URL must include a host".to_string());
    };
    if is_loopback_host(host)
        || std::env::var("KODEX_ALLOW_REMOTE_SELF_CONTROL")
            .ok()
            .as_deref()
            == Some("1")
    {
        return Ok(());
    }
    Err("refusing non-loopback gateway URL without KODEX_ALLOW_REMOTE_SELF_CONTROL=1".to_string())
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn json_object<T: Serialize>(value: T) -> Result<Map<String, Value>, McpError> {
    match serde_json::to_value(value).map_err(json_encode_error)? {
        Value::Object(object) => Ok(object),
        _ => Err(McpError::internal_error(
            "tool parameters did not encode to a JSON object",
            None,
        )),
    }
}

fn spawn_thread_body(params: SpawnThreadToolParams) -> Result<Map<String, Value>, McpError> {
    let mut body = json_object(params)?;
    if let Some(creation_options) = body.remove("creationOptions") {
        let Value::Object(options) = creation_options else {
            return Err(McpError::invalid_params(
                "creationOptions must be a JSON object",
                Some(json!({ "field": "creationOptions" })),
            ));
        };
        for (key, value) in options {
            body.entry(key).or_insert(value);
        }
    }
    Ok(body)
}

async fn upsert_generated_ui_tool(
    service: &KodexControlMcp,
    params: GeneratedUiToolParams,
    meta: Meta,
) -> Result<CallToolResult, McpError> {
    let warnings = generated_ui_bridge_warnings(&params.html);
    let fallback_content = format!("Interactive generated UI: {}", params.title);
    let mut value = upsert_app_surface_value(
        service,
        AppSurfaceToolParams {
            thread_id: params.thread_id,
            title: params.title,
            html: params.html,
            fallback_content,
            presentation: params.presentation,
            display_modes: Vec::new(),
            csp: None,
            grants: Some(json!({"canSendMessage": true})),
            provenance: None,
            source: params.source,
            max_self_control_depth: params.max_self_control_depth,
            extra: params.extra,
        },
        meta,
    )
    .await?;
    if !warnings.is_empty() {
        if let Value::Object(object) = &mut value {
            object.insert("warnings".to_string(), json!(warnings));
        }
    }
    Ok(json_tool_result(value))
}

async fn upsert_app_surface_tool(
    service: &KodexControlMcp,
    params: AppSurfaceToolParams,
    meta: Meta,
) -> Result<CallToolResult, McpError> {
    Ok(json_tool_result(
        upsert_app_surface_value(service, params, meta).await?,
    ))
}

async fn show_app_surface_tool(
    service: &KodexControlMcp,
    params: AppSurfacePresentationToolParams,
    meta: Meta,
) -> Result<CallToolResult, McpError> {
    let thread_id = resolve_app_surface_thread_id(params.thread_id.clone(), &meta)?;
    let mut body = json_object(params)?;
    body.remove("threadId");
    normalize_self_control_source_shorthand(&mut body)?;
    Ok(json_tool_result(
        service
            .post_json(
                &format!(
                    "/v1/self-control/threads/{}/app-surface/presentation",
                    path_segment(&thread_id)
                ),
                Value::Object(body),
            )
            .await?,
    ))
}

async fn upsert_app_surface_value(
    service: &KodexControlMcp,
    params: AppSurfaceToolParams,
    meta: Meta,
) -> Result<Value, McpError> {
    let thread_id = resolve_app_surface_thread_id(params.thread_id.clone(), &meta)?;
    let mut body = json_object(params)?;
    body.remove("threadId");
    normalize_self_control_source_shorthand(&mut body)?;
    service
        .post_json(
            &format!(
                "/v1/self-control/threads/{}/app-surface",
                path_segment(&thread_id)
            ),
            Value::Object(body),
        )
        .await
}

fn generated_ui_bridge_warnings(html: &str) -> Vec<String> {
    generated_ui_post_message_types(html)
        .into_iter()
        .filter(|event_type| event_type.starts_with("kodex") && !is_known_generated_ui_event_type(event_type))
        .map(|event_type| {
            format!(
                "Unrecognized generated UI postMessage event type `{event_type}`; use `window.kodex.submitMessage(message, metadata)` or post `{{ type: \"kodex.generatedUi.submit\", message, metadata }}`."
            )
        })
        .collect()
}

fn generated_ui_post_message_types(html: &str) -> Vec<String> {
    let mut types = Vec::new();
    let mut remaining = html;
    while let Some(post_message_index) = remaining.find("postMessage") {
        remaining = &remaining[post_message_index + "postMessage".len()..];
        let Some(type_index) = remaining.find("type") else {
            break;
        };
        remaining = &remaining[type_index + "type".len()..];
        let Some(colon_index) = remaining.find(':') else {
            continue;
        };
        remaining = &remaining[colon_index + 1..];
        let trimmed = remaining.trim_start();
        let quote = match trimmed.as_bytes().first() {
            Some(b'"') => '"',
            Some(b'\'') => '\'',
            _ => continue,
        };
        let value_start = quote.len_utf8();
        if let Some(value_end) = trimmed[value_start..].find(quote) {
            types.push(trimmed[value_start..value_start + value_end].to_string());
            remaining = &trimmed[value_start + value_end + quote.len_utf8()..];
        }
    }
    types
}

fn is_known_generated_ui_event_type(event_type: &str) -> bool {
    matches!(
        event_type,
        "kodex.generatedUi.submit" | "kodex:generated-ui:submit" | "kodex.ui.submit"
    )
}

fn resolve_app_surface_thread_id(
    explicit_thread_id: Option<String>,
    meta: &Meta,
) -> Result<String, McpError> {
    if let Some(thread_id) = explicit_thread_id {
        return validate_app_surface_thread_id(thread_id, "threadId");
    }

    match meta.0.get(MCP_TOOL_THREAD_ID_META_KEY) {
        Some(Value::String(thread_id)) => {
            validate_app_surface_thread_id(thread_id.clone(), "_meta.threadId")
        }
        Some(_) => Err(McpError::invalid_params(
            "MCP _meta.threadId must be a string",
            Some(json!({ "field": "_meta.threadId" })),
        )),
        None => Err(McpError::invalid_params(
            "threadId is required when MCP _meta.threadId is unavailable",
            Some(json!({ "field": "threadId" })),
        )),
    }
}

fn validate_app_surface_thread_id(
    thread_id: String,
    field: &'static str,
) -> Result<String, McpError> {
    if thread_id.trim().is_empty() {
        return Err(McpError::invalid_params(
            format!("{field} must not be empty"),
            Some(json!({ "field": field })),
        ));
    }
    Ok(thread_id)
}

fn normalize_self_control_source_shorthand(body: &mut Map<String, Value>) -> Result<(), McpError> {
    let Some(source) = body.get_mut("source") else {
        return Ok(());
    };
    match source {
        Value::String(source_id) => {
            let source_id = source_id.trim();
            if source_id.is_empty() {
                return Err(McpError::invalid_params(
                    "source string must not be empty",
                    Some(json!({ "field": "source" })),
                ));
            }
            *source = json!({
                "sourceType": "kodex_control",
                "sourceToolCallId": source_id
            });
            Ok(())
        }
        Value::Object(_) => Ok(()),
        _ => Err(McpError::invalid_params(
            "source must be a string shorthand or self-control provenance object",
            Some(json!({ "field": "source" })),
        )),
    }
}

fn json_encode_error(error: serde_json::Error) -> McpError {
    McpError::internal_error(
        "failed to encode tool parameters",
        Some(json!({ "error": error.to_string() })),
    )
}

fn json_tool_result(value: Value) -> CallToolResult {
    CallToolResult::success(vec![Content::text(value.to_string())])
}

fn append_query<I, K>(path: &str, params: I) -> String
where
    I: IntoIterator<Item = (K, Option<String>)>,
    K: AsRef<str>,
{
    let mut first = !path.contains('?');
    let mut result = path.to_string();
    for (key, value) in params {
        let Some(value) = value else {
            continue;
        };
        if first {
            result.push('?');
            first = false;
        } else {
            result.push('&');
        }
        result.push_str(&percent_encode(key.as_ref()));
        result.push('=');
        result.push_str(&percent_encode(&value));
    }
    result
}

fn path_segment(value: &str) -> String {
    percent_encode(value)
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push('%');
                encoded.push(hex_digit(byte >> 4));
                encoded.push(hex_digit(byte & 0x0f));
            }
        }
    }
    encoded
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        10..=15 => (b'A' + value - 10) as char,
        _ => unreachable!("hex digit nibble"),
    }
}

fn wait_deadline(timeout_ms: u64) -> Instant {
    Instant::now() + Duration::from_millis(timeout_ms.min(60_000))
}

fn poll_interval(poll_interval_ms: Option<u64>) -> Duration {
    Duration::from_millis(poll_interval_ms.unwrap_or(500).clamp(25, 5_000))
}

fn wait_timeout_json(
    condition: &str,
    timeout_ms: u64,
    thread_id: Option<String>,
    last_response: Value,
) -> Value {
    json!({
        "status": "timeout",
        "condition": condition,
        "timeoutMs": timeout_ms,
        "threadId": thread_id,
        "lastResponse": last_response,
    })
}

fn thread_is_idle(value: &Value) -> bool {
    status_type(value, "/thread/status/type")
        .or_else(|| status_type(value, "/status/type"))
        .or_else(|| status_type(value, "/thread/liveState"))
        .or_else(|| status_type(value, "/liveState"))
        .is_some_and(|status| status.eq_ignore_ascii_case("idle"))
}

fn status_type<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer).and_then(Value::as_str)
}

fn find_event_kind(value: &Value, kind: &str) -> Option<Value> {
    value
        .get("events")
        .and_then(Value::as_array)?
        .iter()
        .find(|event| event.get("kind").and_then(Value::as_str) == Some(kind))
        .cloned()
}

fn allowed_wait_event_kind(kind: &str) -> Result<&'static str, McpError> {
    match kind {
        "threadUpserted" | "thread.upserted" => Ok("thread.upserted"),
        "threadReadUpdated" | "thread.read_updated" => Ok("thread.read_updated"),
        "threadViewPatch" | "thread_view.patch" => Ok("thread_view.patch"),
        "threadViewItemDelta" | "thread_view.item_delta" => Ok("thread_view.item_delta"),
        "threadViewRefreshRequired" | "thread_view.refresh_required" => {
            Ok("thread_view.refresh_required")
        }
        "queueItemUpsert" | "turn_queue.item_upsert" => Ok("turn_queue.item_upsert"),
        "queueItemDeleted" | "turn_queue.item_deleted" => Ok("turn_queue.item_deleted"),
        "approvalCreated" | "approval.created" => Ok("approval.created"),
        "approvalResolved" | "approval.resolved" => Ok("approval.resolved"),
        "automationUpserted" | "automation.item_upsert" => Ok("automation.item_upsert"),
        "automationDeleted" | "automation.item_deleted" => Ok("automation.item_deleted"),
        _ => Err(McpError::invalid_params(
            "unsupported wait event kind",
            Some(json!({
                "kind": kind,
                "allowedKinds": [
                    "threadUpserted",
                    "threadReadUpdated",
                    "threadViewPatch",
                    "threadViewItemDelta",
                    "threadViewRefreshRequired",
                    "queueItemUpsert",
                    "queueItemDeleted",
                    "approvalCreated",
                    "approvalResolved",
                    "automationUpserted",
                    "automationDeleted"
                ]
            })),
        )),
    }
}

fn max_event_seq(value: &Value) -> Option<i64> {
    value
        .get("events")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|event| event.get("seq").and_then(Value::as_i64))
        .max()
}

fn automation_run_changed(
    value: &Value,
    after_last_run_at: Option<&str>,
    after_last_queued_input_id: Option<&str>,
) -> bool {
    let automation = value.get("automation").unwrap_or(value);
    let last_run_at = automation.get("lastRunAt").and_then(Value::as_str);
    let last_queued_input_id = automation.get("lastQueuedInputId").and_then(Value::as_str);
    last_run_at.is_some_and(|last| after_last_run_at != Some(last))
        || last_queued_input_id.is_some_and(|last| after_last_queued_input_id != Some(last))
}

fn approval_matches(value: &Value, status: &str, single_approval: bool) -> bool {
    if single_approval {
        return value
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|actual| actual == status);
    }
    value
        .get("approvals")
        .and_then(Value::as_array)
        .is_some_and(|approvals| !approvals.is_empty())
}

fn queue_is_empty(value: &Value) -> bool {
    for key in ["queuedInputs", "queued_inputs", "queue", "items"] {
        if let Some(items) = value.get(key).and_then(Value::as_array) {
            return items.is_empty();
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        api::build_router,
        app_server::{tests::RecordingAppServer, UnavailableAppServer},
        config::Config,
        error::ApiError,
        store::Store,
    };
    use serde_json::json;
    use std::sync::Arc;
    use tokio::net::TcpListener;

    #[test]
    fn gateway_url_accepts_loopback_defaults() {
        validate_gateway_url("http://127.0.0.1:8787").unwrap();
        validate_gateway_url("http://localhost:8787").unwrap();
        validate_gateway_url("http://[::1]:8787").unwrap();
    }

    #[test]
    fn gateway_url_rejects_non_loopback_without_opt_in() {
        let error = validate_gateway_url("https://example.com").unwrap_err();
        assert!(error.contains("non-loopback"));
        let error = validate_gateway_url("http://127.0.0.1.evil.example").unwrap_err();
        assert!(error.contains("non-loopback"));
    }

    #[tokio::test]
    async fn mcp_server_lists_tools_reads_status_and_calls_preview_apply() -> anyhow::Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let gateway_url = format!("http://{}", listener.local_addr()?);
        let state = crate::AppState::new(
            Config::default(),
            Store::in_memory().await?,
            Arc::new(UnavailableAppServer),
        );
        let project = state
            .store
            .create_project(
                "Kodex".to_string(),
                std::env::current_dir()?.display().to_string(),
            )
            .await?;
        let router = build_router(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await });
        let service = KodexControlMcp::for_test(gateway_url);
        let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
        let mcp_server = tokio::spawn(async move {
            let server = service.serve(server_transport).await?;
            server.waiting().await?;
            anyhow::Ok(())
        });
        let client = ().serve(client_transport).await?;

        let tools = client.list_all_tools().await?;
        assert!(tools.iter().any(|tool| tool.name == "get_status"));
        assert_tool_requires(&tools, "create_thread", &["projectId"]);
        assert_tool_requires(&tools, "send_thread_input", &["threadId", "input"]);
        assert_tool_requires(
            &tools,
            "open_app_surface",
            &["title", "html", "fallbackContent"],
        );
        assert_tool_does_not_require(&tools, "open_app_surface", "threadId");
        assert_tool_description_contains(
            &tools,
            "open_app_surface",
            &[
                "MCP App-compatible HTML",
                "JSON-RPC bridge",
                "declared grants",
                "fallbackContent",
            ],
        );
        assert_tool_description_contains(
            &tools,
            "show_app_surface",
            &["action \"open\"", "or \"focus\""],
        );
        assert_tool_requires(&tools, "open_generated_ui", &["title", "html"]);
        assert_tool_does_not_require(&tools, "open_generated_ui", "threadId");
        assert_tool_description_contains(
            &tools,
            "open_generated_ui",
            &[
                "Buttons are not inherently prompts",
                "local UI interactions",
                "conversational actions",
                "standalone human-readable message",
                "window.kodex.submitMessage(message, metadata)",
                "kodex.generatedUi.submit",
                "Strongly prefer a theme-native UI",
                "Kodex semantic CSS variables",
                "avoid inventing custom palettes",
            ],
        );
        assert_tool_description_contains(
            &tools,
            "update_generated_ui",
            &[
                "Buttons are not inherently prompts",
                "local UI interactions",
                "conversational actions",
                "standalone human-readable message",
                "window.kodex.submitMessage(message, metadata)",
                "kodex.generatedUi.submit",
                "Strongly prefer a theme-native UI",
                "Kodex semantic CSS variables",
                "avoid inventing custom palettes",
            ],
        );
        assert_tool_description_contains(&tools, "show_generated_ui", &["show_app_surface"]);
        assert_tool_requires(&tools, "pause_automation", &["automationId"]);
        assert_tool_requires(&tools, "resume_automation", &["automationId"]);
        let status_resource = client
            .read_resource(ReadResourceRequestParams::new("kodex://status"))
            .await?;
        let ResourceContents::TextResourceContents { text, .. } = &status_resource.contents[0]
        else {
            panic!("expected text resource");
        };
        assert!(text.contains("\"gatewayReady\":true"));

        let mut arguments = JsonObject::new();
        arguments.insert("projectId".to_string(), json!(project.id));
        arguments.insert("dryRun".to_string(), json!(true));
        arguments.insert(
            "services".to_string(),
            json!([{"name": "frontend", "localPort": 4000}]),
        );
        arguments.insert(
            "previews".to_string(),
            json!([{"name": "app", "publicPort": 13000, "rootServiceName": "frontend"}]),
        );
        let result = client
            .call_tool(
                CallToolRequestParams::new("apply_project_preview_config")
                    .with_arguments(arguments),
            )
            .await?;
        let value: Value = result.into_typed()?;
        assert_eq!(value["dryRun"], true);
        assert_eq!(value["diff"][0]["action"], "created");

        let mut generated_ui_args = JsonObject::new();
        generated_ui_args.insert("title".to_string(), json!("Mockups"));
        generated_ui_args.insert("source".to_string(), json!("codex"));
        generated_ui_args.insert(
            "html".to_string(),
            json!("<!doctype html><button>Choose</button><script>window.parent.postMessage({type:'kodex:submit-message', message:'Choose'}, '*')</script>"),
        );
        let mut generated_ui_meta = JsonObject::new();
        generated_ui_meta.insert("threadId".to_string(), json!("thread-1"));
        let mut generated_ui_call =
            CallToolRequestParams::new("open_generated_ui").with_arguments(generated_ui_args);
        generated_ui_call.set_meta(Meta(generated_ui_meta));
        let opened: Value = client.call_tool(generated_ui_call).await?.into_typed()?;
        assert_eq!(opened["session"]["threadId"], "thread-1");
        assert_eq!(opened["session"]["revision"], 1);
        assert!(opened["session"].get("html").is_none());
        assert_eq!(
            opened["warnings"][0],
            "Unrecognized generated UI postMessage event type `kodex:submit-message`; use `window.kodex.submitMessage(message, metadata)` or post `{ type: \"kodex.generatedUi.submit\", message, metadata }`."
        );
        let audit_events = state
            .store
            .replay_events(None, None, Some("thread-1".to_string()))
            .await?;
        let generated_ui_audit = audit_events
            .iter()
            .find(|event| event.kind == "self_control.app_surface_upserted")
            .expect("app surface audit event");
        assert_eq!(
            generated_ui_audit.payload["source"]["sourceToolCallId"],
            "codex"
        );

        let read_generated_ui_args = JsonObject::new();
        let mut read_generated_ui_meta = JsonObject::new();
        read_generated_ui_meta.insert("threadId".to_string(), json!("thread-1"));
        let mut read_generated_ui_call =
            CallToolRequestParams::new("get_generated_ui").with_arguments(read_generated_ui_args);
        read_generated_ui_call.set_meta(Meta(read_generated_ui_meta));
        let read: Value = client
            .call_tool(read_generated_ui_call)
            .await?
            .into_typed()?;
        assert_eq!(read["session"]["title"], "Mockups");

        client.cancel().await?;
        mcp_server.abort();
        server.abort();
        Ok(())
    }

    #[tokio::test]
    async fn mcp_gateway_errors_include_non_json_status_and_body() -> anyhow::Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let gateway_url = format!("http://{}", listener.local_addr()?);
        let router = axum::Router::new().route(
            "/plain-error",
            axum::routing::get(|| async { (axum::http::StatusCode::BAD_GATEWAY, "upstream down") }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, router).await });
        let service = KodexControlMcp::for_test(gateway_url);

        let error = service.get_json("/plain-error").await.unwrap_err();

        assert_eq!(error.message, "gateway returned an error");
        assert_eq!(error.data.as_ref().unwrap()["status"], 502);
        assert_eq!(error.data.as_ref().unwrap()["body"], "upstream down");
        server.abort();
        Ok(())
    }

    #[tokio::test]
    async fn mcp_thread_tools_create_and_start_new_unmaterialized_thread() -> anyhow::Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let gateway_url = format!("http://{}", listener.local_addr()?);
        let app_server = Arc::new(RecordingAppServer::default());
        app_server
            .ready
            .store(true, std::sync::atomic::Ordering::SeqCst);
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"thread": test_mcp_thread("thread-1"), "cwd": "/workspace"}));
        let state = crate::AppState::new(
            Config::default(),
            Store::in_memory().await?,
            app_server.clone(),
        );
        let project = state
            .store
            .create_project("Kodex".to_string(), "/workspace".to_string())
            .await?;
        let router = build_router(state);
        let server = tokio::spawn(async move { axum::serve(listener, router).await });
        let service = KodexControlMcp::for_test(gateway_url);
        let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
        let mcp_server = tokio::spawn(async move {
            let server = service.serve(server_transport).await?;
            server.waiting().await?;
            anyhow::Ok(())
        });
        let client = ().serve(client_transport).await?;

        let mut create_args = JsonObject::new();
        create_args.insert("projectId".to_string(), json!(project.id));
        let created: Value = client
            .call_tool(CallToolRequestParams::new("create_thread").with_arguments(create_args))
            .await?
            .into_typed()?;
        assert_eq!(created["thread"]["id"], "thread-1");

        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(
                "app-server error -32600: thread thread-1 is not materialized yet; includeTurns is unavailable before first user message".to_string(),
            ));
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"turnId": "turn-started"}));
        let mut input_args = JsonObject::new();
        input_args.insert("threadId".to_string(), json!("thread-1"));
        input_args.insert(
            "input".to_string(),
            json!([{"type": "text", "text": "start now"}]),
        );
        let started: Value = client
            .call_tool(CallToolRequestParams::new("send_thread_input").with_arguments(input_args))
            .await?
            .into_typed()?;
        assert_eq!(started["action"], "started");
        assert!(started["queuedInput"].is_null());

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/start");
        assert_eq!(requests[1].0, "thread/read");
        assert_eq!(requests[2].0, "turn/start");
        assert_eq!(requests[2].1["input"][0]["text"], "start now");

        client.cancel().await?;
        mcp_server.abort();
        server.abort();
        Ok(())
    }

    fn assert_tool_requires(tools: &[Tool], name: &str, required_fields: &[&str]) {
        let tool = tools
            .iter()
            .find(|tool| tool.name == name)
            .unwrap_or_else(|| panic!("missing tool {name}"));
        let required = tool
            .input_schema
            .get("required")
            .and_then(Value::as_array)
            .unwrap_or_else(|| panic!("{name} tool schema missing required fields"));
        for field in required_fields {
            assert!(
                required.iter().any(|value| value.as_str() == Some(field)),
                "{name} tool schema should require {field}; schema: {:?}",
                tool.input_schema
            );
        }
        let properties = tool
            .input_schema
            .get("properties")
            .and_then(Value::as_object)
            .unwrap_or_else(|| panic!("{name} tool schema missing properties"));
        for field in required_fields {
            assert!(
                properties.contains_key(*field),
                "{name} tool schema should define {field}; schema: {:?}",
                tool.input_schema
            );
        }
    }

    fn assert_tool_does_not_require(tools: &[Tool], name: &str, field: &str) {
        let tool = tools
            .iter()
            .find(|tool| tool.name == name)
            .unwrap_or_else(|| panic!("missing tool {name}"));
        let required = tool
            .input_schema
            .get("required")
            .and_then(Value::as_array)
            .unwrap_or_else(|| panic!("{name} tool schema missing required fields"));
        assert!(
            !required.iter().any(|value| value.as_str() == Some(field)),
            "{name} tool schema should not require {field}; schema: {:?}",
            tool.input_schema
        );
    }

    fn assert_tool_description_contains(tools: &[Tool], name: &str, expected: &[&str]) {
        let tool = tools
            .iter()
            .find(|tool| tool.name == name)
            .unwrap_or_else(|| panic!("missing tool {name}"));
        let description = tool
            .description
            .as_deref()
            .unwrap_or_else(|| panic!("{name} tool missing description"));
        for text in expected {
            assert!(
                description.contains(text),
                "{name} tool description should contain {text:?}; description: {description:?}",
            );
        }
    }

    fn test_mcp_thread(id: &str) -> Value {
        json!({
            "id": id,
            "cliVersion": "0.135.0",
            "cwd": "/workspace",
            "ephemeral": false,
            "modelProvider": "openai",
            "preview": "",
            "source": "vscode",
            "status": {"type": "idle"},
            "turns": [],
            "createdAt": 1_767_225_600_i64,
            "updatedAt": 1_767_225_600_i64
        })
    }
}
