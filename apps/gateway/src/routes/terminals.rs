use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    api::AppState,
    error::{ApiError, ApiResult},
    terminal::{
        decode_browser_terminal_message, CreateTerminalSession, TerminalSessionListResponse,
        TerminalSessionResponse,
    },
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/terminals", get(list_terminals).post(create_terminal))
        .route("/v1/terminals/{terminal_id}", delete(delete_terminal))
        .route("/v1/terminals/{terminal_id}/ws", get(connect_terminal_ws))
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDeleteResponse {
    pub id: String,
}

#[utoipa::path(get, path = "/v1/terminals", responses((status = 200, body = TerminalSessionListResponse)))]
pub async fn list_terminals(
    State(state): State<AppState>,
) -> ApiResult<Json<TerminalSessionListResponse>> {
    Ok(Json(TerminalSessionListResponse {
        terminals: state.terminals.list_sessions().await,
    }))
}

#[utoipa::path(post, path = "/v1/terminals", request_body = CreateTerminalSession, responses((status = 201, body = TerminalSessionResponse)))]
pub async fn create_terminal(
    State(state): State<AppState>,
    Json(request): Json<CreateTerminalSession>,
) -> ApiResult<(StatusCode, Json<TerminalSessionResponse>)> {
    let terminal = state
        .terminals
        .create_session(request)
        .await
        .map_err(|error| {
            ApiError::BadRequest(format!("terminal could not be created: {error:#}"))
        })?;
    Ok((
        StatusCode::CREATED,
        Json(TerminalSessionResponse { terminal }),
    ))
}

#[utoipa::path(delete, path = "/v1/terminals/{terminalId}", responses((status = 200, body = TerminalDeleteResponse)))]
pub async fn delete_terminal(
    State(state): State<AppState>,
    Path(terminal_id): Path<String>,
) -> ApiResult<Json<TerminalDeleteResponse>> {
    if state.terminals.delete_session(&terminal_id).await {
        Ok(Json(TerminalDeleteResponse { id: terminal_id }))
    } else {
        Err(ApiError::NotFound(format!(
            "terminal {terminal_id} was not found"
        )))
    }
}

pub async fn connect_terminal_ws(
    State(state): State<AppState>,
    Path(terminal_id): Path<String>,
    ws: WebSocketUpgrade,
) -> ApiResult<impl IntoResponse> {
    let Some(session) = state.terminals.get_session(&terminal_id).await else {
        return Err(ApiError::NotFound(format!(
            "terminal {terminal_id} was not found"
        )));
    };
    let attachment = session.attach();
    Ok(ws.on_upgrade(move |socket| async move {
        forward_terminal_socket(socket, session, attachment).await;
    }))
}

async fn forward_terminal_socket(
    mut socket: WebSocket,
    session: std::sync::Arc<crate::terminal::TerminalSession>,
    _attachment: crate::terminal::TerminalAttachmentGuard,
) {
    let mut stdout = session.subscribe();
    let mut exit = session.subscribe_exit();
    if session.cancelled() {
        let _ = socket.send(Message::Text("terminal exited".into())).await;
        return;
    }

    let (left, right) = session.history_parts();
    if !left.is_empty() && socket.send(Message::Binary(left.into())).await.is_err() {
        return;
    }
    if !right.is_empty() && socket.send(Message::Binary(right.into())).await.is_err() {
        return;
    }

    if session.cancelled() {
        let _ = socket.send(Message::Text("terminal exited".into())).await;
        return;
    }

    loop {
        tokio::select! {
            message = socket.recv() => {
                let Some(message) = message else {
                    break;
                };
                let bytes = match message {
                    Ok(Message::Binary(bytes)) => bytes,
                    Ok(Message::Text(text)) => text.as_bytes().to_vec().into(),
                    Ok(Message::Close(_)) => break,
                    Ok(_) => continue,
                    Err(_) => break,
                };
                match decode_browser_terminal_message(&bytes) {
                    Ok(crate::terminal::TerminalInput::Begin) => {}
                    Ok(input) => {
                        if session.send(input).await.is_err() {
                            let _ = socket.send(Message::Text("terminal stdin closed".into())).await;
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = socket
                            .send(Message::Text(format!("terminal protocol error: {error:#}").into()))
                            .await;
                        break;
                    }
                }
            }
            output = stdout.recv() => {
                match output {
                    Ok(bytes) => {
                        if socket.send(Message::Binary(bytes.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let _ = socket.send(Message::Text("terminal output lagged; reconnect to replay history".into())).await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = exit.recv() => {
                let _ = socket.send(Message::Text("terminal exited".into())).await;
                break;
            }
        }

        if session.cancelled() {
            let _ = socket.send(Message::Text("terminal exited".into())).await;
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use serde_json::json;
    use tempfile::tempdir;
    use tower::ServiceExt;

    use crate::{
        api::{build_router, AppState},
        app_server::tests::RecordingAppServer,
        config::Config,
        store::Store,
    };

    async fn test_state() -> AppState {
        let temp = tempdir().unwrap();
        let home_dir = temp.path().to_path_buf();
        std::mem::forget(temp);
        let mut config = Config::default();
        config.projects.home_dir = home_dir;
        AppState::new(
            config,
            Store::in_memory().await.unwrap(),
            Arc::new(RecordingAppServer::default()),
        )
    }

    #[tokio::test]
    async fn terminal_routes_create_list_and_delete_sessions() {
        let state = test_state().await;
        let app = build_router(state);

        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/terminals")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"command": "/bin/sh"}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        let body = to_bytes(created.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let terminal_id = body["terminal"]["id"].as_str().unwrap();

        let listed = app
            .clone()
            .oneshot(Request::get("/v1/terminals").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let body = to_bytes(listed.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["terminals"].as_array().unwrap().len(), 1);

        let deleted = app
            .oneshot(
                Request::delete(format!("/v1/terminals/{terminal_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn terminal_create_rejects_missing_cwd() {
        let state = test_state().await;
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/terminals")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"cwd": "/path/that/does/not/exist", "command": "/bin/sh"})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn terminal_delete_missing_session_returns_not_found() {
        let state = test_state().await;
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::delete("/v1/terminals/missing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
