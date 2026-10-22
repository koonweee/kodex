use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex as StdMutex},
};

use serde::Serialize;
use tokio::sync::OwnedMutexGuard;
use utoipa::ToSchema;

use crate::{
    api::AppState,
    app_server_api::{
        ThreadLiveState, ThreadSummary, ThreadTimelineSnapshot, ThreadViewThreadSummary,
    },
    error::{ApiError, ApiResult},
    store::NewEvent,
    turn_lifecycle::ThreadInputLocks,
};

pub const SIDE_THREAD_CLOSED_EVENT: &str = "side_thread.closed";

#[derive(Debug, Clone)]
pub struct SideThreadEntry {
    pub parent_thread: ThreadSummary,
    pub thread: ThreadSummary,
}

#[derive(Default)]
struct SideThreadRegistryState {
    by_parent: HashMap<String, SideThreadEntry>,
    parent_by_child: HashMap<String, String>,
    closed_children: HashSet<String>,
}

#[derive(Clone, Default)]
pub struct SideThreadRegistry {
    state: Arc<StdMutex<SideThreadRegistryState>>,
    operations: ThreadInputLocks,
}

impl SideThreadRegistry {
    pub async fn lock(&self, parent_thread_id: &str) -> OwnedMutexGuard<()> {
        self.operations.lock(parent_thread_id).await
    }

    pub fn get_by_parent(&self, parent_thread_id: &str) -> Option<SideThreadEntry> {
        self.state
            .lock()
            .unwrap()
            .by_parent
            .get(parent_thread_id)
            .cloned()
    }

    pub fn update_parent_summary(
        &self,
        parent_thread_id: &str,
        parent_thread: ThreadSummary,
    ) -> Option<SideThreadEntry> {
        let mut state = self.state.lock().unwrap();
        let entry = state.by_parent.get_mut(parent_thread_id)?;
        entry.parent_thread = parent_thread;
        Some(entry.clone())
    }

    pub fn parent_for_child(&self, child_thread_id: &str) -> Option<String> {
        self.state
            .lock()
            .unwrap()
            .parent_by_child
            .get(child_thread_id)
            .cloned()
    }

    pub fn is_side_child(&self, thread_id: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .parent_by_child
            .contains_key(thread_id)
    }

    pub fn is_closed_child(&self, thread_id: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .closed_children
            .contains(thread_id)
    }

    pub fn forget_closed_child(&self, thread_id: &str) {
        self.state.lock().unwrap().closed_children.remove(thread_id);
    }

    pub fn clear_closed_children(&self) {
        self.state.lock().unwrap().closed_children.clear();
    }

    pub fn insert(&self, entry: SideThreadEntry) {
        let parent_thread_id = entry.parent_thread.id.clone();
        let child_thread_id = entry.thread.id.clone();
        let mut state = self.state.lock().unwrap();
        state.closed_children.remove(&child_thread_id);
        state
            .parent_by_child
            .insert(child_thread_id, parent_thread_id.clone());
        state.by_parent.insert(parent_thread_id, entry);
    }

    pub fn remove_by_parent(&self, parent_thread_id: &str) -> Option<SideThreadEntry> {
        let mut state = self.state.lock().unwrap();
        let entry = state.by_parent.remove(parent_thread_id)?;
        state.parent_by_child.remove(&entry.thread.id);
        state.closed_children.insert(entry.thread.id.clone());
        Some(entry)
    }

    pub fn remove_by_child(&self, child_thread_id: &str) -> Option<SideThreadEntry> {
        let mut state = self.state.lock().unwrap();
        let parent_thread_id = state.parent_by_child.remove(child_thread_id)?;
        let entry = state.by_parent.remove(&parent_thread_id);
        state.closed_children.insert(child_thread_id.to_string());
        entry
    }

    pub fn drain(&self) -> Vec<SideThreadEntry> {
        let mut state = self.state.lock().unwrap();
        let entries = state
            .by_parent
            .drain()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        state.parent_by_child.clear();
        state
            .closed_children
            .extend(entries.iter().map(|entry| entry.thread.id.clone()));
        entries
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SideThreadResponse {
    pub parent_thread: ThreadViewThreadSummary,
    pub thread: ThreadViewThreadSummary,
    pub live_state: ThreadLiveState,
    pub timeline: ThreadTimelineSnapshot,
    pub reused: bool,
}

impl SideThreadResponse {
    pub fn from_entry(
        entry: SideThreadEntry,
        timeline: ThreadTimelineSnapshot,
        reused: bool,
    ) -> Self {
        Self {
            parent_thread: ThreadViewThreadSummary::from(entry.parent_thread),
            thread: ThreadViewThreadSummary::from(entry.thread),
            live_state: timeline.live_state,
            timeline,
            reused,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SideThreadCloseResponse {
    pub closed: bool,
    #[schema(required = true)]
    pub side_thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SideThreadClosed {
    pub parent_thread_id: String,
    pub side_thread_id: String,
    pub reason: String,
}

pub async fn response_for_entry(
    state: &AppState,
    entry: SideThreadEntry,
    reused: bool,
) -> ApiResult<SideThreadResponse> {
    let timeline = state
        .thread_views
        .snapshot(&entry.thread.id)
        .await
        .ok_or_else(|| ApiError::NotFound("side chat expired".into()))?;
    Ok(SideThreadResponse::from_entry(entry, timeline, reused))
}

pub async fn broadcast_closed(
    state: &AppState,
    entry: &SideThreadEntry,
    reason: &str,
) -> ApiResult<()> {
    let event = state
        .store
        .append_event(NewEvent {
            project_id: entry.parent_thread.project_id.clone(),
            thread_id: Some(entry.thread.id.clone()),
            turn_id: None,
            item_id: None,
            kind: SIDE_THREAD_CLOSED_EVENT.into(),
            codex_method: None,
            payload: serde_json::to_value(SideThreadClosed {
                parent_thread_id: entry.parent_thread.id.clone(),
                side_thread_id: entry.thread.id.clone(),
                reason: reason.into(),
            })?,
        })
        .await?;
    let _ = state.events.send(event);
    Ok(())
}

pub async fn invalidate_pending_app_surfaces(state: &AppState, child_thread_id: &str) {
    let mut mutation = state
        .app_surface_imports
        .lock_mutation(child_thread_id)
        .await;
    mutation.committed();
}

pub async fn close_from_native(state: &AppState, child_thread_id: &str) -> ApiResult<bool> {
    let Some(entry) = state.side_threads.remove_by_child(child_thread_id) else {
        return Ok(false);
    };
    invalidate_pending_app_surfaces(state, child_thread_id).await;
    let broadcast_result = broadcast_closed(state, &entry, "native_closed").await;
    state.thread_views.remove(child_thread_id).await;
    state.side_threads.forget_closed_child(child_thread_id);
    broadcast_result?;
    Ok(true)
}

pub async fn expire_all(state: &AppState) -> ApiResult<()> {
    let mut first_error = None;
    for entry in state.side_threads.drain() {
        invalidate_pending_app_surfaces(state, &entry.thread.id).await;
        if let Err(error) = broadcast_closed(state, &entry, "gateway_disconnected").await {
            first_error.get_or_insert(error);
        }
        state.thread_views.remove(&entry.thread.id).await;
    }
    state.side_threads.clear_closed_children();
    first_error.map_or(Ok(()), Err)
}
