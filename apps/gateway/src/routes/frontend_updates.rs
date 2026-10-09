use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::ToSchema;

use crate::{api::AppState, error::ApiResult, store::NewEvent};

pub const FRONTEND_UPDATED_EVENT: &str = "frontend.updated";

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/frontend-updates", post(publish_frontend_update))
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FrontendUpdateRequest {
    pub revision: String,
}

#[utoipa::path(
    post,
    path = "/v1/frontend-updates",
    request_body = FrontendUpdateRequest,
    responses((status = 204, description = "Frontend update published"))
)]
pub async fn publish_frontend_update(
    State(state): State<AppState>,
    Json(request): Json<FrontendUpdateRequest>,
) -> ApiResult<StatusCode> {
    let event = state
        .store
        .append_event(NewEvent {
            project_id: None,
            thread_id: None,
            turn_id: None,
            item_id: None,
            kind: FRONTEND_UPDATED_EVENT.to_string(),
            codex_method: None,
            payload: json!({"revision": request.revision}),
        })
        .await?;
    let _ = state.events.send(event);
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        body::Body,
        http::{header::CONTENT_TYPE, Request, StatusCode},
    };
    use serde_json::json;
    use tokio::time::{timeout, Duration};
    use tower::ServiceExt;

    use crate::{
        api::{build_router, AppState},
        app_server::tests::RecordingAppServer,
        config::Config,
        store::Store,
    };

    #[tokio::test]
    async fn frontend_update_is_published_to_the_global_event_stream() {
        let state = AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            Arc::new(RecordingAppServer::default()),
        );
        let mut events = state.events.subscribe();
        let response = build_router(state)
            .oneshot(
                Request::post("/v1/frontend-updates")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({"revision":"build-123"}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let event = timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.kind, "frontend.updated");
        assert_eq!(event.thread_id, None);
        assert_eq!(event.payload, json!({"revision":"build-123"}));
        assert!(crate::events_replay::is_operational_replay_event(&event));
        assert!(crate::events_replay::is_normal_live_event(&event));
    }
}
