use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars, tool, tool_handler, tool_router, ErrorData as McpError, RoleServer, ServerHandler,
    ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

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
        let value = response.json::<Value>().await.map_err(|error| {
            McpError::internal_error(
                "gateway returned invalid JSON",
                Some(json!({ "error": error.to_string() })),
            )
        })?;
        if !status.is_success() {
            return Err(McpError::internal_error(
                "gateway returned an error",
                Some(json!({ "status": status.as_u16(), "body": value })),
            ));
        }
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
                &format!("/v1/self-control/threads/{thread_id}/input"),
                Value::Object(body),
            )
            .await?,
        ))
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
                &format!("/v1/self-control/automations/{automation_id}"),
                Value::Object(body),
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
                &format!("/v1/self-control/automations/{automation_id}/pause"),
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
                &format!("/v1/self-control/automations/{automation_id}/resume"),
                json!({}),
            )
            .await?,
        ))
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
                Self::resource("kodex://automations", "Kodex automations"),
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
            "kodex://projects" => self.get_json("/v1/projects").await?,
            "kodex://automations" => self.get_json("/v1/automations").await?,
            uri if uri.starts_with("kodex://projects/") && uri.ends_with("/previews") => {
                let project_id = uri
                    .trim_start_matches("kodex://projects/")
                    .trim_end_matches("/previews");
                self.get_json(&format!("/v1/projects/{project_id}/previews"))
                    .await?
            }
            uri if uri.starts_with("kodex://projects/") => {
                let project_id = uri.trim_start_matches("kodex://projects/");
                self.get_json(&format!("/v1/projects/{project_id}")).await?
            }
            uri if uri.starts_with("kodex://threads/") => {
                let thread_id = uri.trim_start_matches("kodex://threads/");
                self.get_json(&format!("/v1/threads/{thread_id}")).await?
            }
            uri if uri.starts_with("kodex://automations/") => {
                let automation_id = uri.trim_start_matches("kodex://automations/");
                self.get_json(&format!("/v1/automations/{automation_id}"))
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
                Self::template("kodex://threads/{threadId}", "Kodex thread"),
                Self::template("kodex://automations/{automationId}", "Kodex automation"),
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

fn json_encode_error(error: serde_json::Error) -> McpError {
    McpError::internal_error(
        "failed to encode tool parameters",
        Some(json!({ "error": error.to_string() })),
    )
}

fn json_tool_result(value: Value) -> CallToolResult {
    CallToolResult::success(vec![Content::text(value.to_string())])
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

        let tools = client.list_all_tools().await?;
        assert!(tools.iter().any(|tool| tool.name == "get_status"));
        assert_tool_requires(&tools, "create_thread", &["projectId"]);
        assert_tool_requires(&tools, "send_thread_input", &["threadId", "input"]);
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

        client.cancel().await?;
        mcp_server.abort();
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
