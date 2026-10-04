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
    turn_id: Option<String>,
    epoch: Arc<()>,
    rows: HashSet<String>,
}

/// Register continuity before an asynchronous native head read. A lifecycle
/// event can retire this probe even before the original turn is known.
pub struct QueueAdmissionProbe {
    thread_id: String,
    epoch: Arc<()>,
}

/// Capture before a single fresh native queue/add; never reconstruct this from
/// history, a later active turn or a retry. Tickets are intentionally not Clone.
pub struct QueueAdmissionTicket {
    thread_id: String,
    turn_id: String,
    epoch: Arc<()>,
}

/// A consumed row right whose original context can still be retired while the
/// coordinator awaits native reads, durable writes or publication.
pub struct QueueAdmissionClaimToken {
    thread_id: String,
    turn_id: String,
    epoch: Arc<()>,
}

impl QueueAdmissionClaimToken {
    pub fn original_turn_id(&self) -> &str {
        &self.turn_id
    }
}

impl QueueAdmissionWitnesses {
    pub fn begin_probe(&self, thread_id: &str) -> QueueAdmissionProbe {
        let mut threads = self.threads.lock().unwrap();
        let context = threads
            .entry(thread_id.into())
            .or_insert_with(|| ThreadAdmissions {
                turn_id: None,
                epoch: Arc::new(()),
                rows: HashSet::new(),
            });
        QueueAdmissionProbe {
            thread_id: thread_id.into(),
            epoch: context.epoch.clone(),
        }
    }

    pub fn capture_after_probe(
        &self,
        probe: QueueAdmissionProbe,
        active_turn_id: Option<&str>,
    ) -> Option<QueueAdmissionTicket> {
        let mut threads = self.threads.lock().unwrap();
        let context = threads.get_mut(&probe.thread_id)?;
        if !Arc::ptr_eq(&context.epoch, &probe.epoch) {
            return None;
        }
        let Some(turn_id) = active_turn_id else {
            threads.remove(&probe.thread_id);
            return None;
        };
        if context.turn_id.as_deref() != Some(turn_id) {
            *context = ThreadAdmissions {
                turn_id: Some(turn_id.into()),
                epoch: Arc::new(()),
                rows: HashSet::new(),
            };
        }
        Some(QueueAdmissionTicket {
            thread_id: probe.thread_id,
            turn_id: turn_id.into(),
            epoch: context.epoch.clone(),
        })
    }

    #[cfg(test)]
    pub fn capture(
        &self,
        thread_id: &str,
        active_turn_id: Option<&str>,
    ) -> Option<QueueAdmissionTicket> {
        active_turn_id?;
        self.capture_after_probe(self.begin_probe(thread_id), active_turn_id)
    }

    /// Bind only the native row ID from that fresh add's acknowledgment. A
    /// terminal/reset/disconnect between submission and ACK retires the ticket.
    pub fn record(&self, ticket: QueueAdmissionTicket, native_row_id: &str) -> bool {
        let mut threads = self.threads.lock().unwrap();
        let Some(context) = threads.get_mut(&ticket.thread_id) else {
            return false;
        };
        if context.turn_id.as_deref() != Some(ticket.turn_id.as_str())
            || !Arc::ptr_eq(&context.epoch, &ticket.epoch)
        {
            return false;
        }
        context.rows.insert(native_row_id.into())
    }

    /// Consume BEFORE any delete attempt. Neither an error nor a lost ACK can
    /// recreate the right. Returning None requires leaving the native row alone.
    #[cfg(test)]
    pub fn claim(
        &self,
        thread_id: &str,
        native_row_id: &str,
        active_turn_id: Option<&str>,
    ) -> Option<String> {
        self.claim_token(thread_id, native_row_id, active_turn_id)
            .map(|token| token.turn_id)
    }

    pub fn claim_token(
        &self,
        thread_id: &str,
        native_row_id: &str,
        active_turn_id: Option<&str>,
    ) -> Option<QueueAdmissionClaimToken> {
        let mut threads = self.threads.lock().unwrap();
        let context = threads.get_mut(thread_id)?;
        let turn_id = context.turn_id.as_deref()?;
        if active_turn_id != Some(turn_id) || !context.rows.remove(native_row_id) {
            return None;
        }
        Some(QueueAdmissionClaimToken {
            thread_id: thread_id.into(),
            turn_id: turn_id.into(),
            epoch: context.epoch.clone(),
        })
    }

    pub fn is_current(&self, token: &QueueAdmissionClaimToken) -> bool {
        self.threads
            .lock()
            .unwrap()
            .get(&token.thread_id)
            .is_some_and(|context| {
                context.turn_id.as_deref() == Some(token.turn_id.as_str())
                    && Arc::ptr_eq(&context.epoch, &token.epoch)
            })
    }

    pub fn forget(&self, thread_id: &str, native_row_id: &str) {
        if let Some(context) = self.threads.lock().unwrap().get_mut(thread_id) {
            context.rows.remove(native_row_id);
        }
    }

    /// Presentation hint only; promotion still rechecks the native turn and
    /// consumes the guarded right under the gateway's shared input lock.
    pub fn can_promote(&self, thread_id: &str, native_row_id: &str) -> bool {
        self.threads
            .lock()
            .unwrap()
            .get(thread_id)
            .is_some_and(|context| {
                context.turn_id.is_some() && context.rows.contains(native_row_id)
            })
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
            "turn/completed" => turn_id.is_some_and(|turn_id| {
                context
                    .turn_id
                    .as_deref()
                    .is_none_or(|current| current == turn_id)
            }),
            "turn/started" => {
                turn_id.is_some_and(|turn_id| context.turn_id.as_deref() != Some(turn_id))
            }
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
