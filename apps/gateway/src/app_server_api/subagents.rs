use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use super::{
    bad_gateway, optional_string, required_string, CodexClient, ThreadStatus, ThreadSummary,
};
use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSubagentSummary {
    pub id: String,
    #[schema(required = true)]
    pub parent_thread_id: Option<String>,
    pub name: Option<String>,
    pub preview: String,
    pub agent_nickname: Option<String>,
    pub agent_role: Option<String>,
    pub status: ThreadStatus,
    pub updated_at: i64,
    #[schema(required = true)]
    pub can_accept_direct_input: Option<bool>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSubagentListResponse {
    pub subagents: Vec<ThreadSubagentSummary>,
    #[schema(required = true)]
    pub next_cursor: Option<String>,
}

impl ThreadSubagentListResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let data = payload
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("thread/list response missing data array"))?;
        let subagents = data
            .iter()
            .map(|payload| {
                let thread = ThreadSummary::from_payload(payload)?;
                Ok(ThreadSubagentSummary {
                    id: thread.id,
                    parent_thread_id: thread.parent_thread_id,
                    name: thread.name,
                    preview: required_string(payload, "preview")?,
                    agent_nickname: thread.agent_nickname,
                    agent_role: thread.agent_role,
                    status: thread.status,
                    updated_at: thread.updated_at,
                    can_accept_direct_input: thread.can_accept_direct_input,
                })
            })
            .collect::<ApiResult<Vec<_>>>()?;
        Ok(Self {
            subagents,
            next_cursor: optional_string(&payload, "nextCursor"),
        })
    }
}

impl CodexClient {
    pub async fn thread_descendants(
        &self,
        ancestor_thread_id: String,
        cursor: Option<String>,
        limit: u32,
        archived: bool,
    ) -> ApiResult<ThreadSubagentListResponse> {
        // Native relation filters include every source/provider when these filters
        // are omitted. sourceKinds:[] would instead restore interactive-only filtering.
        let payload = self
            .request(
                "thread/list",
                json!({
                    "ancestorThreadId": ancestor_thread_id,
                    "cursor": cursor,
                    "limit": limit,
                    "sortKey": "created_at",
                    "sortDirection": "asc",
                    "archived": archived,
                    "useStateDbOnly": true,
                }),
            )
            .await?;
        ThreadSubagentListResponse::from_payload(payload)
    }

    /// Until the legacy queue is removed, reject an explicit native denial before
    /// accepting a durable queued row. Unknown remains for native dispatch to decide.
    pub async fn check_direct_input_capability(&self, thread_id: &str) -> ApiResult<()> {
        let thread = self.thread_read_summary(thread_id.to_string()).await?;
        if thread.can_accept_direct_input == Some(false) {
            return Err(ApiError::BadRequest(
                "Native thread does not accept direct input".into(),
            ));
        }
        Ok(())
    }
}
