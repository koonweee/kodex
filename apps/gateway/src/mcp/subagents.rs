use crate::routes::subagents::ThreadSubagentListQuery;
use rmcp::schemars;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct ListSubagentsToolParams {
    #[serde(alias = "thread_id")]
    pub(super) thread_id: String,
    #[serde(flatten)]
    pub(super) query: ThreadSubagentListQuery,
}
