use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::{
        self, AccountResponse, LoginStartResponse, RateLimitsResponse, RawAppServerResponse,
    },
    error::ApiResult,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/account", get(read_account))
        .route("/v1/account/login", post(start_login))
        .route("/v1/account/login/{login_id}/cancel", post(cancel_login))
        .route("/v1/account/logout", post(logout))
        .route("/v1/account/rate-limits", get(read_rate_limits))
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountQuery {
    #[serde(default)]
    pub refresh_token: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    #[serde(default)]
    pub codex_streamlined_login: Option<bool>,
}

#[utoipa::path(get, path = "/v1/account", params(AccountQuery), responses((status = 200, body = AccountResponse)))]
pub async fn read_account(
    State(state): State<AppState>,
    Query(query): Query<AccountQuery>,
) -> ApiResult<Json<AccountResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .account_read(query.refresh_token)
            .await?,
    ))
}

#[utoipa::path(post, path = "/v1/account/login", request_body = LoginRequest, responses((status = 200, body = LoginStartResponse)))]
pub async fn start_login(
    State(state): State<AppState>,
    Json(request): Json<LoginRequest>,
) -> ApiResult<Json<LoginStartResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .login_start(request.codex_streamlined_login)
            .await?,
    ))
}

#[utoipa::path(post, path = "/v1/account/login/{loginId}/cancel", responses((status = 200, body = RawAppServerResponse)))]
pub async fn cancel_login(
    State(state): State<AppState>,
    Path(login_id): Path<String>,
) -> ApiResult<Json<RawAppServerResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .login_cancel(login_id)
            .await?,
    ))
}

#[utoipa::path(post, path = "/v1/account/logout", responses((status = 200, body = RawAppServerResponse)))]
pub async fn logout(State(state): State<AppState>) -> ApiResult<Json<RawAppServerResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server).logout().await?,
    ))
}

#[utoipa::path(get, path = "/v1/account/rate-limits", responses((status = 200, body = RateLimitsResponse)))]
pub async fn read_rate_limits(
    State(state): State<AppState>,
) -> ApiResult<Json<RateLimitsResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .rate_limits_read()
            .await?,
    ))
}
