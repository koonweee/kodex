use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use rmcp::schemars;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::AppState,
    app_server_api::{self, ThreadSubagentListResponse},
    error::ApiResult,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/threads/{thread_id}/subagents", get(list_subagents))
}

#[derive(Debug, Default, Deserialize, Serialize, IntoParams, ToSchema, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSubagentListQuery {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
    #[serde(default)]
    pub archived: bool,
}

#[utoipa::path(get,path="/v1/threads/{threadId}/subagents",params(ThreadSubagentListQuery),responses((status=200,body=ThreadSubagentListResponse)))]
pub async fn list_subagents(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(query): Query<ThreadSubagentListQuery>,
) -> ApiResult<Json<ThreadSubagentListResponse>> {
    Ok(Json(
        app_server_api::client(&state.app_server)
            .thread_descendants(
                thread_id,
                query.cursor,
                query.limit.unwrap_or(50).clamp(1, 100),
                query.archived,
            )
            .await?,
    ))
}
