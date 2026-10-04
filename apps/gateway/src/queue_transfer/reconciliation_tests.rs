use std::sync::Arc;

use serde_json::{json, Value};

use super::{reconcile, PromotionOutcome};
use crate::{
    api::AppState,
    app_server::tests::RecordingAppServer,
    config::Config,
    error::ApiError,
    store::{QueueTransfer, QueueTransferPhase, Store},
};

async fn fixture() -> (AppState, Arc<RecordingAppServer>, QueueTransfer) {
    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let transfer = state
        .store
        .create_queue_transfer(
            "chat",
            "native-row",
            "reused-original",
            "original-turn",
            vec![json!({"type":"text","text":"saved correction"})],
        )
        .await
        .unwrap();
    state
        .store
        .advance_queue_transfer(
            &transfer.id,
            QueueTransferPhase::Deleting,
            QueueTransferPhase::Uncertain,
            Some("Lost native acknowledgement"),
        )
        .await
        .unwrap();
    (state, native, transfer)
}

fn receipt(client: &str) -> Value {
    json!({"turnId":"original-turn","item":{
        "type":"userMessage","id":"opaque-native-item","clientId":client,
        "content":[{"type":"text","text":"saved correction"}],
    }})
}

#[tokio::test]
async fn bounded_exact_native_receipt_settles_uncertainty_without_chat_activation() {
    let (state, native, transfer) = fixture().await;
    *native.next_response.lock().unwrap() =
        Some(json!({"data":[receipt(&transfer.id)],"nextCursor":"older","backwardsCursor":null}));
    assert!(
        matches!(reconcile(&state, &transfer.id).await.unwrap(), PromotionOutcome::Delivered {id} if id == transfer.id)
    );
    assert!(state
        .store
        .get_queue_transfer(&transfer.id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        *native.requests.lock().unwrap(),
        vec![(
            "thread/items/list".into(),
            json!({
                "threadId":"chat","turnId":"original-turn","cursor":null,"sortDirection":"desc","limit":25,
            })
        )]
    );
}

#[tokio::test]
async fn native_absence_reused_ids_or_duplicate_correlation_never_authorize_resubmission() {
    for data in [
        vec![],
        vec![receipt("reused-original")],
        vec![receipt("foreign-client")],
    ] {
        let (state, native, transfer) = fixture().await;
        *native.next_response.lock().unwrap() =
            Some(json!({"data":data,"nextCursor":"opaque-older-page","backwardsCursor":null}));
        let PromotionOutcome::Transfer { transfer: current } =
            reconcile(&state, &transfer.id).await.unwrap()
        else {
            panic!("absence is not delivery evidence");
        };
        assert_eq!(current.phase, QueueTransferPhase::Uncertain);
        assert_eq!(current.input, transfer.input);
        assert_eq!(native.requests.lock().unwrap().len(), 1);
    }
    let (state, native, transfer) = fixture().await;
    let mut duplicate = receipt(&transfer.id);
    duplicate["item"]["id"] = json!("another-native-item");
    *native.next_response.lock().unwrap() = Some(
        json!({"data":[receipt(&transfer.id),duplicate],"nextCursor":null,"backwardsCursor":null}),
    );
    assert!(
        matches!(reconcile(&state, &transfer.id).await.unwrap(), PromotionOutcome::Transfer {transfer} if transfer.phase == QueueTransferPhase::Uncertain)
    );
}

#[tokio::test]
async fn malformed_or_foreign_turn_history_stays_uncertain_and_unknown_transfer_is_not_delivery() {
    for data in [
        json!([{"turnId":"another-turn","item":{"id":"item","type":"userMessage","clientId":"anything","content":[]}}]),
        json!([{"turnId":"original-turn","item":{"type":"userMessage","clientId":"anything"}}]),
    ] {
        let (state, native, transfer) = fixture().await;
        *native.next_response.lock().unwrap() =
            Some(json!({"data":data,"nextCursor":null,"backwardsCursor":null}));
        assert!(matches!(
            reconcile(&state, &transfer.id).await,
            Err(ApiError::BadGateway(_))
        ));
        assert_eq!(
            state
                .store
                .get_queue_transfer(&transfer.id)
                .await
                .unwrap()
                .unwrap()
                .phase,
            QueueTransferPhase::Uncertain
        );
        assert_eq!(native.requests.lock().unwrap().len(), 1);
    }
    let (state, native, _) = fixture().await;
    assert!(matches!(
        reconcile(&state, "unknown-id").await,
        Err(ApiError::NotFound(_))
    ));
    assert!(native.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn disconnect_refills_both_clients_from_shared_uncertainty_without_native_reads() {
    let (state, native, _) = fixture().await;
    for row in ["second", "third"] {
        state
            .store
            .create_queue_transfer(
                "chat",
                row,
                "reused-original",
                "original-turn",
                vec![json!({"type":"text","text":"saved"})],
            )
            .await
            .unwrap();
    }
    let other_client = state.clone();
    let mut first = state.events.subscribe();
    let mut second = other_client.events.subscribe();
    crate::events::ingest_inbound(crate::app_server::InboundMessage::Disconnected, &state)
        .await
        .unwrap();
    for receiver in [&mut first, &mut second] {
        let event = receiver.recv().await.unwrap();
        assert_eq!(event.kind, super::TRANSFER_CHANGED_EVENT);
        assert_eq!(event.payload, json!({"threadId":"chat"}));
    }
    let authoritative = other_client
        .store
        .list_queue_transfers(Some("chat"))
        .await
        .unwrap();
    assert_eq!(authoritative.len(), 3);
    assert!(authoritative
        .iter()
        .all(|transfer| transfer.phase == QueueTransferPhase::Uncertain));
    assert!(native.requests.lock().unwrap().is_empty());
    crate::events::ingest_inbound(crate::app_server::InboundMessage::Disconnected, &state)
        .await
        .unwrap();
    for receiver in [&mut first, &mut second] {
        while let Ok(event) = receiver.try_recv() {
            assert_ne!(
                event.kind,
                super::TRANSFER_CHANGED_EVENT,
                "repeated unknown state must not loop refills"
            );
        }
    }
}

#[tokio::test]
async fn transfer_refills_reach_selected_and_workspace_http_sse_and_reconnect_replay() {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn next_frame(body: &mut Body) -> String {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), body.frame())
            .await
            .expect("transfer refill was filtered out of SSE")
            .unwrap()
            .unwrap();
        String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap()
    }

    let (state, native, _) = fixture().await;
    state
        .store
        .create_queue_transfer("chat", "new-row", "original", "original-turn", vec![])
        .await
        .unwrap();
    let app = crate::api::build_router(state.clone());
    let mut streams = Vec::new();
    for uri in [
        "/v1/events?threadId=chat&cursor=0",
        "/v1/events?threadIds=another-chat&includeGlobal=true&cursor=0",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        streams.push(response.into_body());
    }
    crate::events::ingest_inbound(crate::app_server::InboundMessage::Disconnected, &state)
        .await
        .unwrap();
    for body in &mut streams {
        let wire = next_frame(body).await;
        assert!(
            wire.contains("event: turn_queue.transfer_changed"),
            "{wire}"
        );
        assert!(wire.contains("\"threadId\":\"chat\""), "{wire}");
    }
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/events?threadId=chat&cursor=0")
                .header("accept", "text/event-stream")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let wire = next_frame(&mut response.into_body()).await;
    assert!(
        wire.contains("event: turn_queue.transfer_changed"),
        "{wire}"
    );
    assert!(native.requests.lock().unwrap().is_empty());
}
