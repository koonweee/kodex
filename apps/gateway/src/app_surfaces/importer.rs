use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
};

use serde_json::{json, Value};
use tokio::{
    sync::{mpsc, watch, Mutex, MutexGuard},
    task::JoinHandle,
};

use crate::{
    api::AppState,
    error::{ApiError, ApiResult},
    routes::app_surfaces::{broadcast_app_surface_event, APP_SURFACE_UPSERTED_EVENT},
    store::{AppSurfaceProvider, NewEvent},
};

use super::{candidate::McpAppSurfaceCandidate, prepare_mcp_app_surface};

const IMPORT_CAPACITY: usize = 32;

pub(crate) struct ImportJob {
    thread_id: String,
    token: Arc<()>,
    candidate: McpAppSurfaceCandidate,
}

#[derive(Default)]
struct ArtifactGate {
    tokens: HashMap<String, Arc<()>>,
    disconnected: bool,
}

/// A single runtime-local FIFO. Native reads never hold the artifact mutation
/// gate, and neither the queue nor its continuity tokens survive a restart.
#[derive(Clone)]
pub(crate) struct AppSurfaceImports {
    sender: mpsc::Sender<ImportJob>,
    receiver: Arc<StdMutex<Option<mpsc::Receiver<ImportJob>>>>,
    gate: Arc<Mutex<ArtifactGate>>,
    stop: watch::Sender<bool>,
}

impl Default for AppSurfaceImports {
    fn default() -> Self {
        Self::with_capacity(IMPORT_CAPACITY)
    }
}

impl AppSurfaceImports {
    pub(super) fn with_capacity(capacity: usize) -> Self {
        let (sender, receiver) = mpsc::channel(capacity);
        let (stop, _) = watch::channel(false);
        Self {
            sender,
            receiver: Arc::new(StdMutex::new(Some(receiver))),
            gate: Arc::default(),
            stop,
        }
    }

    pub(crate) async fn lock_mutation(&self, thread_id: &str) -> ArtifactMutation<'_> {
        ArtifactMutation {
            gate: self.gate.lock().await,
            thread_id: thread_id.to_string(),
        }
    }

    pub(crate) async fn disconnect(&self) {
        self.gate.lock().await.disconnected = true;
        self.stop.send_replace(true);
    }
}

pub(crate) struct ArtifactMutation<'a> {
    gate: MutexGuard<'a, ArtifactGate>,
    thread_id: String,
}

impl ArtifactMutation<'_> {
    /// Call only after the local mutation succeeds, while still holding this
    /// gate. A failed write must not retire work that could still be imported.
    pub(crate) fn committed(&mut self) {
        self.gate
            .tokens
            .insert(self.thread_id.clone(), Arc::new(()));
    }
}

pub struct AppSurfaceImportWorker {
    imports: AppSurfaceImports,
    task: JoinHandle<()>,
}

impl AppSurfaceImportWorker {
    pub async fn shutdown(mut self) {
        self.imports.disconnect().await;
        self.task.abort();
        if let Err(error) = (&mut self.task).await {
            if !error.is_cancelled() {
                tracing::warn!(%error, "widget importer stopped unexpectedly");
            }
        }
    }
}

impl Drop for AppSurfaceImportWorker {
    fn drop(&mut self) {
        self.imports.stop.send_replace(true);
        self.task.abort();
    }
}

pub fn start_import_worker(state: &AppState) -> ApiResult<AppSurfaceImportWorker> {
    let imports = state.app_surface_imports.clone();
    let mut receiver = imports
        .receiver
        .lock()
        .expect("widget receiver lock poisoned")
        .take()
        .ok_or_else(|| ApiError::Conflict("widget importer is already started".into()))?;
    let mut stop = imports.stop.subscribe();
    let state = state.clone();
    let task = tokio::spawn(async move {
        loop {
            if *stop.borrow() {
                break;
            }
            let job = tokio::select! {
                biased;
                _ = stop.changed() => break,
                job = receiver.recv() => match job { Some(job) => job, None => break },
            };
            tokio::select! {
                biased;
                _ = stop.changed() => break,
                result = import_job(&state, &job) => {
                    if let Err(error) = result {
                        tracing::warn!(%error, thread_id = job.thread_id, "failed to import native widget");
                        if is_current(&state, &job).await {
                            report_failure(&state, &job.thread_id, &job.candidate, "Interactive app could not be loaded; the tool result remains available.").await;
                        }
                    }
                },
            }
        }
    });
    Ok(AppSurfaceImportWorker { imports, task })
}

pub(crate) async fn capture_mcp_app_surface_import(
    state: &AppState,
    thread_id: &str,
    turn_id: &str,
    item: &Value,
) -> Option<ImportJob> {
    let candidate = McpAppSurfaceCandidate::from_item(turn_id, item)?;
    let mut gate = state.app_surface_imports.gate.lock().await;
    let token = gate
        .tokens
        .entry(thread_id.to_string())
        .or_default()
        .clone();
    Some(ImportJob {
        thread_id: thread_id.to_string(),
        token,
        candidate,
    })
}

pub(crate) async fn enqueue_mcp_app_surface_import(state: &AppState, job: ImportJob) {
    let gate = state.app_surface_imports.gate.lock().await;
    if gate.disconnected {
        drop(gate);
        report_failure(state, &job.thread_id, &job.candidate, "Interactive app was not loaded because its native runtime disconnected; the tool result remains available.").await;
        return;
    }
    if !current(&gate, &job) {
        return;
    }
    let result = state.app_surface_imports.sender.try_send(job);
    drop(gate);
    if let Err(error) = result {
        let job = error.into_inner();
        report_failure(state, &job.thread_id, &job.candidate, "Interactive app was not loaded because the widget importer is unavailable or full; the tool result remains available.").await;
    }
}

fn current(gate: &ArtifactGate, job: &ImportJob) -> bool {
    !gate.disconnected
        && gate
            .tokens
            .get(&job.thread_id)
            .is_some_and(|token| Arc::ptr_eq(token, &job.token))
}

async fn is_current(state: &AppState, job: &ImportJob) -> bool {
    current(&*state.app_surface_imports.gate.lock().await, job)
}

async fn import_job(state: &AppState, job: &ImportJob) -> ApiResult<()> {
    if !is_current(state, job).await {
        return Ok(());
    }
    if state
        .store
        .latest_app_surface_session(&job.thread_id)
        .await?
        .is_some_and(|latest| {
            latest.provider == AppSurfaceProvider::Mcp
                && latest.provenance.pointer("/mcp/signature") == Some(&job.candidate.signature)
        })
    {
        return Ok(());
    }
    let Some(surface) =
        prepare_mcp_app_surface(state, &job.thread_id, job.candidate.clone()).await?
    else {
        return Ok(());
    };
    let gate = state.app_surface_imports.gate.lock().await;
    if !current(&gate, job) {
        return Ok(());
    }
    let session = state.store.upsert_app_surface_session(surface).await?;
    if let Err(error) =
        broadcast_app_surface_event(state, APP_SURFACE_UPSERTED_EVENT, &session).await
    {
        tracing::warn!(%error, thread_id = job.thread_id, "widget was saved but its update could not be published");
        report_failure(state, &job.thread_id, &job.candidate, "Interactive app was saved, but its update notification failed; reopen the app surface to refresh it.").await;
    }
    Ok(())
}

async fn report_failure(
    state: &AppState,
    thread_id: &str,
    candidate: &McpAppSurfaceCandidate,
    message: &str,
) {
    let result = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: Some(thread_id.to_string()),
            turn_id: Some(candidate.turn_id.clone()),
            item_id: Some(candidate.item_id.clone()),
            kind: "gateway.warning".into(),
            codex_method: None,
            payload: json!({"message":message,"source":"app_surface_import"}),
        })
        .await;
    match result {
        Ok(event) => {
            let _ = state.events.send(event);
        }
        Err(error) => tracing::warn!(%error, thread_id, "failed to publish widget import warning"),
    }
}
