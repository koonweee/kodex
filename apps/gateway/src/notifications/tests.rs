use std::sync::Mutex;

use serde_json::Value;

use super::*;
use crate::{
    app_server::AppServer,
    config::Config,
    error::ApiError,
    store::{NewPushSubscription, NotificationDeliveryStatus, Store},
};

const THREAD_ID: &str = "notification-thread";
const DELIVERY_TURN_ID: &str = "delivery-turn";

struct PreviewAppServer {
    requests: Mutex<Vec<(String, Value)>>,
    items_response: Value,
    items_error: Option<&'static str>,
}

#[async_trait]
impl AppServer for PreviewAppServer {
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
            .push((method.to_string(), params.clone()));
        match method {
            "thread/read" => Ok(json!({"thread": {
                "id": THREAD_ID,
                "cwd": "/notification-fixture",
                "name": "Delivery chat",
                "source": "cli",
                "status": {"type": "idle"},
                "createdAt": 1,
                "updatedAt": 2,
                "turns": if params["includeTurns"] == true {
                    json!([
                        {"id": DELIVERY_TURN_ID, "status": "completed", "items": [
                            {"id": "target-answer", "type": "agentMessage", "phase": "final_answer", "text": "Target answer."}
                        ]},
                        {"id": "newer-unrelated-turn", "status": "completed", "items": [
                            {"id": "newer-answer", "type": "agentMessage", "phase": "final_answer", "text": "Unrelated newer answer."}
                        ]}
                    ])
                } else {
                    json!([])
                }
            }})),
            "thread/items/list" => match self.items_error {
                Some(message) => Err(ApiError::BadGateway(message.into())),
                None => Ok(self.items_response.clone()),
            },
            "thread/list" => Ok(json!({"data": [], "nextCursor": null})),
            _ => panic!("unexpected native preview request {method}: {params}"),
        }
    }

    async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
        panic!("notification preview must not answer native requests")
    }
}

#[derive(Default)]
struct PreviewPushSender {
    payloads: Mutex<Vec<NotificationPayload>>,
}

#[async_trait]
impl PushSender for PreviewPushSender {
    async fn send(
        &self,
        _subscription: &PushSubscription,
        payload: &NotificationPayload,
    ) -> PushDeliveryOutcome {
        self.payloads.lock().unwrap().push(payload.clone());
        PushDeliveryOutcome::Sent
    }
}

async fn preview_fixture(
    turn_id: Option<&str>,
    items_response: Value,
    items_error: Option<&'static str>,
) -> (
    AppState,
    Arc<PreviewAppServer>,
    Arc<PreviewPushSender>,
    String,
) {
    let server = Arc::new(PreviewAppServer {
        requests: Mutex::new(Vec::new()),
        items_response,
        items_error,
    });
    let sender = Arc::new(PreviewPushSender::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        server.clone(),
    )
    .with_notification_sender(sender.clone());
    state
        .store
        .upsert_push_subscription(NewPushSubscription {
            endpoint: "https://push.example/preview-test".into(),
            p256dh: "public".into(),
            auth: "auth".into(),
            user_agent: None,
        })
        .await
        .unwrap();
    let delivery = state
        .store
        .create_notification_delivery(NewNotificationDelivery {
            kind: "unreadAgentMessage".into(),
            thread_id: Some(THREAD_ID.into()),
            turn_id: turn_id.map(str::to_string),
            payload: None,
            available_at: Utc::now(),
        })
        .await
        .unwrap();
    (state, server, sender, delivery.id)
}

fn item_entry(item: Value) -> Value {
    json!({"turnId": DELIVERY_TURN_ID, "item": item})
}

#[tokio::test]
async fn notification_preview_reads_only_delivery_turn_and_prefers_its_final_answer() {
    let (state, server, sender, delivery_id) = preview_fixture(
        Some(DELIVERY_TURN_ID),
        json!({"data": [
            item_entry(json!({"id": "newer-comment", "type": "agentMessage", "phase": "commentary", "text": "Newer commentary."})),
            item_entry(json!({"id": "target-answer", "type": "agentMessage", "phase": "final_answer", "text": "Target answer.\n\nFor this delivery."})),
            item_entry(json!({"id": "older-comment", "type": "agentMessage", "phase": "commentary", "text": "Older commentary."}))
        ], "nextCursor": "opaque-older-items", "backwardsCursor": null}),
        None,
    )
    .await;

    process_due_deliveries(state.clone()).await.unwrap();

    let payloads = sender.payloads.lock().unwrap();
    assert_eq!(payloads.len(), 1);
    assert_eq!(
        payloads[0].body.as_deref(),
        Some("Target answer. For this delivery.")
    );
    assert_eq!(payloads[0].title, "Delivery chat");
    assert_eq!(payloads[0].thread_id.as_deref(), Some(THREAD_ID));
    assert_eq!(payloads[0].route, format!("/threads/{THREAD_ID}"));
    drop(payloads);
    assert_eq!(
        state
            .store
            .get_notification_delivery(&delivery_id)
            .await
            .unwrap()
            .status,
        NotificationDeliveryStatus::Sent
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|(method, _)| method == "thread/read")
            .map(|(_, params)| params)
            .collect::<Vec<_>>(),
        vec![&json!({"threadId": THREAD_ID, "includeTurns": false})]
    );
    assert_eq!(
        requests
            .iter()
            .filter(|(method, _)| method == "thread/items/list")
            .map(|(_, params)| params)
            .collect::<Vec<_>>(),
        vec![
            &json!({"threadId": THREAD_ID, "turnId": DELIVERY_TURN_ID, "cursor": null, "sortDirection": "desc", "limit": 25})
        ]
    );
}

#[tokio::test]
async fn notification_without_final_answer_uses_newest_native_agent_text() {
    let (state, _, sender, _) = preview_fixture(
        Some(DELIVERY_TURN_ID),
        json!({"data": [
            item_entry(json!({"id": "newer-agent", "type": "agentMessage", "text": "Latest update."})),
            item_entry(json!({"id": "older-agent", "type": "agentMessage", "phase": "commentary", "text": "Earlier update."}))
        ], "nextCursor": null, "backwardsCursor": null}),
        None,
    ).await;
    process_due_deliveries(state).await.unwrap();
    let payloads = sender.payloads.lock().unwrap();
    assert_eq!(payloads.len(), 1);
    assert_eq!(payloads[0].body.as_deref(), Some("Latest update."));
}

#[tokio::test]
async fn notification_without_delivery_turn_does_not_borrow_another_answer() {
    let (state, server, sender, _) = preview_fixture(None, json!({}), None).await;
    process_due_deliveries(state).await.unwrap();

    let payloads = sender.payloads.lock().unwrap();
    assert_eq!(payloads.len(), 1);
    assert_eq!(
        payloads[0].body.as_deref(),
        Some(UNREAD_AGENT_MESSAGE_FALLBACK_BODY)
    );
    assert!(!server
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(method, _)| method == "thread/items/list"));
}

#[tokio::test]
async fn notification_empty_or_truncated_item_page_uses_generic_body_without_following_cursor() {
    for page in [
        json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
        json!({"data": [item_entry(json!({"id": "latest-tool", "type": "commandExecution", "aggregatedOutput": "Do not preview tool output"}))], "nextCursor": "answer-outside-bound", "backwardsCursor": null}),
        json!({"data": [item_entry(json!({"id": "blank-answer", "type": "agentMessage", "phase": "final_answer", "text": " \n\t "}))], "nextCursor": null, "backwardsCursor": null}),
    ] {
        let (state, server, sender, delivery_id) =
            preview_fixture(Some(DELIVERY_TURN_ID), page, None).await;
        process_due_deliveries(state.clone()).await.unwrap();
        let payloads = sender.payloads.lock().unwrap();
        assert_eq!(payloads.len(), 1);
        assert_eq!(
            payloads[0].body.as_deref(),
            Some(UNREAD_AGENT_MESSAGE_FALLBACK_BODY)
        );
        drop(payloads);
        assert_eq!(
            state
                .store
                .get_notification_delivery(&delivery_id)
                .await
                .unwrap()
                .status,
            NotificationDeliveryStatus::Sent
        );
        assert_eq!(
            server
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(method, _)| method == "thread/items/list")
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn notification_item_read_failures_retry_instead_of_sending_unrelated_or_generic_body() {
    for (page, error) in [
        (
            json!({}),
            Some("app-server unavailable while reading items"),
        ),
        (
            json!({}),
            Some("app-server error -32601: thread/items/list is not supported yet"),
        ),
        (json!({"data": {}}), None),
        (
            json!({"data": [{"turnId": "unrelated-turn", "item": {"id": "wrong", "type": "agentMessage", "text": "Wrong scoped answer"}}]}),
            None,
        ),
        (
            json!({"data": [item_entry(json!({"id": "missing-text", "type": "agentMessage"}))]}),
            None,
        ),
        (
            json!({"data": [item_entry(json!({"id": "invalid-text", "type": "agentMessage", "text": 7}))]}),
            None,
        ),
    ] {
        let (state, server, sender, delivery_id) =
            preview_fixture(Some(DELIVERY_TURN_ID), page, error).await;
        process_due_deliveries(state.clone()).await.unwrap();
        assert!(sender.payloads.lock().unwrap().is_empty());
        let delivery = state
            .store
            .get_notification_delivery(&delivery_id)
            .await
            .unwrap();
        assert_eq!(delivery.status, NotificationDeliveryStatus::Pending);
        assert_eq!(delivery.attempt_count, 1);
        assert!(delivery.last_error.is_some());
        assert!(delivery.payload.is_none());
        assert!(delivery.delivered_subscription_ids.is_empty());
        assert_eq!(
            server
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(method, _)| method == "thread/items/list")
                .count(),
            1
        );
    }
}
