use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use serde_json::Value;

/// A narrow, ephemeral pre-add context for queued-row promotion. Native queues
/// start new idle turns; they cannot dispatch into the already-active turn.
/// A claimed witness still requires confirmed deletion and one native steer
/// using this ORIGINAL turn ID. It is not evidence of committed delivery.
#[derive(Clone, Default)]
pub struct QueueAdmissionWitnesses {
    threads: Arc<Mutex<HashMap<String, ThreadAdmissions>>>,
}

struct ThreadAdmissions {
    turn_id: String,
    epoch: Arc<()>,
    rows: HashSet<String>,
}

/// Capture before a single fresh native queue/add; never reconstruct this from
/// history, a later active turn or a retry. Tickets are intentionally not Clone.
pub struct QueueAdmissionTicket {
    thread_id: String,
    turn_id: String,
    epoch: Arc<()>,
}

impl QueueAdmissionWitnesses {
    pub fn capture(
        &self,
        thread_id: &str,
        active_turn_id: Option<&str>,
    ) -> Option<QueueAdmissionTicket> {
        let turn_id = active_turn_id?;
        let mut threads = self.threads.lock().unwrap();
        let context = threads
            .entry(thread_id.into())
            .or_insert_with(|| ThreadAdmissions {
                turn_id: turn_id.into(),
                epoch: Arc::new(()),
                rows: HashSet::new(),
            });
        if context.turn_id != turn_id {
            *context = ThreadAdmissions {
                turn_id: turn_id.into(),
                epoch: Arc::new(()),
                rows: HashSet::new(),
            };
        }
        Some(QueueAdmissionTicket {
            thread_id: thread_id.into(),
            turn_id: turn_id.into(),
            epoch: context.epoch.clone(),
        })
    }

    /// Bind only the native row ID from that fresh add's acknowledgment. A
    /// terminal/reset/disconnect between submission and ACK retires the ticket.
    pub fn record(&self, ticket: QueueAdmissionTicket, native_row_id: &str) -> bool {
        let mut threads = self.threads.lock().unwrap();
        let Some(context) = threads.get_mut(&ticket.thread_id) else {
            return false;
        };
        if context.turn_id != ticket.turn_id || !Arc::ptr_eq(&context.epoch, &ticket.epoch) {
            return false;
        }
        context.rows.insert(native_row_id.into())
    }

    /// Consume BEFORE any delete attempt. Neither an error nor a lost ACK can
    /// recreate the right. Returning None requires leaving the native row alone.
    pub fn claim(
        &self,
        thread_id: &str,
        native_row_id: &str,
        active_turn_id: Option<&str>,
    ) -> Option<String> {
        let mut threads = self.threads.lock().unwrap();
        let context = threads.get_mut(thread_id)?;
        if active_turn_id != Some(context.turn_id.as_str()) || !context.rows.remove(native_row_id) {
            return None;
        }
        Some(context.turn_id.clone())
    }

    pub fn forget(&self, thread_id: &str, native_row_id: &str) {
        if let Some(context) = self.threads.lock().unwrap().get_mut(thread_id) {
            context.rows.remove(native_row_id);
        }
    }

    pub fn invalidate_all(&self) {
        self.threads.lock().unwrap().clear();
    }

    pub fn observe_notification(&self, method: &str, params: &Value) {
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return;
        };
        let mut threads = self.threads.lock().unwrap();
        let Some(context) = threads.get(thread_id) else {
            return;
        };
        let turn_id = params.pointer("/turn/id").and_then(Value::as_str);
        let invalidate = match method {
            "turn/completed" => turn_id == Some(context.turn_id.as_str()),
            "turn/started" => turn_id.is_some_and(|turn_id| turn_id != context.turn_id),
            "thread/reverted" | "thread/closed" | "thread/archived" | "thread/deleted" => true,
            "thread/status/changed" => matches!(
                params.pointer("/status/type").and_then(Value::as_str),
                Some("idle" | "notLoaded" | "systemError")
            ),
            _ => false,
        };
        if invalidate {
            threads.remove(thread_id);
        }
    }
}

#[cfg(test)]
#[path = "queue_admission/tests.rs"]
mod tests;
