use std::collections::BTreeMap;

use crate::{
    automations,
    error::ApiResult,
    events::{
        EventsQuery, ACCOUNT_RATE_LIMITS_UPDATED_EVENT, MCP_CONFIG_CHANGED_EVENT,
        MCP_OAUTH_LOGIN_COMPLETED_EVENT, MCP_SERVER_STATUS_UPDATED_EVENT,
    },
    events_synthetic::thread_view_refresh_required_event,
    queue,
    routes::{
        app_surfaces::{
            APP_SURFACE_ARCHIVED_EVENT, APP_SURFACE_BRIDGE_CALL_EVENT, APP_SURFACE_ERROR_EVENT,
            APP_SURFACE_MODEL_CONTEXT_UPDATED_EVENT, APP_SURFACE_PRESENTATION_REQUESTED_EVENT,
            APP_SURFACE_SUBMITTED_EVENT, APP_SURFACE_UPSERTED_EVENT,
        },
        threads::{
            THREAD_NOTIFICATIONS_UPDATED_EVENT, THREAD_PIN_UPDATED_EVENT,
            THREAD_READ_UPDATED_EVENT, THREAD_UPSERTED_EVENT,
        },
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
pub(crate) const WORKSPACE_GLOBAL_THREAD_EVENT_KINDS: &[&str] = &[
    "approval.created",
    "approval.resolved",
    "gateway.error",
    "gateway.warning",
    "timeline.thread_metadata",
    APP_SURFACE_PRESENTATION_REQUESTED_EVENT,
    THREAD_NOTIFICATIONS_UPDATED_EVENT,
    THREAD_READ_UPDATED_EVENT,
    THREAD_PIN_UPDATED_EVENT,
    THREAD_UPSERTED_EVENT,
    THREAD_SUBAGENT_STARTED_EVENT,
    THREAD_SUBAGENT_UPDATED_EVENT,
    THREAD_SUBAGENT_STOPPED_EVENT,
    THREAD_SUBAGENTS_CHANGED_EVENT,
    automations::AUTOMATION_UPSERT_EVENT,
    automations::AUTOMATION_DELETE_EVENT,
    queue::QUEUE_UPSERT_EVENT,
    queue::QUEUE_DELETE_EVENT,
];

pub(crate) fn event_matches(event: &EventEnvelope, query: &EventsQuery) -> bool {
    if query
        .project_id
        .as_ref()
        .is_some_and(|project_id| event.project_id.as_ref() != Some(project_id))
    {
        return false;
    }

    if query.uses_resource_set_filter() {
        return match event.thread_id.as_deref() {
            Some(thread_id) => {
                query.subscribed_thread_ids().contains(thread_id)
                    || (query.include_global_events() && is_workspace_global_thread_event(event))
            }
            None => query.include_global_events(),
        };
    }

    query
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
            | APP_SURFACE_UPSERTED_EVENT
            | APP_SURFACE_PRESENTATION_REQUESTED_EVENT
            | APP_SURFACE_SUBMITTED_EVENT
            | APP_SURFACE_ARCHIVED_EVENT
            | APP_SURFACE_ERROR_EVENT
            | APP_SURFACE_BRIDGE_CALL_EVENT
            | APP_SURFACE_MODEL_CONTEXT_UPDATED_EVENT
            | automations::AUTOMATION_UPSERT_EVENT
            | automations::AUTOMATION_DELETE_EVENT
            | queue::QUEUE_UPSERT_EVENT
            | queue::QUEUE_DELETE_EVENT
    )
}

pub(crate) fn is_workspace_global_thread_event(event: &EventEnvelope) -> bool {
    WORKSPACE_GLOBAL_THREAD_EVENT_KINDS.contains(&event.kind.as_str())
}

pub(crate) fn workspace_sse_replay_events(
    page: Vec<EventEnvelope>,
    query: &EventsQuery,
) -> ApiResult<Vec<EventEnvelope>> {
    let mut events = Vec::new();
    let subscribed_thread_ids = query.subscribed_thread_ids();
    let mut refresh_seq_by_thread_id = BTreeMap::<String, i64>::new();

    for event in page {
        if event_matches(&event, query) && is_workspace_sse_replay_event(&event, query) {
            events.push(event);
        } else if event_matches(&event, query)
            && event
                .thread_id
                .as_ref()
                .is_some_and(|thread_id| subscribed_thread_ids.contains(thread_id))
            && (is_thread_view_replay_refresh_trigger(&event)
                || is_invalid_thread_view_patch_replay_trigger(&event))
        {
            if let Some(thread_id) = event.thread_id.as_ref() {
                refresh_seq_by_thread_id
                    .entry(thread_id.clone())
                    .and_modify(|seq| *seq = (*seq).max(event.seq))
                    .or_insert(event.seq);
            }
        }
    }

    for (thread_id, seq) in refresh_seq_by_thread_id {
        events.push(thread_view_refresh_required_event(
            seq,
            thread_id,
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

fn is_workspace_sse_replay_event(event: &EventEnvelope, query: &EventsQuery) -> bool {
    is_operational_replay_event(event)
        || (query.has_thread_subscriptions()
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

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;

    use super::*;

    #[test]
    fn app_surface_events_are_live_and_replayable() {
        for kind in [
            APP_SURFACE_UPSERTED_EVENT,
            APP_SURFACE_PRESENTATION_REQUESTED_EVENT,
            APP_SURFACE_SUBMITTED_EVENT,
            APP_SURFACE_ARCHIVED_EVENT,
        ] {
            let event = event(kind, 1, "thread-1");
            assert!(is_operational_replay_event(&event), "{kind} should replay");
            assert!(is_normal_live_event(&event), "{kind} should stream live");
        }
    }

    #[test]
    fn selected_thread_replay_includes_app_surface_events() {
        let query = EventsQuery {
            cursor: Some(0),
            project_id: None,
            thread_id: Some("thread-1".to_string()),
            exclude_thread_id: None,
            include_global: None,
            thread_ids: None,
        };
        let replay = workspace_sse_replay_events(
            vec![
                event(APP_SURFACE_UPSERTED_EVENT, 1, "thread-1"),
                event(APP_SURFACE_PRESENTATION_REQUESTED_EVENT, 2, "thread-1"),
                event(APP_SURFACE_ARCHIVED_EVENT, 3, "thread-2"),
                event(APP_SURFACE_SUBMITTED_EVENT, 4, "thread-1"),
            ],
            &query,
        )
        .unwrap();

        assert_eq!(
            replay
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec![
                APP_SURFACE_UPSERTED_EVENT,
                APP_SURFACE_PRESENTATION_REQUESTED_EVENT,
                APP_SURFACE_SUBMITTED_EVENT,
            ]
        );
    }

    #[test]
    fn workspace_replay_matches_unique_thread_ids_and_global_events() {
        let query = EventsQuery {
            cursor: Some(0),
            project_id: None,
            thread_id: None,
            exclude_thread_id: None,
            include_global: Some(true),
            thread_ids: Some("thread-1,thread-1, thread-2".to_string()),
        };

        let replay = workspace_sse_replay_events(
            vec![
                global_event(ACCOUNT_RATE_LIMITS_UPDATED_EVENT, 1),
                event(APP_SURFACE_UPSERTED_EVENT, 2, "thread-1"),
                event(APP_SURFACE_SUBMITTED_EVENT, 3, "thread-2"),
                event(APP_SURFACE_PRESENTATION_REQUESTED_EVENT, 4, "thread-3"),
                event(APP_SURFACE_ARCHIVED_EVENT, 5, "thread-4"),
            ],
            &query,
        )
        .unwrap();

        assert_eq!(
            replay
                .iter()
                .map(|event| (event.kind.as_str(), event.thread_id.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                (ACCOUNT_RATE_LIMITS_UPDATED_EVENT, None),
                (APP_SURFACE_UPSERTED_EVENT, Some("thread-1")),
                (APP_SURFACE_SUBMITTED_EVENT, Some("thread-2")),
                (APP_SURFACE_PRESENTATION_REQUESTED_EVENT, Some("thread-3")),
            ]
        );
    }

    #[test]
    fn workspace_replay_global_delivery_excludes_unsubscribed_thread_view_events() {
        let query = EventsQuery {
            cursor: Some(0),
            project_id: None,
            thread_id: None,
            exclude_thread_id: None,
            include_global: Some(true),
            thread_ids: Some("thread-1".to_string()),
        };

        let replay = workspace_sse_replay_events(
            vec![
                event("approval.created", 1, "thread-2"),
                event(THREAD_VIEW_ITEM_DELTA_EVENT_KIND, 2, "thread-2"),
                event(THREAD_VIEW_PATCH_EVENT_KIND, 3, "thread-2"),
                event(THREAD_VIEW_ITEM_DELTA_EVENT_KIND, 4, "thread-1"),
            ],
            &query,
        )
        .unwrap();

        assert_eq!(
            replay
                .iter()
                .map(|event| (event.kind.as_str(), event.thread_id.as_deref()))
                .collect::<Vec<_>>(),
            vec![("approval.created", Some("thread-2"))]
        );
    }

    #[test]
    fn workspace_replay_emits_one_refresh_per_affected_thread() {
        let query = EventsQuery {
            cursor: Some(0),
            project_id: None,
            thread_id: None,
            exclude_thread_id: None,
            include_global: Some(true),
            thread_ids: Some("thread-1,thread-1,thread-2".to_string()),
        };

        let replay = workspace_sse_replay_events(
            vec![
                event(THREAD_VIEW_CURSOR_KIND, 1, "thread-1"),
                event(THREAD_VIEW_CURSOR_KIND, 2, "thread-1"),
                event(THREAD_VIEW_CURSOR_KIND, 3, "thread-2"),
                event(THREAD_VIEW_CURSOR_KIND, 4, "thread-3"),
            ],
            &query,
        )
        .unwrap();

        assert_eq!(
            replay
                .iter()
                .map(|event| (event.kind.as_str(), event.thread_id.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                (THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND, Some("thread-1")),
                (THREAD_VIEW_REFRESH_REQUIRED_EVENT_KIND, Some("thread-2")),
            ]
        );
    }

    fn global_event(kind: &str, seq: i64) -> EventEnvelope {
        EventEnvelope {
            seq,
            id: format!("event-{seq}"),
            received_at: Utc::now(),
            project_id: None,
            thread_id: None,
            turn_id: None,
            item_id: None,
            kind: kind.to_string(),
            codex_method: None,
            payload: json!({}),
        }
    }

    fn event(kind: &str, seq: i64, thread_id: &str) -> EventEnvelope {
        EventEnvelope {
            seq,
            id: format!("event-{seq}"),
            received_at: Utc::now(),
            project_id: None,
            thread_id: Some(thread_id.to_string()),
            turn_id: None,
            item_id: None,
            kind: kind.to_string(),
            codex_method: None,
            payload: json!({ "threadId": thread_id }),
        }
    }
}
