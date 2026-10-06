use super::*;

/// Remove only the temporary identity. A late native user item remains valid.
pub async fn discard_pending_user_input(
    sessions: &ThreadViewStore,
    thread_id: &str,
    turn_id: &str,
    client_id: &str,
    updated_seq: impl Future<Output = ApiResult<i64>>,
) -> ApiResult<Option<ThreadViewPatch>> {
    let mut sessions = sessions.sessions.write().await;
    let Some(view) = sessions.get_mut(thread_id) else {
        return Ok(None);
    };
    let matches = |item: &ThreadTimelineSnapshotItem| {
        is_pending_user_item(item)
            && item.turn_id == turn_id
            && user_message_client_id(item) == Some(client_id)
    };
    if !view.items.iter().any(matches) {
        return Ok(None);
    }
    // Allocate under the same exclusion as the mutation, just like insertion.
    view.revision = view.revision.max(updated_seq.await?);
    view.items.retain(|item| !matches(item));
    Ok(Some(view.turn_patch(turn_id)))
}

pub async fn record_pending_user_input(
    sessions: &ThreadViewStore,
    thread_id: &str,
    turn_id: &str,
    client_id: &str,
    input: &[impl serde::Serialize],
    attachments: &[TimelineFileAttachment],
    (submission_revision, updated_seq): (i64, impl Future<Output = ApiResult<i64>>),
) -> ApiResult<Option<ThreadViewPatch>> {
    let Ok(content) = serde_json::to_value(input) else {
        return Ok(None);
    };
    let item_id = format!("pending-user-{client_id}");
    let item = json!({
        "id": item_id,
        "type": "userMessage",
        "clientId": client_id,
        "content": content,
        "fileAttachments": attachments,
    });
    let mut item_snapshot = ThreadItemSnapshot::from_payload(&item)?;
    if item_snapshot.file_attachments.is_empty() && visible_text_from_thread_item(&item).is_none() {
        return Ok(None);
    }
    item_snapshot.raw_payload = item.clone();
    let patch = sessions
        .with_thread_view(thread_id, updated_seq, |view| {
            // An accepted native write remains successful, but its late ACK
            // must not recreate input removed by a subsequent native revert.
            if submission_revision < view.history_reset_revision {
                return None;
            }
            // Native events can materialize the input before its submission ACK.
            // Check and insert under the same view lock so late ACKs cannot
            // recreate a synthetic row after the native receipt.
            if view.items.iter().any(|item| {
                !is_pending_user_item(item)
                    && item.turn_id == turn_id
                    && user_message_client_id(item) == Some(client_id)
            }) {
                return None;
            }
            view.upsert_item(
                thread_id,
                turn_id,
                item,
                item_snapshot,
                Some("running"),
                Some(Utc::now().timestamp_millis()),
            );
            Some(view.turn_patch(turn_id))
        })
        .await?;
    Ok(patch)
}

pub(super) fn remove_materialized_pending_match(
    items: &mut Vec<ThreadTimelineSnapshotItem>,
    turn_id: &str,
    item_snapshot: &ThreadItemSnapshot,
    raw_item: &Value,
) {
    if !item_snapshot.item_type.eq_ignore_ascii_case("userMessage")
        || item_snapshot.id.starts_with("pending-user-")
    {
        return;
    }
    let Some(client_id) = raw_item.get("clientId").and_then(Value::as_str) else {
        return;
    };
    items.retain(|item| {
        !is_pending_user_item(item)
            || item.turn_id != turn_id
            || user_message_client_id(item) != Some(client_id)
    });
}

pub(super) fn is_pending_user_item(item: &ThreadTimelineSnapshotItem) -> bool {
    item.item_id.starts_with("pending-user-") && item.item_type.eq_ignore_ascii_case("userMessage")
}

pub(super) fn user_message_identity(item: &ThreadTimelineSnapshotItem) -> Option<(String, String)> {
    user_message_client_id(item).map(|client_id| (item.turn_id.clone(), client_id.to_string()))
}

pub(super) fn user_message_client_id(item: &ThreadTimelineSnapshotItem) -> Option<&str> {
    if !item.item_type.eq_ignore_ascii_case("userMessage") {
        return None;
    }
    item.payload.item.client_id.as_deref()
}
