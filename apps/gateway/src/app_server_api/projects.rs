use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use super::{bad_gateway, CodexClient, ThreadListResponse};
use crate::error::ApiResult;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRoot {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub roots: Vec<ProjectRoot>,
    pub metadata: BTreeMap<String, String>,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub recency_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPage {
    pub data: Vec<Project>,
    pub next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct ProjectResponse {
    project: Project,
}

fn project_from_response(method: &str, payload: Value) -> ApiResult<Project> {
    serde_json::from_value::<ProjectResponse>(payload)
        .map(|response| response.project)
        .map_err(|error| bad_gateway(format!("{method} response: {error}")))
}

impl CodexClient {
    pub async fn project_create(
        &self,
        name: String,
        roots: Vec<ProjectRoot>,
        idempotency_key: String,
        metadata: Option<BTreeMap<String, String>>,
    ) -> ApiResult<Project> {
        let mut params = json!({"name": name, "roots": roots, "idempotencyKey": idempotency_key});
        if let Some(metadata) = metadata {
            params["metadata"] = json!(metadata);
        }
        let payload = self.request("project/create", params).await?;
        project_from_response("project/create", payload)
    }

    pub async fn project_read(&self, project_id: String) -> ApiResult<Project> {
        let payload = self
            .request("project/read", json!({"projectId": project_id}))
            .await?;
        project_from_response("project/read", payload)
    }

    pub async fn project_update(&self, project_id: String, patch: Value) -> ApiResult<Project> {
        let payload = self
            .request(
                "project/update",
                super::merge_path_payload("projectId", project_id, patch),
            )
            .await?;
        project_from_response("project/update", payload)
    }

    pub async fn project_move(
        &self,
        project_id: String,
        before_project_id: Option<String>,
    ) -> ApiResult<()> {
        self.request(
            "project/move",
            json!({"projectId":project_id,"beforeProjectId":before_project_id}),
        )
        .await?;
        Ok(())
    }

    pub async fn project_delete(&self, project_id: String) -> ApiResult<()> {
        self.request("project/delete", json!({"projectId":project_id}))
            .await?;
        Ok(())
    }

    pub async fn thread_assign_project(
        &self,
        thread_id: String,
        project_id: Option<String>,
    ) -> ApiResult<super::ThreadCommandResponse> {
        let payload = self
            .request(
                "thread/metadata/update",
                json!({"threadId":thread_id,"projectId":project_id.unwrap_or_default()}),
            )
            .await?;
        super::ThreadCommandResponse::from_payload(payload)
    }

    pub async fn project_list_page(
        &self,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> ApiResult<ProjectPage> {
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
        project_id: Option<String>,
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
