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
use tokio::time::{timeout, Duration, Instant};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{
    api::AppState,
    app_server::InboundMessage,
    app_server_api::{
        self, visible_text_from_thread_item, ThreadItemSnapshot, ThreadLiveState, ThreadStatus,
        ThreadSummary, ThreadTurnSnapshot, TimelineItemUpsertPayload,
        TimelineThreadMetadataPayload, TimelineUpdateSource,
    },
    automations,
    error::{ApiError, ApiResult},
    queue,
    routes::threads::{THREAD_PIN_UPDATED_EVENT, THREAD_UPSERTED_EVENT},
    schema::is_supported_approval_method,
    skills,
    store::{EventEnvelope, NewApproval, NewEvent, ThreadRuntimeState},
    thread_view::{
        self, THREAD_VIEW_ITEM_DELTA_EVENT_KIND, THREAD_VIEW_PATCH_EVENT_KIND,
        THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND,
    },
};

const SSE_REPLAY_PAGE_SIZE: i64 = 500;
const SELECTED_THREAD_POLL_LIMIT: u32 = 25;
const SELECTED_THREAD_ACTIVE_REFRESH_INTERVAL: Duration = Duration::from_secs(5);
const THREAD_VIEW_CURSOR_KIND: &str = "thread_view.cursor";
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
        let events = replay_operational_events(&state, &query).await?;
        Ok(Json(EventListResponse { events }).into_response())
    }
}

#[utoipa::path(get, path = "/v1/debug/events", params(EventsQuery), responses((status = 200, body = EventListResponse)))]
pub async fn debug_events(
    State(state): State<AppState>,
    Query(query): Query<EventsQuery>,
) -> ApiResult<Json<EventListResponse>> {
    let events = state
        .store
        .replay_events(query.cursor, query.project_id, query.thread_id)
        .await?;
    Ok(Json(EventListResponse { events }))
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
            let event = persist_notification_cursor(state, &method, &params, &metadata).await?;
            let cursor_seq = event.seq;
            let _ = state.events.send(event);
            if let Some(event) = normalized_mcp_event(state, &method, &params).await? {
                let _ = state.events.send(event);
            }
            if let Some(event) =
                normalized_account_event(state, &method, &params, &metadata).await?
            {
                let _ = state.events.send(event);
            }
            let normalized = normalized_timeline_events(
                state,
                &method,
                &params,
                &metadata,
                TimelineUpdateSource::GatewayStream,
                cursor_seq,
            )
            .await?;
            for normalized in normalized.events {
                let _ = state.events.send(normalized);
            }
            for thread_id in normalized.drain_thread_ids {
                queue::trigger_queue_drain(state.clone(), thread_id);
            }
            if method == "skills/changed" {
                skills::broadcast_skills_changed(state, "app-server").await?;
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
                let patch = thread_view_patch_event(state, thread_id).await?;
                let _ = state.events.send(patch);
            }
        }
    }
    Ok(())
}

async fn persist_notification_cursor(
    state: &AppState,
    method: &str,
    params: &Value,
    metadata: &EventMetadata,
) -> ApiResult<EventEnvelope> {
    let payload = if is_transcript_notification_method(method) {
        json!({
            "threadId": metadata.thread_id,
            "turnId": metadata.turn_id,
            "itemId": metadata.item_id,
            "sourceMethod": method,
        })
    } else {
        params.clone()
    };
    state
        .store
        .append_event(NewEvent {
            project_id: metadata.project_id.clone(),
            thread_id: metadata.thread_id.clone(),
            turn_id: metadata.turn_id.clone(),
            item_id: metadata.item_id.clone(),
            kind: "codex.notification".to_string(),
            codex_method: Some(method.to_string()),
            payload,
        })
        .await
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
        let mut selected_sync = SelectedThreadSync::default();

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
                    high_water = event.seq;
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
                Err(_) => {
                    let Some(thread_id) = query.thread_id.clone() else {
                        continue;
                    };
                    match reconcile_selected_thread(&state, &thread_id, high_water, &mut selected_sync).await {
                        Ok(Some(event)) => {
                            debug_assert!(event.seq <= high_water);
                            if let Ok(sse_event) = event_to_sse(event) {
                                yield Ok(sse_event);
                            }
                        }
                        Err(error) => tracing::debug!(%error, thread_id, "selected thread reconciliation failed"),
                        Ok(None) => {}
                    }
                }
            }
        }
    })
}

#[derive(Default)]
struct SelectedThreadSync {
    last_seen_updated_at: Option<i64>,
    last_snapshot_updated_at: Option<i64>,
    last_active_refresh_at: Option<Instant>,
}

async fn reconcile_selected_thread(
    state: &AppState,
    thread_id: &str,
    seq: i64,
    sync: &mut SelectedThreadSync,
) -> ApiResult<Option<EventEnvelope>> {
    let Some(summary) = find_recent_thread_summary(state, thread_id).await? else {
        return Ok(None);
    };

    let updated_at_changed = sync
        .last_seen_updated_at
        .is_none_or(|updated_at| summary.updated_at > updated_at);
    sync.last_seen_updated_at = Some(summary.updated_at);

    let active_refresh_due = summary.status == ThreadStatus::Active
        && sync
            .last_active_refresh_at
            .is_none_or(|last| last.elapsed() >= SELECTED_THREAD_ACTIVE_REFRESH_INTERVAL);
    let snapshot_stale = sync
        .last_snapshot_updated_at
        .is_none_or(|updated_at| summary.updated_at > updated_at);

    if !updated_at_changed && !active_refresh_due && !snapshot_stale {
        return Ok(None);
    }

    sync.last_snapshot_updated_at = Some(summary.updated_at);
    if summary.status == ThreadStatus::Active {
        sync.last_active_refresh_at = Some(Instant::now());
    } else {
        sync.last_active_refresh_at = None;
    }

    thread_view_refresh_required_event(seq, thread_id.to_string(), "thread_changed").map(Some)
}

async fn find_recent_thread_summary(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<Option<ThreadSummary>> {
    let response = app_server_api::client(&state.app_server)
        .thread_list_recent_updated(SELECTED_THREAD_POLL_LIMIT)
        .await?;
    Ok(response
        .threads
        .into_iter()
        .find(|thread| thread.id == thread_id))
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
        events.extend(page.into_iter().filter(is_operational_replay_event));
        if page_len < SSE_REPLAY_PAGE_SIZE as usize || events.len() >= SSE_REPLAY_PAGE_SIZE as usize
        {
            events.truncate(SSE_REPLAY_PAGE_SIZE as usize);
            break;
        }
    }

    Ok(events)
}

fn is_operational_replay_event(event: &EventEnvelope) -> bool {
    matches!(
        event.kind.as_str(),
        "approval.created"
            | "approval.resolved"
            | "gateway.warning"
            | "timeline.thread_metadata"
            | MCP_CONFIG_CHANGED_EVENT
            | ACCOUNT_RATE_LIMITS_UPDATED_EVENT
            | MCP_SERVER_STATUS_UPDATED_EVENT
            | MCP_OAUTH_LOGIN_COMPLETED_EVENT
            | skills::SKILLS_CHANGED_EVENT
            | THREAD_PIN_UPDATED_EVENT
            | THREAD_UPSERTED_EVENT
            | automations::AUTOMATION_UPSERT_EVENT
            | automations::AUTOMATION_DELETE_EVENT
            | queue::QUEUE_UPSERT_EVENT
            | queue::QUEUE_DELETE_EVENT
    )
}

fn is_selected_thread_sse_replay_event(event: &EventEnvelope, query: &EventsQuery) -> bool {
    is_operational_replay_event(event)
        || (query.thread_id.is_some()
            && matches!(
                event.kind.as_str(),
                THREAD_VIEW_PATCH_EVENT_KIND | THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND
            ))
}

fn selected_thread_sse_replay_events(
    page: Vec<EventEnvelope>,
    query: &EventsQuery,
) -> ApiResult<Vec<EventEnvelope>> {
    let mut events = Vec::new();
    let mut thread_view_refresh_seq = None;
    for event in page {
        if is_selected_thread_sse_replay_event(&event, query) {
            events.push(event);
        } else if query.thread_id.is_some() && is_thread_view_replay_refresh_trigger(&event) {
            thread_view_refresh_seq =
                Some(thread_view_refresh_seq.unwrap_or(event.seq).max(event.seq));
        }
    }
    if let (Some(thread_id), Some(seq)) = (query.thread_id.as_ref(), thread_view_refresh_seq) {
        events.push(thread_view_refresh_required_event(
            seq,
            thread_id.to_string(),
            "missed_cursor",
        )?);
    }
    Ok(events)
}

fn is_thread_view_replay_refresh_trigger(event: &EventEnvelope) -> bool {
    event.kind == THREAD_VIEW_CURSOR_KIND
        || (event.kind == "codex.notification"
            && event
                .codex_method
                .as_deref()
                .is_some_and(is_transcript_notification_method))
}

fn is_normal_live_event(event: &EventEnvelope) -> bool {
    is_operational_replay_event(event)
        || matches!(
            event.kind.as_str(),
            THREAD_VIEW_PATCH_EVENT_KIND
                | "timeline.thread_metadata"
                | THREAD_VIEW_ITEM_DELTA_EVENT_KIND
                | THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND
                | ACCOUNT_RATE_LIMITS_UPDATED_EVENT
                | skills::SKILLS_CHANGED_EVENT
                | queue::QUEUE_UPSERT_EVENT
                | queue::QUEUE_DELETE_EVENT
        )
}

fn thread_view_refresh_required_event(
    seq: i64,
    thread_id: String,
    reason: &str,
) -> ApiResult<EventEnvelope> {
    synthetic_event(
        seq,
        Some(thread_id.clone()),
        None,
        None,
        THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND,
        Some("thread_view/refresh_required"),
        json!({
            "threadId": thread_id,
            "reason": reason,
        }),
    )
}

fn thread_view_item_delta_event(
    seq: i64,
    thread_id: String,
    turn_id: String,
    item_id: String,
    delta: String,
    phase: Option<String>,
) -> ApiResult<EventEnvelope> {
    synthetic_event(
        seq,
        Some(thread_id.clone()),
        Some(turn_id.clone()),
        Some(item_id.clone()),
        THREAD_VIEW_ITEM_DELTA_EVENT_KIND,
        Some("thread_view/item_delta"),
        json!({
            "viewRevision": seq,
            "threadId": thread_id,
            "turnId": turn_id,
            "itemId": item_id,
            "delta": delta,
            "phase": phase,
            "itemType": "agentMessage",
            "liveState": "streaming",
        }),
    )
}

fn synthetic_event(
    seq: i64,
    thread_id: Option<String>,
    turn_id: Option<String>,
    item_id: Option<String>,
    kind: &str,
    codex_method: Option<&str>,
    payload: impl Serialize,
) -> ApiResult<EventEnvelope> {
    Ok(EventEnvelope {
        seq,
        id: Uuid::new_v4().to_string(),
        received_at: Utc::now(),
        project_id: None,
        thread_id,
        turn_id,
        item_id,
        kind: kind.to_string(),
        codex_method: codex_method.map(str::to_string),
        payload: serde_json::to_value(payload)?,
    })
}

async fn normalized_timeline_events(
    state: &AppState,
    method: &str,
    params: &Value,
    metadata: &EventMetadata,
    source: TimelineUpdateSource,
    cursor_seq: i64,
) -> ApiResult<NormalizedTimelineEvents> {
    let mut events = Vec::new();
    let mut drain_thread_ids = Vec::new();
    if metadata.thread_id.is_none() {
        return Ok(NormalizedTimelineEvents {
            events,
            drain_thread_ids,
        });
    }

    events.extend(timeline_item_delta_event(state, method, params, metadata, cursor_seq).await?);
    events.extend(timeline_item_upsert_event(state, method, params, metadata, source).await?);
    let turn_upsert = timeline_turn_upsert_event(state, params, metadata, source).await?;
    events.extend(turn_upsert.events);
    drain_thread_ids.extend(turn_upsert.drain_thread_ids);
    if let Some(event) =
        timeline_thread_metadata_event(state, method, params, metadata, source).await?
    {
        events.push(event);
    }
    let thread_status = timeline_thread_status_event(state, params, metadata, source).await?;
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
    cursor_seq: i64,
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
    let delta = string_field(params, &["delta", "text", "content"]).unwrap_or_default();
    let phase = string_field(params, &["phase"]);
    thread_view::record_item_delta(
        &state.thread_views,
        &thread_id,
        &turn_id,
        &item_id,
        &delta,
        cursor_seq,
    )
    .await?;
    Ok(vec![thread_view_item_delta_event(
        cursor_seq, thread_id, turn_id, item_id, delta, phase,
    )?])
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
        item: item.clone(),
        item_snapshot,
    };
    let cursor = append_timeline_changed_cursor(
        state,
        metadata,
        "timeline.item_upsert",
        Some("item/upsert"),
    )
    .await?;
    thread_view::record_item_upsert(
        &state.thread_views,
        &thread_id,
        &turn_id,
        item.clone(),
        payload.item_snapshot.clone(),
        item_upsert_item_status(method),
        cursor.seq,
    )
    .await?;
    let mut events = vec![thread_view_patch_event(state, &thread_id).await?];
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
    thread_view::record_turn_status(&state.thread_views, &thread_id, &turn, cursor.seq).await?;
    events.push(thread_view_patch_event(state, &thread_id).await?);
    if terminal {
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
        state.notifications.schedule_unread_agent_message_recheck(
            state.clone(),
            thread_id.clone(),
            Duration::from_millis(state.config.notifications.recheck_delay_ms),
        );
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

pub(crate) async fn thread_view_patch_event(
    state: &AppState,
    thread_id: &str,
) -> ApiResult<EventEnvelope> {
    let patch = thread_view::patch_for_thread(&state.thread_views, thread_id).await?;
    synthetic_event(
        state.store.latest_event_seq().await?,
        Some(thread_id.to_string()),
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

async fn timeline_thread_status_event(
    state: &AppState,
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
    let cursor = append_timeline_changed_cursor(
        state,
        metadata,
        "timeline.thread_status",
        Some("thread/status"),
    )
    .await?;
    let mut events = Vec::new();
    thread_view::record_thread_live_state(
        &state.thread_views,
        &thread_id,
        live_state_from_thread_status(status),
        cursor.seq,
    )
    .await?;
    events.push(thread_view_patch_event(state, &thread_id).await?);
    match status {
        ThreadStatus::Idle | ThreadStatus::SystemError => {
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
        ThreadStatus::NotLoaded => {}
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

    #[tokio::test]
    async fn notification_ingest_emits_thread_view_item_delta_for_timeline_delta() {
        let state = test_state().await;
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/agentMessage/delta".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "delta": "hello"
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let raw = receiver.recv().await.unwrap();
        let delta = receiver.recv().await.unwrap();
        assert_eq!(raw.kind, "codex.notification");
        assert_eq!(raw.payload["sourceMethod"], "item/agentMessage/delta");
        assert!(raw.payload.get("delta").is_none());
        assert_eq!(delta.kind, THREAD_VIEW_ITEM_DELTA_EVENT_KIND);
        assert_eq!(
            delta.codex_method.as_deref(),
            Some("thread_view/item_delta")
        );
        assert_eq!(delta.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(delta.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(delta.item_id.as_deref(), Some("item-1"));
        assert_eq!(delta.payload["threadId"], "thread-1");
        assert_eq!(delta.payload["turnId"], "turn-1");
        assert_eq!(delta.payload["itemId"], "item-1");
        assert_eq!(delta.payload["delta"], "hello");
        assert_eq!(delta.payload["liveState"], "streaming");

        let patch = thread_view_patch_event(&state, "thread-1").await.unwrap();
        assert_eq!(
            patch.payload["items"][0]["payload"]["item"]["text"],
            "hello"
        );

        let replay = state
            .store
            .replay_events(None, None, Some("thread-1".to_string()))
            .await
            .unwrap();
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].kind, "codex.notification");
        assert!(replay
            .iter()
            .all(|event| event.kind != "thread_view.refresh_required"));
    }

    #[tokio::test]
    async fn realtime_transcript_notifications_persist_only_cursor_metadata() {
        let state = test_state().await;

        ingest_inbound(
            InboundMessage::Notification {
                method: "thread/realtime/transcript/delta".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "delta": "secret live transcript"
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let replay = state.store.replay_events(None, None, None).await.unwrap();
        let raw = replay
            .iter()
            .find(|event| event.codex_method.as_deref() == Some("thread/realtime/transcript/delta"))
            .unwrap();
        assert_eq!(raw.kind, "codex.notification");
        assert_eq!(raw.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(raw.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(
            raw.payload["sourceMethod"],
            "thread/realtime/transcript/delta"
        );
        assert!(raw.payload.get("delta").is_none());
        assert!(raw.payload.get("text").is_none());
    }

    #[tokio::test]
    async fn notification_ingest_emits_normalized_mcp_lifecycle_events() {
        let state = test_state().await;
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "mcpServer/startupStatus/updated".to_string(),
                params: json!({
                    "name": "docs",
                    "status": "ready",
                    "error": null
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let raw = receiver.recv().await.unwrap();
        let normalized = receiver.recv().await.unwrap();
        assert_eq!(raw.kind, "codex.notification");
        assert_eq!(normalized.kind, MCP_SERVER_STATUS_UPDATED_EVENT);
        assert_eq!(
            normalized.codex_method.as_deref(),
            Some("mcpServer/startupStatus/updated")
        );
        assert_eq!(normalized.payload["name"], "docs");
        assert_eq!(normalized.payload["status"], "ready");

        ingest_inbound(
            InboundMessage::Notification {
                method: "mcpServer/oauthLogin/completed".to_string(),
                params: json!({
                    "name": "docs",
                    "success": true,
                    "error": null
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let raw = receiver.recv().await.unwrap();
        let normalized = receiver.recv().await.unwrap();
        assert_eq!(raw.kind, "codex.notification");
        assert_eq!(normalized.kind, MCP_OAUTH_LOGIN_COMPLETED_EVENT);
        assert_eq!(
            normalized.codex_method.as_deref(),
            Some("mcpServer/oauthLogin/completed")
        );
        assert_eq!(normalized.payload["success"], true);

        let replay = state.store.replay_events(None, None, None).await.unwrap();
        assert!(replay
            .iter()
            .any(|event| event.kind == MCP_SERVER_STATUS_UPDATED_EVENT));
        assert!(replay
            .iter()
            .any(|event| event.kind == MCP_OAUTH_LOGIN_COMPLETED_EVENT));
    }

    #[tokio::test]
    async fn notification_ingest_commits_pending_skill_mentions_to_user_item() {
        let state = test_state().await;
        let mut receiver = state.events.subscribe();
        state
            .store
            .insert_pending_timeline_skill_mentions(
                "thread-1",
                "Use $agent-browser",
                &[app_server_api::TimelineSkillMention {
                    start: 4,
                    end: 18,
                    name: "agent-browser".to_string(),
                    path: "/skills/agent-browser/SKILL.md".to_string(),
                    display_name: Some("Agent Browser".to_string()),
                    scope: Some("user".to_string()),
                    short_description: Some("Automate browser tasks".to_string()),
                    brand_color: Some("#23a55a".to_string()),
                    icon_small_url: Some(
                        "/v1/skills/icon?path=%2Fskills%2Fagent-browser%2Ficon.png".to_string(),
                    ),
                }],
            )
            .await
            .unwrap();

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-user-1",
                    "item": {
                        "id": "item-user-1",
                        "type": "userMessage",
                        "content": [
                            {
                                "type": "text",
                                "text": "Use $agent-browser",
                                "text_elements": [{
                                    "byteRange": {"start": 4, "end": 18},
                                    "placeholder": "$agent-browser"
                                }]
                            },
                            {"type": "skill", "name": "agent-browser", "path": "/skills/agent-browser/SKILL.md"}
                        ]
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let _raw = receiver.recv().await.unwrap();
        let patch = receiver.recv().await.unwrap();
        assert_eq!(patch.kind, THREAD_VIEW_PATCH_EVENT_KIND);
        assert_eq!(
            patch.payload["items"][0]["payload"]["itemSnapshot"]["skillMentions"],
            json!([{
                "start": 4,
                "end": 18,
                "name": "agent-browser",
                "path": "/skills/agent-browser/SKILL.md",
                "displayName": "Agent Browser",
                "scope": "user",
                "shortDescription": "Automate browser tasks",
                "brandColor": "#23a55a",
                "iconSmallUrl": "/v1/skills/icon?path=%2Fskills%2Fagent-browser%2Ficon.png"
            }])
        );
        let persisted = state
            .store
            .timeline_skill_mentions_for_items("thread-1", &["item-user-1".to_string()])
            .await
            .unwrap();
        assert_eq!(persisted["item-user-1"][0].name, "agent-browser");
        assert_eq!(
            persisted["item-user-1"][0].display_name.as_deref(),
            Some("Agent Browser")
        );
    }

    #[test]
    fn thread_view_refresh_required_uses_current_cursor_without_advancing_high_water() {
        let event =
            thread_view_refresh_required_event(42, "thread-1".to_string(), "lagged").unwrap();

        assert_eq!(event.seq, 42);
        assert_eq!(event.kind, THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND);
        assert_eq!(event.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(event.payload["reason"], "lagged");
    }

    #[test]
    fn thread_metadata_summary_preserves_git_branch() {
        let thread = thread_summary_from_value(&json!({
            "id": "thread-1",
            "cliVersion": "0.130.0",
            "cwd": "/workspace",
            "ephemeral": false,
            "gitInfo": {
                "branch": "feature/git-underflow",
                "originUrl": null,
                "sha": "abc123"
            },
            "modelProvider": "openai",
            "preview": "hello",
            "source": "cli",
            "status": {"type": "idle"},
            "turns": [],
            "createdAt": 1_i64,
            "updatedAt": 2_i64
        }))
        .unwrap();

        assert_eq!(
            thread
                .git_info
                .as_ref()
                .and_then(|git_info| git_info.branch.as_deref()),
            Some("feature/git-underflow")
        );
    }

    #[tokio::test]
    async fn thread_metadata_patch_emits_git_info_update() {
        let state = test_state().await;
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "thread/metadata/update".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "gitInfo": {
                        "branch": "feature/git-underflow",
                        "originUrl": null,
                        "sha": "abc123"
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let raw = receiver.recv().await.unwrap();
        let normalized = receiver.recv().await.unwrap();
        assert_eq!(raw.kind, "codex.notification");
        assert_eq!(normalized.kind, "timeline.thread_metadata");
        assert_eq!(normalized.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(normalized.payload["threadId"], "thread-1");
        assert_eq!(normalized.payload["thread"], Value::Null);
        assert_eq!(
            normalized.payload["gitInfo"]["branch"],
            "feature/git-underflow"
        );
    }

    #[tokio::test]
    async fn thread_metadata_patch_preserves_omitted_git_info_fields() {
        let state = test_state().await;
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "thread/metadata/update".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "gitInfo": {
                        "sha": "abc123"
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let _raw = receiver.recv().await.unwrap();
        let normalized = receiver.recv().await.unwrap();
        assert_eq!(normalized.kind, "timeline.thread_metadata");
        assert_eq!(normalized.payload["threadId"], "thread-1");
        assert!(normalized.payload["gitInfo"].get("branch").is_none());
        assert_eq!(normalized.payload["gitInfo"]["sha"], "abc123");
    }

    #[tokio::test]
    async fn selected_thread_reconciliation_polls_recent_threads_and_coalesces_reads() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(RecordingAppServer::default());
        app_server.ready.store(true, Ordering::SeqCst);
        let state = AppState::new(Config::default(), store, app_server.clone());
        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "id": "thread-1",
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "preview": "hello",
                "source": "cli",
                "status": {"type": "active"},
                "turns": [],
                "createdAt": 1_i64,
                "updatedAt": 2_i64
            }],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let mut sync = SelectedThreadSync::default();

        let event = reconcile_selected_thread(&state, "thread-1", 10, &mut sync)
            .await
            .unwrap()
            .unwrap();
        sync.last_snapshot_updated_at = Some(2);
        sync.last_active_refresh_at = Some(Instant::now());
        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "id": "thread-1",
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "preview": "hello",
                "source": "cli",
                "status": {"type": "active"},
                "turns": [],
                "createdAt": 1_i64,
                "updatedAt": 2_i64
            }],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let coalesced = reconcile_selected_thread(&state, "thread-1", 10, &mut sync)
            .await
            .unwrap();

        assert_eq!(event.kind, THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND);
        assert_eq!(event.seq, 10);
        assert_eq!(event.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(event.payload["reason"], "thread_changed");
        assert!(coalesced.is_none());
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/list");
        assert_eq!(requests[0].1["sortKey"], "updated_at");
        assert_eq!(requests[0].1["limit"], SELECTED_THREAD_POLL_LIMIT);
        assert_eq!(requests[1].0, "thread/list");
        assert_eq!(requests.len(), 2);
    }
}
