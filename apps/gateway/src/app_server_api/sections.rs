use rmcp::schemars;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use super::{bad_gateway, CodexClient, ThreadListResponse};
use crate::error::ApiResult;

/// The built-in native section in the pinned 0.160.0 app-server contract.
pub const PINNED_THREAD_SECTION_ID: &str = "01984de2-8f74-7c91-a3b2-5c5e937cf318";

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSectionAppearance {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSection {
    pub id: String,
    pub name: String,
    pub appearance: Option<ThreadSectionAppearance>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSectionPage {
    pub data: Vec<ThreadSection>,
    pub next_cursor: Option<String>,
}

#[derive(Deserialize)]
struct SectionResponse {
    section: ThreadSection,
}

fn section_from_response(method: &str, payload: Value) -> ApiResult<ThreadSection> {
    serde_json::from_value::<SectionResponse>(payload)
        .map(|response| response.section)
        .map_err(|error| bad_gateway(format!("{method} response: {error}")))
}

impl CodexClient {
    pub async fn thread_section_list(
        &self,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> ApiResult<ThreadSectionPage> {
        let payload = self
            .request("threadSection/list", json!({"cursor":cursor,"limit":limit}))
            .await?;
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("threadSection/list response: {error}")))
    }

    pub async fn thread_section_create(&self, payload: Value) -> ApiResult<ThreadSection> {
        let payload = self.request("threadSection/create", payload).await?;
        section_from_response("threadSection/create", payload)
    }

    pub async fn thread_section_update(
        &self,
        section_id: String,
        payload: Value,
    ) -> ApiResult<ThreadSection> {
        let payload = self
            .request(
                "threadSection/update",
                super::merge_path_payload("sectionId", section_id, payload),
            )
            .await?;
        section_from_response("threadSection/update", payload)
    }

    pub async fn thread_section_delete(&self, section_id: String) -> ApiResult<()> {
        self.request("threadSection/delete", json!({"sectionId":section_id}))
            .await?;
        Ok(())
    }

    pub async fn thread_move_to_section(&self, thread_id: String, payload: Value) -> ApiResult<()> {
        self.request(
            "thread/section/move",
            super::merge_path_payload("threadId", thread_id, payload),
        )
        .await?;
        Ok(())
    }

    pub async fn thread_list_in_section(
        &self,
        section_id: String,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> ApiResult<ThreadListResponse> {
        // A section can explicitly contain any native thread, including a subagent or
        // a thread created under a different provider. Preserve native list order.
        let payload = self.request("thread/list", json!({
            "sectionId":section_id,"cursor":cursor,"limit":limit,
            "sortKey":"section_position","sortDirection":"asc",
            "archived":false,"useStateDbOnly":true,"modelProviders":[],
            "sourceKinds":["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"],
        })).await?;
        ThreadListResponse::from_payload(payload)
    }
}
