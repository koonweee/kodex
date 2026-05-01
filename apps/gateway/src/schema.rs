use std::sync::LazyLock;

use jsonschema::{Draft, JSONSchema};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};

pub const APP_SERVER_SCHEMA_VERSION: &str = "0.128.0";

static CLIENT_REQUEST_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.128.0/json/ClientRequest.json"
    ))
});

static CLIENT_NOTIFICATION_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.128.0/json/ClientNotification.json"
    ))
});

static COMMAND_APPROVAL_RESPONSE_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.128.0/json/CommandExecutionRequestApprovalResponse.json"
    ))
});

static FILE_CHANGE_APPROVAL_RESPONSE_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.128.0/json/FileChangeRequestApprovalResponse.json"
    ))
});

static PERMISSIONS_APPROVAL_RESPONSE_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.128.0/json/PermissionsRequestApprovalResponse.json"
    ))
});

static MCP_ELICITATION_RESPONSE_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.128.0/json/McpServerElicitationRequestResponse.json"
    ))
});

static TOOL_USER_INPUT_RESPONSE_SCHEMA: LazyLock<JSONSchema> = LazyLock::new(|| {
    compile_schema(include_str!(
        "../app-server-schema/0.128.0/json/ToolRequestUserInputResponse.json"
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

pub fn validate_client_notification(message: &Value) -> ApiResult<()> {
    validate("client notification", &CLIENT_NOTIFICATION_SCHEMA, message)
}

pub fn validate_approval_response(method: &str, response: &Value) -> ApiResult<()> {
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
