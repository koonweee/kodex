use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::RwLock;
use utoipa::ToSchema;

use crate::{
    app_server_api::{ThreadLiveState, ThreadStatus, ThreadSummary},
    routes::threads::ThreadSubagentSummary,
};

pub const THREAD_SUBAGENT_STARTED_EVENT: &str = "thread.subagent_started";
pub const THREAD_SUBAGENT_UPDATED_EVENT: &str = "thread.subagent_updated";
pub const THREAD_SUBAGENT_STOPPED_EVENT: &str = "thread.subagent_stopped";
pub const THREAD_SUBAGENTS_CHANGED_EVENT: &str = "thread.subagents_changed";

#[derive(Debug, Clone, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSubagentEventPayload {
    pub parent_thread_id: String,
    pub subagent_id: Option<String>,
    pub subagent: Option<ThreadSubagentSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentProjectionChangeKind {
    Started,
    Updated,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentProjectionChange {
    pub kind: SubagentProjectionChangeKind,
    pub parent_thread_id: String,
    pub subagent_id: String,
    pub subagent: Option<ThreadSubagentSummary>,
}

#[derive(Clone, Default)]
pub struct SubagentProjection {
    inner: Arc<RwLock<SubagentProjectionState>>,
}

#[derive(Default)]
struct SubagentProjectionState {
    by_parent: HashMap<String, HashMap<String, SubagentRecord>>,
    uncertain_parents: HashSet<String>,
    repaired_parents: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SubagentRecord {
    summary: ThreadSubagentSummary,
    created_at: i64,
}

impl SubagentProjection {
    pub async fn list_descendants(&self, parent_thread_id: &str) -> Vec<ThreadSubagentSummary> {
        let state = self.inner.read().await;
        state.list_descendants(parent_thread_id)
    }

    pub async fn needs_repair(&self, parent_thread_id: &str) -> bool {
        let state = self.inner.read().await;
        state.uncertain_parents.contains(parent_thread_id)
            || (!state.by_parent.contains_key(parent_thread_id)
                && !state.repaired_parents.contains(parent_thread_id))
    }

    pub async fn mark_parent_uncertain(&self, parent_thread_id: &str) {
        let mut state = self.inner.write().await;
        state.uncertain_parents.insert(parent_thread_id.to_string());
        state.repaired_parents.remove(parent_thread_id);
    }

    pub async fn upsert_from_thread_summary(
        &self,
        thread: &ThreadSummary,
    ) -> Option<SubagentProjectionChange> {
        let parent_thread_id = subagent_parent_thread_id(&thread.raw_payload)?;
        let record = subagent_record(thread, parent_thread_id.clone());
        let mut state = self.inner.write().await;
        state.upsert_record(parent_thread_id, record)
    }

    pub async fn update_status(
        &self,
        thread_id: &str,
        status: ThreadStatus,
        updated_at: Option<i64>,
    ) -> Option<SubagentProjectionChange> {
        let mut state = self.inner.write().await;
        let parent_thread_id = state.parent_for_thread(thread_id)?;
        if status == ThreadStatus::NotLoaded {
            return state.remove_record(&parent_thread_id, thread_id);
        }
        let record = state
            .by_parent
            .get_mut(&parent_thread_id)?
            .get_mut(thread_id)?;
        record.summary.status = status;
        record.summary.live_state = live_state_for_thread_status(status);
        if let Some(updated_at) = updated_at {
            record.summary.updated_at = updated_at;
        }
        Some(SubagentProjectionChange {
            kind: SubagentProjectionChangeKind::Updated,
            parent_thread_id,
            subagent_id: thread_id.to_string(),
            subagent: Some(record.summary.clone()),
        })
    }

    pub async fn replace_repaired_descendants(
        &self,
        parent_thread_id: &str,
        threads: Vec<ThreadSummary>,
    ) {
        let repaired_records = descendant_records(parent_thread_id, &threads);
        let mut state = self.inner.write().await;
        let stale_thread_ids = state
            .list_descendants(parent_thread_id)
            .into_iter()
            .map(|subagent| subagent.id)
            .collect::<Vec<_>>();
        for thread_id in stale_thread_ids {
            if let Some(parent_id) = state.parent_for_thread(&thread_id) {
                state.remove_record(&parent_id, &thread_id);
            }
        }
        for (parent_id, record) in repaired_records {
            let _ = state.upsert_record(parent_id, record);
        }
        state.uncertain_parents.remove(parent_thread_id);
        state.repaired_parents.insert(parent_thread_id.to_string());
    }
}

impl SubagentProjectionState {
    fn list_descendants(&self, parent_thread_id: &str) -> Vec<ThreadSubagentSummary> {
        let mut included_thread_ids = HashSet::new();
        let mut parent_ids = HashSet::from([parent_thread_id.to_string()]);
        let mut records = Vec::new();

        loop {
            let mut changed = false;
            for parent_id in parent_ids.clone() {
                let Some(children) = self.by_parent.get(&parent_id) else {
                    continue;
                };
                for record in children.values() {
                    if !included_thread_ids.insert(record.summary.id.clone()) {
                        continue;
                    }
                    parent_ids.insert(record.summary.id.clone());
                    records.push(record.clone());
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }

        records.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.summary.id.cmp(&right.summary.id))
        });
        records.into_iter().map(|record| record.summary).collect()
    }

    fn parent_for_thread(&self, thread_id: &str) -> Option<String> {
        self.by_parent.iter().find_map(|(parent_id, children)| {
            children
                .contains_key(thread_id)
                .then(|| parent_id.to_string())
        })
    }

    fn upsert_record(
        &mut self,
        parent_thread_id: String,
        record: SubagentRecord,
    ) -> Option<SubagentProjectionChange> {
        if let Some(existing_parent_id) = self.parent_for_thread(&record.summary.id) {
            if existing_parent_id != parent_thread_id {
                self.remove_record(&existing_parent_id, &record.summary.id);
            }
        }
        let subagent_id = record.summary.id.clone();
        let children = self.by_parent.entry(parent_thread_id.clone()).or_default();
        let kind = match children.insert(subagent_id.clone(), record.clone()) {
            Some(previous) if previous == record => {
                self.uncertain_parents.remove(&parent_thread_id);
                return None;
            }
            Some(_) => SubagentProjectionChangeKind::Updated,
            None => SubagentProjectionChangeKind::Started,
        };
        self.uncertain_parents.remove(&parent_thread_id);
        Some(SubagentProjectionChange {
            kind,
            parent_thread_id,
            subagent_id,
            subagent: Some(record.summary),
        })
    }

    fn remove_record(
        &mut self,
        parent_thread_id: &str,
        thread_id: &str,
    ) -> Option<SubagentProjectionChange> {
        let children = self.by_parent.get_mut(parent_thread_id)?;
        let removed = children.remove(thread_id)?;
        if children.is_empty() {
            self.by_parent.remove(parent_thread_id);
            self.repaired_parents.insert(parent_thread_id.to_string());
        }
        self.uncertain_parents.remove(parent_thread_id);
        Some(SubagentProjectionChange {
            kind: SubagentProjectionChangeKind::Stopped,
            parent_thread_id: parent_thread_id.to_string(),
            subagent_id: thread_id.to_string(),
            subagent: Some(removed.summary),
        })
    }
}

fn descendant_records(
    parent_thread_id: &str,
    threads: &[ThreadSummary],
) -> Vec<(String, SubagentRecord)> {
    let mut by_child = HashMap::new();
    for thread in threads {
        let Some(source_parent_thread_id) = subagent_parent_thread_id(&thread.raw_payload) else {
            continue;
        };
        by_child.insert(
            thread.id.clone(),
            (
                source_parent_thread_id.clone(),
                subagent_record(thread, source_parent_thread_id),
            ),
        );
    }

    let mut included_thread_ids = HashSet::new();
    let mut parent_ids = HashSet::from([parent_thread_id.to_string()]);
    let mut records = Vec::new();
    loop {
        let mut changed = false;
        for (thread_id, (source_parent_thread_id, record)) in &by_child {
            if included_thread_ids.contains(thread_id)
                || !parent_ids.contains(source_parent_thread_id)
            {
                continue;
            }
            included_thread_ids.insert(thread_id.clone());
            parent_ids.insert(thread_id.clone());
            records.push((source_parent_thread_id.clone(), record.clone()));
            changed = true;
        }
        if !changed {
            break;
        }
    }
    records
}

fn subagent_record(thread: &ThreadSummary, parent_thread_id: String) -> SubagentRecord {
    SubagentRecord {
        summary: ThreadSubagentSummary {
            id: thread.id.clone(),
            parent_thread_id,
            agent_nickname: thread.agent_nickname.clone(),
            agent_role: thread.agent_role.clone(),
            status: thread.status,
            live_state: live_state_for_thread_status(thread.status),
            updated_at: thread.updated_at,
        },
        created_at: thread.created_at,
    }
}

pub(crate) fn subagent_parent_thread_id(payload: &Value) -> Option<String> {
    payload
        .get("source")?
        .get("subAgent")?
        .get("thread_spawn")
        .or_else(|| payload.get("source")?.get("subAgent")?.get("threadSpawn"))?
        .get("parent_thread_id")
        .or_else(|| {
            payload
                .get("source")?
                .get("subAgent")?
                .get("thread_spawn")
                .or_else(|| payload.get("source")?.get("subAgent")?.get("threadSpawn"))?
                .get("parentThreadId")
        })?
        .as_str()
        .map(str::to_string)
}

pub(crate) fn live_state_for_thread_status(status: ThreadStatus) -> ThreadLiveState {
    match status {
        ThreadStatus::Active => ThreadLiveState::Streaming,
        ThreadStatus::Idle | ThreadStatus::SystemError => ThreadLiveState::Idle,
        ThreadStatus::NotLoaded => ThreadLiveState::NotLoaded,
    }
}
