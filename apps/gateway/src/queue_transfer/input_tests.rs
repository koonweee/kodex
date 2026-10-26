use crate::{
    api::AppState,
    app_server::{AppServer, JsonRpcError},
    config::Config,
    error::{ApiError, ApiResult},
    store::Store,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

struct RejectingNative {
    calls: Mutex<Vec<String>>,
    code: Option<i64>,
}
#[async_trait]
impl AppServer for RejectingNative {
    fn is_ready(&self) -> bool {
        true
    }
    fn readiness_error(&self) -> Option<String> {
        None
    }
    async fn respond(&self, _: &str, _: Value) -> ApiResult<()> {
        unreachable!()
    }
    async fn request(&self, method: &str, _: Value) -> ApiResult<Value> {
        self.calls.lock().unwrap().push(method.into());
        if method == "thread/read" {
            return Ok(
                json!({"thread":{"id":"chat","cwd":"/tmp","status":{"type":"idle"},"createdAt":1,"updatedAt":1,"canAcceptDirectInput":true}}),
            );
        }
        assert_eq!(method, "thread/queue/add");
        match self.code {
            Some(code) => Err(ApiError::NativeRpc(JsonRpcError {
                code,
                message: "private native diagnostic".into(),
                data: Some(json!({"secret":"private-data"})),
            })),
            None => Err(ApiError::BadGateway("acknowledgement lost".into())),
        }
    }
}

#[tokio::test]
async fn rejected_queue_requests_are_distinct_from_unconfirmed_writes() {
    for code in [Some(-32600), Some(-32601), Some(-32602), Some(-32603), None] {
        let native = Arc::new(RejectingNative {
            calls: Mutex::new(vec![]),
            code,
        });
        let state = AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            native.clone(),
        );
        let error = super::enqueue(
            &state,
            "chat",
            vec![json!({"type":"text","text":"hello"})],
            "attempt".into(),
        )
        .await
        .unwrap_err();
        let body = error.body();
        assert!(!body.message.contains("private"));
        assert!(
            !body.retryable,
            "an input write must never invite automatic retry: {body:?}"
        );
        if matches!(code, Some(-32600 | -32601 | -32602)) {
            assert_eq!(body.code, "bad_request");
            assert!(
                body.message.contains("rejected") && !body.message.contains("may have occurred")
            );
        } else {
            assert_eq!(body.code, "native_queue_admission_uncertain");
            assert!(body.message.contains("inspect the queue"));
        }
        assert_eq!(
            native
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|m| *m == "thread/queue/add")
                .count(),
            1
        );
    }
}
