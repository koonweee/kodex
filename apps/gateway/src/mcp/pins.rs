use crate::routes::pins::ThreadPinRequest;
use rmcp::schemars;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct PinThreadToolParams {
    pub thread_id: String,
    #[serde(flatten)]
    pub pin: ThreadPinRequest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}
