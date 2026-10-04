use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use async_trait::async_trait;
use axum::{
    extract::{Path, State},
    Json,
};
use serde_json::{json, Value};
use tokio::{
    sync::{broadcast, mpsc, Notify},
    time::{timeout, Duration},
};

use crate::{
    api::AppState,
    app_server::{AppServer, InboundMessage},
    config::Config,
    error::{ApiError, ApiResult},
    events,
    store::{EventEnvelope, Store},
};

struct Native {
    calls: Mutex<Vec<(String, Value)>>,
    held_method: &'static str,
    held_once: AtomicBool,
    fail_next: Mutex<Option<&'static str>>,
    entered: Notify,
    release: Notify,
    waiter_finished: Notify,
}

impl Native {
    fn new(held_method: &'static str) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(vec![]),
            held_method,
            held_once: AtomicBool::new(false),
            fail_next: Mutex::new(None),
            entered: Notify::new(),
            release: Notify::new(),
            waiter_finished: Notify::new(),
        })
    }
}

struct WaiterFinished<'a>(&'a Notify);
impl Drop for WaiterFinished<'_> {
    fn drop(&mut self) {
        self.0.notify_one();
    }
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
        self.calls
            .lock()
            .unwrap()
            .push((method.into(), params.clone()));
        if method == self.held_method && !self.held_once.swap(true, Ordering::SeqCst) {
            let _waiter = WaiterFinished(&self.waiter_finished);
            self.entered.notify_one();
            self.release.notified().await;
        }
        if self
            .fail_next
            .lock()
            .unwrap()
            .take_if(|next| *next == method)
            .is_some()
        {
            return Err(ApiError::BadGateway("native widget read failed".into()));
        }
        match method {
            "mcpServer/resource/read" => Ok(json!({"contents":[{
                "uri":params["uri"],"mimeType":super::MCP_APP_MIME_TYPE,
                "text":format!("<h1>{}</h1>", params["uri"].as_str().unwrap())
            }]})),
            "mcpServerStatus/list" => Ok(json!({"data":[{
                "name":"docs","authStatus":"unsupported","tools":{},"resources":[],"resourceTemplates":[]
            }],"nextCursor":null})),
            "thread/read" => Ok(json!({"thread":{
                "id":params["threadId"],"cwd":"/fixture","status":{"type":"idle"},
                "createdAt":1,"updatedAt":1,"canAcceptDirectInput":true
            }})),
            "turn/start" => {
                Ok(json!({"turn":{"id":"message-turn","status":"inProgress","items":[]}}))
            }
            _ => Err(ApiError::BadGateway(format!(
                "unexpected native request: {method}"
            ))),
        }
    }
    async fn respond(&self, _: &str, _: Value) -> ApiResult<()> {
        Ok(())
    }
}

fn widget(id: &str) -> InboundMessage {
    InboundMessage::Notification {
        method: "item/completed".into(),
        params: json!({
            "threadId":"widget-chat","turnId":"widget-turn","item":{
                "type":"mcpToolCall","id":id,"server":"docs","tool":"show","status":"completed",
                "arguments":{},"error":null,"mcpAppResourceUri":format!("ui://docs/{id}"),
                "result":{"content":[{"type":"text","text":format!("Fallback {id}")}]}
            }
        }),
    }
}

async fn next_kind(receiver: &mut broadcast::Receiver<EventEnvelope>, kind: &str) -> EventEnvelope {
    timeout(Duration::from_secs(2), async {
        loop {
            let event = receiver.recv().await.unwrap();
            if event.kind == kind {
                return event;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no {kind} while native widget read was held"))
}

async fn held_read_stays_responsive(method: &'static str) {
    let native = Native::new(method);
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    crate::approvals::initialize(&state).await.unwrap();
    let worker = super::start_import_worker(&state).unwrap();
    let mut first = state.events.subscribe();
    let mut second = state.events.subscribe();
    let (tx, rx) = mpsc::channel(2);
    let ingest = tokio::spawn(events::run_inbound_ingest(rx, state.clone()));
    tx.send(widget("first")).await.unwrap();
    timeout(Duration::from_secs(2), native.entered.notified())
        .await
        .unwrap();
    for receiver in [&mut first, &mut second] {
        let patch = next_kind(receiver, "thread_view.patch").await;
        assert_eq!(patch.payload["rows"][0]["items"][0]["itemId"], "first");
        assert_eq!(patch.payload["rows"][0]["items"][0]["status"], "completed");
        assert_eq!(
            patch.payload["rows"][0]["items"][0]["payload"]["item"]["result"],
            "Fallback first"
        );
    }
    tx.send(InboundMessage::ServerRequest {
        request_id:"17".into(), method:"item/commandExecution/requestApproval".into(),
        params:json!({"threadId":"other-chat","turnId":"other-turn","itemId":"command","command":"true"}),
    }).await.unwrap();
    tx.send(InboundMessage::Notification {
        method: "turn/completed".into(),
        params: json!({
            "threadId":"third-chat","turn":{"id":"finished","status":"completed","items":[]}
        }),
    })
    .await
    .unwrap();
    next_kind(&mut first, "approval.changed").await;
    next_kind(&mut second, "approval.changed").await;
    let approvals = crate::approvals::list_approvals(&state, None, None)
        .await
        .unwrap();
    assert_eq!(approvals.approvals.len(), 1);
    assert_eq!(approvals.approvals[0].request_id, "17");
    let terminal = next_kind(&mut first, "thread.read_updated").await;
    assert_eq!(terminal.thread_id.as_deref(), Some("third-chat"));
    assert_eq!(terminal.payload["readStateKnown"], false);
    assert_eq!(
        next_kind(&mut second, "thread.read_updated").await.payload,
        terminal.payload
    );
    assert!(state
        .store
        .latest_app_surface_session("widget-chat")
        .await
        .unwrap()
        .is_none());
    native.release.notify_one();
    let imported = next_kind(&mut first, "app_surface.session_upserted").await;
    assert_eq!(imported.payload["resourceUri"], "ui://docs/first");
    assert_eq!(
        next_kind(&mut second, "app_surface.session_upserted")
            .await
            .payload,
        imported.payload
    );
    assert!(state
        .store
        .latest_app_surface_session("widget-chat")
        .await
        .unwrap()
        .unwrap()
        .html
        .contains("first"));
    drop(tx);
    ingest.await.unwrap();
    worker.shutdown().await;
}

async fn generated(state: &AppState, title: &str) {
    let _ = crate::routes::self_control::upsert_self_control_generated_app_surface(
        State(state.clone()),
        Path("widget-chat".into()),
        Json(
            serde_json::from_value(json!({
                "title":title,"html":format!("<h1>{title}</h1>"),"fallbackContent":title,
                "grants":{"canSendMessage":true}
            }))
            .unwrap(),
        ),
    )
    .await
    .unwrap();
}

async fn import_barrier(state: &AppState, live: &mut broadcast::Receiver<EventEnvelope>) {
    let mut barrier = widget("barrier");
    if let InboundMessage::Notification { params, .. } = &mut barrier {
        params["threadId"] = json!("barrier-chat");
    }
    events::ingest_inbound(barrier, state).await.unwrap();
    loop {
        if next_kind(live, "app_surface.session_upserted")
            .await
            .thread_id
            .as_deref()
            == Some("barrier-chat")
        {
            break;
        }
    }
}

#[tokio::test]
async fn fifo_preserves_native_import_order_and_replayed_latest_item_does_not_rotate_token() {
    let native = Native::new("mcpServer/resource/read");
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let worker = super::start_import_worker(&state).unwrap();
    let mut live = state.events.subscribe();
    events::ingest_inbound(widget("first"), &state)
        .await
        .unwrap();
    timeout(Duration::from_secs(2), native.entered.notified())
        .await
        .unwrap();
    events::ingest_inbound(widget("first"), &state)
        .await
        .unwrap();
    events::ingest_inbound(widget("second"), &state)
        .await
        .unwrap();
    native.release.notify_one();
    let first = next_kind(&mut live, "app_surface.session_upserted").await;
    let second = next_kind(&mut live, "app_surface.session_upserted").await;
    assert_eq!(first.payload["resourceUri"], "ui://docs/first");
    assert_eq!(second.payload["resourceUri"], "ui://docs/second");
    assert_eq!(second.payload["revision"], 2);
    let saved = state
        .store
        .latest_app_surface_session("widget-chat")
        .await
        .unwrap()
        .unwrap();
    events::ingest_inbound(widget("second"), &state)
        .await
        .unwrap();
    import_barrier(&state, &mut live).await;
    assert_eq!(
        serde_json::to_value(
            state
                .store
                .latest_app_surface_session("widget-chat")
                .await
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(saved).unwrap()
    );
    let reads = native
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == "mcpServer/resource/read")
        .map(|(_, params)| params["uri"].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        reads,
        vec![
            json!("ui://docs/first"),
            json!("ui://docs/second"),
            json!("ui://docs/barrier")
        ]
    );
    worker.shutdown().await;
}

#[tokio::test]
async fn generated_replacement_and_archive_retire_held_and_queued_widget_imports() {
    for (archive, held) in [
        (false, "mcpServer/resource/read"),
        (true, "mcpServer/resource/read"),
        (false, "mcpServerStatus/list"),
        (true, "mcpServerStatus/list"),
    ] {
        let native = Native::new(held);
        let state = AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            native.clone(),
        );
        generated(&state, "Original").await;
        let worker = super::start_import_worker(&state).unwrap();
        let mut live = state.events.subscribe();
        events::ingest_inbound(widget("old"), &state).await.unwrap();
        timeout(Duration::from_secs(2), native.entered.notified())
            .await
            .unwrap();
        events::ingest_inbound(widget("queued-old"), &state)
            .await
            .unwrap();
        if archive {
            let _ = crate::routes::self_control::archive_self_control_app_surface(
                State(state.clone()),
                Path("widget-chat".into()),
                None,
            )
            .await
            .unwrap();
        } else {
            generated(&state, "Newer generated document").await;
        }
        let saved = state
            .store
            .latest_app_surface_session("widget-chat")
            .await
            .unwrap()
            .unwrap();
        native.release.notify_one();
        import_barrier(&state, &mut live).await;
        assert_eq!(
            serde_json::to_value(
                state
                    .store
                    .latest_app_surface_session("widget-chat")
                    .await
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(saved).unwrap()
        );
        assert!(!native
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(_, params)| params["uri"] == "ui://docs/queued-old"));
        worker.shutdown().await;
    }
}

#[tokio::test]
async fn mutation_between_native_receipt_and_fifo_admission_retires_the_captured_item() {
    let native = Native::new("");
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let worker = super::start_import_worker(&state).unwrap();
    let mut live = state.events.subscribe();
    let InboundMessage::Notification { params, .. } = widget("old") else {
        unreachable!()
    };
    let job = super::capture_mcp_app_surface_import(
        &state,
        "widget-chat",
        "widget-turn",
        &params["item"],
    )
    .await
    .unwrap();
    generated(&state, "Generated after native receipt").await;
    super::enqueue_mcp_app_surface_import(&state, job).await;
    import_barrier(&state, &mut live).await;
    assert_eq!(
        state
            .store
            .latest_app_surface_session("widget-chat")
            .await
            .unwrap()
            .unwrap()
            .title,
        "Generated after native receipt"
    );
    assert!(!native
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|(_, params)| params["uri"] == "ui://docs/old"));
    worker.shutdown().await;
}

#[tokio::test]
async fn saturation_keeps_canonical_rows_and_publishes_failure_without_retrying_or_blocking() {
    let native = Native::new("mcpServer/resource/read");
    let mut state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    state.app_surface_imports = super::AppSurfaceImports::with_capacity(1);
    let worker = super::start_import_worker(&state).unwrap();
    let mut live = state.events.subscribe();
    events::ingest_inbound(widget("first"), &state)
        .await
        .unwrap();
    timeout(Duration::from_secs(2), native.entered.notified())
        .await
        .unwrap();
    events::ingest_inbound(widget("second"), &state)
        .await
        .unwrap();
    timeout(
        Duration::from_secs(2),
        events::ingest_inbound(widget("overflow"), &state),
    )
    .await
    .unwrap()
    .unwrap();
    let warning = next_kind(&mut live, "gateway.warning").await;
    assert_eq!(warning.item_id.as_deref(), Some("overflow"));
    assert!(warning.payload["message"]
        .as_str()
        .unwrap()
        .contains("full"));
    let view = crate::thread_view::patch_for_thread(&state.thread_views, "widget-chat")
        .await
        .unwrap();
    assert!(serde_json::to_value(view)
        .unwrap()
        .to_string()
        .contains("overflow"));
    native.release.notify_one();
    next_kind(&mut live, "app_surface.session_upserted").await;
    next_kind(&mut live, "app_surface.session_upserted").await;
    import_barrier(&state, &mut live).await;
    assert!(!native
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|(_, params)| params["uri"] == "ui://docs/overflow"));
    worker.shutdown().await;
}

#[tokio::test]
async fn native_disconnect_and_shutdown_cancel_held_reads_and_drop_pending_imports() {
    for eof in [true, false] {
        let native = Native::new("mcpServer/resource/read");
        let state = AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            native.clone(),
        );
        crate::approvals::initialize(&state).await.unwrap();
        let worker = super::start_import_worker(&state).unwrap();
        events::ingest_inbound(widget("held"), &state)
            .await
            .unwrap();
        timeout(Duration::from_secs(2), native.entered.notified())
            .await
            .unwrap();
        events::ingest_inbound(widget("queued"), &state)
            .await
            .unwrap();
        if eof {
            timeout(
                Duration::from_secs(2),
                events::ingest_inbound(InboundMessage::Disconnected, &state),
            )
            .await
            .unwrap()
            .unwrap();
        }
        timeout(Duration::from_secs(2), worker.shutdown())
            .await
            .unwrap();
        native.release.notify_one();
        assert!(state
            .store
            .latest_app_surface_session("widget-chat")
            .await
            .unwrap()
            .is_none());
        assert_eq!(native.calls.lock().unwrap().len(), 1);
        let mut live = state.events.subscribe();
        events::ingest_inbound(widget("after-stop"), &state)
            .await
            .unwrap();
        let warning = next_kind(&mut live, "gateway.warning").await;
        assert_eq!(warning.item_id.as_deref(), Some("after-stop"));
        assert_eq!(native.calls.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn repeated_ui_messages_do_not_retire_a_widget_import_or_change_the_retained_surface() {
    let native = Native::new("mcpServer/resource/read");
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    generated(&state, "Interactive form").await;
    let original = state
        .store
        .latest_app_surface_session("widget-chat")
        .await
        .unwrap()
        .unwrap();
    let worker = super::start_import_worker(&state).unwrap();
    let mut live = state.events.subscribe();
    events::ingest_inbound(widget("next"), &state)
        .await
        .unwrap();
    timeout(Duration::from_secs(2), native.entered.notified())
        .await
        .unwrap();
    for message in ["First action", "Second action"] {
        let response = crate::routes::app_surfaces::app_surface_bridge(
            State(state.clone()), Path(original.id.clone()), Json(serde_json::from_value(json!({
                "id":message,"method":"ui/message","revision":original.revision,"bridgeToken":original.bridge_token,
                "params":{"role":"user","content":[{"type":"text","text":message}]}
            })).unwrap())
        ).await.unwrap().0;
        assert!(response.error.is_none(), "{:?}", response.error);
    }
    assert_eq!(
        serde_json::to_value(
            state
                .store
                .latest_app_surface_session("widget-chat")
                .await
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(original).unwrap()
    );
    native.release.notify_one();
    let imported = next_kind(&mut live, "app_surface.session_upserted").await;
    assert_eq!(imported.payload["resourceUri"], "ui://docs/next");
    assert_eq!(
        native
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| method == "turn/start")
            .count(),
        2
    );
    worker.shutdown().await;
}

#[tokio::test]
async fn held_widget_resource_does_not_delay_canonical_approvals_or_other_turns() {
    held_read_stays_responsive("mcpServer/resource/read").await;
}

#[tokio::test]
async fn held_widget_catalog_does_not_delay_canonical_approvals_or_other_turns() {
    held_read_stays_responsive("mcpServerStatus/list").await;
}

#[tokio::test]
async fn compaction_ingestion_only_requests_canonical_refill_without_native_reads() {
    let native = Native::new("");
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let mut live = state.events.subscribe();
    events::ingest_inbound(
        InboundMessage::Notification {
            method: "thread/compacted".into(),
            params: json!({"threadId":"chat","turnId":"turn"}),
        },
        &state,
    )
    .await
    .unwrap();
    let refresh = next_kind(&mut live, "thread_view.refresh_required").await;
    assert_eq!(refresh.payload["reason"], "thread_compacted");
    assert!(
        native.calls.lock().unwrap().is_empty(),
        "serial ingestion must not await native history"
    );
}

#[tokio::test]
async fn native_resource_or_catalog_failure_preserves_existing_artifact_and_does_not_retry() {
    for failed_method in ["mcpServer/resource/read", "mcpServerStatus/list"] {
        let native = Native::new("");
        *native.fail_next.lock().unwrap() = Some(failed_method);
        let state = AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            native.clone(),
        );
        generated(&state, "Retained document").await;
        let before = state
            .store
            .latest_app_surface_session("widget-chat")
            .await
            .unwrap()
            .unwrap();
        let worker = super::start_import_worker(&state).unwrap();
        let mut live = state.events.subscribe();
        events::ingest_inbound(widget("failed"), &state)
            .await
            .unwrap();
        let warning = next_kind(&mut live, "gateway.warning").await;
        assert_eq!(warning.item_id.as_deref(), Some("failed"));
        assert!(warning.payload["message"]
            .as_str()
            .unwrap()
            .contains("could not be loaded"));
        assert_eq!(
            serde_json::to_value(
                state
                    .store
                    .latest_app_surface_session("widget-chat")
                    .await
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(before).unwrap()
        );
        events::ingest_inbound(widget("next"), &state)
            .await
            .unwrap();
        let imported = next_kind(&mut live, "app_surface.session_upserted").await;
        assert_eq!(imported.payload["resourceUri"], "ui://docs/next");
        let reads = native
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, _)| method == "mcpServer/resource/read")
            .map(|(_, params)| params["uri"].clone())
            .collect::<Vec<_>>();
        assert_eq!(
            reads,
            vec![json!("ui://docs/failed"), json!("ui://docs/next")]
        );
        worker.shutdown().await;
    }
}

#[tokio::test]
async fn dropping_worker_cancels_a_native_wait_instead_of_detaching_the_runtime() {
    let native = Native::new("mcpServer/resource/read");
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let worker = super::start_import_worker(&state).unwrap();
    events::ingest_inbound(widget("held"), &state)
        .await
        .unwrap();
    timeout(Duration::from_secs(2), native.entered.notified())
        .await
        .unwrap();
    drop(worker);
    timeout(Duration::from_secs(2), native.waiter_finished.notified())
        .await
        .unwrap();
    assert!(state
        .store
        .latest_app_surface_session("widget-chat")
        .await
        .unwrap()
        .is_none());
    assert_eq!(native.calls.lock().unwrap().len(), 1);
}
