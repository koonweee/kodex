use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use async_trait::async_trait;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::{
    sync::oneshot,
    task::JoinSet,
    time::{timeout, Duration},
};
use tower::ServiceExt;

use crate::{
    api::{build_router, AppState},
    app_server::{AppServer, InboundMessage},
    config::Config,
    error::{ApiError, ApiResult},
    events::ingest_inbound,
    store::Store,
};

const THREAD: &str = "shared-read-chat";
// Deliberately reverse lexical order and use identical native timestamps.
const FIRST: &str = "z-first-completion";
const SECOND: &str = "a-second-completion";
const THIRD: &str = "opaque-third-completion";

struct HeadGate {
    started: oneshot::Sender<()>,
    release: oneshot::Receiver<()>,
}

struct MarkerNative {
    requests: Mutex<Vec<(String, Value)>>,
    heads: Mutex<HashMap<String, Value>>,
    pages: Mutex<Vec<Vec<String>>>,
    malformed_inventory_cursor: Mutex<Option<Value>>,
    gates: Mutex<HashMap<String, HeadGate>>,
    inventory_gate: Mutex<Option<HeadGate>>,
    active_heads: AtomicUsize,
    max_active_heads: AtomicUsize,
}

impl MarkerNative {
    fn new(pages: &[&[&str]]) -> Self {
        let pages = pages
            .iter()
            .map(|page| page.iter().map(|id| id.to_string()).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        let heads = pages
            .iter()
            .flatten()
            .map(|id| (id.clone(), headers(&[(FIRST, "completed")], false)))
            .collect();
        Self {
            requests: Mutex::new(Vec::new()),
            heads: Mutex::new(heads),
            pages: Mutex::new(pages),
            malformed_inventory_cursor: Mutex::new(None),
            gates: Mutex::new(HashMap::new()),
            inventory_gate: Mutex::new(None),
            active_heads: AtomicUsize::new(0),
            max_active_heads: AtomicUsize::new(0),
        }
    }

    fn set_head(&self, thread_id: &str, turn_id: &str) {
        self.heads
            .lock()
            .unwrap()
            .insert(thread_id.into(), headers(&[(turn_id, "completed")], false));
    }

    fn hold_next_head(&self, thread_id: &str) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (started, wait) = oneshot::channel();
        let (release, blocked) = oneshot::channel();
        self.gates.lock().unwrap().insert(
            thread_id.into(),
            HeadGate {
                started,
                release: blocked,
            },
        );
        (wait, release)
    }

    fn hold_inventory(&self) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (started, wait) = oneshot::channel();
        let (release, blocked) = oneshot::channel();
        *self.inventory_gate.lock().unwrap() = Some(HeadGate {
            started,
            release: blocked,
        });
        (wait, release)
    }
}

#[async_trait]
impl AppServer for MarkerNative {
    fn is_ready(&self) -> bool {
        true
    }
    fn readiness_error(&self) -> Option<String> {
        None
    }

    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        self.requests
            .lock()
            .unwrap()
            .push((method.into(), params.clone()));
        match method {
            "thread/list" => {
                let index = match params["cursor"].as_str() {
                    None => 0,
                    Some(cursor) => cursor
                        .strip_prefix("native-page-")
                        .and_then(|value| value.parse().ok())
                        .ok_or_else(|| {
                            ApiError::BadGateway("unexpected inventory cursor".into())
                        })?,
                };
                let mut captured = {
                    let pages = self.pages.lock().unwrap();
                    let ids = pages.get(index).ok_or_else(|| {
                        ApiError::BadGateway("inventory page outside fixture".into())
                    })?;
                    json!({"data": ids.iter().map(|id| summary(id)).collect::<Vec<_>>(), "nextCursor": (index + 1 < pages.len()).then(|| format!("native-page-{}", index + 1)), "backwardsCursor": null})
                };
                if let Some(cursor) = self.malformed_inventory_cursor.lock().unwrap().clone() {
                    captured["nextCursor"] = cursor;
                }
                let gate = self.inventory_gate.lock().unwrap().take();
                if let Some(gate) = gate {
                    let _ = gate.started.send(());
                    gate.release.await.map_err(|_| {
                        ApiError::BadGateway("held inventory read cancelled".into())
                    })?;
                }
                Ok(captured)
            }
            "thread/read" if params["includeTurns"] == false => {
                Ok(json!({"thread": summary(params["threadId"].as_str().unwrap())}))
            }
            "thread/turns/list" => {
                let thread_id = params["threadId"].as_str().unwrap();
                let captured = self
                    .heads
                    .lock()
                    .unwrap()
                    .get(thread_id)
                    .cloned()
                    .ok_or_else(|| {
                        ApiError::BadGateway(format!("unknown fixture thread {thread_id}"))
                    })?;
                if params["itemsView"] == "notLoaded" {
                    if params["cursor"] != Value::Null
                        || params["sortDirection"] != "desc"
                        || params["limit"] != 8
                    {
                        return Err(ApiError::BadGateway(format!(
                            "completion read must be one bounded native header page: {params}"
                        )));
                    }
                    let active = self.active_heads.fetch_add(1, Ordering::SeqCst) + 1;
                    self.max_active_heads.fetch_max(active, Ordering::SeqCst);
                    let gate = self.gates.lock().unwrap().remove(thread_id);
                    if let Some(gate) = gate {
                        let _ = gate.started.send(());
                        gate.release.await.map_err(|_| {
                            ApiError::BadGateway("held header read cancelled".into())
                        })?;
                    }
                    self.active_heads.fetch_sub(1, Ordering::SeqCst);
                    Ok(captured)
                } else if params["itemsView"] == "full" {
                    let mut page = captured;
                    page["nextCursor"] = Value::Null;
                    for turn in page["data"].as_array_mut().unwrap() {
                        turn["itemsView"] = json!("full");
                    }
                    Ok(page)
                } else {
                    Err(ApiError::BadGateway("unsupported item view".into()))
                }
            }
            _ => Err(ApiError::BadGateway(format!(
                "unexpected marker native request: {method} {params}"
            ))),
        }
    }

    async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
        Err(ApiError::BadGateway(
            "read marker must not answer native request".into(),
        ))
    }
}

fn summary(thread_id: &str) -> Value {
    json!({"id":thread_id,"cwd":"/marker-fixture","name":thread_id,"source":"cli","createdAt":1,"updatedAt":2,"status":{"type":"idle"},"modelProvider":"openai","turns":[]})
}

fn headers(turns: &[(&str, &str)], has_older: bool) -> Value {
    json!({"data": turns.iter().map(|(id, status)| json!({"id":id,"status":status,"startedAt":42,"completedAt":42,"items":[],"itemsView":"notLoaded"})).collect::<Vec<_>>(), "nextCursor":has_older.then_some("opaque-history-not-to-walk"),"backwardsCursor":null})
}

async fn fixture(pages: &[&[&str]]) -> (AppState, Arc<MarkerNative>) {
    let native = Arc::new(MarkerNative::new(pages));
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    (state, native)
}

async fn request(
    state: &AppState,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let response = build_router(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"text":String::from_utf8_lossy(&bytes)})),
    )
}

async fn list(state: &AppState) -> Value {
    let (status, body) = request(state, "GET", "/v1/threads", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["threads"][0].clone()
}

fn revision(read: &Value) -> i64 {
    read["readRevision"]
        .as_i64()
        .expect("authoritative read revision")
}

fn assert_read(read: &Value, latest: Option<&str>, seen: Option<&str>, unread: bool) {
    assert_eq!(read["latestCompletedTurnId"], json!(latest));
    assert_eq!(read["seenCompletedTurnId"], json!(seen));
    assert_eq!(read["readStateKnown"], true);
    assert_eq!(read["unreadCompletedAgentTurn"], unread);
    assert!(revision(read) > 0);
    assert!(read.get("lastCompletedAgentTurnSeq").is_none());
    assert!(read.get("seenCompletedAgentTurnSeq").is_none());
}

fn assert_unknown(read: &Value, seen: Option<&str>) {
    assert!(read["latestCompletedTurnId"].is_null());
    assert_eq!(read["seenCompletedTurnId"], json!(seen));
    assert_eq!(read["readStateKnown"], false);
    assert_eq!(read["unreadCompletedAgentTurn"], false);
    assert!(revision(read) > 0);
}

async fn seen(
    state: &AppState,
    thread_id: &str,
    turn_id: &str,
    read_revision: i64,
) -> (StatusCode, Value) {
    request(
        state,
        "POST",
        &format!("/v1/threads/{thread_id}/seen"),
        Some(json!({"completedTurnId":turn_id,"readRevision":read_revision})),
    )
    .await
}

async fn stream(state: &AppState) -> Body {
    let cursor = state.store.latest_event_seq().await.unwrap();
    let response = build_router(state.clone())
        .oneshot(
            Request::get(format!("/v1/events?threadId={THREAD}&cursor={cursor}"))
                .header("accept", "text/event-stream")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response.into_body()
}

async fn read_event(body: &mut Body, minimum_revision: i64) -> Value {
    timeout(Duration::from_secs(2), async {
        let mut buffer = String::new();
        while let Some(frame) = body.frame().await {
            if let Some(bytes) = frame.unwrap().data_ref() {
                buffer.push_str(std::str::from_utf8(bytes).unwrap());
            }
            while let Some(end) = buffer.find("\n\n") {
                let event = buffer.drain(..end + 2).collect::<String>();
                for data in event.lines().filter_map(|line| line.strip_prefix("data: ")) {
                    let envelope: Value = serde_json::from_str(data).unwrap();
                    if envelope["kind"] == "thread.read_updated"
                        && envelope["payload"]["readRevision"]
                            .as_i64()
                            .is_some_and(|rev| rev >= minimum_revision)
                    {
                        return envelope["payload"].clone();
                    }
                }
            }
        }
        panic!("SSE ended before authoritative read update")
    })
    .await
    .expect("missing authoritative read update")
}

async fn complete(state: &AppState, native: &MarkerNative, turn_id: &str) {
    native.set_head(THREAD, turn_id);
    terminal_event(state, turn_id).await;
}

async fn terminal_event(state: &AppState, turn_id: &str) {
    ingest_inbound(InboundMessage::Notification {method:"turn/completed".into(),params:json!({"threadId":THREAD,"turn":{"id":turn_id,"status":"completed","items":[],"itemsView":"notLoaded","startedAt":42,"completedAt":42}})},state).await.unwrap();
}

fn assert_read_only_headers(native: &MarkerNative) {
    for (method, params) in native.requests.lock().unwrap().iter() {
        assert!(
            matches!(
                method.as_str(),
                "thread/list" | "thread/read" | "thread/turns/list"
            ),
            "unexpected native mutation {method}"
        );
        if method == "thread/read" {
            assert_eq!(params["includeTurns"], false);
        }
        if method == "thread/turns/list" {
            assert_eq!(params["itemsView"], "notLoaded");
            assert_eq!(params["limit"], 8);
            assert!(params["cursor"].is_null());
        }
    }
}

#[tokio::test]
async fn native_read_marker_two_clients_ack_exact_head_and_receive_revisioned_sse() {
    let (state, native) = fixture(&[&[THREAD]]).await;
    let first = list(&state).await;
    assert_read(&first, Some(FIRST), None, true);
    let mut second_client = stream(&state).await;
    let (status, acknowledged) = seen(&state, THREAD, FIRST, revision(&first)).await;
    assert_eq!(status, StatusCode::OK, "{acknowledged}");
    assert_read(&acknowledged, Some(FIRST), Some(FIRST), false);
    assert!(revision(&acknowledged) > revision(&first));
    assert_eq!(acknowledged["threadId"], THREAD);
    chrono::DateTime::parse_from_rfc3339(acknowledged["updatedAt"].as_str().unwrap()).unwrap();
    assert_eq!(
        read_event(&mut second_client, revision(&acknowledged)).await,
        acknowledged
    );

    complete(&state, &native, SECOND).await;
    let invalidated = read_event(&mut second_client, revision(&acknowledged) + 1).await;
    assert_unknown(&invalidated, Some(FIRST));
    // The other client refills after the revisioned invalidation. Ingestion
    // itself cannot wait for a native RPC on its bounded notification channel.
    let newer = list(&state).await;
    assert_read(&newer, Some(SECOND), Some(FIRST), true);
    for (turn, old_revision) in [(FIRST, revision(&acknowledged)), (FIRST, revision(&newer))] {
        let (status, _) = seen(&state, THREAD, turn, old_revision).await;
        assert_eq!(
            status,
            StatusCode::CONFLICT,
            "stale or wrong-head acknowledgment must reject"
        );
    }
    let (status, final_read) = seen(&state, THREAD, SECOND, revision(&newer)).await;
    assert_eq!(status, StatusCode::OK, "{final_read}");
    assert_read(&final_read, Some(SECOND), Some(SECOND), false);
    assert_eq!(
        read_event(&mut second_client, revision(&final_read)).await,
        final_read
    );
    assert_read(&list(&state).await, Some(SECOND), Some(SECOND), false);
    assert_read_only_headers(&native);
}

#[tokio::test]
async fn native_read_marker_requires_explicit_identity_and_revision_without_latest_fallback() {
    let (state, native) = fixture(&[&[THREAD]]).await;
    let initial = list(&state).await;
    native.requests.lock().unwrap().clear();
    for body in [
        None,
        Some(json!({})),
        Some(json!({"completedTurnId":FIRST})),
        Some(json!({"readRevision":revision(&initial)})),
        Some(json!({"seenCompletedAgentTurnSeq":999})),
    ] {
        let (status, _) =
            request(&state, "POST", &format!("/v1/threads/{THREAD}/seen"), body).await;
        assert!(
            status.is_client_error(),
            "missing identity/revision must not acknowledge latest: {status}"
        );
    }
    assert!(native.requests.lock().unwrap().is_empty());
    let after = list(&state).await;
    assert_read(&after, Some(FIRST), None, true);
    assert_eq!(revision(&after), revision(&initial));
}

#[tokio::test]
async fn native_read_marker_reconciles_missed_completion_and_offline_revert_from_native_identity() {
    let (state, native) = fixture(&[&[THREAD]]).await;
    let initial = list(&state).await;
    let (status, acknowledged) = seen(&state, THREAD, FIRST, revision(&initial)).await;
    assert_eq!(status, StatusCode::OK);
    // A new gateway projection retains shared acknowledgments but received no
    // completion or revert events while native history changed.
    let restarted = AppState::new(Config::default(), state.store.clone(), native.clone());
    native.set_head(THREAD, SECOND);
    let missed = list(&restarted).await;
    assert_read(&missed, Some(SECOND), Some(FIRST), true);
    assert!(revision(&missed) > revision(&acknowledged));
    let (status, acknowledged) = seen(&restarted, THREAD, SECOND, revision(&missed)).await;
    assert_eq!(status, StatusCode::OK);
    native.set_head(THREAD, FIRST);
    let rewound = list(&restarted).await;
    assert_read(&rewound, Some(FIRST), Some(SECOND), true);
    assert!(revision(&rewound) > revision(&acknowledged));
    let (status, read) = seen(&restarted, THREAD, FIRST, revision(&rewound)).await;
    assert_eq!(status, StatusCode::OK);
    assert_read(&read, Some(FIRST), Some(FIRST), false);
    assert_read_only_headers(&native);
}

#[tokio::test]
async fn native_read_marker_held_header_cannot_overwrite_new_completion_and_ack() {
    let (state, native) = fixture(&[&[THREAD]]).await;
    let initial = list(&state).await;
    let (status, _) = seen(&state, THREAD, FIRST, revision(&initial)).await;
    assert_eq!(status, StatusCode::OK);
    native.set_head(THREAD, SECOND);
    let (captured, release) = native.hold_next_head(THREAD);
    let old_state = state.clone();
    let old_read = tokio::spawn(async move { list(&old_state).await });
    timeout(Duration::from_secs(2), captured)
        .await
        .unwrap()
        .unwrap();
    let mut observer = stream(&state).await;
    complete(&state, &native, THIRD).await;
    let invalidated = read_event(&mut observer, revision(&initial) + 1).await;
    assert_unknown(&invalidated, Some(FIRST));
    let current = list(&state).await;
    assert_read(&current, Some(THIRD), Some(FIRST), true);
    let (status, acknowledged) = seen(&state, THREAD, THIRD, revision(&current)).await;
    assert_eq!(status, StatusCode::OK);
    release.send(()).unwrap();
    let old_reply = timeout(Duration::from_secs(2), old_read)
        .await
        .unwrap()
        .unwrap();
    assert_read(&old_reply, Some(THIRD), Some(THIRD), false);
    assert_eq!(revision(&old_reply), revision(&acknowledged));
    assert_read_only_headers(&native);
}

#[path = "native_read_marker_lag_tests.rs"]
mod lag_tests;

#[tokio::test]
async fn native_read_marker_revert_invalidates_and_fences_a_captured_header() {
    let (state, native) = fixture(&[&[THREAD]]).await;
    native.set_head(THREAD, SECOND);
    let initial = list(&state).await;
    let (status, acknowledged) = seen(&state, THREAD, SECOND, revision(&initial)).await;
    assert_eq!(status, StatusCode::OK);
    let (captured, release) = native.hold_next_head(THREAD);
    let old_state = state.clone();
    let old_read = tokio::spawn(async move { list(&old_state).await });
    timeout(Duration::from_secs(2), captured)
        .await
        .unwrap()
        .unwrap();
    let mut observer = stream(&state).await;
    native.set_head(THREAD, FIRST);
    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/reverted".into(),
            params: json!({"threadId":THREAD}),
        },
        &state,
    )
    .await
    .unwrap();
    let reset = read_event(&mut observer, revision(&acknowledged) + 1).await;
    assert_eq!(reset["readStateKnown"], false);
    assert!(reset["latestCompletedTurnId"].is_null());
    assert_eq!(reset["seenCompletedTurnId"], SECOND);
    let (status, _) = seen(&state, THREAD, SECOND, revision(&reset)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    release.send(()).unwrap();
    let old_reply = timeout(Duration::from_secs(2), old_read)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(old_reply["latestCompletedTurnId"], SECOND);
    assert!(revision(&old_reply) >= revision(&reset));
    let current = list(&state).await;
    assert_read(&current, Some(FIRST), Some(SECOND), true);
    assert_read_only_headers(&native);
}

#[tokio::test]
async fn native_read_marker_badge_includes_unloaded_native_pages_and_reflects_archive_membership() {
    let (state, native) = fixture(&[&[THREAD], &["off-page-one", "off-page-two"]]).await;
    let visible = list(&state).await;
    let (status, _) = seen(&state, THREAD, FIRST, revision(&visible)).await;
    assert_eq!(status, StatusCode::OK);
    native.requests.lock().unwrap().clear();
    let (status, badge) = request(&state, "GET", "/v1/threads/unread-badge", None).await;
    assert_eq!(status, StatusCode::OK, "{badge}");
    assert_eq!(badge["count"], 2);
    assert!(revision(&badge) > 0);
    let requests = native.requests.lock().unwrap().clone();
    let inventories = requests
        .iter()
        .filter(|(method, _)| method == "thread/list")
        .map(|(_, params)| params)
        .collect::<Vec<_>>();
    assert_eq!(inventories.len(), 2);
    assert!(inventories[0]["cursor"].is_null());
    assert_eq!(inventories[1]["cursor"], "native-page-1");
    assert!(inventories
        .iter()
        .all(|params| params["archived"] == false && params["useStateDbOnly"] == true));
    assert!(requests
        .iter()
        .any(|(method, params)| method == "thread/turns/list"
            && params["threadId"] == "off-page-two"));
    assert_read_only_headers(&native);

    // Native archive membership removes a chat from the complete inventory;
    // its durable unread row must not inflate the aggregate afterward.
    *native.pages.lock().unwrap() = vec![vec![THREAD.into()], vec!["off-page-one".into()]];
    let (status, after) = request(&state, "GET", "/v1/threads/unread-badge", None).await;
    assert_eq!(status, StatusCode::OK, "{after}");
    assert_eq!(after["count"], 1);
    assert!(revision(&after) >= revision(&badge));
}

#[tokio::test]
async fn native_read_marker_truncated_nonterminal_head_is_unknown_without_history_scan() {
    let (state, native) = fixture(&[&[THREAD]]).await;
    let active = (0..8)
        .map(|index| (format!("active-{index}"), "inProgress"))
        .collect::<Vec<_>>();
    let refs = active
        .iter()
        .map(|(id, status)| (id.as_str(), *status))
        .collect::<Vec<_>>();
    native
        .heads
        .lock()
        .unwrap()
        .insert(THREAD.into(), headers(&refs, true));
    let (status, _) = request(&state, "GET", "/v1/threads", None).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    let head_requests = native
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == "thread/turns/list")
        .count();
    assert_eq!(head_requests, 1);
    assert_read_only_headers(&native);
    let (status, _) = seen(&state, THREAD, FIRST, 0).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, badge) = request(&state, "GET", "/v1/threads/unread-badge", None).await;
    assert_eq!(
        status,
        StatusCode::BAD_GATEWAY,
        "unknown badge must not report a partial zero: {badge}"
    );
    assert!(badge.get("count").is_none());
    assert_read_only_headers(&native);
}

#[tokio::test]
async fn native_read_marker_badge_rejects_inventory_captured_before_native_archive() {
    let (state, native) = fixture(&[&[THREAD, "archived-during-inventory"]]).await;
    let (captured, release) = native.hold_inventory();
    let old_state = state.clone();
    let old_badge =
        tokio::spawn(
            async move { request(&old_state, "GET", "/v1/threads/unread-badge", None).await },
        );
    timeout(Duration::from_secs(2), captured)
        .await
        .unwrap()
        .unwrap();
    *native.pages.lock().unwrap() = vec![vec![THREAD.into()]];
    ingest_inbound(
        InboundMessage::Notification {
            method: "thread/archived".into(),
            params: json!({"threadId":"archived-during-inventory"}),
        },
        &state,
    )
    .await
    .unwrap();
    release.send(()).unwrap();
    let (status, stale) = timeout(Duration::from_secs(2), old_badge)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "stale native membership must not receive a current aggregate revision: {stale}"
    );
    assert!(stale.get("count").is_none());
    let (status, current) = request(&state, "GET", "/v1/threads/unread-badge", None).await;
    assert_eq!(status, StatusCode::OK, "{current}");
    assert_eq!(current["count"], 1);
    assert_read_only_headers(&native);
}

#[tokio::test]
async fn native_read_marker_badge_limits_head_queries_to_four_in_flight() {
    let ids = (0..8)
        .map(|index| format!("badge-chat-{index}"))
        .collect::<Vec<_>>();
    let refs = ids.iter().map(String::as_str).collect::<Vec<_>>();
    let (state, native) = fixture(&[&refs]).await;
    let gates = ids
        .iter()
        .map(|id| native.hold_next_head(id))
        .collect::<Vec<_>>();
    let mut started = JoinSet::new();
    for (wait, release) in gates {
        started.spawn(async move {
            wait.await.unwrap();
            release
        });
    }
    let badge_state = state.clone();
    let pending = tokio::spawn(async move {
        request(&badge_state, "GET", "/v1/threads/unread-badge", None).await
    });
    // Hold the first batch so starting a fifth read is observable without
    // relying on sleeps or the speed of the native responses.
    let mut releases = Vec::new();
    for _ in 0..4 {
        releases.push(
            timeout(Duration::from_secs(2), started.join_next())
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
        );
    }
    assert_eq!(native.active_heads.load(Ordering::SeqCst), 4);
    for release in releases {
        release.send(()).unwrap();
    }
    for _ in 0..4 {
        let release = timeout(Duration::from_secs(2), started.join_next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        release.send(()).unwrap();
    }
    let (status, badge) = timeout(Duration::from_secs(2), pending)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status, StatusCode::OK, "{badge}");
    assert_eq!(badge["count"], 8);
    assert_eq!(native.max_active_heads.load(Ordering::SeqCst), 4);
    assert_read_only_headers(&native);
}
