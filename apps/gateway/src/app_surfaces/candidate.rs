use serde_json::{json, Value};

pub(super) struct McpAppSurfaceCandidate {
    pub(super) turn_id: String,
    pub(super) item_id: String,
    pub(super) server: String,
    pub(super) tool: String,
    pub(super) resource_uri: String,
    pub(super) arguments: Option<Value>,
    pub(super) result: Option<Value>,
    pub(super) error: Option<Value>,
    pub(super) status: Option<String>,
    pub(super) signature: Value,
    pub(super) title: Option<String>,
    pub(super) app_context: Value,
    pub(super) mcp_app_ui: Value,
}

impl McpAppSurfaceCandidate {
    pub(super) fn from_item(turn_id: &str, item: &Value) -> Option<Self> {
        // Native resource origins become available only after a successful
        // completed call. Importing started items races that native authority.
        if item.get("type").and_then(Value::as_str) != Some("mcpToolCall")
            || item.get("status").and_then(Value::as_str) != Some("completed")
            || item.get("error").is_some_and(|error| !error.is_null())
        {
            return None;
        }
        let result = item
            .get("result")
            .filter(|result| result.get("content").is_some_and(Value::is_array))?
            .clone();
        let item_id = string_field(item, "id")?;
        let server = string_field(item, "server")?;
        let tool = string_field(item, "tool")?;
        let app_context = item.get("appContext").cloned().unwrap_or(Value::Null);
        let mcp_app_ui = item.get("mcpAppUi").cloned().unwrap_or(Value::Null);
        let resource_uri = string_field(&mcp_app_ui, "resourceUri")
            .or_else(|| string_field(item, "mcpAppResourceUri"))
            .or_else(|| {
                result
                    .get("_meta")
                    .and_then(|meta| meta.get("ui"))
                    .and_then(|ui| string_field(ui, "resourceUri"))
            })?;
        let arguments = item.get("arguments").cloned();
        let title = string_field(&app_context, "actionName")
            .or_else(|| string_field(&app_context, "appName"));
        let signature = json!({
            "turnId": turn_id,
            "itemId": item_id,
            "server": server,
            "tool": tool,
            "resourceUri": resource_uri,
            "arguments": arguments,
            "result": result,
            "error": null,
            "status": "completed",
            "appContext": app_context,
            "mcpAppUi": mcp_app_ui,
        });
        Some(Self {
            turn_id: turn_id.to_string(),
            item_id,
            server,
            tool,
            resource_uri,
            arguments,
            result: Some(result),
            error: None,
            status: Some("completed".to_string()),
            signature,
            title,
            app_context,
            mcp_app_ui,
        })
    }
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

#[cfg(test)]
#[path = "candidate_tests.rs"]
mod tests;
