use crate::{api::AppState, error::ApiResult, events::CONFIG_CHANGED_EVENT, store::NewEvent};

pub(super) async fn emit_config_changed(state: &AppState) -> ApiResult<()> {
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: None,
            turn_id: None,
            item_id: None,
            kind: CONFIG_CHANGED_EVENT.to_string(),
            codex_method: None,
            payload: serde_json::json!({}),
        })
        .await?;
    let _ = state.events.send(event);
    Ok(())
}

pub(super) fn saved_notification_error(result: ApiResult<()>) -> Option<String> {
    result.err().map(|_| {
        tracing::warn!("configuration saved but its refill notification failed");
        "Configuration saved, but notification failed. Refetch before further changes.".into()
    })
}
