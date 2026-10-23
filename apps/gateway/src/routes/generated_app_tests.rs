//! Generated-card admission, canonical convergence, bridge isolation and retirement.
use super::tests::{response_json, test_state};
use crate::{
    app_server::{tests::RecordingAppServer, AppServer, InboundMessage},
    error::ApiResult,
    AppState,
};
use async_trait::async_trait;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tower::ServiceExt;

struct Native {
    inner: Arc<RecordingAppServer>,
    retained: AtomicBool,
}
#[async_trait]
impl AppServer for Native {
    fn is_ready(&self) -> bool {
        true
    }
    fn readiness_error(&self) -> Option<String> {
        None
    }
    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        if method == "thread/items/list" {
            return Ok(
                json!({"data":if self.retained.load(Ordering::SeqCst) {vec![json!({"turnId":"turn-1","item":{"id":"call-1","type":"mcpToolCall","server":"kodex-control","tool":"create_app_surface","arguments":{},"status":"completed"}})]} else {vec![]},"nextCursor":null}),
            );
        }
        self.inner.request(method, params).await
    }
    async fn respond(&self, id: &str, response: Value) -> ApiResult<()> {
        self.inner.respond(id, response).await
    }
}
async fn request(state: &AppState, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = crate::build_router(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    (status, response_json(response).await)
}
async fn seed(state: &AppState, title: &str) {
    let mut args = body(title);
    args["threadId"] = json!("thread-1");
    crate::events::ingest_inbound(InboundMessage::Notification {method:"item/started".into(),params:json!({"threadId":"thread-1","turnId":"turn-1","item":{"id":"call-1","type":"mcpToolCall","server":"kodex-control","tool":"create_app_surface","arguments":args,"status":"inProgress"}})},state).await.unwrap();
}
fn body(title: &str) -> Value {
    json!({"origin":{"threadId":"thread-1","turnId":"turn-1","itemId":"call-1"},"title":title,"html":format!("<main>{title}</main>"),"fallbackContent":title,"grants":{"canSendMessage":true,"tools":[{"name":"lookup","server":"docs","tool":"lookup"}]}})
}
async fn bridge(
    state: &AppState,
    card: &Value,
    method: &str,
    params: Value,
) -> (StatusCode, Value) {
    request(state,"POST",&format!("/v1/app-surfaces/{}/bridge",card["id"].as_str().unwrap()),json!({"id":"action","bridgeToken":card["bridgeToken"],"revision":card["revision"],"method":method,"params":params})).await
}
#[tokio::test]
async fn generated_cards_publish_to_two_clients_keep_old_grants_and_reject_orphans() {
    let (mut state, inner) = test_state().await;
    let native = Arc::new(Native {
        inner: inner.clone(),
        retained: AtomicBool::new(true),
    });
    state.app_server = native.clone();
    seed(&state, "A").await;
    let mut first = state.events.subscribe();
    let mut second = state.events.subscribe();
    let (status, a) = request(
        &state,
        "POST",
        "/v1/self-control/threads/thread-1/app-surface",
        body("A"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{a}");
    let a = a["session"].clone();
    let one = first.recv().await.unwrap();
    let two = second.recv().await.unwrap();
    assert_eq!(one.kind, "thread_view.patch");
    assert_eq!(one.payload, two.payload);
    assert_eq!(
        one.payload["rows"][1]["item"]["payload"]["item"]["generatedApp"]["id"],
        a["id"]
    );
    seed(&state, "B").await;
    let (_, b) = request(
        &state,
        "POST",
        "/v1/self-control/threads/thread-1/app-surface",
        body("B"),
    )
    .await;
    assert_ne!(a["id"], b["session"]["id"]);
    let snapshot = state.thread_views.snapshot("thread-1").await.unwrap();
    assert_eq!(
        snapshot
            .rows
            .iter()
            .filter(|row| row.kind == "generated_app")
            .count(),
        2
    );
    let (_, read) = request(
        &state,
        "GET",
        &format!("/v1/app-surfaces/{}", a["id"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(read["session"], a);
    let (_, own) = bridge(
        &state,
        &a,
        "resources/read",
        json!({"uri":a["resourceUri"]}),
    )
    .await;
    assert_eq!(own["result"]["contents"][0]["text"], "<main>A</main>");
    let (_, denied) = bridge(
        &state,
        &a,
        "tools/call",
        json!({"name":"ungranted","arguments":{}}),
    )
    .await;
    assert_eq!(denied["error"]["code"], -32000);
    let (_, approval) = bridge(
        &state,
        &a,
        "tools/call",
        json!({"name":"lookup","arguments":{"query":"answer"}}),
    )
    .await;
    assert_eq!(approval["result"]["approvalRequired"], true, "{approval}");
    for text in ["First action", "Second action"] {
        inner
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"turn":{"id":"submitted","status":"inProgress"}}));
        let (status, result) = bridge(
            &state,
            &a,
            "ui/message",
            json!({"role":"user","content":{"type":"text","text":text}}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(result["error"].is_null(), "{result}");
    }
    let calls = inner.requests.lock().unwrap();
    let inputs = calls
        .iter()
        .filter(|(m, _)| m == "turn/start")
        .collect::<Vec<_>>();
    assert_eq!(inputs.len(), 2);
    assert_ne!(
        inputs[0].1["clientUserMessageId"],
        inputs[1].1["clientUserMessageId"]
    );
    drop(calls);
    native.retained.store(false, Ordering::SeqCst);
    assert_eq!(
        bridge(
            &state,
            &a,
            "ui/message",
            json!({"role":"user","content":{"type":"text","text":"obsolete"}})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    state
        .thread_views
        .reset_history("thread-1", std::future::ready(Ok(10000)))
        .await
        .unwrap();
    assert!(state
        .thread_views
        .load_generated_apps(&state.store, "thread-1", 1)
        .await
        .is_err());
    state
        .thread_views
        .load_generated_apps(&state.store, "thread-1", 10000)
        .await
        .unwrap();
    assert!(state
        .thread_views
        .snapshot("thread-1")
        .await
        .unwrap()
        .rows
        .is_empty());
    assert_eq!(
        state.store.generated_apps("thread-1").await.unwrap().len(),
        2
    );
}

#[tokio::test]
async fn generated_admission_requires_the_live_call_in_its_explicit_native_thread() {
    let (state, _) = test_state().await;
    let path = "/v1/self-control/threads/thread-1/app-surface";
    assert_eq!(
        request(&state, "POST", path, body("No origin witness"))
            .await
            .0,
        StatusCode::CONFLICT
    );
    seed(&state, "A").await;
    let mut wrong = body("Wrong");
    wrong["origin"]["threadId"] = json!("another");
    assert_eq!(
        request(&state, "POST", path, wrong).await.0,
        StatusCode::CONFLICT
    );
    assert!(state
        .store
        .generated_apps("thread-1")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn legacy_generated_storage_is_retired_without_history_import_or_presentation() {
    let (state, _) = test_state().await;
    let session = state
        .store
        .upsert_app_surface_session(crate::store::AppSurfaceSessionUpsert {
            thread_id: "thread-1".into(),
            provider: crate::store::AppSurfaceProvider::Generated,
            title: "Legacy".into(),
            html: "<main>Old</main>".into(),
            fallback_content: "Old".into(),
            resource_uri: None,
            resource_mime_type: "text/html;profile=mcp-app".into(),
            display_modes: vec!["inline".into()],
            csp: Default::default(),
            permissions: Default::default(),
            grants: Default::default(),
            provenance: json!({}),
        })
        .await
        .unwrap();
    let (_, read) = request(
        &state,
        "GET",
        "/v1/threads/thread-1/app-surface",
        Value::Null,
    )
    .await;
    assert!(read["session"].is_null());
    assert_eq!(read["retiredGenerated"], true);
    assert_eq!(
        request(
            &state,
            "POST",
            "/v1/self-control/threads/thread-1/app-surface/presentation",
            json!({"action":"focus"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &state,
            "DELETE",
            "/v1/self-control/threads/thread-1/app-surface",
            json!({})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &state,
            "GET",
            &format!("/v1/app-surfaces/{}/document?revision=1", session.id),
            Value::Null
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert!(state
        .store
        .generated_apps("thread-1")
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        state
            .store
            .get_app_surface_session(&session.id)
            .await
            .unwrap()
            .html,
        "<main>Old</main>"
    );
}
