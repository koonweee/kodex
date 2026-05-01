use std::convert::Infallible;

use async_stream::stream;
use axum::{
    extract::{Query, State},
    http::{header, HeaderMap},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server::InboundMessage,
    error::ApiResult,
    schema::is_supported_approval_method,
    store::{EventEnvelope, NewApproval, NewEvent},
};

const SSE_REPLAY_PAGE_SIZE: i64 = 500;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventListResponse {
    pub events: Vec<EventEnvelope>,
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventsQuery {
    pub cursor: Option<i64>,
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
}

#[utoipa::path(get, path = "/v1/events", params(EventsQuery), responses((status = 200, body = EventListResponse)))]
pub async fn events(
    headers: HeaderMap,
    State(state): State<AppState>,
    Query(query): Query<EventsQuery>,
) -> ApiResult<Response> {
    if wants_sse(&headers) {
        let stream = event_stream(state, query).await?;
        Ok(Sse::new(stream)
            .keep_alive(KeepAlive::default())
            .into_response())
    } else {
        let events = state
            .store
            .replay_events(query.cursor, query.project_id, query.thread_id)
            .await?;
        Ok(Json(EventListResponse { events }).into_response())
    }
}

pub async fn run_inbound_ingest(mut inbound: mpsc::Receiver<InboundMessage>, state: AppState) {
    while let Some(message) = inbound.recv().await {
        if let Err(error) = ingest_inbound(message, &state).await {
            tracing::warn!(%error, "failed to ingest app-server message");
        }
    }
}

pub async fn ingest_inbound(message: InboundMessage, state: &AppState) -> ApiResult<()> {
    match message {
        InboundMessage::Notification { method, params } => {
            let metadata = EventMetadata::from_payload(&params);
            let event = state
                .store
                .append_event(NewEvent {
                    project_id: metadata.project_id,
                    thread_id: metadata.thread_id,
                    turn_id: metadata.turn_id,
                    item_id: metadata.item_id,
                    kind: "codex.notification".to_string(),
                    codex_method: Some(method),
                    payload: params,
                })
                .await?;
            let _ = state.events.send(event);
        }
        InboundMessage::ServerRequest {
            request_id,
            method,
            params,
        } => {
            let metadata = EventMetadata::from_payload(&params);
            let server_request_event = state
                .store
                .append_event(NewEvent {
                    project_id: metadata.project_id.clone(),
                    thread_id: metadata.thread_id.clone(),
                    turn_id: metadata.turn_id.clone(),
                    item_id: metadata.item_id.clone(),
                    kind: "codex.server_request".to_string(),
                    codex_method: Some(method.clone()),
                    payload: json!({
                        "requestId": request_id,
                        "method": method,
                        "params": params,
                    }),
                })
                .await?;
            let _ = state.events.send(server_request_event);

            if !is_supported_approval_method(&method) {
                let warning = state
                    .store
                    .append_event(NewEvent {
                        project_id: metadata.project_id,
                        thread_id: metadata.thread_id,
                        turn_id: metadata.turn_id,
                        item_id: metadata.item_id,
                        kind: "gateway.warning".to_string(),
                        codex_method: Some(method),
                        payload: json!({"message": "unsupported app-server server request"}),
                    })
                    .await?;
                let _ = state.events.send(warning);
                return Ok(());
            }

            let approval = state
                .store
                .insert_approval(NewApproval {
                    request_id,
                    thread_id: metadata.thread_id.clone(),
                    turn_id: metadata.turn_id.clone(),
                    item_id: metadata.item_id.clone(),
                    method: method.clone(),
                    payload: params,
                })
                .await?;
            let event = state
                .store
                .append_event(NewEvent {
                    project_id: metadata.project_id,
                    thread_id: metadata.thread_id,
                    turn_id: metadata.turn_id,
                    item_id: metadata.item_id,
                    kind: "approval.created".to_string(),
                    codex_method: Some(method),
                    payload: serde_json::to_value(&approval)?,
                })
                .await?;
            let _ = state.events.send(event);
        }
    }
    Ok(())
}

fn wants_sse(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| accept.contains("text/event-stream"))
}

async fn event_stream(
    state: AppState,
    query: EventsQuery,
) -> ApiResult<impl Stream<Item = Result<Event, Infallible>>> {
    let mut receiver = state.events.subscribe();
    let mut replay = Vec::new();
    let mut replay_high_water = query.cursor.unwrap_or(0);

    loop {
        let page = state
            .store
            .replay_events_page(
                Some(replay_high_water),
                query.project_id.as_deref(),
                query.thread_id.as_deref(),
                SSE_REPLAY_PAGE_SIZE,
            )
            .await?;
        let page_len = page.len();
        let Some(last) = page.last() else {
            break;
        };
        replay_high_water = last.seq;
        replay.extend(page);
        if page_len < SSE_REPLAY_PAGE_SIZE as usize {
            break;
        }
    }

    Ok(stream! {
        let mut high_water = replay_high_water;

        for event in replay {
            high_water = high_water.max(event.seq);
            if let Ok(sse_event) = event_to_sse(event) {
                yield Ok(sse_event);
            }
        }

        loop {
            match receiver.recv().await {
                Ok(event) if event.seq > high_water && event_matches(&event, &query) => {
                    high_water = event.seq;
                    if let Ok(sse_event) = event_to_sse(event) {
                        yield Ok(sse_event);
                    }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    })
}

fn event_matches(event: &EventEnvelope, query: &EventsQuery) -> bool {
    query
        .project_id
        .as_ref()
        .is_none_or(|project_id| event.project_id.as_ref() == Some(project_id))
        && query
            .thread_id
            .as_ref()
            .is_none_or(|thread_id| event.thread_id.as_ref() == Some(thread_id))
}

fn event_to_sse(event: EventEnvelope) -> Result<Event, axum::Error> {
    Event::default()
        .id(event.seq.to_string())
        .event(event.kind.clone())
        .json_data(event)
}

#[derive(Debug, Default)]
struct EventMetadata {
    project_id: Option<String>,
    thread_id: Option<String>,
    turn_id: Option<String>,
    item_id: Option<String>,
}

impl EventMetadata {
    fn from_payload(payload: &Value) -> Self {
        Self {
            project_id: string_field(payload, &["projectId", "project_id"]),
            thread_id: string_field(payload, &["threadId", "thread_id"]),
            turn_id: string_field(payload, &["turnId", "turn_id"])
                .or_else(|| nested_string_field(payload, "turn", &["id", "turnId", "turn_id"])),
            item_id: string_field(payload, &["itemId", "item_id"])
                .or_else(|| nested_string_field(payload, "item", &["id", "itemId", "item_id"])),
        }
    }
}

fn string_field(payload: &Value, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| payload.get(*name).and_then(Value::as_str))
        .map(str::to_string)
}

fn nested_string_field(payload: &Value, parent: &str, names: &[&str]) -> Option<String> {
    payload
        .get(parent)
        .and_then(|value| string_field(value, names))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use std::sync::{atomic::Ordering, Arc};

    use crate::{
        api::AppState, app_server::tests::RecordingAppServer, config::Config, store::Store,
    };

    use super::*;

    async fn test_state() -> AppState {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(RecordingAppServer::default());
        app_server.ready.store(true, Ordering::SeqCst);
        AppState::new(Config::default(), store, app_server)
    }

    #[tokio::test]
    async fn notification_ingest_persists_before_broadcast() {
        let state = test_state().await;
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "turn/completed".to_string(),
                params: json!({"threadId": "thread-1", "turn": {"id": "turn-1"}}),
            },
            &state,
        )
        .await
        .unwrap();

        let broadcast = receiver.recv().await.unwrap();
        let replay = state
            .store
            .replay_events(Some(broadcast.seq - 1), None, None)
            .await
            .unwrap();
        assert_eq!(replay[0].id, broadcast.id);
        assert_eq!(replay[0].thread_id.as_deref(), Some("thread-1"));
        assert_eq!(replay[0].turn_id.as_deref(), Some("turn-1"));
    }
}
