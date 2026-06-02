use crate::{
    automations,
    error::ApiResult,
    events::{
        EventsQuery, ACCOUNT_RATE_LIMITS_UPDATED_EVENT, MCP_CONFIG_CHANGED_EVENT,
        MCP_OAUTH_LOGIN_COMPLETED_EVENT, MCP_SERVER_STATUS_UPDATED_EVENT,
    },
    events_synthetic::thread_view_refresh_required_event,
    queue,
    routes::threads::{
        THREAD_NOTIFICATIONS_UPDATED_EVENT, THREAD_PIN_UPDATED_EVENT, THREAD_READ_UPDATED_EVENT,
        THREAD_UPSERTED_EVENT,
    },
    skills,
    store::EventEnvelope,
    subagents::{
        THREAD_SUBAGENTS_CHANGED_EVENT, THREAD_SUBAGENT_STARTED_EVENT,
        THREAD_SUBAGENT_STOPPED_EVENT, THREAD_SUBAGENT_UPDATED_EVENT,
    },
    thread_view::{
        self, THREAD_VIEW_ITEM_DELTA_EVENT_KIND, THREAD_VIEW_PATCH_EVENT_KIND,
        THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND,
    },
};

pub(crate) const THREAD_VIEW_CURSOR_KIND: &str = "thread_view.cursor";

pub(crate) fn event_matches(event: &EventEnvelope, query: &EventsQuery) -> bool {
    query
        .project_id
        .as_ref()
        .is_none_or(|project_id| event.project_id.as_ref() == Some(project_id))
        && query
            .thread_id
            .as_ref()
            .is_none_or(|thread_id| event.thread_id.as_ref() == Some(thread_id))
        && query
            .exclude_thread_id
            .as_ref()
            .is_none_or(|thread_id| event.thread_id.as_ref() != Some(thread_id))
}

pub(crate) fn is_operational_replay_event(event: &EventEnvelope) -> bool {
    matches!(
        event.kind.as_str(),
        "approval.created"
            | "approval.resolved"
            | "gateway.error"
            | "gateway.warning"
            | "timeline.thread_metadata"
            | MCP_CONFIG_CHANGED_EVENT
            | ACCOUNT_RATE_LIMITS_UPDATED_EVENT
            | MCP_SERVER_STATUS_UPDATED_EVENT
            | MCP_OAUTH_LOGIN_COMPLETED_EVENT
            | skills::SKILLS_CHANGED_EVENT
            | THREAD_NOTIFICATIONS_UPDATED_EVENT
            | THREAD_READ_UPDATED_EVENT
            | THREAD_PIN_UPDATED_EVENT
            | THREAD_UPSERTED_EVENT
            | THREAD_SUBAGENT_STARTED_EVENT
            | THREAD_SUBAGENT_UPDATED_EVENT
            | THREAD_SUBAGENT_STOPPED_EVENT
            | THREAD_SUBAGENTS_CHANGED_EVENT
            | automations::AUTOMATION_UPSERT_EVENT
            | automations::AUTOMATION_DELETE_EVENT
            | queue::QUEUE_UPSERT_EVENT
            | queue::QUEUE_DELETE_EVENT
    )
}

pub(crate) fn selected_thread_sse_replay_events(
    page: Vec<EventEnvelope>,
    query: &EventsQuery,
) -> ApiResult<Vec<EventEnvelope>> {
    let mut events = Vec::new();
    let mut thread_view_refresh_seq = None;
    for event in page {
        if event_matches(&event, query) && is_selected_thread_sse_replay_event(&event, query) {
            events.push(event);
        } else if event_matches(&event, query)
            && query.thread_id.is_some()
            && (is_thread_view_replay_refresh_trigger(&event)
                || is_invalid_thread_view_patch_replay_trigger(&event))
        {
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

pub(crate) fn is_normal_live_event(event: &EventEnvelope) -> bool {
    is_operational_replay_event(event)
        || matches!(
            event.kind.as_str(),
            THREAD_VIEW_PATCH_EVENT_KIND
                | THREAD_VIEW_ITEM_DELTA_EVENT_KIND
                | "timeline.thread_metadata"
                | THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND
                | ACCOUNT_RATE_LIMITS_UPDATED_EVENT
                | skills::SKILLS_CHANGED_EVENT
                | queue::QUEUE_UPSERT_EVENT
                | queue::QUEUE_DELETE_EVENT
        )
}

fn is_selected_thread_sse_replay_event(event: &EventEnvelope, query: &EventsQuery) -> bool {
    is_operational_replay_event(event)
        || (query.thread_id.is_some()
            && (event.kind == THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND
                || is_valid_thread_view_patch_replay_event(event)))
}

fn is_thread_view_replay_refresh_trigger(event: &EventEnvelope) -> bool {
    event.kind == THREAD_VIEW_CURSOR_KIND
}

fn is_valid_thread_view_patch_replay_event(event: &EventEnvelope) -> bool {
    if event.kind != THREAD_VIEW_PATCH_EVENT_KIND {
        return false;
    }

    serde_json::from_value::<thread_view::ThreadViewPatch>(event.payload.clone())
        .is_ok_and(|patch| patch.validate_scope().is_ok())
}

fn is_invalid_thread_view_patch_replay_trigger(event: &EventEnvelope) -> bool {
    event.kind == THREAD_VIEW_PATCH_EVENT_KIND && !is_valid_thread_view_patch_replay_event(event)
}
