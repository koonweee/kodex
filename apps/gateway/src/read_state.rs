use std::collections::HashSet;

use serde::Serialize;
use tokio::task::JoinSet;
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api,
    error::{ApiError, ApiResult},
    store::ThreadRead,
};

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnreadBadgeResponse {
    pub count: i64,
    pub read_revision: i64,
}

pub async fn reconcile(state: &AppState, thread_id: &str) -> ApiResult<ThreadRead> {
    reconcile_inner(state, thread_id, true).await
}

async fn reconcile_inner(
    state: &AppState,
    thread_id: &str,
    publish: bool,
) -> ApiResult<ThreadRead> {
    let before = state.store.get_thread_read(thread_id).await?;
    let witness = state.thread_views.pending_completion(thread_id).await;
    let terminal_ids = app_server_api::client(&state.app_server)
        .thread_completion_head(thread_id.to_string())
        .await?;
    let head = terminal_ids.first().map(String::as_str);
    let confirmed = witness.as_ref().is_none_or(|id| terminal_ids.contains(id));
    let read = if confirmed {
        state
            .store
            .reconcile_thread_completion_head(thread_id, before.read_revision, head)
            .await?
    } else {
        state
            .store
            .invalidate_thread_completion_head_if_revision(thread_id, before.read_revision)
            .await?
    };
    if confirmed && read.read_state_known && read.latest_completed_turn_id.as_deref() == head {
        if let Some(witness) = witness {
            state
                .thread_views
                .confirm_completion(thread_id, &witness)
                .await;
        }
    }
    if publish && read.read_revision != before.read_revision {
        crate::routes::threads::broadcast_thread_read_update(state, read.clone()).await?;
    }
    Ok(read)
}

pub async fn unread_badge(state: &AppState) -> ApiResult<UnreadBadgeResponse> {
    let membership_revision = state.store.thread_read_membership_revision().await?;
    let mut cursor = None;
    let mut cursors = HashSet::new();
    let mut thread_ids = HashSet::new();
    loop {
        let page = app_server_api::client(&state.app_server)
            .thread_list(None, cursor, Some(100))
            .await?;
        app_server_api::validate_native_next_cursor(&page.raw_payload)?;
        thread_ids.extend(page.threads.into_iter().map(|thread| thread.id));
        match page.next_cursor {
            None => break,
            Some(next) if cursors.insert(next.clone()) => cursor = Some(next),
            Some(_) => {
                return Err(ApiError::BadGateway(
                    "native chat inventory repeated a cursor".into(),
                ))
            }
        }
    }
    let mut ids = thread_ids.iter();
    let mut reads = JoinSet::new();
    loop {
        while reads.len() < 4 {
            let Some(id) = ids.next() else { break };
            let state = state.clone();
            let id = id.clone();
            reads.spawn(async move { reconcile_inner(&state, &id, false).await });
        }
        let Some(read) = reads.join_next().await else {
            break;
        };
        read.map_err(|error| ApiError::Other(error.into()))??;
    }
    let ids = thread_ids.into_iter().collect::<Vec<_>>();
    let (count, read_revision) = state
        .store
        .unread_badge_snapshot(&ids, membership_revision)
        .await?;
    Ok(UnreadBadgeResponse {
        count,
        read_revision,
    })
}

// Successful local catalog writes must fence aggregate reads even when the
// native runtime does not emit a notification to this client.
pub async fn catalog_changed(state: &AppState, method: &str, thread_id: &str) -> ApiResult<()> {
    state.store.bump_thread_read_membership_revision().await?;
    if let Some(event) = crate::subagents::native_change_event(
        state,
        method,
        &serde_json::json!({"threadId": thread_id}),
    )
    .await?
    {
        let _ = state.events.send(event);
    }
    Ok(())
}
