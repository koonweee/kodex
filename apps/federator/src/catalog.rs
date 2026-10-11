use std::{collections::HashSet, convert::Infallible, time::Duration};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::{future::BoxFuture, FutureExt, StreamExt};
use kodex_gateway::{
    app_server_api::ThreadListResponse,
    routes::threads::{SidebarThreadSummary, SidebarThreadsResponse},
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

use crate::{
    registry::{self, ExecutorRecord, ExecutorStatus, SUPPORTED_EXECUTOR_API_VERSION},
    CatalogChange, State as FederatorState,
};

const EXPECTED_INSTANCE_HEADER: &str = "x-kodex-expected-instance";
const API_VERSION_HEADER: &str = "x-kodex-api-version";
const CATALOG_REVISION_KEY: &str = "catalog_revision";
const ORDER_REVISION_KEY: &str = "catalog_order_revision";
const REFRESH_CONCURRENCY: usize = 4;
#[cfg(not(test))]
const REFRESH_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(test)]
const REFRESH_TIMEOUT: Duration = Duration::from_millis(150);
const REFRESH_FAILED: &str = "Executor catalog refresh failed.";
const PINNED_PAGE_LIMIT: u32 = 100;
const MAX_PINNED_PAGES: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QualifiedCatalogRef {
    pub executor_id: String,
    pub native_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogExecutorSnapshot {
    pub executor_id: String,
    pub executor_name: String,
    pub generation: i64,
    pub observed_at: i64,
    pub stale: bool,
    pub snapshot: SidebarThreadsResponse,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResponse {
    pub revision: i64,
    pub order_revision: i64,
    pub project_order: Vec<QualifiedCatalogRef>,
    pub pinned_order: Vec<QualifiedCatalogRef>,
    pub executors: Vec<CatalogExecutorSnapshot>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MoveCatalogItemRequest {
    pub item: QualifiedCatalogRef,
    pub before: Option<QualifiedCatalogRef>,
    pub order_revision: i64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogOrderResponse {
    pub order_revision: i64,
    pub items: Vec<QualifiedCatalogRef>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEvent {
    pub revision: i64,
    pub order_revision: i64,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct CatalogErrorBody {
    code: &'static str,
    message: String,
}

#[derive(Debug, Clone)]
pub(crate) struct CatalogError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl CatalogError {
    fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "federated catalog operation failed");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "catalog_internal_error",
            message: "Federated catalog operation failed.".to_string(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "catalog_order_conflict",
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_catalog_order",
            message: message.into(),
        }
    }
}

impl IntoResponse for CatalogError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(CatalogErrorBody {
                code: self.code,
                message: self.message,
            }),
        )
            .into_response()
    }
}

#[derive(Clone)]
pub(crate) struct CatalogWriter {
    commands: tokio::sync::mpsc::Sender<CatalogCommand>,
}

enum CatalogCommand {
    Refresh {
        reply: tokio::sync::oneshot::Sender<Result<(), CatalogError>>,
    },
    Move {
        kind: String,
        request: MoveCatalogItemRequest,
        reply: tokio::sync::oneshot::Sender<Result<CatalogOrderResponse, CatalogError>>,
    },
}

struct PendingRefresh {
    error: Option<CatalogError>,
    remaining: usize,
    replies: Vec<tokio::sync::oneshot::Sender<Result<(), CatalogError>>>,
    successful: HashSet<(String, i64)>,
    trailing_replies: Vec<tokio::sync::oneshot::Sender<Result<(), CatalogError>>>,
}

struct RefreshOutcome {
    executor: ExecutorRecord,
    result: anyhow::Result<SidebarThreadsResponse>,
}

impl CatalogWriter {
    pub(crate) fn start(
        store: crate::store::Store,
        changes: tokio::sync::broadcast::Sender<CatalogChange>,
    ) -> Self {
        let (commands, mut receiver) = tokio::sync::mpsc::channel(16);
        tokio::spawn(async move {
            let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(REFRESH_CONCURRENCY));
            let mut fetches: futures_util::stream::FuturesUnordered<
                BoxFuture<'static, RefreshOutcome>,
            > = futures_util::stream::FuturesUnordered::new();
            let mut refresh: Option<PendingRefresh> = None;
            loop {
                tokio::select! {
                    command = receiver.recv() => match command {
                        Some(CatalogCommand::Refresh { reply }) => {
                            if let Some(refresh) = refresh.as_mut() {
                                refresh.trailing_replies.push(reply);
                                continue;
                            }
                            refresh = begin_refresh(&store, &permits, &mut fetches, vec![reply]).await;
                        }
                        Some(CatalogCommand::Move { kind, request, reply }) => {
                            let result = write_move(&store, &changes, &kind, request).await;
                            let _ = reply.send(result);
                        }
                        None => break,
                    },
                    Some(outcome) = fetches.next(), if !fetches.is_empty() => {
                        let result = apply_refresh_outcome(&store, &changes, outcome).await;
                        let Some(active) = refresh.as_mut() else { continue; };
                        match result {
                            Ok(Some(success)) => { active.successful.insert(success); }
                            Ok(None) => {}
                            Err(error) => { active.error.get_or_insert(error); }
                        }
                        active.remaining -= 1;
                        if active.remaining == 0 {
                            let mut complete = refresh.take().expect("completed refresh exists");
                            match reconcile_catalog_order(&store, &complete.successful).await {
                                Ok(Some(change)) => { let _ = changes.send(change); }
                                Ok(None) => {}
                                Err(error) => { complete.error.get_or_insert(error); }
                            }
                            let result = complete.error.map_or(Ok(()), Err);
                            for reply in complete.replies {
                                let _ = reply.send(result.clone());
                            }
                            if !complete.trailing_replies.is_empty() {
                                refresh = begin_refresh(
                                    &store,
                                    &permits,
                                    &mut fetches,
                                    complete.trailing_replies,
                                ).await;
                            }
                        }
                    }
                }
            }
        });
        Self { commands }
    }

    async fn refresh(&self) -> Result<(), CatalogError> {
        let (reply, response) = tokio::sync::oneshot::channel();
        self.commands
            .send(CatalogCommand::Refresh { reply })
            .await
            .map_err(|_| CatalogError::internal("catalog writer stopped"))?;
        response
            .await
            .map_err(|_| CatalogError::internal("catalog writer stopped"))?
    }

    async fn move_item(
        &self,
        kind: String,
        request: MoveCatalogItemRequest,
    ) -> Result<CatalogOrderResponse, CatalogError> {
        let (reply, response) = tokio::sync::oneshot::channel();
        self.commands
            .send(CatalogCommand::Move {
                kind,
                request,
                reply,
            })
            .await
            .map_err(|_| CatalogError::internal("catalog writer stopped"))?;
        response
            .await
            .map_err(|_| CatalogError::internal("catalog writer stopped"))?
    }
}

async fn begin_refresh(
    store: &crate::store::Store,
    permits: &std::sync::Arc<tokio::sync::Semaphore>,
    fetches: &mut futures_util::stream::FuturesUnordered<BoxFuture<'static, RefreshOutcome>>,
    replies: Vec<tokio::sync::oneshot::Sender<Result<(), CatalogError>>>,
) -> Option<PendingRefresh> {
    let executors = match store.list_executors().await {
        Ok(executors) => executors
            .into_iter()
            .filter(|executor| executor.enabled && executor.status != ExecutorStatus::Incompatible)
            .collect::<Vec<_>>(),
        Err(error) => {
            let error = CatalogError::internal(error);
            for reply in replies {
                let _ = reply.send(Err(error.clone()));
            }
            return None;
        }
    };
    if executors.is_empty() {
        for reply in replies {
            let _ = reply.send(Ok(()));
        }
        return None;
    }
    let refresh = PendingRefresh {
        error: None,
        remaining: executors.len(),
        replies,
        successful: HashSet::new(),
        trailing_replies: Vec::new(),
    };
    for executor in executors {
        let permits = permits.clone();
        fetches.push(
            async move {
                let result = match permits.acquire_owned().await {
                    Ok(permit) => {
                        let result =
                            tokio::time::timeout(REFRESH_TIMEOUT, fetch_snapshot(&executor))
                                .await
                                .map_err(|_| anyhow::anyhow!("executor catalog refresh timed out"))
                                .and_then(|result| result);
                        drop(permit);
                        result
                    }
                    Err(_) => Err(anyhow::anyhow!("catalog refresh stopped")),
                };
                RefreshOutcome { executor, result }
            }
            .boxed(),
        );
    }
    Some(refresh)
}

pub fn router() -> Router<FederatorState> {
    Router::new()
        .route(
            "/v1/federation/catalog",
            get(get_catalog).post(refresh_catalog),
        )
        .route("/v1/federation/catalog/events", get(catalog_events))
        .route(
            "/v1/federation/catalog/order/{kind}/move",
            post(move_catalog_item),
        )
}

#[utoipa::path(get, path = "/v1/federation/catalog", responses((status = 200, body = CatalogResponse)))]
pub(crate) async fn get_catalog(
    State(state): State<FederatorState>,
) -> Result<Json<CatalogResponse>, CatalogError> {
    Ok(Json(read_catalog(&state).await?))
}

#[utoipa::path(post, path = "/v1/federation/catalog", responses((status = 200, body = CatalogResponse)))]
pub(crate) async fn refresh_catalog(
    State(state): State<FederatorState>,
) -> Result<Json<CatalogResponse>, CatalogError> {
    state.catalog_writer.refresh().await?;
    Ok(Json(read_catalog(&state).await?))
}

#[utoipa::path(
    post,
    path = "/v1/federation/catalog/order/{kind}/move",
    params(("kind" = String, Path)),
    request_body = MoveCatalogItemRequest,
    responses(
        (status = 200, body = CatalogOrderResponse),
        (status = 400, body = CatalogErrorBody),
        (status = 409, body = CatalogErrorBody)
    )
)]
pub(crate) async fn move_catalog_item(
    State(state): State<FederatorState>,
    Path(kind): Path<String>,
    Json(request): Json<MoveCatalogItemRequest>,
) -> Result<Json<CatalogOrderResponse>, CatalogError> {
    if !matches!(kind.as_str(), "project" | "pinned") {
        return Err(CatalogError::bad_request(
            "Order kind must be project or pinned.",
        ));
    }
    Ok(Json(state.catalog_writer.move_item(kind, request).await?))
}

#[utoipa::path(
    get,
    path = "/v1/federation/catalog/events",
    params(("Last-Event-ID" = Option<i64>, Header, description = "Last applied catalog revision")),
    responses((status = 200, body = CatalogEvent, content_type = "text/event-stream"))
)]
pub(crate) async fn catalog_events(
    State(state): State<FederatorState>,
    headers: HeaderMap,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>, CatalogError> {
    let mut changes = state.catalog_changes.subscribe();
    let current = catalog_revisions(&state).await?;
    let requested = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok());
    let stream = async_stream::stream! {
        let mut delivered = requested.unwrap_or(-1);
        if requested != Some(current.revision) {
            yield Ok(catalog_event(current.clone()));
            delivered = current.revision;
        }
        loop {
            match changes.recv().await {
                Ok(change) if change.revision > delivered => {
                    delivered = change.revision;
                    yield Ok(catalog_event(CatalogEvent { revision: change.revision, order_revision: change.order_revision }));
                }
                Ok(_) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let Ok(current) = catalog_revisions(&state).await else { break; };
                    if current.revision > delivered {
                        delivered = current.revision;
                        yield Ok(catalog_event(current));
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn catalog_event(event: CatalogEvent) -> Event {
    Event::default()
        .event("federation.catalog_changed")
        .id(event.revision.to_string())
        .json_data(event)
        .expect("catalog event serializes")
}

async fn apply_refresh_outcome(
    store: &crate::store::Store,
    changes: &tokio::sync::broadcast::Sender<CatalogChange>,
    outcome: RefreshOutcome,
) -> Result<Option<(String, i64)>, CatalogError> {
    let executor = outcome.executor;
    let (change, successful) = match outcome.result {
        Ok(snapshot) => {
            let change = write_snapshot(store, &executor.id, executor.generation, snapshot).await?;
            let successful = change
                .as_ref()
                .map(|_| (executor.id.clone(), executor.generation));
            (change, successful)
        }
        Err(error) => {
            tracing::warn!(executor_id = %executor.id, %error, "executor catalog refresh failed");
            (
                write_refresh_failure(store, &executor.id, executor.generation).await?,
                None,
            )
        }
    };
    if let Some(change) = change {
        let _ = changes.send(change);
    }
    Ok(successful)
}

async fn fetch_snapshot(executor: &ExecutorRecord) -> anyhow::Result<SidebarThreadsResponse> {
    let endpoint = registry::validate_executor_proxy_endpoint(&executor.base_url)
        .await
        .map_err(|error| anyhow::anyhow!(error.message().to_string()))?;
    let mut url = url::Url::parse(&endpoint.base_url)?;
    url.set_path("/v1/sidebar/threads");
    let mut snapshot: SidebarThreadsResponse = fetch_json(&endpoint, executor, url).await?;
    let mut cursor = snapshot.pinned_threads.next_cursor.take();
    let mut seen_cursors = HashSet::new();
    for _ in 0..MAX_PINNED_PAGES {
        let Some(next_cursor) = cursor.take() else {
            break;
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            anyhow::bail!("executor repeated a pinned-thread page cursor");
        }
        let mut page_url = url::Url::parse(&endpoint.base_url)?;
        page_url.set_path("/v1/pinned-threads");
        page_url
            .query_pairs_mut()
            .append_pair("cursor", &next_cursor)
            .append_pair("limit", &PINNED_PAGE_LIMIT.to_string());
        let page: ThreadListResponse = fetch_json(&endpoint, executor, page_url).await?;
        snapshot
            .pinned_threads
            .threads
            .extend(page.threads.into_iter().map(SidebarThreadSummary::from));
        cursor = page.next_cursor;
    }
    snapshot.pinned_threads.next_cursor = cursor;
    let mut seen_ids = HashSet::new();
    snapshot
        .pinned_threads
        .threads
        .retain(|thread| seen_ids.insert(thread.id.clone()));
    Ok(snapshot)
}

async fn fetch_json<T: serde::de::DeserializeOwned>(
    endpoint: &registry::ValidatedEndpoint,
    executor: &ExecutorRecord,
    url: url::Url,
) -> anyhow::Result<T> {
    let response = endpoint
        .client
        .get(url)
        .header(EXPECTED_INSTANCE_HEADER, &executor.instance_id)
        .header(API_VERSION_HEADER, SUPPORTED_EXECUTOR_API_VERSION)
        .send()
        .await?;
    if response
        .headers()
        .get(API_VERSION_HEADER)
        .is_none_or(|version| version != SUPPORTED_EXECUTOR_API_VERSION)
    {
        anyhow::bail!("executor response did not confirm API version");
    }
    if response.status().is_redirection() {
        anyhow::bail!("executor redirects are not permitted");
    }
    Ok(response.error_for_status()?.json::<T>().await?)
}

async fn read_catalog(state: &FederatorState) -> Result<CatalogResponse, CatalogError> {
    let mut transaction = state
        .store
        .pool
        .begin()
        .await
        .map_err(CatalogError::internal)?;
    let revision = meta_revision(&mut transaction, CATALOG_REVISION_KEY).await?;
    let order_revision = meta_revision(&mut transaction, ORDER_REVISION_KEY).await?;
    let rows = sqlx::query(
        "SELECT c.executor_id, e.display_name, c.generation, c.observed_at, c.snapshot_json, c.refresh_error, e.enabled, e.generation AS executor_generation, e.status FROM catalog_snapshots c JOIN executors e ON e.id = c.executor_id ORDER BY e.created_at, e.id",
    )
    .fetch_all(&mut *transaction)
    .await
    .map_err(CatalogError::internal)?;
    let mut executors = Vec::with_capacity(rows.len());
    for row in rows {
        let status: String = row.try_get("status").map_err(CatalogError::internal)?;
        let enabled: bool = row.try_get("enabled").map_err(CatalogError::internal)?;
        let generation = row.try_get("generation").map_err(CatalogError::internal)?;
        let executor_generation: i64 = row
            .try_get("executor_generation")
            .map_err(CatalogError::internal)?;
        let refresh_error: Option<String> = row
            .try_get("refresh_error")
            .map_err(CatalogError::internal)?;
        executors.push(CatalogExecutorSnapshot {
            executor_id: row.try_get("executor_id").map_err(CatalogError::internal)?,
            executor_name: row
                .try_get("display_name")
                .map_err(CatalogError::internal)?,
            generation,
            observed_at: row.try_get("observed_at").map_err(CatalogError::internal)?,
            stale: !enabled
                || status != "ready"
                || generation != executor_generation
                || refresh_error.is_some(),
            snapshot: serde_json::from_str(
                &row.try_get::<String, _>("snapshot_json")
                    .map_err(CatalogError::internal)?,
            )
            .map_err(CatalogError::internal)?,
        });
    }
    let project_order = order_items(&mut transaction, "project").await?;
    let pinned_order = order_items(&mut transaction, "pinned").await?;
    transaction.commit().await.map_err(CatalogError::internal)?;
    Ok(CatalogResponse {
        revision,
        order_revision,
        project_order,
        pinned_order,
        executors,
    })
}

async fn write_snapshot(
    store: &crate::store::Store,
    executor_id: &str,
    generation: i64,
    snapshot: SidebarThreadsResponse,
) -> Result<Option<CatalogChange>, CatalogError> {
    let snapshot_json = serde_json::to_string(&snapshot).map_err(CatalogError::internal)?;
    let mut transaction = store
        .pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(CatalogError::internal)?;
    if current_generation(&mut transaction, executor_id).await? != Some(generation) {
        transaction
            .rollback()
            .await
            .map_err(CatalogError::internal)?;
        return Ok(None);
    }
    sqlx::query(
        "INSERT INTO catalog_snapshots (executor_id, generation, snapshot_json, observed_at, refresh_error) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(executor_id) DO UPDATE SET generation = excluded.generation, snapshot_json = excluded.snapshot_json, observed_at = excluded.observed_at, refresh_error = NULL",
    )
    .bind(executor_id)
    .bind(generation)
    .bind(snapshot_json)
    .bind(unix_seconds())
    .execute(&mut *transaction)
    .await
    .map_err(CatalogError::internal)?;
    let order_revision = meta_revision(&mut transaction, ORDER_REVISION_KEY).await?;
    let revision = advance_meta_revision(&mut transaction, CATALOG_REVISION_KEY).await?;
    transaction.commit().await.map_err(CatalogError::internal)?;
    Ok(Some(CatalogChange {
        revision,
        order_revision,
    }))
}

async fn write_refresh_failure(
    store: &crate::store::Store,
    executor_id: &str,
    generation: i64,
) -> Result<Option<CatalogChange>, CatalogError> {
    let mut transaction = store
        .pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(CatalogError::internal)?;
    if current_generation(&mut transaction, executor_id).await? != Some(generation) {
        transaction
            .rollback()
            .await
            .map_err(CatalogError::internal)?;
        return Ok(None);
    }
    let changed = sqlx::query(
        "UPDATE catalog_snapshots SET refresh_error = ? WHERE executor_id = ? AND refresh_error IS NULL",
    )
    .bind(REFRESH_FAILED)
    .bind(executor_id)
    .execute(&mut *transaction)
    .await
    .map_err(CatalogError::internal)?
    .rows_affected()
        > 0;
    if !changed {
        transaction.commit().await.map_err(CatalogError::internal)?;
        return Ok(None);
    }
    let order_revision = meta_revision(&mut transaction, ORDER_REVISION_KEY).await?;
    let revision = advance_meta_revision(&mut transaction, CATALOG_REVISION_KEY).await?;
    transaction.commit().await.map_err(CatalogError::internal)?;
    Ok(Some(CatalogChange {
        revision,
        order_revision,
    }))
}

async fn reconcile_catalog_order(
    store: &crate::store::Store,
    successful: &HashSet<(String, i64)>,
) -> Result<Option<CatalogChange>, CatalogError> {
    if successful.is_empty() {
        return Ok(None);
    }
    let mut transaction = store
        .pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(CatalogError::internal)?;
    let rows = sqlx::query(
        "SELECT c.executor_id, c.generation, c.snapshot_json, e.generation AS executor_generation FROM catalog_snapshots c JOIN executors e ON e.id = c.executor_id ORDER BY e.created_at, e.id",
    )
    .fetch_all(&mut *transaction)
    .await
    .map_err(CatalogError::internal)?;
    let mut order_changed = false;
    for row in rows {
        let executor_id: String = row.try_get("executor_id").map_err(CatalogError::internal)?;
        let generation: i64 = row.try_get("generation").map_err(CatalogError::internal)?;
        let executor_generation: i64 = row
            .try_get("executor_generation")
            .map_err(CatalogError::internal)?;
        if generation != executor_generation
            || !successful.contains(&(executor_id.clone(), generation))
        {
            continue;
        }
        let snapshot: SidebarThreadsResponse = serde_json::from_str(
            &row.try_get::<String, _>("snapshot_json")
                .map_err(CatalogError::internal)?,
        )
        .map_err(CatalogError::internal)?;
        order_changed |= reconcile_membership(
            &mut transaction,
            "project",
            &executor_id,
            snapshot
                .projects
                .iter()
                .map(|project| project.id.as_str())
                .collect(),
            true,
        )
        .await?;
        order_changed |= reconcile_membership(
            &mut transaction,
            "pinned",
            &executor_id,
            snapshot
                .pinned_threads
                .threads
                .iter()
                .map(|thread| thread.id.as_str())
                .collect(),
            snapshot.pinned_threads.next_cursor.is_none(),
        )
        .await?;
    }
    if !order_changed {
        transaction.commit().await.map_err(CatalogError::internal)?;
        return Ok(None);
    }
    let order_revision = advance_meta_revision(&mut transaction, ORDER_REVISION_KEY).await?;
    let revision = advance_meta_revision(&mut transaction, CATALOG_REVISION_KEY).await?;
    transaction.commit().await.map_err(CatalogError::internal)?;
    Ok(Some(CatalogChange {
        revision,
        order_revision,
    }))
}

async fn current_generation(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    executor_id: &str,
) -> Result<Option<i64>, CatalogError> {
    sqlx::query_scalar("SELECT generation FROM executors WHERE id = ?")
        .bind(executor_id)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(CatalogError::internal)
}

async fn write_move(
    store: &crate::store::Store,
    changes: &tokio::sync::broadcast::Sender<CatalogChange>,
    kind: &str,
    request: MoveCatalogItemRequest,
) -> Result<CatalogOrderResponse, CatalogError> {
    let mut transaction = store
        .pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(CatalogError::internal)?;
    let current_revision = meta_revision(&mut transaction, ORDER_REVISION_KEY).await?;
    if current_revision != request.order_revision {
        return Err(CatalogError::conflict(format!(
            "Catalog order changed from revision {} to {current_revision}.",
            request.order_revision
        )));
    }
    let mut items = order_items(&mut transaction, kind).await?;
    let Some(index) = items.iter().position(|item| item == &request.item) else {
        return Err(CatalogError::bad_request(
            "Moved item is not in the authoritative catalog order.",
        ));
    };
    let item = items.remove(index);
    let insertion = match request.before {
        Some(before) => items
            .iter()
            .position(|candidate| candidate == &before)
            .ok_or_else(|| {
                CatalogError::bad_request("Order anchor is not in the authoritative catalog order.")
            })?,
        None => items.len(),
    };
    items.insert(insertion, item);
    for (position, item) in items.iter().enumerate() {
        sqlx::query("UPDATE catalog_order SET position = ? WHERE kind = ? AND executor_id = ? AND native_id = ?")
            .bind(-(position as i64) - 1)
            .bind(kind)
            .bind(&item.executor_id)
            .bind(&item.native_id)
            .execute(&mut *transaction)
            .await
            .map_err(CatalogError::internal)?;
    }
    for (position, item) in items.iter().enumerate() {
        sqlx::query("UPDATE catalog_order SET position = ? WHERE kind = ? AND executor_id = ? AND native_id = ?")
            .bind(position as i64)
            .bind(kind)
            .bind(&item.executor_id)
            .bind(&item.native_id)
            .execute(&mut *transaction)
            .await
            .map_err(CatalogError::internal)?;
    }
    let order_revision = advance_meta_revision(&mut transaction, ORDER_REVISION_KEY).await?;
    let revision = advance_meta_revision(&mut transaction, CATALOG_REVISION_KEY).await?;
    transaction.commit().await.map_err(CatalogError::internal)?;
    let _ = changes.send(CatalogChange {
        revision,
        order_revision,
    });
    Ok(CatalogOrderResponse {
        order_revision,
        items,
    })
}

async fn reconcile_membership(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    kind: &str,
    executor_id: &str,
    incoming: HashSet<&str>,
    complete: bool,
) -> Result<bool, CatalogError> {
    let rows =
        sqlx::query("SELECT native_id FROM catalog_order WHERE kind = ? AND executor_id = ?")
            .bind(kind)
            .bind(executor_id)
            .fetch_all(&mut **transaction)
            .await
            .map_err(CatalogError::internal)?;
    let existing = rows
        .into_iter()
        .map(|row| row.try_get::<String, _>("native_id"))
        .collect::<Result<HashSet<_>, _>>()
        .map_err(CatalogError::internal)?;
    let mut changed = false;
    if complete {
        for removed in existing.iter().filter(|id| !incoming.contains(id.as_str())) {
            sqlx::query(
                "DELETE FROM catalog_order WHERE kind = ? AND executor_id = ? AND native_id = ?",
            )
            .bind(kind)
            .bind(executor_id)
            .bind(removed)
            .execute(&mut **transaction)
            .await
            .map_err(CatalogError::internal)?;
            changed = true;
        }
    }
    let mut position: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM catalog_order WHERE kind = ?",
    )
    .bind(kind)
    .fetch_one(&mut **transaction)
    .await
    .map_err(CatalogError::internal)?;
    let mut additions = incoming
        .into_iter()
        .filter(|id| !existing.contains(*id))
        .collect::<Vec<_>>();
    additions.sort_unstable();
    for native_id in additions {
        sqlx::query("INSERT INTO catalog_order (kind, executor_id, native_id, position) VALUES (?, ?, ?, ?)")
            .bind(kind)
            .bind(executor_id)
            .bind(native_id)
            .bind(position)
            .execute(&mut **transaction)
            .await
            .map_err(CatalogError::internal)?;
        position += 1;
        changed = true;
    }
    Ok(changed)
}

async fn order_items(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    kind: &str,
) -> Result<Vec<QualifiedCatalogRef>, CatalogError> {
    let rows = sqlx::query(
        "SELECT executor_id, native_id FROM catalog_order WHERE kind = ? ORDER BY position, executor_id, native_id",
    )
    .bind(kind)
    .fetch_all(&mut **transaction)
    .await
    .map_err(CatalogError::internal)?;
    rows.into_iter()
        .map(|row| {
            Ok(QualifiedCatalogRef {
                executor_id: row.try_get("executor_id").map_err(CatalogError::internal)?,
                native_id: row.try_get("native_id").map_err(CatalogError::internal)?,
            })
        })
        .collect()
}

async fn catalog_revisions(state: &FederatorState) -> Result<CatalogEvent, CatalogError> {
    let mut transaction = state
        .store
        .pool
        .begin()
        .await
        .map_err(CatalogError::internal)?;
    let revision = meta_revision(&mut transaction, CATALOG_REVISION_KEY).await?;
    let order_revision = meta_revision(&mut transaction, ORDER_REVISION_KEY).await?;
    transaction.commit().await.map_err(CatalogError::internal)?;
    Ok(CatalogEvent {
        revision,
        order_revision,
    })
}

async fn meta_revision(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    key: &str,
) -> Result<i64, CatalogError> {
    sqlx::query_scalar("SELECT CAST(value AS INTEGER) FROM federation_meta WHERE key = ?")
        .bind(key)
        .fetch_one(&mut **transaction)
        .await
        .map_err(CatalogError::internal)
}

async fn advance_meta_revision(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    key: &str,
) -> Result<i64, CatalogError> {
    sqlx::query_scalar(
        "UPDATE federation_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = ? RETURNING CAST(value AS INTEGER)",
    )
    .bind(key)
    .fetch_one(&mut **transaction)
    .await
    .map_err(CatalogError::internal)
}

fn unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use axum::{routing::get, Json, Router};
    use serde_json::json;

    use super::*;

    fn executor(base_url: String) -> ExecutorRecord {
        ExecutorRecord {
            id: "executor-1".to_string(),
            generation: 1,
            display_name: "Executor".to_string(),
            base_url,
            instance_id: "instance-1".to_string(),
            api_version: SUPPORTED_EXECUTOR_API_VERSION.to_string(),
            app_server_schema_version: "0.160.0".to_string(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn snapshot(project: &str, pins: &[&str], next_cursor: Option<&str>) -> SidebarThreadsResponse {
        serde_json::from_value(json!({
            "projects": [{
                "id": project,
                "name": project,
                "roots": [{"path": format!("/{project}")}],
                "metadata": {},
                "position": 0,
                "createdAt": 1,
                "updatedAt": 1,
                "recencyAt": null
            }],
            "projectThreads": {},
            "chatThreads": {"threads": [], "nextCursor": null, "backwardsCursor": null},
            "pinnedThreads": {
                "threads": pins.iter().map(|id| json!({
                    "id": id,
                    "parentThreadId": null,
                    "canAcceptDirectInput": true,
                    "name": id,
                    "projectId": null,
                    "cwd": "/tmp",
                    "status": "idle",
                    "createdAt": 1,
                    "updatedAt": 1,
                    "source": null,
                    "preview": id,
                    "model": null,
                    "reasoningEffort": null,
                    "serviceTier": null,
                    "approvalPolicy": null,
                    "approvalsReviewer": null,
                    "agentNickname": null,
                    "agentRole": null,
                    "sandbox": null,
                    "gitInfo": null,
                    "readRevision": 0,
                    "readStateKnown": true,
                    "latestCompletedTurnId": null,
                    "seenCompletedTurnId": null,
                    "unreadCompletedAgentTurn": false,
                    "notificationsEnabled": true,
                    "pinned": true
                })).collect::<Vec<_>>(),
                "nextCursor": next_cursor,
                "backwardsCursor": null
            }
        }))
        .unwrap()
    }

    fn full_thread(id: &str) -> serde_json::Value {
        json!({
            "id": id,
            "parentThreadId": null,
            "canAcceptDirectInput": true,
            "projectId": null,
            "name": id,
            "cwd": "/tmp",
            "status": "idle",
            "createdAt": 1,
            "updatedAt": 1,
            "source": null,
            "model": null,
            "reasoningEffort": null,
            "serviceTier": null,
            "approvalPolicy": null,
            "approvalsReviewer": null,
            "activePermissionProfile": null,
            "agentNickname": null,
            "agentRole": null,
            "sandbox": null,
            "gitInfo": null,
            "pinned": true,
            "preview": id,
            "latestCompletedTurnId": null,
            "seenCompletedTurnId": null,
            "readRevision": 0,
            "readStateKnown": true,
            "unreadCompletedAgentTurn": false,
            "notificationsEnabled": true,
            "rawPayload": {}
        })
    }

    async fn write_and_reconcile_snapshot(
        store: &crate::store::Store,
        executor_id: &str,
        generation: i64,
        snapshot: SidebarThreadsResponse,
    ) {
        assert!(write_snapshot(store, executor_id, generation, snapshot)
            .await
            .unwrap()
            .is_some());
        reconcile_catalog_order(
            store,
            &HashSet::from([(executor_id.to_string(), generation)]),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn partial_pinned_pages_preserve_unseen_members_and_each_observation_advances_revision() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::connect(&dir.path().join("federator.db"))
            .await
            .unwrap();
        store
            .insert_executor(&executor("http://127.0.0.1:9".to_string()))
            .await
            .unwrap();
        write_and_reconcile_snapshot(
            &store,
            "executor-1",
            1,
            snapshot("project", &["pin-a", "pin-b"], None),
        )
        .await;
        let first_revision: i64 =
            sqlx::query_scalar("SELECT CAST(value AS INTEGER) FROM federation_meta WHERE key = ?")
                .bind(CATALOG_REVISION_KEY)
                .fetch_one(&store.pool)
                .await
                .unwrap();

        write_and_reconcile_snapshot(
            &store,
            "executor-1",
            1,
            snapshot("project", &["pin-a"], Some("more")),
        )
        .await;
        let pins: Vec<String> = sqlx::query_scalar(
            "SELECT native_id FROM catalog_order WHERE kind = 'pinned' ORDER BY position",
        )
        .fetch_all(&store.pool)
        .await
        .unwrap();
        assert_eq!(pins, ["pin-a", "pin-b"]);

        write_and_reconcile_snapshot(
            &store,
            "executor-1",
            1,
            snapshot("project", &["pin-a"], Some("more")),
        )
        .await;
        let final_revision: i64 =
            sqlx::query_scalar("SELECT CAST(value AS INTEGER) FROM federation_meta WHERE key = ?")
                .bind(CATALOG_REVISION_KEY)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(final_revision, first_revision + 2);
    }

    #[tokio::test]
    async fn refresh_discovers_and_removes_pins_beyond_the_sidebar_page() {
        let removed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let page_requests = Arc::new(AtomicUsize::new(0));
        let first_page = (0..10)
            .map(|index| format!("pin-{index}"))
            .collect::<Vec<_>>();
        let sidebar = {
            let first_page = first_page.clone();
            move |headers: HeaderMap| {
                let first_page = first_page.clone();
                async move {
                    assert_eq!(headers[API_VERSION_HEADER], SUPPORTED_EXECUTOR_API_VERSION);
                    let ids = first_page.iter().map(String::as_str).collect::<Vec<_>>();
                    (
                        [(API_VERSION_HEADER, SUPPORTED_EXECUTOR_API_VERSION)],
                        Json(
                            serde_json::to_value(snapshot("project", &ids, Some("page-2")))
                                .unwrap(),
                        ),
                    )
                }
            }
        };
        let pinned = {
            let removed = removed.clone();
            let page_requests = page_requests.clone();
            move |headers: HeaderMap| {
                let removed = removed.clone();
                let page_requests = page_requests.clone();
                async move {
                    assert_eq!(headers[EXPECTED_INSTANCE_HEADER], "instance-1");
                    page_requests.fetch_add(1, Ordering::SeqCst);
                    let last = if removed.load(Ordering::SeqCst) {
                        14
                    } else {
                        15
                    };
                    let threads = (10..last)
                        .map(|index| full_thread(&format!("pin-{index}")))
                        .collect::<Vec<_>>();
                    (
                        [(API_VERSION_HEADER, SUPPORTED_EXECUTOR_API_VERSION)],
                        Json(json!({
                            "threads": threads,
                            "nextCursor": null,
                            "backwardsCursor": null,
                            "rawPayload": {}
                        })),
                    )
                }
            }
        };
        let app = Router::new()
            .route("/v1/sidebar/threads", get(sidebar))
            .route("/v1/pinned-threads", get(pinned));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let record = executor(format!("http://{address}"));
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::connect(&dir.path().join("federator.db"))
            .await
            .unwrap();
        store.insert_executor(&record).await.unwrap();

        write_and_reconcile_snapshot(
            &store,
            &record.id,
            record.generation,
            fetch_snapshot(&record).await.unwrap(),
        )
        .await;
        let pins: Vec<String> = sqlx::query_scalar(
            "SELECT native_id FROM catalog_order WHERE kind = 'pinned' ORDER BY position",
        )
        .fetch_all(&store.pool)
        .await
        .unwrap();
        assert_eq!(pins.len(), 15);
        assert!(pins.contains(&"pin-14".to_string()));

        removed.store(true, Ordering::SeqCst);
        write_and_reconcile_snapshot(
            &store,
            &record.id,
            record.generation,
            fetch_snapshot(&record).await.unwrap(),
        )
        .await;
        let pins: Vec<String> = sqlx::query_scalar(
            "SELECT native_id FROM catalog_order WHERE kind = 'pinned' ORDER BY position",
        )
        .fetch_all(&store.pool)
        .await
        .unwrap();
        assert_eq!(pins.len(), 14);
        assert!(!pins.contains(&"pin-14".to_string()));
        assert_eq!(page_requests.load(Ordering::SeqCst), 2);
        server.abort();
    }

    #[tokio::test]
    async fn catalog_writes_recheck_registry_changes_after_waiting_for_the_sqlite_writer() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::connect(&dir.path().join("federator.db"))
            .await
            .unwrap();
        store
            .insert_executor(&executor("http://127.0.0.1:9".to_string()))
            .await
            .unwrap();
        write_and_reconcile_snapshot(&store, "executor-1", 1, snapshot("project", &[], None)).await;

        let mut registry_update = store.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let stale_apply = {
            let store = store.clone();
            tokio::spawn(async move {
                write_snapshot(&store, "executor-1", 1, snapshot("stale", &[], None)).await
            })
        };
        sqlx::query("UPDATE executors SET generation = 2 WHERE id = 'executor-1'")
            .execute(&mut *registry_update)
            .await
            .unwrap();
        registry_update.commit().await.unwrap();
        assert!(stale_apply.await.unwrap().unwrap().is_none());

        let mut deletion = store.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let stale_move = {
            let store = store.clone();
            let (changes, _) = tokio::sync::broadcast::channel(1);
            tokio::spawn(async move {
                write_move(
                    &store,
                    &changes,
                    "project",
                    MoveCatalogItemRequest {
                        item: QualifiedCatalogRef {
                            executor_id: "executor-1".to_string(),
                            native_id: "project".to_string(),
                        },
                        before: None,
                        order_revision: 1,
                    },
                )
                .await
            })
        };
        sqlx::query("DELETE FROM executors WHERE id = 'executor-1'")
            .execute(&mut *deletion)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE federation_meta SET value = CAST(value AS INTEGER) + 1 WHERE key IN (?, ?)",
        )
        .bind(CATALOG_REVISION_KEY)
        .bind(ORDER_REVISION_KEY)
        .execute(&mut *deletion)
        .await
        .unwrap();
        deletion.commit().await.unwrap();
        let error = stale_move.await.unwrap().unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn new_order_members_use_registration_order_not_refresh_completion_order() {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::connect(&dir.path().join("federator.db"))
            .await
            .unwrap();
        let mut first = executor("http://127.0.0.1:91".to_string());
        first.id = "executor-a".to_string();
        first.instance_id = "instance-a".to_string();
        first.created_at = 1;
        let mut second = executor("http://127.0.0.1:92".to_string());
        second.id = "executor-b".to_string();
        second.instance_id = "instance-b".to_string();
        second.created_at = 2;
        store.insert_executor(&first).await.unwrap();
        store.insert_executor(&second).await.unwrap();

        write_snapshot(&store, &second.id, 1, snapshot("project-b", &[], None))
            .await
            .unwrap();
        write_snapshot(&store, &first.id, 1, snapshot("project-a", &[], None))
            .await
            .unwrap();
        reconcile_catalog_order(
            &store,
            &HashSet::from([
                (second.id.clone(), second.generation),
                (first.id.clone(), first.generation),
            ]),
        )
        .await
        .unwrap();
        let order: Vec<(String, String)> = sqlx::query_as(
            "SELECT executor_id, native_id FROM catalog_order WHERE kind = 'project' ORDER BY position",
        )
        .fetch_all(&store.pool)
        .await
        .unwrap();
        assert_eq!(
            order,
            [
                ("executor-a".to_string(), "project-a".to_string()),
                ("executor-b".to_string(), "project-b".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn queued_executor_gets_its_own_timeout_after_a_slow_concurrency_wave() {
        let mut servers = Vec::new();
        let fast_requests = Arc::new(AtomicUsize::new(0));
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::connect(&dir.path().join("federator.db"))
            .await
            .unwrap();
        for index in 0..=REFRESH_CONCURRENCY {
            let fast = index == REFRESH_CONCURRENCY;
            let fast_requests = fast_requests.clone();
            let app = Router::new().route(
                "/v1/sidebar/threads",
                get(move || {
                    let fast_requests = fast_requests.clone();
                    async move {
                        if fast {
                            fast_requests.fetch_add(1, Ordering::SeqCst);
                        } else {
                            tokio::time::sleep(REFRESH_TIMEOUT * 2).await;
                        }
                        (
                            [(API_VERSION_HEADER, SUPPORTED_EXECUTOR_API_VERSION)],
                            Json(
                                serde_json::to_value(snapshot(
                                    if fast { "fast" } else { "slow" },
                                    &[],
                                    None,
                                ))
                                .unwrap(),
                            ),
                        )
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            servers.push(tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap()
            }));
            let mut record = executor(format!("http://{address}"));
            record.id = format!("executor-{index}");
            record.instance_id = format!("instance-{index}");
            record.created_at = index as i64;
            store.insert_executor(&record).await.unwrap();
        }
        let (changes, _) = tokio::sync::broadcast::channel(16);
        let writer = CatalogWriter::start(store.clone(), changes);
        tokio::time::timeout(Duration::from_secs(2), writer.refresh())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(fast_requests.load(Ordering::SeqCst), 1);
        let fast_snapshot: Option<String> =
            sqlx::query_scalar("SELECT snapshot_json FROM catalog_snapshots WHERE executor_id = ?")
                .bind(format!("executor-{REFRESH_CONCURRENCY}"))
                .fetch_optional(&store.pool)
                .await
                .unwrap();
        assert!(fast_snapshot.is_some());
        for server in servers {
            server.abort();
        }
    }

    #[tokio::test]
    async fn writer_coalesces_refreshes_finishes_dropped_callers_and_does_not_block_moves() {
        #[derive(Clone)]
        struct ServerState {
            requests: Arc<AtomicUsize>,
            entered: Arc<tokio::sync::Notify>,
            release: Arc<tokio::sync::Notify>,
        }

        let server_state = ServerState {
            requests: Arc::new(AtomicUsize::new(0)),
            entered: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Notify::new()),
        };
        let app = Router::new().route(
            "/v1/sidebar/threads",
            get({
                let state = server_state.clone();
                move |headers: HeaderMap| {
                    let state = state.clone();
                    async move {
                        assert_eq!(headers[EXPECTED_INSTANCE_HEADER], "instance-1");
                        assert_eq!(headers[API_VERSION_HEADER], SUPPORTED_EXECUTOR_API_VERSION);
                        let request = state.requests.fetch_add(1, Ordering::SeqCst);
                        if request == 0 {
                            state.entered.notify_one();
                            state.release.notified().await;
                        }
                        (
                            [(API_VERSION_HEADER, SUPPORTED_EXECUTOR_API_VERSION)],
                            Json(if request == 0 {
                                serde_json::to_value(snapshot("older", &[], None)).unwrap()
                            } else {
                                serde_json::to_value(snapshot("newer", &[], None)).unwrap()
                            }),
                        )
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::connect(&dir.path().join("federator.db"))
            .await
            .unwrap();
        store
            .insert_executor(&executor(format!("http://{address}")))
            .await
            .unwrap();
        write_and_reconcile_snapshot(&store, "executor-1", 1, snapshot("seed", &[], None)).await;
        let (changes, _) = tokio::sync::broadcast::channel(8);
        let writer = CatalogWriter::start(store.clone(), changes);

        let (first_reply, first_response) = tokio::sync::oneshot::channel();
        writer
            .commands
            .send(CatalogCommand::Refresh { reply: first_reply })
            .await
            .unwrap();
        drop(first_response);
        server_state.entered.notified().await;
        let (second_reply, second_response) = tokio::sync::oneshot::channel();
        writer
            .commands
            .send(CatalogCommand::Refresh {
                reply: second_reply,
            })
            .await
            .unwrap();
        tokio::task::yield_now().await;
        assert_eq!(server_state.requests.load(Ordering::SeqCst), 1);
        let moved = tokio::time::timeout(
            Duration::from_secs(1),
            writer.move_item(
                "project".to_string(),
                MoveCatalogItemRequest {
                    item: QualifiedCatalogRef {
                        executor_id: "executor-1".to_string(),
                        native_id: "seed".to_string(),
                    },
                    before: None,
                    order_revision: 1,
                },
            ),
        )
        .await
        .expect("a network refresh does not block order writes")
        .unwrap();
        assert_eq!(moved.items[0].native_id, "seed");
        server_state.release.notify_one();
        second_response.await.unwrap().unwrap();

        let stored: String = sqlx::query_scalar(
            "SELECT snapshot_json FROM catalog_snapshots WHERE executor_id = 'executor-1'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&stored).unwrap()["projects"][0]["id"],
            "newer"
        );
        assert_eq!(server_state.requests.load(Ordering::SeqCst), 2);
        server.abort();
    }
}
