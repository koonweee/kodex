use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{bad_gateway, CodexClient, ThreadListResponse};
use crate::error::ApiResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectRoot {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProject {
    pub id: String,
    pub name: String,
    pub roots: Vec<NativeProjectRoot>,
    pub metadata: BTreeMap<String, String>,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub recency_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProjectPage {
    pub data: Vec<NativeProject>,
    pub next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct NativeProjectResponse {
    project: NativeProject,
}

fn project_from_response(method: &str, payload: Value) -> ApiResult<NativeProject> {
    serde_json::from_value::<NativeProjectResponse>(payload)
        .map(|response| response.project)
        .map_err(|error| bad_gateway(format!("{method} response: {error}")))
}

impl CodexClient {
    pub async fn project_create(
        &self,
        name: String,
        roots: Vec<NativeProjectRoot>,
        idempotency_key: String,
    ) -> ApiResult<NativeProject> {
        let payload = self
            .request(
                "project/create",
                json!({"name": name, "roots": roots, "idempotencyKey": idempotency_key}),
            )
            .await?;
        project_from_response("project/create", payload)
    }

    pub async fn project_read(&self, project_id: String) -> ApiResult<NativeProject> {
        let payload = self
            .request("project/read", json!({"projectId": project_id}))
            .await?;
        project_from_response("project/read", payload)
    }

    pub async fn project_list_page(
        &self,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> ApiResult<NativeProjectPage> {
        let payload = self
            .request(
                "project/list",
                json!({
                    "cursor": cursor,
                    "limit": limit,
                    "sortKey": "position",
                    "sortDirection": "asc",
                }),
            )
            .await?;
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("project/list response: {error}")))
    }

    pub async fn thread_list_in_project(
        &self,
        project_id: String,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> ApiResult<ThreadListResponse> {
        let payload = self
            .request(
                "thread/list",
                json!({
                    "projectId": project_id,
                    "cursor": cursor,
                    "limit": limit,
                    "sortKey": "updated_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true,
                }),
            )
            .await?;
        ThreadListResponse::from_payload(payload)
    }
}
