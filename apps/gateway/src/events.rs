use std::{collections::BTreeSet, convert::Infallible};

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
use tokio::time::{timeout, Duration};
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server::InboundMessage,
    app_server_api::{
        self, ThreadItemSnapshot, ThreadLiveState, ThreadStatus, ThreadSummary, ThreadTurnSnapshot,
        TimelineItemUpsertPayload, TimelineThreadMetadataPayload, TimelineUpdateSource,
    },
    app_surfaces,
    error::{ApiError, ApiResult},
    events_replay::{
        event_matches, is_normal_live_event, is_operational_replay_event,
        workspace_sse_replay_events, THREAD_VIEW_CURSOR_KIND,
    },
    events_synthetic::{synthetic_event, thread_view_refresh_required_event},
    queue,
    routes::threads::{ThreadReadStateUpdate, THREAD_READ_UPDATED_EVENT},
    schema::is_supported_approval_method,
    skills,
    store::{EventEnvelope, NewApproval, NewEvent},
    thread_view::{self, THREAD_VIEW_ITEM_DELTA_EVENT_KIND, THREAD_VIEW_PATCH_EVENT_KIND},
};

const SSE_REPLAY_PAGE_SIZE: i64 = 500;
pub const CONFIG_CHANGED_EVENT: &str = "config.changed";
pub const MCP_SERVER_STATUS_UPDATED_EVENT: &str = "mcp.server_status_updated";
pub const MCP_OAUTH_LOGIN_COMPLETED_EVENT: &str = "mcp.oauth_login_completed";
pub const ACCOUNT_RATE_LIMITS_UPDATED_EVENT: &str = "account.rate_limits_updated";
pub const ACCOUNT_UPDATED_EVENT: &str = "account.updated";
pub const ACCOUNT_LOGIN_COMPLETED_EVENT: &str = "account.login_completed";
pub const PROJECT_CHANGED_EVENT: &str = "project.changed";
pub const THREAD_PROJECT_UPDATED_EVENT: &str = "thread.project_updated";

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChanged {
    pub project_id: String,
    pub change_type: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadProjectUpdated {
    pub thread_id: String,
    #[schema(required = true)]
    pub project_id: Option<String>,
}

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
    pub include_global: Option<bool>,
    pub thread_ids: Option<String>,
}

impl EventsQuery {
    pub(crate) fn uses_resource_set_filter(&self) -> bool {
        self.include_global.is_some() || self.thread_ids.is_some()
    }

    pub(crate) fn include_global_events(&self) -> bool {
        self.uses_resource_set_filter() && self.include_global.unwrap_or(false)
    }

    pub(crate) fn subscribed_thread_ids(&self) -> BTreeSet<String> {
        let mut ids = BTreeSet::new();
        if let Some(thread_id) = self.thread_id.as_deref() {
            if !thread_id.trim().is_empty() {
                ids.insert(thread_id.trim().to_string());
            }
        }
        if let Some(thread_ids) = self.thread_ids.as_deref() {
            ids.extend(
                thread_ids
                    .split(',')
                    .map(str::trim)
                    .filter(|thread_id| !thread_id.is_empty())
                    .map(ToOwned::to_owned),
            );
        }
        ids
    }

    pub(crate) fn has_thread_subscriptions(&self) -> bool {
        !self.subscribed_thread_ids().is_empty()
    }

    pub(crate) fn is_thread_subscribed(&self, thread_id: Option<&str>) -> bool {
        let Some(thread_id) = thread_id else {
            return false;
        };
        if self.uses_resource_set_filter() {
            return self.subscribed_thread_ids().contains(thread_id);
        }
        self.thread_id.as_deref() == Some(thread_id)
    }
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
    let events = replay_events_page_for_query(
        &state,
        query.cursor,
        &query,
        crate::store::EVENT_REPLAY_LIMIT,
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
    if query.thread_ids.is_some() && query.thread_id.is_some() {
        return Err(ApiError::BadRequest(
            "threadId and threadIds cannot be combined".to_string(),
        ));
    }
    if query.uses_resource_set_filter() && query.exclude_thread_id.is_some() {
        return Err(ApiError::BadRequest(
            "excludeThreadId cannot be combined with workspace event filters".to_string(),
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
        InboundMessage::Disconnected => {
            state.app_surface_imports.disconnect().await;
            state.queue_steer_guards.invalidate_all();
            if let Err(error) = crate::queue_transfer::recover(state).await {
                tracing::warn!(%error, "failed to publish queue transfer continuity loss");
            }
            state.thread_views.clear_completion_witnesses().await;
            crate::approvals::runtime_unavailable(state).await?;
        }
        InboundMessage::Notification { method, params } => {
            let pending_widget = if method == "item/completed" {
                match (
                    params.get("threadId").and_then(Value::as_str),
                    params.get("turnId").and_then(Value::as_str),
                    params.get("item"),
                ) {
                    (Some(thread), Some(turn), Some(item)) => {
                        app_surfaces::capture_mcp_app_surface_import(state, thread, turn, item)
                            .await
                    }
                    _ => None,
                }
            } else {
                None
            };
            if method == "serverRequest/resolved" {
                return crate::approvals::resolve_native(state, &params).await;
            }
            state
                .queue_steer_guards
                .observe_notification(&method, &params);
            if let Err(error) =
                crate::queue_transfer::observe_notification(state, &method, &params).await
            {
                tracing::warn!(%error, "failed to reconcile queue transfer notification");
            }
            if matches!(method.as_str(), "item/started" | "item/completed")
                && params.pointer("/item/type").and_then(Value::as_str) == Some("userMessage")
                && params.pointer("/item/id").and_then(Value::as_str).is_some()
            {
                if let (Some(thread), Some(turn)) = (
                    params.get("threadId").and_then(Value::as_str),
                    params.get("turnId").and_then(Value::as_str),
                ) {
                    if let Err(error) = crate::automations::observe_user_receipt(
                        state,
                        thread,
                        turn,
                        params.pointer("/item/clientId").and_then(Value::as_str),
                    )
                    .await
                    {
                        tracing::warn!(%error, "failed to reconcile automation user receipt");
                    }
                }
            }
            let metadata = EventMetadata::from_payload(&params);
            if matches!(
                method.as_str(),
                "thread/started" | "thread/archived" | "thread/unarchived" | "thread/deleted"
            ) {
                state.store.bump_thread_read_membership_revision().await?;
            }
            if method == "thread/reverted" {
                if let Some(thread_id) = metadata.thread_id.as_deref() {
                    let read = state
                        .store
                        .invalidate_thread_completion_head(thread_id)
                        .await?;
                    crate::routes::threads::broadcast_thread_read_update(state, read).await?;
                    let patch = state
                        .thread_views
                        .reset_history(thread_id, async {
                            Ok(append_timeline_changed_cursor(
                                state,
                                &metadata,
                                "thread_view.history_reset",
                                Some(&method),
                            )
                            .await?
                            .seq)
                        })
                        .await?;
                    let reset = thread_view_patch_payload_event(state, patch).await?;
                    let refill_seq = reset.seq;
                    let _ = state.events.send(reset);
                    let _ = state.events.send(thread_view_refresh_required_event(
                        refill_seq,
                        thread_id.to_string(),
                        "thread_reverted",
                    )?);
                }
                queue::observe_notification(state, &method, &params).await;
                return Ok(());
            }
            let mut emitted = false;
            if let Some(event) = normalized_project_event(state, &method, &params).await? {
                let _ = state.events.send(event);
                emitted = true;
            }
            if let Some(event) = normalized_mcp_event(state, &method, &params).await? {
                let _ = state.events.send(event);
                emitted = true;
            }
            if let Some(event) = normalized_account_event(state, &method, &params).await? {
                let _ = state.events.send(event);
                emitted = true;
            }
            if let Some(event) = normalized_thread_settings_event(state, &method, &metadata).await?
            {
                let _ = state.events.send(event);
                emitted = true;
            }
            if let Some(event) = normalized_thread_goal_event(state, &method, &metadata).await? {
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
            if let Some(event) =
                crate::thread_summary::native_change_event(state, &method, &params).await?
            {
                let _ = state.events.send(event);
                emitted = true;
            }
            // Canonical state is already published before optional widget work
            // enters the bounded importer. This path performs no native reads.
            if let Some(job) = pending_widget {
                app_surfaces::enqueue_mcp_app_surface_import(state, job).await;
            }
            if let Some(event) =
                crate::subagents::native_change_event(state, &method, &params).await?
            {
                let _ = state.events.send(event);
                emitted = true;
            }
            queue::observe_notification(state, &method, &params).await;
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
            if matches!(
                method.as_str(),
                "thread/started" | "thread/archived" | "thread/unarchived" | "thread/deleted"
            ) {
                state.store.bump_thread_read_membership_revision().await?;
            }
            if !is_supported_approval_method(&method) {
                state
                    .app_server
                    .respond_error(
                        &request_id,
                        crate::app_server::JsonRpcError {
                            code: -32601,
                            message: format!("unsupported app-server request: {method}"),
                            data: None,
                        },
                    )
                    .await?;
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

            crate::approvals::receive_native(
                state,
                NewApproval {
                    request_id,
                    thread_id: metadata.thread_id,
                    turn_id: metadata.turn_id,
                    item_id: metadata.item_id,
                    method,
                    payload: params,
                },
            )
            .await?;
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

async fn normalized_project_event(
    state: &AppState,
    method: &str,
    params: &Value,
) -> ApiResult<Option<EventEnvelope>> {
    let (kind, thread_id, payload) = match method {
        "project/changed" => {
            let notification: ProjectChanged = serde_json::from_value(params.clone())?;
            (
                PROJECT_CHANGED_EVENT,
                None,
                serde_json::to_value(notification)?,
            )
        }
        "thread/project/updated" => {
            let notification: ThreadProjectUpdated = serde_json::from_value(params.clone())?;
            (
                THREAD_PROJECT_UPDATED_EVENT,
                Some(notification.thread_id.clone()),
                serde_json::to_value(notification)?,
            )
        }
        _ => return Ok(None),
    };
    // Native project mutations can change sibling positions and membership of
    // unloaded threads, so these notifications invalidate complete projections.
    Ok(Some(
        state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id,
                turn_id: None,
                item_id: None,
                kind: kind.to_string(),
                codex_method: Some(method.to_string()),
                payload,
            })
            .await?,
    ))
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
            let page = replay_events_page_for_query(
                &state,
                Some(replay_high_water),
                &query,
                SSE_REPLAY_PAGE_SIZE,
            )
            .await?;
            let page_len = page.len();
            let Some(last) = page.last() else {
                break;
            };
            replay_high_water = last.seq;
            replay.extend(workspace_sse_replay_events(page, &query)?);
            if page_len < SSE_REPLAY_PAGE_SIZE as usize {
                break;
            }
        }
    }

    Ok(stream! {
        let mut high_water = replay_high_water;
        for event in replay {
            high_water = high_water.max(event.seq);
            let event = event_for_sse_query(event, &query);
            if let Ok(sse_event) = event_to_sse(event) {
                yield Ok(sse_event);
            }
        }

        loop {
            let received = timeout(Duration::from_secs(5), receiver.recv()).await;
            match received {
                // Suppress only operational events already covered by replay.
                // Independent publishers can broadcast committed events out of
                // order, so the latest live cursor is not a delivery cutoff.
                // Canonical payloads use projection revisions; their wrappers
                // and refill signals may share an observed transport cursor.
                Ok(Ok(event))
                    if (event.seq > replay_high_water
                        || matches!(event.kind.as_str(),
                            THREAD_VIEW_PATCH_EVENT_KIND
                                | THREAD_VIEW_ITEM_DELTA_EVENT_KIND
                                | thread_view::THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND))
                        && event_matches(&event, &query)
                        && is_sse_live_event_for_query(&event, &query) =>
                {
                    high_water = high_water.max(event.seq);
                    let event = event_for_sse_query(event, &query);
                    if let Ok(sse_event) = event_to_sse(event) {
                        yield Ok(sse_event);
                    }
                }
                Ok(Ok(_)) => {}
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                    if let Ok(event) = synthetic_event(high_water, None, None, None,
                        crate::approvals::APPROVAL_CHANGED_EVENT, None,
                        json!({"runtimeId": state.approvals.runtime_id()})) {
                        if let Ok(event) = event_to_sse(event) { yield Ok(event); }
                    }
                    for thread_id in query.subscribed_thread_ids() {
                        if let Ok(event) = thread_view_refresh_required_event(high_water, thread_id, "lagged") {
                            if let Ok(sse_event) = event_to_sse(event) {
                                yield Ok(sse_event);
                            }
                        }
                    }
                    // Reconnect from the unchanged cursor before any newer event
                    // can advance past missed global invalidations.
                    break;
                }
                Ok(Err(broadcast::error::RecvError::Closed)) => break,
                Err(_) => {}
            }
        }
    })
}

fn event_for_sse_query(mut event: EventEnvelope, query: &EventsQuery) -> EventEnvelope {
    if !query.has_thread_subscriptions() && event.kind == THREAD_VIEW_PATCH_EVENT_KIND {
        if let Ok(patch) =
            serde_json::from_value::<thread_view::ThreadViewPatch>(event.payload.clone())
        {
            let mut lifecycle = thread_view::ThreadViewPatch::lifecycle(
                patch.view_revision,
                patch.thread_id,
                patch.active_turn_id,
                patch.live_state,
                patch.pending_approval_requests,
                patch.pending_user_input_requests,
            );
            lifecycle.thread_status = patch.thread_status;
            if let Ok(payload) = serde_json::to_value(lifecycle) {
                event.payload = payload;
            }
        }
    }
    event
}

fn is_sse_live_event_for_query(event: &EventEnvelope, query: &EventsQuery) -> bool {
    if event.kind == THREAD_VIEW_ITEM_DELTA_EVENT_KIND {
        return query.is_thread_subscribed(event.thread_id.as_deref());
    }
    is_normal_live_event(event)
}

async fn replay_operational_events(
    state: &AppState,
    query: &EventsQuery,
) -> ApiResult<Vec<EventEnvelope>> {
    let mut events = Vec::new();
    let mut high_water = query.cursor.unwrap_or(0);

    loop {
        let page =
            replay_events_page_for_query(state, Some(high_water), query, SSE_REPLAY_PAGE_SIZE)
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

async fn replay_events_page_for_query(
    state: &AppState,
    cursor: Option<i64>,
    query: &EventsQuery,
    limit: i64,
) -> ApiResult<Vec<EventEnvelope>> {
    if query.uses_resource_set_filter() {
        let thread_ids = query
            .subscribed_thread_ids()
            .into_iter()
            .collect::<Vec<_>>();
        state
            .store
            .replay_events_page_for_threads(
                cursor,
                query.project_id.as_deref(),
                &thread_ids,
                query.include_global_events(),
                limit,
            )
            .await
    } else {
        state
            .store
            .replay_events_page(
                cursor,
                query.project_id.as_deref(),
                query.thread_id.as_deref(),
                limit,
            )
            .await
    }
}

async fn normalized_timeline_events(
    state: &AppState,
    method: &str,
    params: &Value,
    metadata: &EventMetadata,
    source: TimelineUpdateSource,
) -> ApiResult<NormalizedTimelineEvents> {
    let mut events = Vec::new();
    if metadata.thread_id.is_none() {
        return Ok(NormalizedTimelineEvents { events });
    }

    events.extend(timeline_item_delta_event(state, method, params, metadata).await?);
    events.extend(timeline_item_upsert_event(state, method, params, metadata, source).await?);
    let turn_upsert = timeline_turn_upsert_event(state, params, metadata, source).await?;
    events.extend(turn_upsert.events);
    events.extend(timeline_turn_completion_reconciliation_events(state, method, metadata).await?);
    let compaction = timeline_thread_compacted_event(state, method, metadata).await?;
    events.extend(compaction.events);
    if let Some(event) =
        timeline_thread_metadata_event(state, method, params, metadata, source).await?
    {
        events.push(event);
    }
    let thread_status =
        timeline_thread_status_event(state, method, params, metadata, source).await?;
    events.extend(thread_status.events);

    Ok(NormalizedTimelineEvents { events })
}

struct NormalizedTimelineEvents {
    events: Vec<EventEnvelope>,
}

impl Default for NormalizedTimelineEvents {
    fn default() -> Self {
        Self { events: Vec::new() }
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
    let delta = string_field(params, &["delta", "text", "content"]).unwrap_or_default();
    let _phase = string_field(params, &["phase"]);
    let (outcome, view_revision) = thread_view::record_item_delta(
        &state.thread_views,
        &thread_id,
        &turn_id,
        &item_id,
        &delta,
        async {
            Ok(append_timeline_changed_cursor(
                state,
                metadata,
                "thread_view.item_delta_observed",
                Some(method),
            )
            .await?
            .seq)
        },
    )
    .await?;
    match outcome {
        thread_view::ItemDeltaApplyOutcome::Ignored => return Ok(Vec::new()),
        thread_view::ItemDeltaApplyOutcome::Created => {
            let patch = thread_view::patch_for_thread(&state.thread_views, &thread_id).await?;
            return Ok(vec![thread_view_patch_payload_event(state, patch).await?]);
        }
        thread_view::ItemDeltaApplyOutcome::Appended => {}
    }
    Ok(vec![
        thread_view_item_delta_payload_event(
            state,
            thread_view::ThreadViewItemDelta {
                thread_id,
                turn_id,
                item_id,
                delta,
                view_revision,
            },
        )
        .await?,
    ])
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
    let Ok(item_snapshot) = item_snapshot_from_value(item) else {
        return Ok(Vec::new());
    };
    let payload = TimelineItemUpsertPayload {
        source,
        turn_id: turn_id.clone(),
        item_id: item_snapshot.id.clone(),
        item: app_server_api::compact_timeline_item_payload(item),
        item_snapshot,
    };
    let patch = thread_view::record_item_upsert(
        &state.thread_views,
        &thread_id,
        &turn_id,
        item.clone(),
        payload.item_snapshot.clone(),
        item_upsert_item_status(method),
        async {
            Ok(append_timeline_changed_cursor(
                state,
                metadata,
                "thread_view.item_upsert_observed",
                Some("item/upsert"),
            )
            .await?
            .seq)
        },
    )
    .await?;
    Ok(vec![thread_view_patch_payload_event(state, patch).await?])
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

async fn timeline_thread_compacted_event(
    state: &AppState,
    method: &str,
    metadata: &EventMetadata,
) -> ApiResult<NormalizedTimelineEvents> {
    if !method.eq_ignore_ascii_case("thread/compacted") {
        return Ok(NormalizedTimelineEvents::default());
    }
    let Some(thread_id) = metadata.thread_id.as_deref() else {
        return Ok(NormalizedTimelineEvents::default());
    };
    let cursor =
        append_timeline_changed_cursor(state, metadata, "timeline.thread_compacted", Some(method))
            .await?;
    Ok(NormalizedTimelineEvents {
        events: vec![thread_view_refresh_required_event(
            cursor.seq,
            thread_id.to_string(),
            "thread_compacted",
        )?],
    })
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
    // The ordinary canonical refill hydrates persisted identities outside the
    // serial notification listener. Waiting for its RPC here can deadlock when
    // the bounded inbound queue fills ahead of that RPC's response.
    Ok(vec![thread_view_refresh_required_event(
        cursor.seq,
        thread_id.to_string(),
        "turn_completed",
    )?])
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
    let mut events = Vec::new();
    let terminal = is_terminal_turn_status(&turn.status);
    let (newly_terminal, patch) =
        thread_view::record_turn_status(&state.thread_views, &thread_id, &turn, async {
            Ok(append_timeline_changed_cursor(
                state,
                metadata,
                "thread_view.turn_changed",
                Some("turn/upsert"),
            )
            .await?
            .seq)
        })
        .await?;
    events.push(thread_view_patch_payload_event(state, patch).await?);
    if terminal {
        if let Some(event) =
            append_thread_read_projection_event(state, &thread_id, &turn.id).await?
        {
            events.push(event);
        }
    }
    if newly_terminal {
        let _ = thread_view::record_turn_status(&state.thread_views, &thread_id, &turn, async {
            Ok(append_completed_turn_cursor(state, metadata, "turn/upsert")
                .await?
                .seq)
        })
        .await?;
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
    Ok(NormalizedTimelineEvents { events })
}

async fn append_thread_read_projection_event(
    state: &AppState,
    thread_id: &str,
    turn_id: &str,
) -> ApiResult<Option<EventEnvelope>> {
    let current = state.store.get_thread_read(thread_id).await?;
    if current.read_state_known
        && current.latest_completed_turn_id.as_deref() == Some(turn_id)
        && state
            .thread_views
            .pending_completion(thread_id)
            .await
            .is_none()
    {
        return Ok(None);
    }
    // History hydration can already know this terminal turn; that suppresses
    // duplicate push planning, not confirmation of a pending live witness.
    state
        .thread_views
        .observe_completion(thread_id, turn_id)
        .await;
    let read = state
        .store
        .invalidate_thread_completion_head(thread_id)
        .await?;
    state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(thread_id.to_string()),
            turn_id: Some(turn_id.to_string()),
            item_id: None,
            kind: THREAD_READ_UPDATED_EVENT.to_string(),
            codex_method: None,
            payload: serde_json::to_value(ThreadReadStateUpdate(read))?,
        })
        .await
        .map(Some)
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

async fn thread_view_item_delta_payload_event(
    state: &AppState,
    delta: thread_view::ThreadViewItemDelta,
) -> ApiResult<EventEnvelope> {
    synthetic_event(
        state.store.latest_event_seq().await?,
        Some(delta.thread_id.clone()),
        Some(delta.turn_id.clone()),
        Some(delta.item_id.clone()),
        THREAD_VIEW_ITEM_DELTA_EVENT_KIND,
        Some("thread_view/item_delta"),
        delta,
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
        Some(thread) => match ThreadSummary::from_payload(thread) {
            Ok(mut thread) => {
                crate::routes::threads::apply_stored_thread_summary_state(
                    state,
                    std::slice::from_mut(&mut thread),
                )
                .await?;
                Some(thread)
            }
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
) -> ApiResult<Option<EventEnvelope>> {
    let (kind, payload) = match method {
        "account/rateLimits/updated" => (ACCOUNT_RATE_LIMITS_UPDATED_EVENT, params.clone()),
        "account/updated" => (ACCOUNT_UPDATED_EVENT, params.clone()),
        "account/login/completed" => (
            ACCOUNT_LOGIN_COMPLETED_EVENT,
            serde_json::to_value(serde_json::from_value::<
                app_server_api::AccountLoginCompleted,
            >(params.clone())?)?,
        ),
        _ => return Ok(None),
    };
    state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: None,
            turn_id: None,
            item_id: None,
            kind: kind.to_string(),
            codex_method: Some(method.to_string()),
            payload,
        })
        .await
        .map(Some)
}

async fn normalized_thread_goal_event(
    state: &AppState,
    method: &str,
    metadata: &EventMetadata,
) -> ApiResult<Option<EventEnvelope>> {
    if !matches!(method, "thread/goal/updated" | "thread/goal/cleared") {
        return Ok(None);
    }
    let Some(thread_id) = metadata.thread_id.clone() else {
        return Ok(None);
    };
    state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(thread_id.clone()),
            turn_id: None,
            item_id: None,
            kind: crate::routes::thread_goals::THREAD_GOAL_CHANGED_EVENT.to_string(),
            codex_method: Some(method.to_string()),
            payload: serde_json::to_value(crate::routes::thread_goals::ThreadGoalChanged {
                thread_id,
            })?,
        })
        .await
        .map(Some)
}

async fn normalized_thread_settings_event(
    state: &AppState,
    method: &str,
    metadata: &EventMetadata,
) -> ApiResult<Option<EventEnvelope>> {
    if !method.eq_ignore_ascii_case("thread/settings/updated") {
        return Ok(None);
    }
    let Some(thread_id) = metadata.thread_id.clone() else {
        return Ok(None);
    };
    state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(thread_id.clone()),
            turn_id: None,
            item_id: None,
            kind: crate::routes::thread_settings::THREAD_SETTINGS_UPDATED_EVENT.to_string(),
            codex_method: Some(method.to_string()),
            payload: serde_json::to_value(crate::routes::thread_settings::ThreadSettingsUpdated {
                thread_id,
            })?,
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
    let mut events = Vec::new();
    let mut patch = thread_view::record_thread_live_state(
        &state.thread_views,
        &thread_id,
        live_state_from_thread_status(status),
        async {
            Ok(append_timeline_changed_cursor(
                state,
                metadata,
                "thread_view.status_changed",
                Some(method),
            )
            .await?
            .seq)
        },
    )
    .await?;
    patch.thread_status = Some(status);
    events.push(thread_view_patch_payload_event(state, patch).await?);
    Ok(NormalizedTimelineEvents { events })
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
                "sourceKind": "thread_view.turn_completed",
                "sourceMethod": source_method,
            }),
        })
        .await
}

fn is_transcript_timeline_event(kind: &str) -> bool {
    matches!(
        kind,
        "thread_view.item_upsert_observed"
            | "thread_view.turn_changed"
            | "thread_view.status_changed"
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
            thread_id: string_field(payload, &["threadId", "thread_id"])
                .or_else(|| nested_string_field(payload, "thread", &["id"])),
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

#[cfg(test)]
#[path = "events/lag_tests.rs"]
mod lag_tests;

#[cfg(test)]
#[path = "events/revert_tests.rs"]
mod revert_tests;

#[cfg(test)]
#[path = "events/projection_sequence_tests.rs"]
mod projection_sequence_tests;
