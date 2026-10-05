use super::{CodexClient, ThreadListResponse};
use crate::error::ApiResult;
use serde_json::json;

/// Built-in native Pinned identity in the checked-in 0.160.0 contract.
pub const PINNED_THREAD_SECTION_ID: &str = "01984de2-8f74-7c91-a3b2-5c5e937cf318";

impl CodexClient {
    pub async fn thread_set_pinned(
        &self,
        thread_id: String,
        pinned: bool,
        before_thread_id: Option<String>,
    ) -> ApiResult<()> {
        self.request(
            "thread/section/move",
            json!({
                "threadId":thread_id,
                "sectionId":if pinned {Some(PINNED_THREAD_SECTION_ID)} else {None},
                "beforeThreadId":before_thread_id,
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn pinned_thread_list(
        &self,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> ApiResult<ThreadListResponse> {
        // Preserve native position order, including directly pinned subagents.
        let payload = self.request("thread/list", json!({
            "sectionId":PINNED_THREAD_SECTION_ID,"cursor":cursor,"limit":limit,
            "sortKey":"section_position","sortDirection":"asc",
            "archived":false,"useStateDbOnly":true,"modelProviders":[],
            "sourceKinds":["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"],
        })).await?;
        ThreadListResponse::from_payload(payload)
    }
}
