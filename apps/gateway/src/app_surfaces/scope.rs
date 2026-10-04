//! Hosted MCP bridge calls keep the account validated by native widget import.
use serde_json::{json, Value};

use crate::{
    app_server_api::{McpResourceReadRequest, McpResourceReadTarget},
    error::{ApiError, ApiResult},
};

pub(crate) struct HostedAppScope {
    connector: String,
    link: Option<String>,
}

impl HostedAppScope {
    pub(crate) fn from_provenance(mcp: &Value) -> ApiResult<Self> {
        let item = mcp
            .get("itemId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        if item.is_none() || mcp.get("originCallId").and_then(Value::as_str) != item {
            return Err(ApiError::BadRequest(
                "hosted MCP surface has no verified native origin".into(),
            ));
        }
        let context = &mcp["appContext"];
        let connector = context
            .get("connectorId")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                ApiError::BadRequest("hosted MCP surface has no native connector".into())
            })?;
        // Only a native-verified origin with an explicit nullable account field
        // may authorize no-auth access. Missing context is not no-auth access.
        let link = match context.get("linkId") {
            Some(Value::Null) => None,
            Some(Value::String(link)) if !link.trim().is_empty() => Some(link.clone()),
            _ => {
                return Err(ApiError::BadRequest(
                    "hosted MCP surface has no native account context".into(),
                ))
            }
        };
        Ok(Self {
            connector: connector.into(),
            link,
        })
    }

    pub(crate) fn matches_descriptor(&self, meta: Option<&Value>) -> bool {
        let Some(meta) = meta else {
            return false;
        };
        meta.get("connector_id").and_then(Value::as_str) == Some(self.connector.as_str())
            && meta.get("link_id").and_then(Value::as_str) == self.link.as_deref()
            && !(self.link.is_none()
                && meta
                    .pointer("/_codex_apps/requires_explicit_link_id")
                    .and_then(Value::as_bool)
                    == Some(true))
    }

    pub(crate) fn tool_meta(
        &self,
        arguments: Option<&Value>,
        meta: Option<&Value>,
    ) -> ApiResult<Value> {
        if let Some(selected) = arguments.and_then(|args| args.get("link_id")) {
            if selected != &json!(self.link) {
                return Err(ApiError::BadRequest(
                    "MCP app cannot change its originating account".into(),
                ));
            }
        }
        let mut meta = match meta {
            None | Some(Value::Null) => serde_json::Map::new(),
            Some(Value::Object(meta)) => meta.clone(),
            _ => {
                return Err(ApiError::BadRequest(
                    "MCP tool metadata must be an object".into(),
                ))
            }
        };
        meta.insert("connector_id".into(), json!(self.connector));
        meta.insert("link_id".into(), json!(self.link));
        let turn = meta
            .entry("x-codex-turn-metadata")
            .or_insert_with(|| json!({}));
        if !turn.is_object() {
            *turn = json!({});
        }
        turn["mcp_request_meta"] =
            json!({"selected_connector_ids":[self.connector],"link_id":self.link});
        Ok(Value::Object(meta))
    }

    pub(crate) fn resource_request(&self, uri: String, thread: String) -> McpResourceReadRequest {
        // Native origins authorize the widget URI only. Additional granted
        // resources use the verified account's direct native target.
        McpResourceReadRequest {
            server: "codex_apps".into(),
            uri,
            thread_id: Some(thread),
            target: Some(McpResourceReadTarget {
                connector_id: self.connector.clone(),
                link_id: self.link.clone(),
            }),
            ..Default::default()
        }
    }
}
