use std::convert::Infallible;

use axum::{
    extract::State,
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
    Router,
};
use futures_util::Stream;
use serde::Serialize;
use utoipa::ToSchema;

use crate::{
    catalog::{self, CatalogEvent},
    frontend_updates::{self, FrontendUpdateRequest},
    registry::{self, ExecutorRegistryEvent},
    State as FederatorState,
};

#[derive(Serialize, ToSchema)]
#[serde(untagged)]
pub(crate) enum BrowserEventPayload {
    Executors(ExecutorRegistryEvent),
    Catalog(CatalogEvent),
    Frontend(FrontendUpdateRequest),
}

impl BrowserEventPayload {
    fn into_event(self) -> Event {
        match self {
            Self::Executors(payload) => registry::registry_event(payload),
            Self::Catalog(payload) => catalog::catalog_event(payload),
            Self::Frontend(payload) => frontend_updates::frontend_event(&payload.revision),
        }
    }
}

pub(crate) fn router() -> Router<FederatorState> {
    Router::new().route("/v1/federation/browser-events", get(browser_events))
}

#[utoipa::path(
    get,
    path = "/v1/federation/browser-events",
    responses((status = 200, description = "Multiplexed browser invalidation stream", body = BrowserEventPayload, content_type = "text/event-stream"))
)]
pub(crate) async fn browser_events(
    State(state): State<FederatorState>,
) -> Result<
    Sse<impl Stream<Item = Result<axum::response::sse::Event, Infallible>>>,
    axum::http::StatusCode,
> {
    let mut registry_changes = state.registry_changes.subscribe();
    let mut catalog_changes = state.catalog_changes.subscribe();
    let mut frontend_updates = state.frontend_updates.subscribe();
    let registry_revision = state
        .store
        .executor_registry_revision()
        .await
        .map_err(|error| {
            tracing::error!(%error, "reading executor registry revision failed");
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        })?;
    let catalog = catalog::catalog_revisions(&state).await.map_err(|error| {
        tracing::error!(?error, "reading catalog revisions failed");
        axum::http::StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let frontend = state.store.frontend_revision().await.map_err(|error| {
        tracing::error!(%error, "reading frontend revision failed");
        axum::http::StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let store = state.store.clone();
    let stream = async_stream::stream! {
        let mut delivered_registry = registry_revision;
        let mut delivered_catalog = catalog.revision;
        let mut delivered_frontend = frontend.clone();
        yield Ok(BrowserEventPayload::Executors(ExecutorRegistryEvent {
            revision: registry_revision,
            executor_id: None,
            generation: None,
        }).into_event());
        yield Ok(BrowserEventPayload::Catalog(catalog).into_event());
        if let Some(revision) = frontend {
            yield Ok(BrowserEventPayload::Frontend(FrontendUpdateRequest { revision }).into_event());
        }
        loop {
            tokio::select! {
                change = registry_changes.recv() => match change {
                    Ok(change) if change.revision == delivered_registry + 1 => {
                        delivered_registry = change.revision;
                        yield Ok(BrowserEventPayload::Executors(ExecutorRegistryEvent {
                            revision: change.revision,
                            executor_id: Some(change.executor_id),
                            generation: change.generation,
                        }).into_event());
                    }
                    Ok(change) if change.revision > delivered_registry => {
                        let Ok(revision) = store.executor_registry_revision().await else { break; };
                        delivered_registry = revision.max(change.revision);
                        yield Ok(BrowserEventPayload::Executors(ExecutorRegistryEvent {
                            revision: delivered_registry,
                            executor_id: None,
                            generation: None,
                        }).into_event());
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let Ok(revision) = store.executor_registry_revision().await else { break; };
                        if revision != delivered_registry {
                            delivered_registry = revision;
                            yield Ok(BrowserEventPayload::Executors(ExecutorRegistryEvent {
                                revision,
                                executor_id: None,
                                generation: None,
                            }).into_event());
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                change = catalog_changes.recv() => match change {
                    Ok(change) if change.revision > delivered_catalog => {
                        delivered_catalog = change.revision;
                        yield Ok(BrowserEventPayload::Catalog(CatalogEvent {
                            revision: change.revision,
                            order_revision: change.order_revision,
                        }).into_event());
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let Ok(current) = catalog::catalog_revisions(&state).await else { break; };
                        if current.revision > delivered_catalog {
                            delivered_catalog = current.revision;
                            yield Ok(BrowserEventPayload::Catalog(current).into_event());
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                revision = frontend_updates.recv() => match revision {
                    Ok(revision) if delivered_frontend.as_deref() != Some(&revision) => {
                        delivered_frontend = Some(revision.clone());
                        yield Ok(BrowserEventPayload::Frontend(FrontendUpdateRequest { revision }).into_event());
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let Ok(revision) = store.frontend_revision().await else { break; };
                        if revision.is_some() && revision != delivered_frontend {
                            delivered_frontend = revision.clone();
                            yield Ok(BrowserEventPayload::Frontend(FrontendUpdateRequest {
                                revision: revision.unwrap(),
                            }).into_event());
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}
