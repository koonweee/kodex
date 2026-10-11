//! Request-scoped observation; no activation, durable waiter, or inferred completion.
use super::control_reads::{compact_turns, CompactTurn};
use crate::{
    api::AppState,
    app_server_api::{self, SortDirection, ThreadStatus, ThreadTurnItemsView, ThreadTurnSnapshot},
    error::{ApiError, ApiErrorBody, ApiResult},
};
use axum::{extract::State, Json};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rmcp::schemars;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tokio::{
    task::JoinSet,
    time::{timeout, Duration, Instant},
};
use utoipa::ToSchema;

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WaitTarget {
    pub thread_id: String,
    pub after_cursor: Option<String>,
}
#[derive(Debug, Deserialize, Serialize, ToSchema, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WaitThreadsRequest {
    pub targets: Vec<WaitTarget>,
    pub timeout_ms: Option<u64>,
}
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WaitThreadsResponse {
    pub status: String,
    pub results: Vec<WaitThreadResult>,
    pub errors: Vec<WaitThreadError>,
}
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WaitThreadResult {
    pub thread_id: String,
    pub cursor: String,
    pub condition: String,
    pub changed: bool,
    pub reset: bool,
    pub progress: Vec<CompactTurn>,
    pub truncated: bool,
}
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WaitThreadError {
    pub thread_id: String,
    pub error: ApiErrorBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    version: u8,
    thread_id: String,
    runtime: String,
    reset_revision: i64,
    // Preserve the delivered terminal receipt through intermediate active snapshots.
    terminal: Option<(String, String)>,
    attention: Vec<String>,
}
impl Cursor {
    fn decode(value: Option<&str>, thread_id: &str) -> ApiResult<Option<Self>> {
        let Some(value) = value else {
            return Ok(None);
        };
        let invalid = || ApiError::BadRequest("Invalid wait cursor for this thread".into());
        if value.len() > 8192 {
            return Err(invalid());
        }
        let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| invalid())?;
        let cursor: Self = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if cursor.version != 1 || cursor.thread_id != thread_id {
            return Err(invalid());
        }
        Ok(Some(cursor))
    }
    fn encode(&self) -> ApiResult<String> {
        Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(self)?))
    }
}
struct Observation {
    target: WaitTarget,
    cursor: Cursor,
    condition: String,
    changed: bool,
    reset: bool,
    head: Option<ThreadTurnSnapshot>,
    repeat_terminal: bool,
    revision: i64,
}
impl Observation {
    fn matches(&self) -> bool {
        self.reset
            || (self.changed
                && matches!(
                    self.condition.as_str(),
                    "completed" | "failed" | "interrupted" | "attention"
                ))
    }
}

#[utoipa::path(post, path = "/v1/self-control/threads/wait", request_body = WaitThreadsRequest, responses((status = 200, body = WaitThreadsResponse)))]
pub async fn wait_threads(
    State(state): State<AppState>,
    Json(request): Json<WaitThreadsRequest>,
) -> ApiResult<Json<WaitThreadsResponse>> {
    let duration = request.timeout_ms.unwrap_or(30_000);
    let mut ids = HashSet::new();
    if request.targets.is_empty()
        || request.targets.len() > 8
        || duration > 60_000
        || request.targets.iter().any(|target| {
            target.thread_id.is_empty()
                || target.thread_id.len() > 256
                || !ids.insert(target.thread_id.clone())
        })
    {
        return Err(ApiError::BadRequest(
            "Provide 1–8 distinct thread IDs and timeoutMs from 0 to 60000".into(),
        ));
    }
    let deadline = Instant::now() + Duration::from_millis(duration);
    let mut events = state.events.subscribe();
    loop {
        let mut reads = JoinSet::new();
        for target in &request.targets {
            let state = state.clone();
            let target = target.clone();
            reads.spawn(async move {
                let result = timeout(Duration::from_secs(5), observe(&state, target.clone()))
                    .await
                    .unwrap_or_else(|_| {
                        Err(ApiError::Retryable("Wait snapshot read timed out".into()))
                    });
                (target.thread_id, result)
            });
        }
        let mut observations = Vec::new();
        let mut errors = Vec::new();
        while let Some(read) = reads.join_next().await {
            let (thread_id, result) = read.map_err(|error| ApiError::Other(error.into()))?;
            match result {
                Ok(value) => observations.push(value),
                Err(error) => errors.push(target_error(thread_id, error)),
            }
        }
        let matched = observations.iter().any(Observation::matches);
        if matched
            || errors.iter().any(|error| !error.error.retryable)
            || Instant::now() >= deadline
        {
            let mut progress_reads = JoinSet::new();
            for observation in observations {
                let state = state.clone();
                progress_reads.spawn(async move {
                    let thread_id = observation.target.thread_id.clone();
                    let result = timeout(Duration::from_secs(5), finish(&state, observation))
                        .await
                        .unwrap_or_else(|_| {
                            Err(ApiError::Retryable("Wait progress read timed out".into()))
                        });
                    (thread_id, result)
                });
            }
            let mut results = Vec::new();
            while let Some(read) = progress_reads.join_next().await {
                let (thread_id, result) = read.map_err(|error| ApiError::Other(error.into()))?;
                match result {
                    Ok(value) => results.push(value),
                    Err(error) => errors.push(target_error(thread_id, error)),
                }
            }
            results.sort_by_key(|result| {
                request
                    .targets
                    .iter()
                    .position(|target| target.thread_id == result.thread_id)
            });
            errors.sort_by_key(|result| {
                request
                    .targets
                    .iter()
                    .position(|target| target.thread_id == result.thread_id)
            });
            let matched = results.iter().any(|result| {
                result.reset
                    || (result.changed
                        && matches!(
                            result.condition.as_str(),
                            "completed" | "failed" | "interrupted" | "attention"
                        ))
            });
            if !matched
                && !errors.is_empty()
                && errors.iter().all(|error| error.error.retryable)
                && Instant::now() < deadline
            {
                wait_for_change(&mut events, &ids, deadline).await;
                continue;
            }
            return Ok(Json(WaitThreadsResponse {
                status: if matched {
                    "matched"
                } else if !errors.is_empty() {
                    "error"
                } else {
                    "timeout"
                }
                .into(),
                results,
                errors,
            }));
        }
        wait_for_change(&mut events, &ids, deadline).await;
    }
}

fn retry_snapshot_conflict(error: ApiError) -> ApiError {
    match error {
        ApiError::Conflict(message) => ApiError::Retryable(message),
        other => other,
    }
}

async fn wait_for_change(
    events: &mut tokio::sync::broadcast::Receiver<crate::store::EventEnvelope>,
    ids: &HashSet<String>,
    deadline: Instant,
) {
    // At most four rounds per second even during a burst of relevant lifecycle changes.
    let earliest = (Instant::now() + Duration::from_millis(250)).min(deadline);
    let fallback = (Instant::now() + Duration::from_millis(500)).min(deadline);
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(fallback) => return,
            event = events.recv() => match event {
                Ok(event) => {
                    let affected = event.thread_id.as_ref().is_some_and(|id| ids.contains(id))
                        || event.payload.get("changedThreadId").and_then(serde_json::Value::as_str).is_some_and(|id| ids.contains(id));
                    let lifecycle = matches!(event.codex_method.as_deref(), Some("turn/started"|"turn/completed"|"thread/status/changed"|"thread/reverted"|"thread/archived"|"thread/unarchived"))
                        || matches!(event.kind.as_str(), "thread_view.refresh_required"|"approval.changed");
                    if affected && lifecycle { tokio::time::sleep_until(earliest).await; return; }
                }
                Err(_) => { tokio::time::sleep_until(earliest).await; return; }
            }
        }
    }
}

fn target_error(thread_id: String, error: ApiError) -> WaitThreadError {
    let mut error = error.body();
    error.message = error.message.chars().take(2048).collect();
    WaitThreadError { thread_id, error }
}

async fn observe(state: &AppState, target: WaitTarget) -> ApiResult<Observation> {
    let previous = Cursor::decode(target.after_cursor.as_deref(), &target.thread_id)?;
    let revision = state.store.latest_event_seq().await?;
    let client = app_server_api::client(&state.app_server);
    let mut summary = client.thread_read_summary(target.thread_id.clone()).await?;
    let page = match client
        .thread_turns_list_page(
            target.thread_id.clone(),
            None,
            SortDirection::Desc,
            ThreadTurnItemsView::NotLoaded,
            Some(8),
        )
        .await
    {
        Ok(page) => Some(page),
        Err(error)
            if app_server_api::is_thread_not_materialized_before_first_user_message(
                &error,
                &target.thread_id,
            ) =>
        {
            None
        }
        Err(error) => return Err(error),
    };
    let turns = page.as_ref().map_or(&[][..], |page| page.data.as_slice());
    if turns.iter().any(|turn| {
        !matches!(
            turn.raw_payload
                .get("status")
                .and_then(serde_json::Value::as_str),
            Some("completed" | "failed" | "interrupted" | "inProgress")
        )
    }) {
        return Err(ApiError::BadGateway(
            "Native wait header has an invalid turn status".into(),
        ));
    }
    // If a turn finished between the metadata and header reads, refresh the
    // metadata once before treating that terminal as an older active baseline.
    if summary.status == ThreadStatus::Active
        && turns
            .first()
            .is_some_and(|turn| turn.status != "inProgress")
    {
        summary = client.thread_read_summary(target.thread_id.clone()).await?;
    }
    // Activity can precede persistence of the new head. Never deliver an older
    // completed answer as the result of work the native summary says is active.
    let head = turns
        .first()
        .filter(|turn| summary.status != ThreadStatus::Active || turn.status == "inProgress")
        .cloned();
    if let Some(witness) = state
        .thread_views
        .pending_completion(&target.thread_id)
        .await
    {
        if !turns.iter().any(|turn| {
            turn.id == witness
                && matches!(turn.status.as_str(), "completed" | "failed" | "interrupted")
        }) {
            return Err(ApiError::Retryable(
                "Native completion header has not caught up; refresh the wait".into(),
            ));
        }
    }
    let approval_ids = crate::approvals::attention_ids(state, &target.thread_id).await?;
    let mut attention: Vec<String> = summary
        .raw_payload
        .pointer("/status/activeFlags")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .filter(|flag| matches!(*flag, "waitingOnApproval" | "waitingOnUserInput"))
        .map(str::to_owned)
        .collect();
    if summary.status == ThreadStatus::SystemError {
        attention.push("systemError".into());
    }
    attention.extend(approval_ids);
    attention.sort();
    let terminal = head
        .as_ref()
        .filter(|head| head.status != "inProgress")
        .map(|head| (head.id.clone(), head.status.clone()));
    let reset_revision = state
        .thread_views
        .history_reset_revision(&target.thread_id)
        .await;
    let runtime = state.approvals.runtime_id().to_owned();
    let reset = previous.as_ref().is_some_and(|previous| {
        previous.runtime != runtime || previous.reset_revision != reset_revision
    });
    let repeat_terminal = terminal.is_some()
        && previous
            .as_ref()
            .is_some_and(|previous| previous.terminal == terminal);
    let condition = if !attention.is_empty() {
        "attention".into()
    } else if let Some(head) = &head {
        head.status.clone()
    } else if summary.status == ThreadStatus::Active {
        "inProgress".into()
    } else {
        "idle".into()
    };
    let changed = match condition.as_str() {
        "attention" => previous
            .as_ref()
            .is_none_or(|previous| previous.attention != attention),
        "completed" | "failed" | "interrupted" => !repeat_terminal,
        _ => false,
    };
    let cursor = Cursor {
        version: 1,
        thread_id: target.thread_id.clone(),
        runtime,
        reset_revision,
        terminal: terminal
            .or_else(|| {
                (summary.status == ThreadStatus::Active)
                    .then(|| {
                        turns
                            .iter()
                            .find(|turn| turn.status != "inProgress")
                            .map(|turn| (turn.id.clone(), turn.status.clone()))
                    })
                    .flatten()
            })
            .or_else(|| {
                previous
                    .as_ref()
                    .and_then(|previous| previous.terminal.clone())
            }),
        attention,
    };
    state
        .thread_views
        .ensure_history_current(&target.thread_id, revision)
        .await
        .map_err(retry_snapshot_conflict)?;
    Ok(Observation {
        target,
        cursor,
        condition,
        changed,
        reset,
        head,
        repeat_terminal,
        revision,
    })
}

async fn finish(state: &AppState, observation: Observation) -> ApiResult<WaitThreadResult> {
    let mut turns = Vec::new();
    if let Some(head) = &observation.head {
        if observation.repeat_terminal {
            let mut delivered = head.clone();
            delivered.items.clear();
            turns.push(delivered);
        } else {
            let page = app_server_api::client(&state.app_server)
                .thread_turns_list_page(
                    observation.target.thread_id.clone(),
                    None,
                    SortDirection::Desc,
                    ThreadTurnItemsView::Full,
                    Some(1),
                )
                .await?;
            let current = page.data.first();
            if current.is_none_or(|current| current.id != head.id || current.status != head.status)
            {
                return Err(ApiError::Retryable(
                    "Thread changed while collecting wait progress; refresh the wait".into(),
                ));
            }
            turns = page.data;
        }
    }
    state
        .thread_views
        .ensure_history_current(&observation.target.thread_id, observation.revision)
        .await
        .map_err(retry_snapshot_conflict)?;
    let progress = compact_turns(&turns, 8_000, false);
    Ok(WaitThreadResult {
        thread_id: observation.target.thread_id,
        cursor: observation.cursor.encode()?,
        condition: observation.condition,
        changed: observation.changed,
        reset: observation.reset,
        truncated: progress.iter().any(|turn| turn.truncated),
        progress,
    })
}
