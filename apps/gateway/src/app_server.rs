use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Instant,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, oneshot, Mutex},
    time::{sleep, timeout, Duration},
};

use crate::{
    config::CodexConfig,
    error::{ApiError, ApiResult},
    schema::{
        client_request_message, initialized_notification_message, validate_client_notification,
        validate_client_request,
    },
};

#[derive(Debug, Clone)]
pub enum InboundMessage {
    Disconnected,
    Notification {
        method: String,
        params: Value,
    },
    ServerRequest {
        request_id: String,
        method: String,
        params: Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

#[async_trait]
pub trait AppServer: Send + Sync {
    fn is_ready(&self) -> bool;
    fn readiness_error(&self) -> Option<String>;
    fn detected_version(&self) -> Option<String> {
        None
    }
    async fn request(&self, method: &str, params: Value) -> ApiResult<Value>;
    async fn respond(&self, request_id: &str, result: Value) -> ApiResult<()>;
    async fn respond_error(&self, _request_id: &str, _error: JsonRpcError) -> ApiResult<()> {
        Err(ApiError::AppServerUnavailable)
    }
}

pub type DynAppServer = Arc<dyn AppServer>;

pub struct UnavailableAppServer;

#[async_trait]
impl AppServer for UnavailableAppServer {
    fn is_ready(&self) -> bool {
        false
    }

    fn readiness_error(&self) -> Option<String> {
        Some("Codex app-server is unavailable".to_string())
    }

    fn detected_version(&self) -> Option<String> {
        None
    }

    async fn request(&self, _method: &str, _params: Value) -> ApiResult<Value> {
        Err(ApiError::AppServerUnavailable)
    }

    async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
        Err(ApiError::AppServerUnavailable)
    }
}

mod control_binding;

pub struct JsonRpcAppServer {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, JsonRpcError>>>>,
    ready: AtomicBool,
    readiness_error: StdMutex<Option<String>>,
    detected_version: Option<String>,
}

impl JsonRpcAppServer {
    pub async fn start(
        config: &CodexConfig,
        inbound: mpsc::Sender<InboundMessage>,
    ) -> ApiResult<Arc<Self>> {
        Self::start_inner(config, inbound, None).await
    }

    pub async fn start_with_control(
        config: &CodexConfig,
        inbound: mpsc::Sender<InboundMessage>,
        address: std::net::SocketAddr,
        gateway_binary: &std::path::Path,
    ) -> ApiResult<Arc<Self>> {
        Self::start_inner(config, inbound, Some((address, gateway_binary))).await
    }

    async fn start_inner(
        config: &CodexConfig,
        inbound: mpsc::Sender<InboundMessage>,
        control: Option<(std::net::SocketAddr, &std::path::Path)>,
    ) -> ApiResult<Arc<Self>> {
        let detected_version = detect_codex_cli_version(config).await;
        if detected_version.as_deref() != Some(crate::schema::APP_SERVER_SCHEMA_VERSION) {
            return Err(ApiError::BadGateway(format!(
                "configured Codex executable reports {}; required version is {}",
                detected_version.as_deref().unwrap_or("an unknown version"),
                crate::schema::APP_SERVER_SCHEMA_VERSION
            )));
        }

        let mut command = codex_command(config);
        if let Some((address, binary)) = control {
            control_binding::apply_control_binding(&mut command, address, binary);
        }
        command.args(&config.args);
        for (key, value) in [
            ("sqlite_home", config.home.join("sqlite")),
            ("log_dir", config.home.join("log")),
        ] {
            command.args([
                "-c",
                &format!("{key}={}", serde_json::to_string(&value.to_string_lossy())?),
            ]);
        }
        command.args([
            "-c",
            "cli_auth_credentials_store=\"file\"",
            "-c",
            "mcp_oauth_credentials_store=\"file\"",
        ]);
        let mut child = command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        let stdin = child.stdin.take().ok_or_else(|| {
            ApiError::Other(anyhow::anyhow!("codex app-server stdin was not piped"))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ApiError::Other(anyhow::anyhow!("codex app-server stdout was not piped"))
        })?;

        let server = Arc::new(Self {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            ready: AtomicBool::new(false),
            readiness_error: StdMutex::new(None),
            detected_version,
        });

        tokio::spawn(read_loop(
            Arc::clone(&server),
            BufReader::new(stdout),
            inbound,
        ));
        tokio::spawn(watch_child(Arc::clone(&server)));

        let initialized = timeout(Duration::from_secs(10), server.initialize()).await;
        match initialized {
            Ok(Ok(())) => {}
            outcome => {
                server.shutdown().await?;
                return Err(match outcome {
                    Ok(Err(error)) => error,
                    Err(_) => ApiError::BadGateway(
                        "Codex app-server initialization timed out".to_string(),
                    ),
                    Ok(Ok(())) => unreachable!(),
                });
            }
        }
        Ok(server)
    }

    async fn initialize(&self) -> ApiResult<()> {
        self.request("initialize", initialize_params()).await?;
        self.send_initialized().await?;
        if let Err(error) = crate::schema::validate_required_experimental_fields() {
            self.ready.store(false, Ordering::SeqCst);
            *self.readiness_error.lock().unwrap() = Some(error.to_string());
            return Err(error);
        }
        self.ready.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn send_initialized(&self) -> ApiResult<()> {
        let message = initialized_notification_message();
        validate_client_notification(&message)?;
        self.write_message(message).await
    }

    async fn write_message(&self, message: Value) -> ApiResult<()> {
        let mut stdin = self.stdin.lock().await;
        let mut line = serde_json::to_vec(&message)?;
        line.push(b'\n');
        stdin.write_all(&line).await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn shutdown(&self) -> ApiResult<()> {
        self.ready.store(false, Ordering::SeqCst);
        fail_pending(self).await;

        let mut child = self.child.lock().await;
        if child.try_wait()?.is_none() {
            child.start_kill()?;
        }
        let _ = child.wait().await;
        Ok(())
    }
}

fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": "kodex_gateway",
            "title": "Kodex Gateway",
            "version": env!("CARGO_PKG_VERSION")
        },
        "capabilities": {
            "experimentalApi": true,
            "extensions": {
                "io.modelcontextprotocol/ui": {
                    "mimeTypes": ["text/html;profile=mcp-app"]
                }
            }
        }
    })
}

#[async_trait]
impl AppServer for JsonRpcAppServer {
    fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst) && self.readiness_error.lock().unwrap().is_none()
    }

    fn readiness_error(&self) -> Option<String> {
        self.readiness_error.lock().unwrap().clone()
    }

    fn detected_version(&self) -> Option<String> {
        self.detected_version.clone()
    }

    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        let started_at = Instant::now();
        if !self.is_ready() && method != "initialize" {
            log_app_server_timing(method, started_at, None, "unavailable");
            return Err(ApiError::AppServerUnavailable);
        }

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let message = client_request_message(id, method, params);
        validate_client_request(&message)?;

        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);

        if let Err(error) = self.write_message(message).await {
            self.pending.lock().await.remove(&id);
            log_app_server_timing(method, started_at, None, api_error_classification(&error));
            return Err(error);
        }

        match receiver.await {
            Ok(Ok(value)) => {
                log_app_server_timing(method, started_at, Some(serialized_json_len(&value)), "ok");
                Ok(value)
            }
            Ok(Err(error)) if error.code == -32001 => {
                log_app_server_timing(method, started_at, None, "retryable");
                Err(ApiError::Retryable(error.message))
            }
            Ok(Err(error)) => {
                let error = api_error_from_rpc(error);
                log_app_server_timing(method, started_at, None, api_error_classification(&error));
                Err(error)
            }
            Err(_) => {
                log_app_server_timing(method, started_at, None, "unavailable");
                Err(ApiError::AppServerUnavailable)
            }
        }
    }

    async fn respond(&self, request_id: &str, result: Value) -> ApiResult<()> {
        if !self.is_ready() {
            return Err(ApiError::AppServerUnavailable);
        }

        let id = serde_json::from_str::<Value>(request_id)
            .unwrap_or_else(|_| Value::String(request_id.to_string()));
        self.write_message(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        }))
        .await
    }
    async fn respond_error(&self, request_id: &str, error: JsonRpcError) -> ApiResult<()> {
        if !self.is_ready() {
            return Err(ApiError::AppServerUnavailable);
        }
        let id = serde_json::from_str::<Value>(request_id)
            .unwrap_or_else(|_| Value::String(request_id.to_string()));
        self.write_message(json!({"jsonrpc":"2.0", "id":id, "error":error}))
            .await
    }
}

fn log_app_server_timing(
    method: &str,
    started_at: Instant,
    response_bytes: Option<usize>,
    outcome: &'static str,
) {
    tracing::info!(
        target: "kodex.performance",
        app_server_method = method,
        duration_ms = started_at.elapsed().as_secs_f64() * 1000.0,
        response_bytes,
        outcome,
        "app-server rpc completed"
    );
}

fn serialized_json_len(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(0, |bytes| bytes.len())
}

fn api_error_from_rpc(error: JsonRpcError) -> ApiError {
    if let Some(code) = error
        .data
        .as_ref()
        .and_then(|data| data.get("config_write_error_code"))
        .and_then(|code| serde_json::from_value(code.clone()).ok())
    {
        // Keep only the known native code. Native validation errors and data can
        // include submitted secret values, so they are not public error text.
        return ApiError::NativeConfigWrite(code);
    }
    let message = if let Some(data) = error.data {
        format!(
            "app-server error {}: {}; data: {}",
            error.code, error.message, data
        )
    } else {
        format!("app-server error {}: {}", error.code, error.message)
    };
    ApiError::BadGateway(message)
}

fn api_error_classification(error: &ApiError) -> &'static str {
    match error {
        ApiError::NotFound(_) => "not_found",
        ApiError::BadRequest(_) => "bad_request",
        ApiError::UnsupportedMediaType(_) => "unsupported_media_type",
        ApiError::Conflict(_) => "conflict",
        ApiError::NativeConfigWrite(_) => "config_write_error",
        ApiError::AppServerUnavailable => "unavailable",
        ApiError::Retryable(_) => "retryable",
        ApiError::BadGateway(_) => "bad_gateway",
        ApiError::Store(_) => "store_error",
        ApiError::Io(_) => "io_error",
        ApiError::Other(_) => "internal_error",
    }
}

async fn detect_codex_cli_version(config: &CodexConfig) -> Option<String> {
    let output = timeout(
        Duration::from_secs(2),
        codex_command(config).arg("--version").output(),
    )
    .await
    .ok()?
    .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_codex_cli_version(&String::from_utf8_lossy(&output.stdout))
}

fn codex_command(config: &CodexConfig) -> Command {
    let mut command = Command::new(&config.binary);
    // Applies to version probes as well as the long-lived app-server.
    command.kill_on_drop(true);
    for (key, _) in std::env::vars_os() {
        let key_name = key.to_string_lossy();
        if key_name.starts_with("CODEX_")
            || (cfg!(windows) && key_name.to_ascii_uppercase().starts_with("CODEX_"))
        {
            command.env_remove(key);
        }
    }
    command.env_remove("OPENAI_API_KEY");
    command.env_remove("OPENAI_BASE_URL");
    for key in control_binding::CONTROL_ENV {
        command.env_remove(key);
    }
    command.env("CODEX_HOME", &config.home);
    command.current_dir(&config.home);
    command
}

fn parse_codex_cli_version(output: &str) -> Option<String> {
    let mut parts = output.split_whitespace();
    match (parts.next(), parts.next()) {
        (Some("codex-cli"), Some(version)) => Some(version.to_string()),
        _ => None,
    }
}

async fn read_loop(
    server: Arc<JsonRpcAppServer>,
    stdout: BufReader<tokio::process::ChildStdout>,
    inbound: mpsc::Sender<InboundMessage>,
) {
    let mut lines = stdout.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            tracing::warn!(line, "invalid app-server json-rpc line");
            continue;
        };

        if message.get("id").is_some() && message.get("method").is_none() {
            route_response(&server, message).await;
        } else if message.get("id").is_some() {
            route_server_request(&inbound, message).await;
        } else if message.get("method").is_some() {
            route_notification(&inbound, message).await;
        }
    }

    server.ready.store(false, Ordering::SeqCst);
    fail_pending(&server).await;
    let _ = inbound.send(InboundMessage::Disconnected).await;
}

async fn route_response(server: &JsonRpcAppServer, message: Value) {
    let Some(id) = message.get("id").and_then(Value::as_u64) else {
        tracing::warn!(payload = %message, "response id was not an unsigned integer");
        return;
    };

    let Some(sender) = server.pending.lock().await.remove(&id) else {
        tracing::warn!(id, "received response for unknown request id");
        return;
    };

    let response = if let Some(error) = message.get("error") {
        serde_json::from_value::<JsonRpcError>(error.clone()).map_or_else(
            |parse_error| {
                Err(JsonRpcError {
                    code: -32603,
                    message: format!("invalid app-server error: {parse_error}"),
                    data: Some(error.clone()),
                })
            },
            Err,
        )
    } else {
        Ok(message.get("result").cloned().unwrap_or(Value::Null))
    };

    let _ = sender.send(response);
}

async fn route_notification(inbound: &mpsc::Sender<InboundMessage>, message: Value) {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let _ = inbound
        .send(InboundMessage::Notification {
            method: method.to_string(),
            params,
        })
        .await;
}

async fn route_server_request(inbound: &mpsc::Sender<InboundMessage>, message: Value) {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    let request_id = message
        .get("id")
        .map(Value::to_string)
        .unwrap_or_else(|| "null".to_string());
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let _ = inbound
        .send(InboundMessage::ServerRequest {
            request_id,
            method: method.to_string(),
            params,
        })
        .await;
}

async fn fail_pending(server: &JsonRpcAppServer) {
    let mut pending = server.pending.lock().await;
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err(JsonRpcError {
            code: -32000,
            message: "app-server exited".to_string(),
            data: None,
        }));
    }
}

async fn watch_child(server: Arc<JsonRpcAppServer>) {
    loop {
        let status = {
            let mut child = server.child.lock().await;
            child.try_wait()
        };

        match status {
            Ok(Some(status)) => {
                server.ready.store(false, Ordering::SeqCst);
                tracing::warn!(%status, "codex app-server exited");
                return;
            }
            Ok(None) => sleep(Duration::from_millis(100)).await,
            Err(error) => {
                server.ready.store(false, Ordering::SeqCst);
                tracing::warn!(%error, "failed checking codex app-server status");
                return;
            }
        }
    }
}

#[cfg(test)]
pub mod tests {
    use std::{collections::HashMap, path::Path, sync::Mutex as StdMutex};

    use super::*;
    use tempfile::tempdir;
    use tokio::time::timeout;

    #[derive(Default)]
    pub struct RecordingAppServer {
        pub ready: AtomicBool,
        pub readiness_error: StdMutex<Option<String>>,
        pub requests: StdMutex<Vec<(String, Value)>>,
        pub responses: StdMutex<Vec<(String, Value)>>,
        pub error_responses: StdMutex<Vec<(String, JsonRpcError)>>,
        pub queued_errors: StdMutex<Vec<ApiError>>,
        pub queued_responses: StdMutex<Vec<Value>>,
        pub native_projects: StdMutex<HashMap<String, Value>>,
        pub thread_list_responses_by_section_id: StdMutex<HashMap<String, Value>>,
        pub thread_list_responses_by_project_id: StdMutex<HashMap<String, Value>>,
        pub next_response: StdMutex<Option<Value>>,
    }

    impl RecordingAppServer {
        pub fn seed_project(&self, name: String, cwd: String) -> crate::routes::projects::Project {
            let mut projects = self.native_projects.lock().unwrap();
            let position = projects.len() as i64;
            let id = format!("native-project-{}", position + 1);
            let timestamp = 1_767_225_600_i64;
            projects.insert(
                id.clone(),
                json!({
                    "id": id,
                    "name": name,
                    "roots": [{"path": cwd}],
                    "metadata": {},
                    "position": position,
                    "createdAt": timestamp,
                    "updatedAt": timestamp,
                    "recencyAt": timestamp,
                }),
            );
            serde_json::from_value(projects[&id].clone()).unwrap()
        }
    }

    #[test]
    fn initialize_params_match_current_protocol_shape() {
        let params = initialize_params();
        assert_eq!(params["clientInfo"]["name"], "kodex_gateway");
        assert_eq!(params["clientInfo"]["title"], "Kodex Gateway");
        assert_eq!(params["clientInfo"]["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(params["capabilities"]["experimentalApi"], true);
        assert_eq!(
            params["capabilities"]["extensions"]["io.modelcontextprotocol/ui"]["mimeTypes"][0],
            "text/html;profile=mcp-app"
        );
    }

    #[test]
    fn native_config_version_conflict_is_typed_and_does_not_expose_raw_error_data() {
        let error = api_error_from_rpc(JsonRpcError {
            code: -32600,
            message: "Configuration was modified since last read. Fetch latest version and retry."
                .into(),
            data: Some(
                json!({"config_write_error_code":"configVersionConflict","untrusted":"secret-token"}),
            ),
        });
        assert_eq!(error.status_code(), axum::http::StatusCode::CONFLICT);
        let body = serde_json::to_value(error.body()).unwrap();
        assert_eq!(body["code"], "config_version_conflict");
        assert_eq!(
            body["data"],
            json!({"config_write_error_code":"configVersionConflict"})
        );
        assert_eq!(body["retryable"], false);
        assert!(!body.to_string().contains("secret-token"));
    }

    #[test]
    fn initialized_notification_has_no_params() {
        let notification = initialized_notification_message();
        assert_eq!(notification["method"], "initialized");
        assert!(notification.get("params").is_none());
    }

    #[test]
    fn parses_codex_cli_version_output() {
        assert_eq!(
            parse_codex_cli_version("codex-cli 0.135.0\n"),
            Some("0.135.0".to_string())
        );
        assert_eq!(parse_codex_cli_version("GNU bash, version 5.2\n"), None);
    }

    #[tokio::test]
    async fn wrong_cli_version_is_rejected_before_startup_writes() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let script = dir.path().join("wrong-version-codex");
        let log = dir.path().join("messages.log");
        let launched = dir.path().join("launched");
        write_fake_app_server(&script, false);
        let body = std::fs::read_to_string(&script).unwrap();
        std::fs::write(
            &script,
            format!(
                "#!/bin/bash\nif [[ ${{1:-}} == --version ]]; then printf 'codex-cli 0.159.0\\n'; exit 0; fi\ntouch '{}'\n{body}",
                launched.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = CodexConfig {
            binary: script.display().to_string(),
            args: vec![log.display().to_string()],
            home: dir.path().to_path_buf(),
        };
        let (inbound_tx, _inbound_rx) = mpsc::channel(8);
        let error = match JsonRpcAppServer::start(&config, inbound_tx).await {
            Ok(server) => {
                server.shutdown().await.unwrap();
                panic!("wrong-version executable must be rejected before launching app-server");
            }
            Err(error) => error,
        };
        assert!(error.to_string().contains("0.159.0"));
        assert!(!launched.exists());
    }

    #[tokio::test]
    async fn supervisor_initializes_and_routes_process_messages() {
        let dir = tempdir().unwrap();
        let script = dir.path().join("fake-app-server.sh");
        let log = dir.path().join("messages.log");
        write_fake_app_server(&script, false);

        let config = CodexConfig {
            binary: script.display().to_string(),
            args: vec![log.display().to_string()],
            home: dir.path().to_path_buf(),
        };
        let (inbound_tx, mut inbound_rx) = mpsc::channel(8);
        let server = JsonRpcAppServer::start(&config, inbound_tx).await.unwrap();

        assert!(server.is_ready());
        let response = timeout(
            Duration::from_secs(2),
            server.request("thread/list", json!({"cwd": null})),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response, json!({"ok": true}));

        let notification = timeout(Duration::from_secs(2), inbound_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            notification,
            InboundMessage::Notification { method, .. } if method == "turn/completed"
        ));

        let server_request = timeout(Duration::from_secs(2), inbound_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            server_request,
            InboundMessage::ServerRequest { method, request_id, .. }
                if method == "item/permissions/requestApproval" && request_id == "\"approval-1\""
        ));

        server.shutdown().await.unwrap();
        assert!(!server.is_ready());

        let messages = std::fs::read_to_string(log).unwrap();
        let mut lines = messages
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap());
        assert_eq!(lines.next().unwrap()["method"], "initialize");
        assert_eq!(lines.next().unwrap()["method"], "initialized");
        assert_eq!(lines.next().unwrap()["method"], "thread/list");
    }

    #[tokio::test]
    async fn child_process_exit_changes_readiness() {
        let dir = tempdir().unwrap();
        let script = dir.path().join("fake-app-server.sh");
        let log = dir.path().join("messages.log");
        write_fake_app_server(&script, true);

        let config = CodexConfig {
            binary: script.display().to_string(),
            args: vec![log.display().to_string()],
            home: dir.path().to_path_buf(),
        };
        let (inbound_tx, _inbound_rx) = mpsc::channel(8);
        let server = JsonRpcAppServer::start(&config, inbound_tx).await.unwrap();

        timeout(Duration::from_secs(2), async {
            while server.is_ready() {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(!server.is_ready());
    }

    #[tokio::test]
    async fn initialization_failure_terminates_the_child() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let script = dir.path().join("codex");
        let pid_file = dir.path().join("pid");
        std::fs::write(
            &script,
            format!(
                r#"#!/bin/bash
if [[ ${{1:-}} == --version ]]; then printf 'codex-cli 0.160.0\n'; exit 0; fi
printf '%s' "$$" > '{}'
IFS= read -r line
printf '%s\n' '{{"id":1,"error":{{"code":-32603,"message":"fixture initialization failure"}}}}'
while IFS= read -r line; do :; done
"#,
                pid_file.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = CodexConfig {
            binary: script.display().to_string(),
            args: vec![],
            home: dir.path().into(),
        };
        let (tx, _rx) = mpsc::channel(8);
        let error = match JsonRpcAppServer::start(&config, tx).await {
            Ok(server) => {
                server.shutdown().await.unwrap();
                panic!("initialization must fail");
            }
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("fixture initialization failure"),
            "{error}"
        );
        assert_process_exited(&pid_file).await;
    }

    #[tokio::test]
    async fn a_timed_out_version_probe_does_not_leave_a_process_running() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let script = dir.path().join("codex");
        let pid_file = dir.path().join("pid");
        std::fs::write(
            &script,
            format!(
                r#"#!/bin/bash
printf '%s' "$$" > '{}'
while true; do :; done
"#,
                pid_file.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = CodexConfig {
            binary: script.display().to_string(),
            args: vec![],
            home: dir.path().into(),
        };
        assert!(detect_codex_cli_version(&config).await.is_none());
        let checked = timeout(Duration::from_millis(500), assert_process_exited(&pid_file)).await;
        if checked.is_err() {
            let pid = std::fs::read_to_string(&pid_file).unwrap();
            let _ = Command::new("/bin/kill")
                .args(["-KILL", &pid])
                .status()
                .await;
        }
        assert!(
            checked.is_ok(),
            "timed-out version probe must terminate its child"
        );
    }

    async fn assert_process_exited(pid_file: &Path) {
        let pid = std::fs::read_to_string(pid_file).unwrap();
        timeout(Duration::from_secs(2), async {
            loop {
                let alive = Command::new("/bin/kill")
                    .args(["-0", &pid])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .await
                    .unwrap()
                    .success();
                if !alive {
                    break;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[test]
    fn inherited_native_storage_and_auth_are_not_imported() {
        let dir = tempdir().unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "app_server::tests::isolated_environment_child",
                "--ignored",
            ])
            .env("KODEX_ENVIRONMENT_FIXTURE_HOME", dir.path())
            .env("CODEX_HOME", "/fixture/desktop")
            .env("CODEX_SQLITE_HOME", "/fixture/desktop/sqlite")
            .env("CODEX_ACCESS_TOKEN", "synthetic-access-token")
            .env("CODEX_API_KEY", "synthetic-api-key")
            .env("OPENAI_API_KEY", "synthetic-provider-key")
            .env("OPENAI_BASE_URL", "https://fixture.invalid")
            .env("KODEX_GATEWAY_URL", "http://foreign.invalid:8787")
            .env("KODEX_GATEWAY_BINARY", "/foreign/desktop/gateway")
            .env("KODEX_ALLOW_REMOTE_SELF_CONTROL", "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
    }

    #[tokio::test]
    #[ignore = "invoked by parent test with isolated synthetic environment"]
    async fn isolated_environment_child() {
        let home = std::env::var_os("KODEX_ENVIRONMENT_FIXTURE_HOME").unwrap();
        let config = CodexConfig {
            binary: "/usr/bin/env".into(),
            args: vec![],
            home: home.clone().into(),
        };
        let output = codex_command(&config).output().await.unwrap();
        assert!(output.status.success());
        let environment = String::from_utf8(output.stdout).unwrap();
        let native_vars = environment
            .lines()
            .filter(|line| line.starts_with("CODEX_"))
            .collect::<Vec<_>>();
        assert_eq!(
            native_vars,
            vec![format!("CODEX_HOME={}", Path::new(&home).display())]
        );
        assert!(!environment.lines().any(
            |line| line.starts_with("OPENAI_API_KEY=") || line.starts_with("OPENAI_BASE_URL=")
        ));
        for name in [
            "KODEX_GATEWAY_URL",
            "KODEX_GATEWAY_BINARY",
            "KODEX_ALLOW_REMOTE_SELF_CONTROL",
        ] {
            assert!(
                !environment
                    .lines()
                    .any(|line| line.starts_with(&format!("{name}="))),
                "ambient control binding leaked: {name}"
            );
        }
        // Child sanitization must never mutate the gateway environment.
        assert_eq!(
            std::env::var("CODEX_ACCESS_TOKEN").unwrap(),
            "synthetic-access-token"
        );
    }

    fn write_fake_app_server(path: &Path, exit_after_initialized: bool) {
        let exit_line = if exit_after_initialized { "exit 0" } else { "" };
        std::fs::write(
            path,
            format!(
                r#"#!/bin/bash
if [[ ${{1:-}} == --version ]]; then printf 'codex-cli 0.160.0\n'; exit 0; fi
set -euo pipefail
log="$1"
IFS= read -r line
printf '%s\n' "$line" >> "$log"
printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"initialized":true}}}}'
IFS= read -r line
printf '%s\n' "$line" >> "$log"
{exit_line}
printf '%s\n' '{{"jsonrpc":"2.0","method":"turn/completed","params":{{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1"}}}}'
printf '%s\n' '{{"jsonrpc":"2.0","id":"approval-1","method":"item/permissions/requestApproval","params":{{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1"}}}}'
IFS= read -r line
printf '%s\n' "$line" >> "$log"
printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"ok":true}}}}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$log"
done
"#
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[async_trait]
    impl AppServer for RecordingAppServer {
        fn is_ready(&self) -> bool {
            self.ready.load(Ordering::SeqCst) && self.readiness_error.lock().unwrap().is_none()
        }

        fn readiness_error(&self) -> Option<String> {
            self.readiness_error.lock().unwrap().clone()
        }

        async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
            self.requests
                .lock()
                .unwrap()
                .push((method.to_string(), params.clone()));
            if method == "thread/list" {
                if let Some(section_id) = params.get("sectionId").and_then(Value::as_str) {
                    if let Some(response) = self
                        .thread_list_responses_by_section_id
                        .lock()
                        .unwrap()
                        .get(section_id)
                        .cloned()
                    {
                        return Ok(response);
                    }
                }
                if let Some(project_id) = params.get("projectId").and_then(Value::as_str) {
                    if let Some(response) = self
                        .thread_list_responses_by_project_id
                        .lock()
                        .unwrap()
                        .get(project_id)
                        .cloned()
                    {
                        return Ok(response);
                    }
                }
            }
            if method == "project/read" {
                if let Some(project) = params
                    .get("projectId")
                    .and_then(Value::as_str)
                    .and_then(|id| self.native_projects.lock().unwrap().get(id).cloned())
                {
                    return Ok(json!({"project": project}));
                }
            }
            if method == "project/list" {
                let projects = self.native_projects.lock().unwrap();
                if !projects.is_empty() {
                    let mut data = projects.values().cloned().collect::<Vec<_>>();
                    data.sort_by_key(|project| project["position"].as_i64().unwrap_or_default());
                    return Ok(json!({"data": data, "nextCursor": null}));
                }
            }
            let mut queued_errors = self.queued_errors.lock().unwrap();
            if !queued_errors.is_empty() {
                return Err(queued_errors.remove(0));
            }
            drop(queued_errors);
            let mut queued_responses = self.queued_responses.lock().unwrap();
            if !queued_responses.is_empty() {
                return Ok(queued_responses.remove(0));
            }
            drop(queued_responses);
            if method == "project/create" && self.next_response.lock().unwrap().is_none() {
                let mut projects = self.native_projects.lock().unwrap();
                let id = format!("native-project-{}", projects.len() + 1);
                let project = json!({
                    "id":id, "name":params["name"], "roots":params["roots"],
                    "metadata":params.get("metadata").cloned().unwrap_or_else(||json!({})),
                    "position":projects.len(), "createdAt":1_767_225_600_i64,
                    "updatedAt":1_767_225_600_i64, "recencyAt":null,
                });
                projects.insert(id, project.clone());
                return Ok(json!({"project":project}));
            }
            if method == "thread/start" && self.next_response.lock().unwrap().is_none() {
                let mut response = default_test_response(method);
                response["thread"]["cwd"] = params["cwd"].clone();
                response["thread"]["projectId"] = params["projectId"].clone();
                return Ok(response);
            }
            if method == "thread/queue/add" && self.next_response.lock().unwrap().is_none() {
                return Ok(json!({"queuedSubmission": {
                    "id": format!("native-queue-{}", uuid::Uuid::new_v4()),
                    "clientUserMessageId": params["clientUserMessageId"],
                    "input": params["input"],
                }}));
            }
            Ok(self
                .next_response
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| default_test_response(method)))
        }

        async fn respond(&self, request_id: &str, result: Value) -> ApiResult<()> {
            self.responses
                .lock()
                .unwrap()
                .push((request_id.to_string(), result));
            Ok(())
        }
        async fn respond_error(&self, request_id: &str, error: JsonRpcError) -> ApiResult<()> {
            self.error_responses
                .lock()
                .unwrap()
                .push((request_id.to_string(), error));
            Ok(())
        }
    }

    fn default_test_response(method: &str) -> Value {
        match method {
            "project/list" => json!({"data": [], "nextCursor": null}),
            "thread/list" => json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
            "thread/loaded/list" => json!({"data": [], "nextCursor": null}),
            "thread/queue/list" => json!({"data": [], "nextCursor": null}),
            "thread/queue/start" => json!({"turn": {
                "id":"native-queue-turn", "items":[], "itemsView":"notLoaded",
                "status":"inProgress", "error":null, "startedAt":null,
                "completedAt":null, "durationMs":null,
            }}),
            "thread/read" => json!({"thread": test_thread("thread-1")}),
            "thread/turns/list" => json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
            "thread/start" | "thread/resume" | "thread/fork" => json!({
                "thread": test_thread("thread-1"),
                "cwd": "/workspace",
                "model": "gpt-5.4",
                "modelProvider": "openai"
            }),
            "account/read" => json!({"requiresOpenaiAuth": true, "account": null}),
            "account/login/start" => json!({
                "type": "chatgptDeviceCode",
                "loginId": "login-1",
                "verificationUrl": "https://example.test/device",
                "userCode": "CODE-1234"
            }),
            "account/rateLimits/read" => json!({
                "rateLimits": null,
                "rateLimitsByLimitId": null
            }),
            "model/list" => json!({"data": [], "nextCursor": null}),
            "skills/list" => json!({"data": []}),
            _ => json!({"ok": true, "method": method}),
        }
    }

    fn test_thread(id: &str) -> Value {
        json!({
            "id": id,
            "cliVersion": "0.130.0",
            "cwd": "/workspace",
            "ephemeral": false,
            "modelProvider": "openai",
            "preview": "hello",
            "source": "cli",
            "status": {"type": "idle"},
            "turns": [],
            "createdAt": 1_767_225_600_i64,
            "updatedAt": 1_767_225_600_i64
        })
    }
}
