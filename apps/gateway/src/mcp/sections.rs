use rmcp::schemars;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::routes::thread_sections::{
    CreateThreadSectionRequest, MoveThreadToSectionRequest, UpdateThreadSectionRequest,
};

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct SectionThreadsToolParams {
    pub section_id: String,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct CreateSectionToolParams {
    #[serde(flatten)]
    pub section: CreateThreadSectionRequest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdateSectionToolParams {
    pub section_id: String,
    #[serde(flatten)]
    pub section: UpdateThreadSectionRequest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeleteSectionToolParams {
    pub section_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct MoveThreadToSectionToolParams {
    pub thread_id: String,
    #[serde(flatten)]
    pub placement: MoveThreadToSectionRequest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
}
