use std::sync::{Arc, Mutex, Weak};

use serde_json::Value;

type Operations = Mutex<Vec<Weak<Operation>>>;

/// Continuity guards for one queue-to-steer operation. These registrations
/// hold no queue-row identity or eligibility state and expire with the operation.
#[derive(Clone, Default)]
pub struct QueueSteerGuards {
    operations: Arc<Operations>,
}

struct Operation {
    thread_id: String,
    phase: Mutex<Phase>,
}

enum Phase {
    Probing,
    Bound(String),
    Retired,
}

/// Register before asynchronous capability, active-head and native queue reads.
/// A lifecycle event retires an unbound probe even before its turn is known.
pub struct QueueSteerProbe {
    operation: Arc<Operation>,
    registry: Weak<Operations>,
}

/// Recheck continuity after each await before handing input to native steer.
/// This token describes only the current operation, never a queued row's origin.
pub struct QueueSteerToken {
    operation: Arc<Operation>,
    registry: Weak<Operations>,
    turn_id: String,
}

impl QueueSteerToken {
    pub fn turn_id(&self) -> &str {
        &self.turn_id
    }
}

impl QueueSteerGuards {
    pub fn begin_probe(&self, thread_id: &str) -> QueueSteerProbe {
        let operation = Arc::new(Operation {
            thread_id: thread_id.into(),
            phase: Mutex::new(Phase::Probing),
        });
        let mut operations = self.operations.lock().unwrap();
        operations.retain(|operation| operation.strong_count() > 0);
        operations.push(Arc::downgrade(&operation));
        QueueSteerProbe {
            operation,
            registry: Arc::downgrade(&self.operations),
        }
    }

    pub fn capture_after_probe(
        &self,
        probe: QueueSteerProbe,
        active_turn_id: Option<&str>,
    ) -> Option<QueueSteerToken> {
        if !Weak::ptr_eq(&probe.registry, &Arc::downgrade(&self.operations)) {
            return None;
        }
        {
            let mut phase = probe.operation.phase.lock().unwrap();
            if !matches!(*phase, Phase::Probing) {
                return None;
            }
            let Some(turn_id) = active_turn_id else {
                *phase = Phase::Retired;
                return None;
            };
            *phase = Phase::Bound(turn_id.into());
        }
        Some(QueueSteerToken {
            operation: probe.operation,
            registry: probe.registry,
            turn_id: active_turn_id.unwrap().into(),
        })
    }

    /// Idle queue-start preflight has no active turn to bind. Keep its probe
    /// registered until dispatch so lifecycle changes still fence stale reads.
    pub fn is_probe_current(&self, probe: &QueueSteerProbe) -> bool {
        Weak::ptr_eq(&probe.registry, &Arc::downgrade(&self.operations))
            && matches!(*probe.operation.phase.lock().unwrap(), Phase::Probing)
    }

    pub fn is_current(&self, token: &QueueSteerToken) -> bool {
        Weak::ptr_eq(&token.registry, &Arc::downgrade(&self.operations))
            && matches!(
                &*token.operation.phase.lock().unwrap(),
                Phase::Bound(turn_id) if turn_id == &token.turn_id
            )
    }

    pub fn invalidate_all(&self) {
        let mut operations = self.operations.lock().unwrap();
        for operation in operations
            .drain(..)
            .filter_map(|operation| operation.upgrade())
        {
            *operation.phase.lock().unwrap() = Phase::Retired;
        }
    }

    pub fn observe_notification(&self, method: &str, params: &Value) {
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return;
        };
        let turn_id = params.pointer("/turn/id").and_then(Value::as_str);
        let mut operations = self.operations.lock().unwrap();
        operations.retain(|operation| {
            let Some(operation) = operation.upgrade() else {
                return false;
            };
            if operation.thread_id != thread_id {
                return true;
            }
            let mut phase = operation.phase.lock().unwrap();
            let invalidate = match method {
                "turn/started" => match &*phase {
                    Phase::Bound(current) => turn_id != Some(current.as_str()),
                    Phase::Probing => true,
                    Phase::Retired => false,
                },
                "turn/completed" => match &*phase {
                    Phase::Bound(current) => turn_id.is_none_or(|turn| turn == current),
                    Phase::Probing => true,
                    Phase::Retired => false,
                },
                "thread/reverted" | "thread/closed" | "thread/archived" | "thread/deleted" => true,
                "thread/status/changed" => matches!(
                    params.pointer("/status/type").and_then(Value::as_str),
                    Some("idle" | "notLoaded" | "systemError")
                ),
                _ => false,
            };
            if invalidate {
                *phase = Phase::Retired;
            }
            !matches!(*phase, Phase::Retired)
        });
    }
}

#[cfg(test)]
#[path = "queue_steer_guard/tests.rs"]
mod tests;
