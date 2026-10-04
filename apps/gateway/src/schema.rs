use std::sync::LazyLock;

use jsonschema::{Draft, JSONSchema};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};

pub const APP_SERVER_SCHEMA_VERSION: &str = "0.160.0";

static CLIENT_REQUEST_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.160.0/json/ClientRequest.json"
    ))
});

static CLIENT_NOTIFICATION_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.160.0/json/ClientNotification.json"
    ))
});

#[cfg(test)]
static SERVER_NOTIFICATION_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.160.0/json/ServerNotification.json"
    ))
});

static COMMAND_APPROVAL_RESPONSE_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.160.0/json/CommandExecutionRequestApprovalResponse.json"
    ))
});

static FILE_CHANGE_APPROVAL_RESPONSE_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.160.0/json/FileChangeRequestApprovalResponse.json"
    ))
});

static PERMISSIONS_APPROVAL_RESPONSE_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.160.0/json/PermissionsRequestApprovalResponse.json"
    ))
});

static MCP_ELICITATION_RESPONSE_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.160.0/json/McpServerElicitationRequestResponse.json"
    ))
});

static TOOL_USER_INPUT_RESPONSE_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.160.0/json/ToolRequestUserInputResponse.json"
    ))
});

pub fn client_request_message(id: u64, method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
}

pub fn initialized_notification_message() -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "initialized",
    })
}

pub fn validate_client_request(message: &Value) -> ApiResult<()> {
    validate("client request", &CLIENT_REQUEST_SCHEMA, message)
}

pub fn validate_client_request_params(method: &str, params: Value) -> ApiResult<()> {
    let message = client_request_message(0, method, params);
    validate_client_request(&message)
}

pub fn validate_required_experimental_fields() -> ApiResult<()> {
    for (method, params) in [
        (
            "thread/start",
            json!({"cwd": "/workspace", "historyMode": "paginated"}),
        ),
        (
            "thread/resume",
            json!({"threadId": "thread-1", "excludeTurns": true}),
        ),
        (
            "thread/fork",
            json!({"threadId": "thread-1", "excludeTurns": true}),
        ),
        ("thread/timeline/list", json!({"threadId": "thread-1"})),
        ("thread/queue/list", json!({"threadId": "thread-1"})),
    ] {
        validate_client_request_params(method, params)?;
    }
    Ok(())
}

pub fn validate_client_notification(message: &Value) -> ApiResult<()> {
    validate("client notification", &CLIENT_NOTIFICATION_SCHEMA, message)
}

#[cfg(test)]
fn validate_server_notification(message: &Value) -> ApiResult<()> {
    validate("server notification", &SERVER_NOTIFICATION_SCHEMA, message)
}

pub fn validate_approval_response(method: &str, response: &Value) -> ApiResult<()> {
    if method == crate::routes::app_surfaces::APP_SURFACE_BRIDGE_APPROVAL_METHOD {
        return validate_app_surface_bridge_approval_response(response);
    }
    let Some(schema) = approval_response_schema(method) else {
        return Err(ApiError::BadRequest(format!(
            "unsupported approval method {method}"
        )));
    };

    validate_bad_request("approval response", schema, response)
}

pub fn is_supported_approval_method(method: &str) -> bool {
    approval_response_schema(method).is_some()
}

fn validate_app_surface_bridge_approval_response(response: &Value) -> ApiResult<()> {
    match response.get("decision").and_then(Value::as_str) {
        Some("accept" | "decline" | "cancel") => Ok(()),
        _ => Err(ApiError::BadRequest(
            "app surface bridge approval response must include decision accept, decline, or cancel"
                .to_string(),
        )),
    }
}

fn approval_response_schema(method: &str) -> Option<&'static JSONSchema> {
    match method {
        "item/commandExecution/requestApproval" => Some(&COMMAND_APPROVAL_RESPONSE_SCHEMA),
        "item/fileChange/requestApproval" => Some(&FILE_CHANGE_APPROVAL_RESPONSE_SCHEMA),
        "item/permissions/requestApproval" => Some(&PERMISSIONS_APPROVAL_RESPONSE_SCHEMA),
        "mcpServer/elicitation/request" => Some(&MCP_ELICITATION_RESPONSE_SCHEMA),
        "item/tool/requestUserInput" => Some(&TOOL_USER_INPUT_RESPONSE_SCHEMA),
        _ => None,
    }
}

fn compile_schema(schema: &str) -> JSONSchema {
    let schema: Value =
        serde_json::from_str(schema).expect("checked-in app-server schema must be valid JSON");
    JSONSchema::options()
        .with_draft(Draft::Draft7)
        .compile(&schema)
        .expect("checked-in app-server schema must compile")
}

fn validate(kind: &str, schema: &JSONSchema, message: &Value) -> ApiResult<()> {
    if let Err(errors) = schema.validate(message) {
        let errors = validation_errors(errors);
        return Err(ApiError::Other(anyhow::anyhow!(
            "app-server schema validation failed for {kind}: {errors}"
        )));
    }

    Ok(())
}

fn validate_bad_request(kind: &str, schema: &JSONSchema, message: &Value) -> ApiResult<()> {
    if let Err(errors) = schema.validate(message) {
        let errors = validation_errors(errors);
        return Err(ApiError::BadRequest(format!(
            "app-server schema validation failed for {kind}: {errors}"
        )));
    }

    Ok(())
}

fn validation_errors<'a>(errors: impl Iterator<Item = jsonschema::ValidationError<'a>>) -> String {
    errors
        .take(5)
        .map(|error| error.to_string())
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn validates_supported_client_request() {
        let message = client_request_message(
            1,
            "thread/list",
            json!({
                "cursor": null,
                "limit": 1,
                "cwd": "/workspace",
            }),
        );

        validate_client_request(&message).unwrap();
    }

    #[test]
    fn required_experimental_history_fields_are_supported() {
        validate_required_experimental_fields().unwrap();
    }

    #[test]
    fn native_reasoning_effort_is_an_open_string() {
        for effort in ["max", "ultra", "future-catalogued-effort"] {
            validate_client_request_params(
                "turn/start",
                json!({"threadId": "thread-1", "input": [], "effort": effort}),
            )
            .unwrap();
        }
    }

    #[test]
    fn native_paginated_history_methods_are_supported() {
        validate_client_request_params(
            "thread/items/list",
            json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "cursor": {"type": "item", "itemId": "item-1"},
                "sortDirection": "desc",
                "limit": 25,
            }),
        )
        .unwrap();
        validate_client_request_params(
            "thread/timeline/list",
            json!({"threadId": "thread-1", "limit": 25}),
        )
        .unwrap();
    }

    #[test]
    fn native_settings_and_permissions_requests_are_supported() {
        validate_client_request(&client_request_message(
            1,
            "thread/settings/update",
            json!({
                "threadId": "thread-1",
                "model": "gpt-5.4",
                "serviceTier": null,
            }),
        ))
        .unwrap();

        validate_client_request(&client_request_message(
            2,
            "permissionProfile/list",
            json!({
                "cwd": "/workspace",
                "limit": 25,
                "cursor": null,
            }),
        ))
        .unwrap();
    }

    #[test]
    fn native_project_notifications_match_checked_in_contract() {
        for (method, params) in [
            (
                "project/changed",
                json!({"projectId":"project-1","changeType":"updated"}),
            ),
            (
                "thread/project/updated",
                json!({"threadId":"thread-1","projectId":null}),
            ),
            (
                "thread/project/updated",
                json!({"threadId":"thread-1","projectId":"project-1"}),
            ),
        ] {
            validate_server_notification(&json!({"jsonrpc":"2.0","method":method,"params":params}))
                .unwrap();
        }
    }

    #[test]
    fn native_status_and_settings_notifications_are_supported() {
        validate_server_notification(&json!({
            "jsonrpc": "2.0",
            "method": "thread/status/changed",
            "params": {
                "threadId": "thread-1",
                "status": { "type": "idle" },
            },
        }))
        .unwrap();

        validate_server_notification(&json!({
            "jsonrpc": "2.0",
            "method": "thread/settings/updated",
            "params": {
                "threadId": "thread-1",
                "threadSettings": {
                    "activePermissionProfile": { "id": ":workspace" },
                    "approvalPolicy": "on-request",
                    "approvalsReviewer": "user",
                    "collaborationMode": {
                        "mode": "default",
                        "settings": { "model": "gpt-5.4" }
                    },
                    "cwd": "/workspace",
                    "model": "gpt-5.4",
                    "modelProvider": "openai",
                    "sandboxPolicy": { "type": "workspaceWrite" },
                    "serviceTier": null,
                },
            },
        }))
        .unwrap();
    }

    #[test]
    fn rejects_invalid_client_request_params() {
        let message = client_request_message(1, "account/logout", json!({}));

        assert!(validate_client_request(&message).is_err());
    }

    #[test]
    fn validates_initialized_notification() {
        validate_client_notification(&initialized_notification_message()).unwrap();
    }

    #[test]
    fn validates_approval_response_by_method() {
        validate_approval_response(
            "item/commandExecution/requestApproval",
            &json!({"decision": "accept"}),
        )
        .unwrap();
        assert!(matches!(
            validate_approval_response(
                "item/commandExecution/requestApproval",
                &json!({"decision": "bogus"})
            ),
            Err(ApiError::BadRequest(_))
        ));
        assert!(!is_supported_approval_method("unknown/request"));
    }
}
