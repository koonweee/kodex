use axum::{
    extract::{Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::{
        self, AccountResponse, ConsumeRateLimitResetCreditRequest,
        ConsumeRateLimitResetCreditResponse, LoginStartResponse, RateLimitsResponse,
        RawAppServerResponse,
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
        .route(
            "/v1/account/rate-limit-reset-credits/consume",
            post(consume_reset_credit),
        )
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountQuery {
    #[serde(default)]
    pub refresh_token: bool,
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

#[utoipa::path(post, path = "/v1/account/login", responses((status = 200, body = LoginStartResponse)))]
pub async fn start_login(State(state): State<AppState>) -> ApiResult<Json<LoginStartResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .login_start()
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

#[utoipa::path(post, path = "/v1/account/rate-limit-reset-credits/consume", request_body = ConsumeRateLimitResetCreditRequest, responses((status = 200, body = ConsumeRateLimitResetCreditResponse)))]
pub async fn consume_reset_credit(
    State(state): State<AppState>,
    Json(request): Json<ConsumeRateLimitResetCreditRequest>,
) -> ApiResult<Json<ConsumeRateLimitResetCreditResponse>> {
    if request.credit_id.trim().is_empty() || request.idempotency_key.trim().is_empty() {
        return Err(crate::error::ApiError::BadRequest(
            "creditId and idempotencyKey must not be empty".into(),
        ));
    }
    let result = app_server_api::client(&state.app_server)
        .consume_rate_limit_reset_credit(request)
        .await;
    // Even an ambiguous native failure can have consumed a credit. All clients
    // must refetch; never turn an accepted reset into a retryable write failure.
    match state
        .store
        .append_event(crate::store::NewEvent {
            project_id: None,
            thread_id: None,
            turn_id: None,
            item_id: None,
            kind: crate::events::ACCOUNT_RATE_LIMITS_UPDATED_EVENT.into(),
            codex_method: None,
            payload: serde_json::json!({}),
        })
        .await
    {
        Ok(event) => {
            let _ = state.events.send(event);
        }
        Err(error) => tracing::warn!(%error, "could not publish usage refill after reset attempt"),
    }
    result.map(Json)
}
