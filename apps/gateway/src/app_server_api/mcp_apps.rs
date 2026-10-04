use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, Clone, serde::Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpServerConnectionStatus {
    NotStarted,
    Starting,
    Connected,
    AuthenticationRequired,
    Failed,
    Cancelled,
    Disabled,
}

/// Native account selector. Null linkId explicitly requests no-auth access;
/// it must not disappear through skip_serializing_if.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceReadTarget {
    pub connector_id: String,
    pub link_id: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceReadRequest {
    pub server: String,
    pub uri: String,
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connector_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<McpResourceReadTarget>,
}

/// Visible native MCP text, without app/widget metadata or serialized binary data.
pub(crate) fn mcp_result_text(result: Option<&serde_json::Value>) -> Option<String> {
    let content = result?.get("content")?.as_array()?;
    let text = content
        .iter()
        .filter(|part| part.get("type").and_then(serde_json::Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}
