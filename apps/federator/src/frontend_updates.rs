use std::convert::Infallible;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
    Json, Router,
};
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc, oneshot};
use utoipa::ToSchema;

use crate::{store::Store, State as FederatorState};

pub(crate) const FRONTEND_UPDATED_EVENT: &str = "frontend.updated";

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrontendUpdateRequest {
    pub revision: String,
}

#[derive(Clone)]
pub(crate) struct FrontendUpdateWriter {
    commands: mpsc::Sender<FrontendUpdateCommand>,
}

struct FrontendUpdateCommand {
    revision: String,
    reply: oneshot::Sender<anyhow::Result<()>>,
}

impl FrontendUpdateWriter {
    pub(crate) fn start(store: Store, changes: broadcast::Sender<String>) -> Self {
        let (commands, mut receiver) = mpsc::channel::<FrontendUpdateCommand>(8);
        tokio::spawn(async move {
            while let Some(command) = receiver.recv().await {
                let result = store.set_frontend_revision(&command.revision).await;
                if result.is_ok() {
                    let _ = changes.send(command.revision);
                }
                let _ = command.reply.send(result);
            }
        });
        Self { commands }
    }

    async fn publish(&self, revision: String) -> anyhow::Result<()> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(FrontendUpdateCommand { revision, reply })
            .await
            .map_err(|_| anyhow::anyhow!("frontend update writer stopped"))?;
        response
            .await
            .map_err(|_| anyhow::anyhow!("frontend update writer stopped"))?
    }
}

pub(crate) fn router() -> Router<FederatorState> {
    Router::new()
        .route("/v1/frontend-updates", post(publish_frontend_update))
        .route(
            "/v1/federation/frontend-events",
            get(frontend_update_events),
        )
}

#[utoipa::path(
    post,
    path = "/v1/frontend-updates",
    request_body = FrontendUpdateRequest,
    responses((status = 204, description = "Frontend update published"), (status = 400, description = "Invalid frontend revision"))
)]
pub(crate) async fn publish_frontend_update(
    State(state): State<FederatorState>,
    Json(request): Json<FrontendUpdateRequest>,
) -> Result<StatusCode, (StatusCode, &'static str)> {
    if request.revision.is_empty()
        || request.revision.len() > 256
        || !request
            .revision
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid frontend revision."));
    }
    state
        .frontend_update_writer
        .publish(request.revision)
        .await
        .map_err(|error| {
            tracing::error!(%error, "publishing frontend update failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Frontend update could not be published.",
            )
        })?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/v1/federation/frontend-events",
    params(("Last-Event-ID" = Option<String>, Header, description = "Last applied frontend revision")),
    responses((status = 200, description = "Frontend update stream", body = FrontendUpdateRequest, content_type = "text/event-stream"))
)]
pub(crate) async fn frontend_update_events(
    State(state): State<FederatorState>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    let mut changes = state.frontend_updates.subscribe();
    let initial = state.store.frontend_revision().await.map_err(|error| {
        tracing::error!(%error, "reading frontend revision failed");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let requested = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let store = state.store.clone();
    let stream = async_stream::stream! {
        let mut delivered = requested;
        if initial.is_some() && initial != delivered {
            delivered = initial.clone();
            yield Ok(frontend_event(initial.as_deref().unwrap()));
        }
        loop {
            match changes.recv().await {
                Ok(revision) if delivered.as_deref() != Some(&revision) => {
                    delivered = Some(revision.clone());
                    yield Ok(frontend_event(&revision));
                }
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let Ok(revision) = store.frontend_revision().await else { break; };
                    if revision.is_some() && revision != delivered {
                        delivered = revision.clone();
                        yield Ok(frontend_event(revision.as_deref().unwrap()));
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn frontend_event(revision: &str) -> Event {
    Event::default()
        .event(FRONTEND_UPDATED_EVENT)
        .id(revision)
        .json_data(FrontendUpdateRequest {
            revision: revision.to_string(),
        })
        .expect("frontend update event serializes")
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use serde_json::json;
    use tower::ServiceExt;

    use crate::{config, primary_router};

    fn mutation(builder: axum::http::request::Builder) -> axum::http::request::Builder {
        builder
            .header("host", "localhost:8787")
            .header("origin", "http://localhost:8787")
            .header("x-kodex-api-version", crate::trust::FEDERATOR_API_VERSION)
    }

    #[tokio::test]
    async fn frontend_update_is_durable_and_replayed_to_new_clients() {
        let dir = tempfile::tempdir().unwrap();
        let config = config::Config {
            data_dir: dir.path().to_path_buf(),
            database_path: dir.path().join("federator.db"),
            ..config::Config::default()
        };
        let (_instance, state) = crate::prepare(&config).await.unwrap();
        let app = primary_router(state, None, config.sandbox_public_url);
        let response = app
            .clone()
            .oneshot(
                mutation(Request::post("/v1/frontend-updates"))
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"revision":"build-123"}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::NO_CONTENT);

        let mut response = app
            .oneshot(
                Request::get("/v1/federation/frontend-events")
                    .header("host", "localhost:8787")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let frame = response.body_mut().frame().await.unwrap().unwrap();
        let data = std::str::from_utf8(frame.data_ref().unwrap()).unwrap();
        assert!(data.contains("event: frontend.updated"), "{data}");
        assert!(data.contains("id: build-123"), "{data}");
        assert!(data.contains(r#"{"revision":"build-123"}"#), "{data}");
    }

    #[tokio::test]
    async fn frontend_update_rejects_values_that_cannot_be_safe_event_ids() {
        let dir = tempfile::tempdir().unwrap();
        let config = config::Config {
            data_dir: dir.path().to_path_buf(),
            database_path: dir.path().join("federator.db"),
            ..config::Config::default()
        };
        let (_instance, state) = crate::prepare(&config).await.unwrap();
        let app = primary_router(state, None, config.sandbox_public_url);

        let response = app
            .oneshot(
                mutation(Request::post("/v1/frontend-updates"))
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"revision":"bad\nid"}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn loopback_controller_can_publish_with_the_configured_public_host() {
        let dir = tempfile::tempdir().unwrap();
        let config = config::Config {
            data_dir: dir.path().to_path_buf(),
            database_path: dir.path().join("federator.db"),
            public_origin: "https://kodex.example.ts.net".to_string(),
            ..config::Config::default()
        };
        let (_instance, state) = crate::prepare(&config).await.unwrap();
        let app = primary_router(state, None, config.sandbox_public_url);

        let response = app
            .oneshot(
                Request::post("/v1/frontend-updates")
                    .header("host", "kodex.example.ts.net")
                    .header("x-kodex-api-version", crate::trust::FEDERATOR_API_VERSION)
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"revision":"build-123"}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::NO_CONTENT);
    }
}
