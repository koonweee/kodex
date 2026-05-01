use std::{
    collections::HashMap,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, oneshot, Mutex},
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
}

impl JsonRpcAppServer {
    pub async fn start(
        config: &CodexConfig,
        inbound: mpsc::Sender<InboundMessage>,
    ) -> ApiResult<Arc<Self>> {
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

#[async_trait]
impl AppServer for JsonRpcAppServer {
    fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        if !self.is_ready() && method != "initialize" {
            return Err(ApiError::AppServerUnavailable);
        }

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let message = client_request_message(id, method, params);
        validate_client_request(&message)?;

        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);

        if let Err(error) = self.write_message(message).await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }

        match receiver.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) if error.code == -32001 => Err(ApiError::Retryable(error.message)),
            Ok(Err(error)) => Err(ApiError::Other(anyhow::anyhow!(
                "app-server error {}: {}",
                error.code,
                error.message
            ))),
            Err(_) => Err(ApiError::AppServerUnavailable),
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
    let status = server.child.lock().await.wait().await;
    server.ready.store(false, Ordering::SeqCst);
    match status {
        Ok(status) => tracing::warn!(%status, "codex app-server exited"),
        Err(error) => tracing::warn!(%error, "failed waiting for codex app-server"),
    }
}

#[cfg(test)]
pub mod tests {
    use std::sync::Mutex as StdMutex;

    use super::*;

    #[derive(Default)]
    pub struct RecordingAppServer {
        pub ready: AtomicBool,
        pub requests: StdMutex<Vec<(String, Value)>>,
        pub responses: StdMutex<Vec<(String, Value)>>,
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

    #[async_trait]
    impl AppServer for RecordingAppServer {
        fn is_ready(&self) -> bool {
            self.ready.load(Ordering::SeqCst)
        }

        async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
            self.requests
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            Ok(json!({"ok": true, "method": method}))
        }

        async fn respond(&self, request_id: &str, result: Value) -> ApiResult<()> {
            self.responses
                .lock()
                .unwrap()
                .push((request_id.to_string(), result));
            Ok(())
        }
    }
}
