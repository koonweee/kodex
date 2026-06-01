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
        let detected_version = detect_codex_cli_version(config).await;

        let mut child = Command::new(&config.binary)
            .args(&config.args)
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

        server.initialize().await?;
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
        self.probe_required_experimental_behavior().await?;
        self.ready.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn probe_required_experimental_behavior(&self) -> ApiResult<()> {
        match self
            .startup_probe_request(
                "thread/resume",
                json!({
                    "threadId": "00000000-0000-0000-0000-000000000000",
                    "persistExtendedHistory": true
                }),
            )
            .await?
        {
            Ok(_) => Ok(()),
            Err(error) if error.message.contains("persistExtendedHistory") => {
                self.mark_persist_extended_history_incompatible();
                Err(ApiError::BadGateway(format!(
                    "app-server error {}: {}",
                    error.code, error.message
                )))
            }
            Err(error) if is_expected_probe_missing_thread_error(&error.message) => Ok(()),
            Err(error) => {
                self.ready.store(false, Ordering::SeqCst);
                *self.readiness_error.lock().unwrap() = Some(format!(
                    "Codex app-server compatibility probe failed: {}",
                    error.message
                ));
                Err(ApiError::BadGateway(format!(
                    "app-server compatibility probe failed {}: {}",
                    error.code, error.message
                )))
            }
        }
    }

    async fn startup_probe_request(
        &self,
        method: &str,
        params: Value,
    ) -> ApiResult<Result<Value, JsonRpcError>> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let message = client_request_message(id, method, params);

        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);

        if let Err(error) = self.write_message(message).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }

        receiver.await.map_err(|_| ApiError::AppServerUnavailable)
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

    fn mark_persist_extended_history_incompatible(&self) {
        self.ready.store(false, Ordering::SeqCst);
        *self.readiness_error.lock().unwrap() = Some(
            "Codex app-server is incompatible: rejected required persistExtendedHistory field"
                .to_string(),
        );
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
            "experimentalApi": true
        }
    })
}

fn is_expected_probe_missing_thread_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    (message.contains("thread")
        && (message.contains("not found")
            || message.contains("no such")
            || message.contains("does not exist")
            || message.contains("unknown")))
        || message.contains("no rollout found for thread id")
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
                let message = if let Some(data) = error.data {
                    format!(
                        "app-server error {}: {}; data: {}",
                        error.code, error.message, data
                    )
                } else {
                    format!("app-server error {}: {}", error.code, error.message)
                };
                if message.contains("persistExtendedHistory") {
                    self.mark_persist_extended_history_incompatible();
                }
                log_app_server_timing(method, started_at, None, "bad_gateway");
                Err(ApiError::BadGateway(message))
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

fn api_error_classification(error: &ApiError) -> &'static str {
    match error {
        ApiError::NotFound(_) => "not_found",
        ApiError::BadRequest(_) => "bad_request",
        ApiError::UnsupportedMediaType(_) => "unsupported_media_type",
        ApiError::Conflict(_) => "conflict",
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
        Command::new(&config.binary).arg("--version").output(),
    )
    .await
    .ok()?
    .ok()?;

    if !output.status.success() {
        return None;
    }

    parse_codex_cli_version(&String::from_utf8_lossy(&output.stdout))
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
        pub queued_errors: StdMutex<Vec<ApiError>>,
        pub queued_responses: StdMutex<Vec<Value>>,
        pub thread_list_responses_by_cwd: StdMutex<HashMap<String, Value>>,
        pub next_response: StdMutex<Option<Value>>,
    }

    #[test]
    fn initialize_params_match_current_protocol_shape() {
        let params = initialize_params();
        assert_eq!(params["clientInfo"]["name"], "kodex_gateway");
        assert_eq!(params["clientInfo"]["title"], "Kodex Gateway");
        assert_eq!(params["clientInfo"]["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(params["capabilities"]["experimentalApi"], true);
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

    #[test]
    fn startup_probe_only_accepts_missing_thread_errors() {
        assert!(is_expected_probe_missing_thread_error("thread not found"));
        assert!(is_expected_probe_missing_thread_error("no such thread"));
        assert!(is_expected_probe_missing_thread_error(
            "no rollout found for thread id 00000000-0000-0000-0000-000000000000"
        ));
        assert!(!is_expected_probe_missing_thread_error("missing field cwd"));
        assert!(!is_expected_probe_missing_thread_error(
            "unknown field persistExtendedHistory"
        ));
    }

    #[tokio::test]
    async fn supervisor_initializes_and_routes_process_messages() {
        let dir = tempdir().unwrap();
        let script = dir.path().join("fake-app-server.sh");
        let log = dir.path().join("messages.log");
        write_fake_app_server(&script, false);

        let config = CodexConfig {
            binary: "/bin/bash".to_string(),
            args: vec![script.display().to_string(), log.display().to_string()],
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
        assert_eq!(lines.next().unwrap()["method"], "thread/resume");
        assert_eq!(lines.next().unwrap()["method"], "thread/list");
    }

    #[tokio::test]
    async fn child_process_exit_changes_readiness() {
        let dir = tempdir().unwrap();
        let script = dir.path().join("fake-app-server.sh");
        let log = dir.path().join("messages.log");
        write_fake_app_server(&script, true);

        let config = CodexConfig {
            binary: "/bin/bash".to_string(),
            args: vec![script.display().to_string(), log.display().to_string()],
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
    async fn persist_extended_history_rejection_fails_startup_readiness() {
        let dir = tempdir().unwrap();
        let script = dir.path().join("rejecting-app-server.sh");
        let log = dir.path().join("messages.log");
        write_persist_rejecting_app_server(&script);

        let config = CodexConfig {
            binary: "/bin/bash".to_string(),
            args: vec![script.display().to_string(), log.display().to_string()],
        };
        let (inbound_tx, _inbound_rx) = mpsc::channel(8);
        let error = match JsonRpcAppServer::start(&config, inbound_tx).await {
            Ok(server) => {
                server.shutdown().await.unwrap();
                panic!("expected incompatible app-server startup to fail");
            }
            Err(error) => error,
        };

        assert!(error.to_string().contains("persistExtendedHistory"));
    }

    fn write_fake_app_server(path: &Path, exit_after_initialized: bool) {
        let exit_line = if exit_after_initialized { "exit 0" } else { "" };
        std::fs::write(
            path,
            format!(
                r#"set -euo pipefail
log="$1"
IFS= read -r line
printf '%s\n' "$line" >> "$log"
printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"initialized":true}}}}'
IFS= read -r line
printf '%s\n' "$line" >> "$log"
IFS= read -r line
printf '%s\n' "$line" >> "$log"
printf '%s\n' '{{"jsonrpc":"2.0","id":2,"error":{{"code":-32602,"message":"thread not found"}}}}'
{exit_line}
printf '%s\n' '{{"jsonrpc":"2.0","method":"turn/completed","params":{{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1"}}}}'
printf '%s\n' '{{"jsonrpc":"2.0","id":"approval-1","method":"item/permissions/requestApproval","params":{{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1"}}}}'
IFS= read -r line
printf '%s\n' "$line" >> "$log"
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{"ok":true}}}}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$log"
done
"#
            ),
        )
        .unwrap();
    }

    fn write_persist_rejecting_app_server(path: &Path) {
        std::fs::write(
            path,
            r#"set -euo pipefail
log="$1"
IFS= read -r line
printf '%s\n' "$line" >> "$log"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"initialized":true}}'
IFS= read -r line
printf '%s\n' "$line" >> "$log"
IFS= read -r line
printf '%s\n' "$line" >> "$log"
printf '%s\n' '{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"unknown field persistExtendedHistory"}}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$log"
done
"#,
        )
        .unwrap();
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
                if let Some(cwd) = params.get("cwd").and_then(Value::as_str) {
                    if let Some(response) = self
                        .thread_list_responses_by_cwd
                        .lock()
                        .unwrap()
                        .get(cwd)
                        .cloned()
                    {
                        return Ok(response);
                    }
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
    }

    fn default_test_response(method: &str) -> Value {
        match method {
            "thread/list" => json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
            "thread/loaded/list" => json!({"data": [], "nextCursor": null}),
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
                "type": "chatgpt",
                "loginId": "login-1",
                "authUrl": "https://example.test/login"
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
