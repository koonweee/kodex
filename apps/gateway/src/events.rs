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
use chrono::Utc;
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};
use tokio::time::{timeout, Duration};
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server::InboundMessage,
    app_server_api::{
        self, visible_text_from_thread_item, SortDirection, ThreadItemSnapshot, ThreadLiveState,
        ThreadStatus, ThreadSummary, ThreadTimelineWindowPage, ThreadTurnItemsView,
        ThreadTurnSnapshot, TimelineItemUpsertPayload, TimelineThreadMetadataPayload,
        TimelineUpdateSource,
    },
    error::{ApiError, ApiResult},
    events_replay::{
        event_matches, is_normal_live_event, is_operational_replay_event,
        selected_thread_sse_replay_events, THREAD_VIEW_CURSOR_KIND,
    },
    events_synthetic::{synthetic_event, thread_view_refresh_required_event},
    queue,
    routes::threads::{
        apply_thread_summary_state, ThreadReadStateUpdate, THREAD_READ_UPDATED_EVENT,
    },
    schema::is_supported_approval_method,
    skills,
    store::{EventEnvelope, NewApproval, NewEvent, ThreadRuntimeState},
    thread_view::{self, THREAD_VIEW_PATCH_EVENT_KIND},
};

const SSE_REPLAY_PAGE_SIZE: i64 = 500;
const TURN_COMPLETION_HEAD_REFRESH_LIMIT: u32 = 50;
pub const MCP_CONFIG_CHANGED_EVENT: &str = "mcp.config_changed";
pub const MCP_SERVER_STATUS_UPDATED_EVENT: &str = "mcp.server_status_updated";
pub const MCP_OAUTH_LOGIN_COMPLETED_EVENT: &str = "mcp.oauth_login_completed";
pub const ACCOUNT_RATE_LIMITS_UPDATED_EVENT: &str = "account.rate_limits_updated";

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
    pub exclude_thread_id: Option<String>,
}

#[utoipa::path(get, path = "/v1/events", params(EventsQuery), responses((status = 200, body = EventListResponse)))]
pub async fn events(
    headers: HeaderMap,
    State(state): State<AppState>,
    Query(query): Query<EventsQuery>,
) -> ApiResult<Response> {
    validate_events_query(&query)?;
    if wants_sse(&headers) {
        let stream = event_stream(state, query).await?;
        Ok(Sse::new(stream)
            .keep_alive(KeepAlive::default())
            .into_response())
    } else {
        let events = replay_operational_events(&state, &query).await?;
        Ok(Json(EventListResponse { events }).into_response())
    }
}

#[utoipa::path(get, path = "/v1/debug/events", params(EventsQuery), responses((status = 200, body = EventListResponse)))]
pub async fn debug_events(
    State(state): State<AppState>,
    Query(query): Query<EventsQuery>,
) -> ApiResult<Json<EventListResponse>> {
    validate_events_query(&query)?;
    let events = state
        .store
        .replay_events(
            query.cursor,
            query.project_id.clone(),
            query.thread_id.clone(),
        )
        .await?;
    let events = events
        .into_iter()
        .filter(|event| event_matches(event, &query))
        .collect();
    Ok(Json(EventListResponse { events }))
}

fn validate_events_query(query: &EventsQuery) -> ApiResult<()> {
    if query.thread_id.is_some() && query.exclude_thread_id.is_some() {
        return Err(ApiError::BadRequest(
            "threadId and excludeThreadId cannot be combined".to_string(),
        ));
    }
    Ok(())
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
            let mut emitted = false;
            if let Some(event) = normalized_mcp_event(state, &method, &params).await? {
                let _ = state.events.send(event);
                emitted = true;
            }
            if let Some(event) =
                normalized_account_event(state, &method, &params, &metadata).await?
            {
                let _ = state.events.send(event);
                emitted = true;
            }
            if let Some(event) =
                normalized_thread_settings_event(state, &method, &params, &metadata).await?
            {
                let _ = state.events.send(event);
                emitted = true;
            }
            let normalized = normalized_timeline_events(
                state,
                &method,
                &params,
                &metadata,
                TimelineUpdateSource::GatewayStream,
            )
            .await?;
            emitted |= !normalized.events.is_empty();
            for normalized in normalized.events {
                send_normalized_live_event(state, normalized).await;
            }
            for thread_id in normalized.drain_thread_ids {
                queue::trigger_queue_drain(state.clone(), thread_id);
            }
            if method == "skills/changed" {
                skills::broadcast_skills_changed(state, "app-server").await?;
                emitted = true;
            }
            if !emitted
                && is_transcript_notification_method(&method)
                && metadata.thread_id.is_some()
            {
                append_timeline_changed_cursor(
                    state,
                    &metadata,
                    "app_server.notification",
                    Some(&method),
                )
                .await?;
                emitted = true;
            }
            if !emitted {
                tracing::debug!(%method, "ignored unhandled app-server notification");
            }
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
            thread_view::record_approval_created(&state.thread_views, &approval, event.seq).await?;
            let _ = state.events.send(event);
            if let Some(thread_id) = approval.thread_id.as_deref() {
                let patch =
                    thread_view::lifecycle_patch_for_thread(&state.thread_views, thread_id).await?;
                let patch = thread_view_patch_payload_event(state, patch).await?;
                let _ = state.events.send(patch);
            }
        }
    }
    Ok(())
}

async fn send_normalized_live_event(state: &AppState, event: EventEnvelope) {
    let _ = state.events.send(event);
}

fn is_transcript_notification_method(method: &str) -> bool {
    matches!(
        method,
        "item/agentMessage/delta"
            | "item/completed"
            | "item/started"
            | "item/updated"
            | "turn/completed"
            | "turn/started"
            | "turn/upsert"
            | "thread/status"
    ) || method.starts_with("item/")
        || method.starts_with("turn/")
        || method.starts_with("thread/realtime/transcript/")
}

async fn normalized_mcp_event(
    state: &AppState,
    method: &str,
    params: &Value,
) -> ApiResult<Option<EventEnvelope>> {
    let kind = match method {
        "mcpServer/startupStatus/updated" => MCP_SERVER_STATUS_UPDATED_EVENT,
        "mcpServer/oauthLogin/completed" => MCP_OAUTH_LOGIN_COMPLETED_EVENT,
        _ => return Ok(None),
    };

    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: None,
            turn_id: None,
            item_id: None,
            kind: kind.to_string(),
            codex_method: Some(method.to_string()),
            payload: params.clone(),
        })
        .await?;
    Ok(Some(event))
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
    let mut replay_high_water = match query.cursor {
        Some(cursor) => cursor,
        None => state.store.latest_event_seq().await?,
    };

    if query.cursor.is_some() {
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
            replay.extend(selected_thread_sse_replay_events(page, &query)?);
            if page_len < SSE_REPLAY_PAGE_SIZE as usize {
                break;
            }
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
            let received = timeout(Duration::from_secs(5), receiver.recv()).await;
            match received {
                Ok(Ok(event))
                    if event.seq > high_water
                        && event_matches(&event, &query)
                        && is_normal_live_event(&event) =>
                {
                    high_water = high_water.max(event.seq);
                    if let Ok(sse_event) = event_to_sse(event) {
                        yield Ok(sse_event);
                    }
                }
                Ok(Ok(_)) => {}
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                    if let Some(thread_id) = query.thread_id.clone() {
                        if let Ok(event) = thread_view_refresh_required_event(high_water, thread_id, "lagged") {
                            if let Ok(sse_event) = event_to_sse(event) {
                                yield Ok(sse_event);
                            }
                        }
                    }
                }
                Ok(Err(broadcast::error::RecvError::Closed)) => break,
                Err(_) => {}
            }
        }
    })
}

async fn replay_operational_events(
    state: &AppState,
    query: &EventsQuery,
) -> ApiResult<Vec<EventEnvelope>> {
    let mut events = Vec::new();
    let mut high_water = query.cursor.unwrap_or(0);

    loop {
        let page = state
            .store
            .replay_events_page(
                Some(high_water),
                query.project_id.as_deref(),
                query.thread_id.as_deref(),
                SSE_REPLAY_PAGE_SIZE,
            )
            .await?;
        let page_len = page.len();
        let Some(last) = page.last() else {
            break;
        };
        high_water = last.seq;
        events.extend(
            page.into_iter()
                .filter(|event| event_matches(event, query))
                .filter(is_operational_replay_event),
        );
        if page_len < SSE_REPLAY_PAGE_SIZE as usize || events.len() >= SSE_REPLAY_PAGE_SIZE as usize
        {
            events.truncate(SSE_REPLAY_PAGE_SIZE as usize);
            break;
        }
    }

    Ok(events)
}

async fn normalized_timeline_events(
    state: &AppState,
    method: &str,
    params: &Value,
    metadata: &EventMetadata,
    source: TimelineUpdateSource,
) -> ApiResult<NormalizedTimelineEvents> {
    let mut events = Vec::new();
    let mut drain_thread_ids = Vec::new();
    if metadata.thread_id.is_none() {
        return Ok(NormalizedTimelineEvents {
            events,
            drain_thread_ids,
        });
    }

    events.extend(timeline_item_delta_event(state, method, params, metadata).await?);
    events.extend(timeline_item_upsert_event(state, method, params, metadata, source).await?);
    let turn_upsert = timeline_turn_upsert_event(state, params, metadata, source).await?;
    events.extend(turn_upsert.events);
    drain_thread_ids.extend(turn_upsert.drain_thread_ids);
    events.extend(timeline_turn_completion_reconciliation_events(state, method, metadata).await?);
    if let Some(event) =
        timeline_thread_metadata_event(state, method, params, metadata, source).await?
    {
        events.push(event);
    }
    let thread_status =
        timeline_thread_status_event(state, method, params, metadata, source).await?;
    events.extend(thread_status.events);
    drain_thread_ids.extend(thread_status.drain_thread_ids);

    Ok(NormalizedTimelineEvents {
        events,
        drain_thread_ids,
    })
}

struct NormalizedTimelineEvents {
    events: Vec<EventEnvelope>,
    drain_thread_ids: Vec<String>,
}

impl Default for NormalizedTimelineEvents {
    fn default() -> Self {
        Self {
            events: Vec::new(),
            drain_thread_ids: Vec::new(),
        }
    }
}

async fn timeline_item_delta_event(
    state: &AppState,
    method: &str,
    params: &Value,
    metadata: &EventMetadata,
) -> ApiResult<Vec<EventEnvelope>> {
    if !is_assistant_message_delta_method(method) {
        return Ok(Vec::new());
    }
    let Some(thread_id) = metadata.thread_id.clone() else {
        return Ok(Vec::new());
    };
    let Some(item_id) = metadata.item_id.clone() else {
        return Ok(Vec::new());
    };
    let Some(turn_id) = metadata.turn_id.clone() else {
        return Ok(Vec::new());
    };
    let cursor =
        append_timeline_changed_cursor(state, metadata, "timeline.item_delta", Some(method))
            .await?;
    let delta = string_field(params, &["delta", "text", "content"]).unwrap_or_default();
    let _phase = string_field(params, &["phase"]);
    let patch = thread_view::record_item_delta_patch(
        &state.thread_views,
        &thread_id,
        &turn_id,
        &item_id,
        &delta,
        cursor.seq,
    )
    .await?;
    Ok(vec![thread_view_patch_payload_event(state, patch).await?])
}

fn is_assistant_message_delta_method(method: &str) -> bool {
    matches!(
        method.to_ascii_lowercase().as_str(),
        "item/agentmessage/delta" | "item/assistantmessage/delta"
    )
}

async fn timeline_item_upsert_event(
    state: &AppState,
    method: &str,
    params: &Value,
    metadata: &EventMetadata,
    source: TimelineUpdateSource,
) -> ApiResult<Vec<EventEnvelope>> {
    let Some(thread_id) = metadata.thread_id.clone() else {
        return Ok(Vec::new());
    };
    let Some(turn_id) = metadata.turn_id.clone() else {
        return Ok(Vec::new());
    };
    let Some(item) = params.get("item").filter(|item| item.is_object()) else {
        return Ok(Vec::new());
    };
    let Ok(mut item_snapshot) = item_snapshot_from_value(item) else {
        return Ok(Vec::new());
    };
    apply_live_item_skill_mentions(state, &thread_id, item, &mut item_snapshot).await?;
    let payload = TimelineItemUpsertPayload {
        source,
        turn_id: turn_id.clone(),
        item_id: item_snapshot.id.clone(),
        item: app_server_api::compact_timeline_item_payload(item),
        item_snapshot,
    };
    let cursor = append_timeline_changed_cursor(
        state,
        metadata,
        "timeline.item_upsert",
        Some("item/upsert"),
    )
    .await?;
    let patch = thread_view::record_item_upsert(
        &state.thread_views,
        &thread_id,
        &turn_id,
        item.clone(),
        payload.item_snapshot.clone(),
        item_upsert_item_status(method),
        cursor.seq,
    )
    .await?;
    let mut events = vec![thread_view_patch_payload_event(state, patch).await?];
    if let Some(event) =
        queue::reconcile_pending_steer_commit_event(state, &thread_id, &turn_id, item).await?
    {
        events.push(event);
    }
    Ok(events)
}

fn item_upsert_item_status(method: &str) -> Option<&'static str> {
    if method.ends_with("/completed") {
        Some("completed")
    } else if method.ends_with("/started") {
        Some("running")
    } else {
        None
    }
}

async fn timeline_turn_completion_reconciliation_events(
    state: &AppState,
    method: &str,
    metadata: &EventMetadata,
) -> ApiResult<Vec<EventEnvelope>> {
    if method != "turn/completed" {
        return Ok(Vec::new());
    }
    let Some(thread_id) = metadata.thread_id.as_deref() else {
        return Ok(Vec::new());
    };
    let cursor = append_completed_turn_cursor(state, metadata, method).await?;
    let revision = cursor.seq;
    let reconciliation =
        refresh_completed_turn_head(state, thread_id, metadata.turn_id.as_deref(), revision).await;
    match reconciliation {
        Ok(()) => Ok(vec![
            thread_view_full_snapshot_patch_event(state, thread_id).await?,
        ]),
        Err(error) => {
            tracing::warn!(
                %error,
                thread_id,
                "failed to reconcile completed turn head from app-server"
            );
            Ok(vec![thread_view_refresh_required_event(
                cursor.seq,
                thread_id.to_string(),
                "turn_completed_reconciliation_failed",
            )?])
        }
    }
}

async fn refresh_completed_turn_head(
    state: &AppState,
    thread_id: &str,
    completed_turn_id: Option<&str>,
    revision: i64,
) -> ApiResult<()> {
    let mut page = app_server_api::client(&state.app_server)
        .thread_turns_list_page(
            thread_id.to_string(),
            None,
            SortDirection::Desc,
            ThreadTurnItemsView::Full,
            Some(TURN_COMPLETION_HEAD_REFRESH_LIMIT),
        )
        .await?;
    if let Some(completed_turn_id) = completed_turn_id {
        if !page.data.iter().any(|turn| turn.id == completed_turn_id) {
            return Err(ApiError::BadGateway(format!(
                "completed turn {completed_turn_id} missing from recent head reconciliation"
            )));
        }
    }
    page.data.reverse();
    let history_page = ThreadTimelineWindowPage {
        older_cursor: page.next_cursor.clone(),
        newer_cursor: page.backwards_cursor.clone(),
        has_older: page.next_cursor.is_some(),
        limit: TURN_COMPLETION_HEAD_REFRESH_LIMIT,
        loaded_turn_count: page.data.len() as u32,
        reset_window: false,
    };
    thread_view::build_thread_timeline_window(
        &state.thread_views,
        thread_id,
        &page.data,
        Some(history_page),
        revision,
    )
    .await?;
    Ok(())
}

async fn apply_live_item_skill_mentions(
    state: &AppState,
    thread_id: &str,
    item: &Value,
    item_snapshot: &mut ThreadItemSnapshot,
) -> ApiResult<()> {
    let Some(text) = visible_text_from_thread_item(item) else {
        if !item_snapshot.skill_mentions.is_empty() {
            state
                .store
                .upsert_timeline_skill_mentions(
                    thread_id,
                    &item_snapshot.id,
                    &item_snapshot.skill_mentions,
                )
                .await?;
        }
        return Ok(());
    };
    if let Some(mentions) = state
        .store
        .commit_pending_timeline_skill_mentions(thread_id, &item_snapshot.id, &text)
        .await?
    {
        item_snapshot.skill_mentions = mentions;
        return Ok(());
    }
    if !item_snapshot.skill_mentions.is_empty() {
        state
            .store
            .upsert_timeline_skill_mentions(
                thread_id,
                &item_snapshot.id,
                &item_snapshot.skill_mentions,
            )
            .await?;
        return Ok(());
    }
    if let Some(mentions) = state
        .store
        .timeline_skill_mentions_for_items(thread_id, std::slice::from_ref(&item_snapshot.id))
        .await?
        .remove(&item_snapshot.id)
    {
        item_snapshot.skill_mentions = mentions;
    }
    Ok(())
}

async fn timeline_turn_upsert_event(
    state: &AppState,
    params: &Value,
    metadata: &EventMetadata,
    _source: TimelineUpdateSource,
) -> ApiResult<NormalizedTimelineEvents> {
    let Some(thread_id) = metadata.thread_id.clone() else {
        return Ok(NormalizedTimelineEvents::default());
    };
    let Some(turn) = params.get("turn").filter(|turn| turn.is_object()) else {
        return Ok(NormalizedTimelineEvents::default());
    };
    let Ok(turn) = turn_snapshot_from_value(turn) else {
        return Ok(NormalizedTimelineEvents::default());
    };
    let cursor = append_timeline_changed_cursor(
        state,
        metadata,
        "timeline.turn_upsert",
        Some("turn/upsert"),
    )
    .await?;
    let mut events = Vec::new();
    let terminal = is_terminal_turn_status(&turn.status);
    let (newly_terminal, patch) =
        thread_view::record_turn_status(&state.thread_views, &thread_id, &turn, cursor.seq).await?;
    events.push(thread_view_patch_payload_event(state, patch).await?);
    if newly_terminal {
        let completed_cursor = append_completed_turn_cursor(state, metadata, "turn/upsert").await?;
        let _ = thread_view::record_turn_status(
            &state.thread_views,
            &thread_id,
            &turn,
            completed_cursor.seq,
        )
        .await?;
        events.push(append_thread_read_projection_event(state, &thread_id).await?);
        events.extend(
            queue::requeue_unmatched_pending_commit_input_events_for_turn(
                state, &thread_id, &turn.id,
            )
            .await?,
        );
        let planned = state
            .store
            .append_event(NewEvent {
                project_id: metadata.project_id.clone(),
                thread_id: Some(thread_id.clone()),
                turn_id: Some(turn.id.clone()),
                item_id: None,
                kind: "notification.planned".to_string(),
                codex_method: None,
                payload: crate::notifications::notification_planning_event_payload(&thread_id),
            })
            .await?;
        events.push(planned);
        state
            .notifications
            .enqueue_unread_agent_message_recheck(
                state,
                thread_id.clone(),
                Some(turn.id.clone()),
                Duration::from_millis(state.config.notifications.recheck_delay_ms),
            )
            .await?;
    }
    let runtime = if terminal {
        ThreadRuntimeState {
            thread_id: metadata.thread_id.clone().unwrap_or_default(),
            status: "idle".to_string(),
            active_turn_id: None,
            updated_at: Utc::now(),
            last_event_seq: Some(cursor.seq),
        }
    } else {
        ThreadRuntimeState {
            thread_id: metadata.thread_id.clone().unwrap_or_default(),
            status: "active".to_string(),
            active_turn_id: None,
            updated_at: Utc::now(),
            last_event_seq: Some(cursor.seq),
        }
    };
    let runtime_thread_id = runtime.thread_id.clone();
    queue::refresh_runtime_state(state, runtime).await?;
    Ok(NormalizedTimelineEvents {
        events,
        drain_thread_ids: if terminal {
            vec![runtime_thread_id]
        } else {
            Vec::new()
        },
    })
}

async fn append_thread_read_projection_event(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<EventEnvelope> {
    let last_completed_agent_turn_seq = Some(
        state
            .store
            .completed_agent_turn_event_count(thread_id)
            .await?,
    )
    .filter(|count| *count > 0);
    let read_states = state
        .store
        .thread_read_states(&[thread_id.to_string()])
        .await?;
    let seen_completed_agent_turn_seq = read_states
        .get(thread_id)
        .map(|state| state.seen_completed_agent_turn_seq)
        .unwrap_or_default();
    state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(thread_id.to_string()),
            turn_id: None,
            item_id: None,
            kind: THREAD_READ_UPDATED_EVENT.to_string(),
            codex_method: None,
            payload: serde_json::to_value(ThreadReadStateUpdate {
                thread_id: thread_id.to_string(),
                seen_completed_agent_turn_seq,
                last_completed_agent_turn_seq,
                unread_completed_agent_turn: last_completed_agent_turn_seq
                    .map(|last_completed| last_completed > seen_completed_agent_turn_seq)
                    .unwrap_or(true),
            })?,
        })
        .await
}

async fn thread_view_full_snapshot_patch_event(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<EventEnvelope> {
    let patch = thread_view::patch_for_thread(&state.thread_views, thread_id).await?;
    thread_view_patch_payload_event(state, patch).await
}

pub(crate) async fn thread_view_patch_payload_event(
    state: &AppState,
    patch: thread_view::ThreadViewPatch,
) -> ApiResult<EventEnvelope> {
    patch.validate_scope().map_err(|message| {
        ApiError::BadGateway(format!("invalid thread_view.patch payload: {message}"))
    })?;
    synthetic_event(
        state.store.latest_event_seq().await?,
        Some(patch.thread_id.clone()),
        patch.active_turn_id.clone(),
        None,
        THREAD_VIEW_PATCH_EVENT_KIND,
        Some("thread_view/patch"),
        patch,
    )
}

async fn timeline_thread_metadata_event(
    state: &AppState,
    method: &str,
    params: &Value,
    metadata: &EventMetadata,
    source: TimelineUpdateSource,
) -> ApiResult<Option<EventEnvelope>> {
    let Some(thread_id) = metadata.thread_id.clone() else {
        return Ok(None);
    };
    if is_raw_thread_metadata_method(method) {
        return append_timeline_event(
            state,
            NewEvent {
                project_id: metadata.project_id.clone(),
                thread_id: Some(thread_id),
                turn_id: None,
                item_id: None,
                kind: "timeline.thread_metadata".to_string(),
                codex_method: Some(method.to_string()),
                payload: params.clone(),
            },
        )
        .await
        .map(Some);
    }

    let thread = params.get("thread").filter(|thread| thread.is_object());
    let thread = match thread {
        Some(thread) => match thread_summary_from_value(thread) {
            Ok(thread) => Some(thread),
            Err(_) => return Ok(None),
        },
        None => None,
    };
    let git_info = if thread.is_none() {
        if !params.get("gitInfo").is_some() {
            return Ok(None);
        }
        app_server_api::optional_git_info_patch(params)?
    } else {
        None
    };
    let payload = TimelineThreadMetadataPayload {
        source,
        thread_id: thread
            .as_ref()
            .map(|thread| thread.id.clone())
            .unwrap_or(thread_id),
        thread,
        git_info,
    };
    append_timeline_event(
        state,
        NewEvent {
            project_id: metadata.project_id.clone(),
            thread_id: Some(payload.thread_id.clone()),
            turn_id: None,
            item_id: None,
            kind: "timeline.thread_metadata".to_string(),
            codex_method: Some("thread/metadata".to_string()),
            payload: serde_json::to_value(payload)?,
        },
    )
    .await
    .map(Some)
}

fn is_raw_thread_metadata_method(method: &str) -> bool {
    let method = method.to_ascii_lowercase();
    matches!(
        method.as_str(),
        "thread/name/updated"
            | "thread/nameupdated"
            | "thread/name_updated"
            | "thread/tokenusage/updated"
    )
}

async fn normalized_account_event(
    state: &AppState,
    method: &str,
    params: &Value,
    metadata: &EventMetadata,
) -> ApiResult<Option<EventEnvelope>> {
    if !method.eq_ignore_ascii_case("account/rateLimits/updated") {
        return Ok(None);
    }
    state
        .store
        .append_event(NewEvent {
            project_id: metadata.project_id.clone(),
            thread_id: metadata.thread_id.clone(),
            turn_id: metadata.turn_id.clone(),
            item_id: metadata.item_id.clone(),
            kind: ACCOUNT_RATE_LIMITS_UPDATED_EVENT.to_string(),
            codex_method: Some(method.to_string()),
            payload: params.clone(),
        })
        .await
        .map(Some)
}

async fn normalized_thread_settings_event(
    state: &AppState,
    method: &str,
    _params: &Value,
    metadata: &EventMetadata,
) -> ApiResult<Option<EventEnvelope>> {
    if !method.eq_ignore_ascii_case("thread/settings/updated") {
        return Ok(None);
    }
    let Some(thread_id) = metadata.thread_id.clone() else {
        return Ok(None);
    };
    let mut thread = app_server_api::client(&state.app_server)
        .thread_read_summary(thread_id)
        .await?;
    apply_thread_summary_state(state, std::slice::from_mut(&mut thread)).await?;
    let payload = TimelineThreadMetadataPayload {
        source: TimelineUpdateSource::GatewayStream,
        thread_id: thread.id.clone(),
        thread: Some(thread),
        git_info: None,
    };
    state
        .store
        .append_event(NewEvent {
            project_id: metadata.project_id.clone(),
            thread_id: Some(payload.thread_id.clone()),
            turn_id: None,
            item_id: None,
            kind: "timeline.thread_metadata".to_string(),
            codex_method: Some(method.to_string()),
            payload: serde_json::to_value(payload)?,
        })
        .await
        .map(Some)
}

async fn timeline_thread_status_event(
    state: &AppState,
    method: &str,
    params: &Value,
    metadata: &EventMetadata,
    _source: TimelineUpdateSource,
) -> ApiResult<NormalizedTimelineEvents> {
    let Some(thread_id) = metadata.thread_id.clone() else {
        return Ok(NormalizedTimelineEvents::default());
    };
    let status_value = params
        .get("status")
        .or_else(|| params.get("thread").and_then(|thread| thread.get("status")));
    let Some(status) = status_value.and_then(thread_status_from_value) else {
        return Ok(NormalizedTimelineEvents::default());
    };
    let cursor =
        append_timeline_changed_cursor(state, metadata, "timeline.thread_status", Some(method))
            .await?;
    let mut events = Vec::new();
    let mut patch = thread_view::record_thread_live_state(
        &state.thread_views,
        &thread_id,
        live_state_from_thread_status(status),
        cursor.seq,
    )
    .await?;
    patch.thread_status = Some(status);
    events.push(thread_view_patch_payload_event(state, patch).await?);
    match status {
        ThreadStatus::Idle | ThreadStatus::SystemError | ThreadStatus::NotLoaded => {
            state
                .store
                .upsert_thread_runtime_state(ThreadRuntimeState {
                    thread_id: thread_id.clone(),
                    status: "idle".to_string(),
                    active_turn_id: None,
                    updated_at: Utc::now(),
                    last_event_seq: Some(cursor.seq),
                })
                .await?;
            events.extend(
                queue::requeue_unmatched_pending_commit_input_events_for_thread(state, &thread_id)
                    .await?,
            );
            return Ok(NormalizedTimelineEvents {
                events,
                drain_thread_ids: vec![thread_id],
            });
        }
        ThreadStatus::Active => {
            state
                .store
                .upsert_thread_runtime_state(ThreadRuntimeState {
                    thread_id: thread_id.clone(),
                    status: "active".to_string(),
                    active_turn_id: None,
                    updated_at: Utc::now(),
                    last_event_seq: Some(cursor.seq),
                })
                .await?;
        }
    }
    Ok(NormalizedTimelineEvents {
        events,
        drain_thread_ids: Vec::new(),
    })
}

async fn append_timeline_event(state: &AppState, event: NewEvent) -> ApiResult<EventEnvelope> {
    if is_transcript_timeline_event(&event.kind) {
        let persisted = state
            .store
            .append_event(NewEvent {
                project_id: event.project_id.clone(),
                thread_id: event.thread_id.clone(),
                turn_id: event.turn_id.clone(),
                item_id: event.item_id.clone(),
                kind: THREAD_VIEW_CURSOR_KIND.to_string(),
                codex_method: Some("thread_view/cursor".to_string()),
                payload: json!({
                    "threadId": event.thread_id.clone(),
                    "reason": "timeline_changed",
                    "sourceKind": event.kind.clone(),
                }),
            })
            .await?;
        return Ok(EventEnvelope {
            id: persisted.id,
            seq: persisted.seq,
            project_id: event.project_id,
            thread_id: event.thread_id,
            turn_id: event.turn_id,
            item_id: event.item_id,
            kind: event.kind,
            codex_method: event.codex_method,
            payload: event.payload,
            received_at: persisted.received_at,
        });
    }
    state.store.append_event(event).await
}

async fn append_timeline_changed_cursor(
    state: &AppState,
    metadata: &EventMetadata,
    source_kind: &str,
    codex_method: Option<&str>,
) -> ApiResult<EventEnvelope> {
    state
        .store
        .append_event(NewEvent {
            project_id: metadata.project_id.clone(),
            thread_id: metadata.thread_id.clone(),
            turn_id: metadata.turn_id.clone(),
            item_id: metadata.item_id.clone(),
            kind: THREAD_VIEW_CURSOR_KIND.to_string(),
            codex_method: Some("thread_view/cursor".to_string()),
            payload: json!({
                "threadId": metadata.thread_id.clone(),
                "reason": "timeline_changed",
                "sourceKind": source_kind,
                "sourceMethod": codex_method,
            }),
        })
        .await
}

async fn append_completed_turn_cursor(
    state: &AppState,
    metadata: &EventMetadata,
    source_method: &str,
) -> ApiResult<EventEnvelope> {
    state
        .store
        .append_event(NewEvent {
            project_id: metadata.project_id.clone(),
            thread_id: metadata.thread_id.clone(),
            turn_id: metadata.turn_id.clone(),
            item_id: metadata.item_id.clone(),
            kind: THREAD_VIEW_CURSOR_KIND.to_string(),
            codex_method: Some("thread_view/cursor".to_string()),
            payload: json!({
                "threadId": metadata.thread_id.clone(),
                "turnId": metadata.turn_id.clone(),
                "reason": "agent_turn_completed",
                "sourceKind": "timeline.turn_completed",
                "sourceMethod": source_method,
            }),
        })
        .await
}

fn is_transcript_timeline_event(kind: &str) -> bool {
    matches!(
        kind,
        "timeline.item_upsert" | "timeline.turn_upsert" | "timeline.thread_status"
    )
}

fn turn_snapshot_from_value(turn: &Value) -> ApiResult<ThreadTurnSnapshot> {
    let items = turn
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(item_snapshot_from_value)
                .collect::<ApiResult<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(ThreadTurnSnapshot {
        id: required_payload_string(turn, "id")?,
        status: status_type(turn.get("status")).unwrap_or_else(|| "unknown".to_string()),
        started_at: turn.get("startedAt").and_then(Value::as_i64),
        completed_at: turn.get("completedAt").and_then(Value::as_i64),
        items,
        raw_payload: turn.clone(),
    })
}

fn item_snapshot_from_value(item: &Value) -> ApiResult<ThreadItemSnapshot> {
    ThreadItemSnapshot::from_payload(item)
}

fn thread_summary_from_value(thread: &Value) -> ApiResult<ThreadSummary> {
    let status = thread
        .get("status")
        .and_then(thread_status_from_value)
        .ok_or_else(|| missing_payload_field("status.type"))?;
    Ok(ThreadSummary {
        id: required_payload_string(thread, "id")?,
        name: string_field(thread, &["name"]),
        cwd: required_payload_string(thread, "cwd")?,
        status,
        created_at: required_payload_i64(thread, "createdAt")?,
        updated_at: required_payload_i64(thread, "updatedAt")?,
        source: string_field(thread, &["source"]),
        model: string_field(thread, &["model"]),
        reasoning_effort: string_field(thread, &["reasoningEffort"]),
        service_tier: string_field(thread, &["serviceTier"]),
        approval_policy: string_field(thread, &["approvalPolicy"]),
        approvals_reviewer: string_field(thread, &["approvalsReviewer"]),
        agent_nickname: string_field(thread, &["agentNickname"]),
        agent_role: string_field(thread, &["agentRole"]),
        sandbox: thread
            .get("sandbox")
            .filter(|value| !value.is_null())
            .cloned(),
        git_info: app_server_api::optional_git_info(thread)?,
        pinned_at: None,
        preview: thread.get("preview").cloned(),
        last_completed_agent_turn_seq: None,
        seen_completed_agent_turn_seq: 0,
        unread_completed_agent_turn: false,
        notifications_enabled: true,
        raw_payload: thread.clone(),
    })
}

fn thread_status_from_value(status: &Value) -> Option<ThreadStatus> {
    match status_type(Some(status)).as_deref() {
        Some("notLoaded") => Some(ThreadStatus::NotLoaded),
        Some("idle") => Some(ThreadStatus::Idle),
        Some("systemError") => Some(ThreadStatus::SystemError),
        Some("active") => Some(ThreadStatus::Active),
        _ => None,
    }
}

fn live_state_from_thread_status(status: ThreadStatus) -> ThreadLiveState {
    match status {
        ThreadStatus::Active => ThreadLiveState::Streaming,
        ThreadStatus::Idle | ThreadStatus::SystemError => ThreadLiveState::Idle,
        ThreadStatus::NotLoaded => ThreadLiveState::NotLoaded,
    }
}

fn is_terminal_turn_status(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "cancelled" | "canceled" | "interrupted"
    )
}

fn status_type(value: Option<&Value>) -> Option<String> {
    value.and_then(|status| {
        status.as_str().map(str::to_string).or_else(|| {
            status
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
    })
}

fn required_payload_string(payload: &Value, field: &str) -> ApiResult<String> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| missing_payload_field(field))
}

fn required_payload_i64(payload: &Value, field: &str) -> ApiResult<i64> {
    payload
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| missing_payload_field(field))
}

fn missing_payload_field(field: &str) -> ApiError {
    ApiError::BadGateway(format!(
        "unexpected app-server payload: missing timeline field {field}"
    ))
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
#[path = "events/tests.rs"]
mod tests;
