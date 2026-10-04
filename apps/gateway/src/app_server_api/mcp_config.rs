use std::path::Path;

use super::config::{config_edit, native_config_key_segment, native_config_write_target};
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpReloadResponse {
    /// True when native acknowledges queuing a refresh, not server readiness.
    /// False with an error means unconfirmed; it does not prove no refresh was queued.
    pub queued: bool,
    #[schema(required = true)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredMcpServerListResponse {
    #[schema(required = true)]
    pub write_target: Option<NativeConfigWriteTarget>,
    pub servers: Vec<ConfiguredMcpServer>,
}

impl ConfiguredMcpServerListResponse {
    fn from_config_payload(payload: Value, home: &Path) -> ApiResult<Self> {
        let entries = payload
            .get("config")
            .and_then(|config| config.get("mcp_servers"))
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|servers| servers.iter())
            .filter_map(|(name, value)| ConfiguredMcpServer::from_config(name, value))
            .collect();
        Ok(Self {
            write_target: native_config_write_target(&payload, home),
            servers: entries,
        })
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
    pub write_target: NativeConfigWriteTarget,
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
        let mut value = match &self.transport {
            McpServerTransportRequest::Stdio {
                command,
                args,
                cwd,
                env,
                env_vars,
            } => json!({
                "command":command,"args":args,"cwd":cwd,"env":env,"env_vars":env_vars,
            }),
            McpServerTransportRequest::StreamableHttp {
                url,
                bearer_token_env_var,
                oauth_resource,
                http_headers,
                env_http_headers,
            } => json!({
                "url":url,"bearer_token_env_var":bearer_token_env_var,"oauth_resource":oauth_resource,
                "http_headers":http_headers,"env_http_headers":env_http_headers,
            }),
        };
        for (key, field) in [
            ("enabled", json!(self.enabled)),
            ("required", json!(self.required)),
            ("startup_timeout_sec", json!(self.startup_timeout_sec)),
            ("tool_timeout_sec", json!(self.tool_timeout_sec)),
            ("scopes", json!(self.scopes)),
            ("enabled_tools", json!(self.enabled_tools)),
        ] {
            if !field.is_null() {
                value[key] = field;
            }
        }
        if let Some(object) = value.as_object_mut() {
            object.retain(|_, value| !value.is_null());
        }
        value
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
        #[serde(default, rename = "envHttpHeaders")]
        env_http_headers: BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerToggleRequest {
    pub write_target: NativeConfigWriteTarget,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerUpdateRequest {
    pub write_target: NativeConfigWriteTarget,
    pub edits: Vec<NativeConfigLeafEdit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRemoveRequest {
    pub write_target: NativeConfigWriteTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigMutationResponse {
    pub saved: bool,
    pub write: NativeConfigWriteResult,
    pub reload: McpReloadResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notification_error: Option<String>,
}

impl CodexClient {
    pub async fn mcp_reload(&self) -> ApiResult<McpReloadResponse> {
        self.request("config/mcpServer/reload", Value::Null).await?;
        Ok(McpReloadResponse {
            queued: true,
            error: None,
        })
    }

    pub async fn mcp_configured_servers(
        &self,
        home: &Path,
    ) -> ApiResult<ConfiguredMcpServerListResponse> {
        let payload = self
            .request("config/read", json!({"cwd":null,"includeLayers":true}))
            .await?;
        ConfiguredMcpServerListResponse::from_config_payload(payload, home)
    }

    pub async fn mcp_add_server(
        &self,
        request: McpServerInstallRequest,
    ) -> ApiResult<NativeConfigWriteResult> {
        let path = format!("mcp_servers.{}", native_config_key_segment(&request.name)?);
        self.config_batch_write(
            &request.write_target,
            vec![config_edit(&path, request.config_value())],
            false,
        )
        .await
    }

    pub async fn mcp_update_server(
        &self,
        name: &str,
        request: McpServerUpdateRequest,
    ) -> ApiResult<NativeConfigWriteResult> {
        let prefix = format!("mcp_servers.{}", native_config_key_segment(name)?);
        let edits = request
            .edits
            .into_iter()
            .map(|edit| {
                if edit.key_path.is_empty() || edit.value.is_object() {
                    return Err(ApiError::BadRequest(
                        "MCP updates require relative leaf edits, not a replacement object".into(),
                    ));
                }
                let suffix = edit
                    .key_path
                    .iter()
                    .map(|segment| native_config_key_segment(segment))
                    .collect::<ApiResult<Vec<_>>>()?
                    .join(".");
                Ok(config_edit(&format!("{prefix}.{suffix}"), edit.value))
            })
            .collect::<ApiResult<Vec<_>>>()?;
        self.config_batch_write(&request.write_target, edits, false)
            .await
    }

    pub async fn mcp_set_server_enabled(
        &self,
        name: &str,
        request: McpServerToggleRequest,
    ) -> ApiResult<NativeConfigWriteResult> {
        let path = format!(
            "mcp_servers.{}.\"enabled\"",
            native_config_key_segment(name)?
        );
        self.config_batch_write(
            &request.write_target,
            vec![config_edit(&path, json!(request.enabled))],
            false,
        )
        .await
    }

    pub async fn mcp_remove_server(
        &self,
        name: &str,
        request: McpServerRemoveRequest,
    ) -> ApiResult<NativeConfigWriteResult> {
        let path = format!("mcp_servers.{}", native_config_key_segment(name)?);
        self.config_batch_write(
            &request.write_target,
            vec![config_edit(&path, Value::Null)],
            false,
        )
        .await
    }
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
