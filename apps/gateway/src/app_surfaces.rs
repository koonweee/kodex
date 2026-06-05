use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api::{client as app_server_client, McpServerStatusDetail, ThreadTurnSnapshot},
    error::{ApiError, ApiResult},
    store::{
        AppSurfaceCsp, AppSurfaceGrants, AppSurfaceProvider, AppSurfaceResourceGrant,
        AppSurfaceSession, AppSurfaceSessionUpsert, AppSurfaceToolGrant,
    },
};

pub const MCP_APP_MIME_TYPE: &str = "text/html;profile=mcp-app";
pub const APP_SURFACE_HTML_MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceUiMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_uri: Option<String>,
    #[serde(default)]
    pub visibility: Vec<String>,
    #[serde(default)]
    pub csp: AppSurfaceCsp,
    #[serde(default)]
    pub raw: Value,
}

impl AppSurfaceUiMetadata {
    pub fn from_tool_meta(meta: Option<&Value>) -> Self {
        let Some(ui) = meta.and_then(|meta| meta.get("ui")) else {
            return Self::default();
        };
        Self::from_ui_value(ui)
    }

    pub fn from_resource_meta(meta: Option<&Value>) -> Self {
        let Some(ui) = meta.and_then(|meta| meta.get("ui")) else {
            return Self {
                raw: Value::Null,
                ..Self::default()
            };
        };
        Self::from_ui_value(ui)
    }

    fn from_ui_value(ui: &Value) -> Self {
        let resource_uri = ui
            .get("resourceUri")
            .and_then(Value::as_str)
            .map(str::to_string);
        let visibility = ui
            .get("visibility")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .filter(|values| !values.is_empty())
            .unwrap_or_else(|| vec!["model".to_string(), "app".to_string()]);
        let csp = ui.get("csp").map(csp_from_value).unwrap_or_default();
        Self {
            resource_uri,
            visibility,
            csp,
            raw: ui.clone(),
        }
    }

    pub fn app_visible(&self) -> bool {
        self.visibility.is_empty() || self.visibility.iter().any(|value| value == "app")
    }
}

impl Default for AppSurfaceUiMetadata {
    fn default() -> Self {
        Self {
            resource_uri: None,
            visibility: vec!["model".to_string(), "app".to_string()],
            csp: AppSurfaceCsp::default(),
            raw: Value::Null,
        }
    }
}

pub fn validate_app_surface_html(html: String) -> ApiResult<String> {
    if html.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "app surface HTML cannot be empty".to_string(),
        ));
    }
    if html.len() > APP_SURFACE_HTML_MAX_BYTES {
        return Err(ApiError::BadRequest(
            "app surface HTML exceeds the 4 MiB limit".to_string(),
        ));
    }
    Ok(html)
}

pub fn validate_app_surface_title(title: String) -> ApiResult<String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(ApiError::BadRequest(
            "app surface title cannot be empty".to_string(),
        ));
    }
    if title.len() > 120 {
        return Err(ApiError::BadRequest(
            "app surface title is too long".to_string(),
        ));
    }
    Ok(title)
}

pub fn validate_app_surface_grants(
    provider: AppSurfaceProvider,
    grants: AppSurfaceGrants,
) -> ApiResult<AppSurfaceGrants> {
    if provider == AppSurfaceProvider::Mcp
        && grants
            .tools
            .iter()
            .any(|grant| grant.server.trim().is_empty() || grant.tool.trim().is_empty())
    {
        return Err(ApiError::BadRequest(
            "MCP app surface tool grants require server and tool".to_string(),
        ));
    }
    if provider == AppSurfaceProvider::Generated
        && grants
            .tools
            .iter()
            .any(|grant| grant.server.trim().is_empty() || grant.tool.trim().is_empty())
    {
        return Err(ApiError::BadRequest(
            "generated app surface tool grants require server and tool".to_string(),
        ));
    }
    Ok(grants)
}

pub fn app_surface_csp(csp: &AppSurfaceCsp) -> String {
    let connect_src = csp_source_list(&csp.connect_domains, "'none'");
    let resource_src = csp_source_list(&csp.resource_domains, "data: blob:");
    format!(
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src {resource_src}; font-src data:; connect-src {connect_src}; navigate-to 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'"
    )
}

pub async fn sync_mcp_app_surfaces_for_turns(
    state: &AppState,
    thread_id: &str,
    turns: &[ThreadTurnSnapshot],
) -> ApiResult<Vec<AppSurfaceSession>> {
    let mut sessions = Vec::new();
    for turn in turns {
        for item in &turn.items {
            if let Some(session) =
                sync_mcp_app_surface_for_item(state, thread_id, &turn.id, &item.raw_payload).await?
            {
                sessions.push(session);
            }
        }
    }
    Ok(sessions)
}

pub async fn sync_mcp_app_surface_for_item(
    state: &AppState,
    thread_id: &str,
    turn_id: &str,
    item: &Value,
) -> ApiResult<Option<AppSurfaceSession>> {
    let Some(candidate) = McpAppSurfaceCandidate::from_item(turn_id, item) else {
        return Ok(None);
    };
    if let Some(latest) = state.store.latest_app_surface_session(thread_id).await? {
        if latest.provider == AppSurfaceProvider::Mcp
            && latest
                .provenance
                .get("mcp")
                .and_then(|mcp| mcp.get("signature"))
                == Some(&candidate.signature)
        {
            return Ok(None);
        }
    }
    upsert_mcp_app_surface_from_candidate(state, thread_id, candidate).await
}

async fn upsert_mcp_app_surface_from_candidate(
    state: &AppState,
    thread_id: &str,
    candidate: McpAppSurfaceCandidate,
) -> ApiResult<Option<AppSurfaceSession>> {
    let McpAppSurfaceCandidate {
        turn_id,
        item_id,
        server,
        tool,
        resource_uri,
        arguments,
        result,
        error,
        status,
        signature,
        title,
    } = candidate;
    let client = app_server_client(&state.app_server);
    let resource = client
        .mcp_resource_read(
            server.clone(),
            resource_uri.clone(),
            Some(thread_id.to_string()),
        )
        .await?;
    let Some(content) = resource.contents.into_iter().find(|content| {
        content
            .get("uri")
            .and_then(Value::as_str)
            .is_some_and(|uri| uri == resource_uri)
    }) else {
        return Err(ApiError::BadGateway(format!(
            "MCP app resource {resource_uri} was not returned by {server}"
        )));
    };
    let mime_type = content
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if mime_type != MCP_APP_MIME_TYPE {
        return Ok(None);
    }
    let Some(html) = content.get("text").and_then(Value::as_str) else {
        return Ok(None);
    };
    let html = validate_app_surface_html(html.to_string())?;
    let resource_metadata = AppSurfaceUiMetadata::from_resource_meta(
        content.get("_meta").or_else(|| content.get("meta")),
    );
    let grants = mcp_app_surface_grants(state, &server).await?;
    let title = validate_app_surface_title(title.unwrap_or_else(|| tool.clone()))?;
    let fallback_content = mcp_tool_result_content_text(result.as_ref())
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| format!("{server}.{tool} returned an interactive app."));
    let session = state
        .store
        .upsert_app_surface_session(AppSurfaceSessionUpsert {
            thread_id: thread_id.to_string(),
            provider: AppSurfaceProvider::Mcp,
            title,
            resource_uri: Some(resource_uri.clone()),
            resource_mime_type: mime_type,
            html,
            fallback_content,
            display_modes: vec!["inline".to_string(), "fullscreen".to_string()],
            csp: resource_metadata.csp,
            grants,
            provenance: serde_json::json!({
                "mcp": {
                    "server": server,
                    "tool": tool,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "resourceUri": resource_uri,
                    "arguments": arguments,
                    "result": result,
                    "error": error,
                    "status": status,
                    "signature": signature
                }
            }),
        })
        .await?;
    Ok(Some(session))
}

fn csp_from_value(value: &Value) -> AppSurfaceCsp {
    AppSurfaceCsp {
        connect_domains: string_array(value.get("connectDomains")),
        resource_domains: string_array(value.get("resourceDomains")),
    }
}

async fn mcp_app_surface_grants(
    state: &AppState,
    server_name: &str,
) -> ApiResult<AppSurfaceGrants> {
    let inventory = app_server_client(&state.app_server)
        .mcp_server_status_list(McpServerStatusDetail::Full)
        .await?;
    let Some(server) = inventory
        .servers
        .into_iter()
        .find(|server| server.name == server_name)
    else {
        return Ok(AppSurfaceGrants::default());
    };
    let tools = server
        .tools
        .into_values()
        .filter(|tool| AppSurfaceUiMetadata::from_tool_meta(tool.meta.as_ref()).app_visible())
        .map(|tool| AppSurfaceToolGrant {
            server: server_name.to_string(),
            tool: tool.name,
        })
        .collect::<Vec<_>>();
    let resources = server
        .resources
        .into_iter()
        .map(|resource| AppSurfaceResourceGrant {
            server: Some(server_name.to_string()),
            uri: resource.uri,
        })
        .collect::<Vec<_>>();
    Ok(AppSurfaceGrants {
        tools,
        resources,
        can_send_message: true,
        can_update_model_context: true,
        can_open_links: false,
    })
}

struct McpAppSurfaceCandidate {
    turn_id: String,
    item_id: String,
    server: String,
    tool: String,
    resource_uri: String,
    arguments: Option<Value>,
    result: Option<Value>,
    error: Option<Value>,
    status: Option<String>,
    signature: Value,
    title: Option<String>,
}

impl McpAppSurfaceCandidate {
    fn from_item(turn_id: &str, item: &Value) -> Option<Self> {
        let item_type = string_field(item, "type")?;
        if item_type != "mcpToolCall" {
            return None;
        }
        let item_id = string_field(item, "id")?;
        let server = string_field(item, "server")?;
        let tool = string_field(item, "tool").or_else(|| string_field(item, "toolName"))?;
        let resource_uri = mcp_app_resource_uri(item)?;
        let arguments = item.get("arguments").cloned();
        let result = item
            .get("result")
            .filter(|result| result.is_object())
            .cloned();
        let error = item.get("error").filter(|error| !error.is_null()).cloned();
        let status = string_field(item, "status");
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| item.get("name").and_then(Value::as_str))
            .map(str::to_string);
        let signature = serde_json::json!({
            "turnId": turn_id,
            "itemId": item_id,
            "server": server,
            "tool": tool,
            "resourceUri": resource_uri,
            "arguments": arguments,
            "result": result,
            "error": error,
            "status": status
        });
        Some(Self {
            turn_id: turn_id.to_string(),
            item_id,
            server,
            tool,
            resource_uri,
            arguments,
            result,
            error,
            status,
            signature,
            title,
        })
    }
}

fn mcp_app_resource_uri(item: &Value) -> Option<String> {
    string_field(item, "mcpAppResourceUri")
        .or_else(|| {
            item.get("result")
                .and_then(|result| result.get("_meta"))
                .and_then(|meta| AppSurfaceUiMetadata::from_tool_meta(Some(meta)).resource_uri)
        })
        .or_else(|| {
            item.get("_meta")
                .and_then(|meta| AppSurfaceUiMetadata::from_tool_meta(Some(meta)).resource_uri)
        })
}

fn mcp_tool_result_content_text(result: Option<&Value>) -> Option<String> {
    let content = result
        .and_then(|result| result.get("content"))
        .and_then(Value::as_array)?;
    let text = content
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .collect()
}

fn csp_source_list(values: &[String], fallback: &str) -> String {
    if values.is_empty() {
        fallback.to_string()
    } else {
        values.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn parses_mcp_apps_ui_metadata_defaults_visibility_to_model_and_app() {
        let metadata = AppSurfaceUiMetadata::from_tool_meta(Some(&json!({
            "ui": {
                "resourceUri": "ui://example/dashboard",
                "csp": {
                    "connectDomains": ["https://api.example.test"],
                    "resourceDomains": ["https://cdn.example.test"]
                }
            }
        })));

        assert_eq!(
            metadata.resource_uri.as_deref(),
            Some("ui://example/dashboard")
        );
        assert_eq!(metadata.visibility, vec!["model", "app"]);
        assert!(metadata.app_visible());
        assert_eq!(
            metadata.csp.connect_domains,
            vec!["https://api.example.test"]
        );
        assert_eq!(
            metadata.csp.resource_domains,
            vec!["https://cdn.example.test"]
        );
    }

    #[test]
    fn rejects_model_only_mcp_apps_tool_visibility_for_app_calls() {
        let metadata = AppSurfaceUiMetadata::from_tool_meta(Some(&json!({
            "ui": {
                "visibility": ["model"]
            }
        })));

        assert!(!metadata.app_visible());
    }

    #[test]
    fn app_surface_html_limit_allows_bundled_mcp_apps() {
        let html = format!("<!doctype html><script>{}</script>", "a".repeat(700 * 1024));

        assert!(validate_app_surface_html(html).is_ok());
    }

    #[test]
    fn app_surface_html_limit_rejects_unbounded_documents() {
        let html = format!(
            "<!doctype html><script>{}</script>",
            "a".repeat(APP_SURFACE_HTML_MAX_BYTES)
        );

        let error = validate_app_surface_html(html).unwrap_err();
        assert!(error
            .to_string()
            .contains("app surface HTML exceeds the 4 MiB limit"));
    }
}
