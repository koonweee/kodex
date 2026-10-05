use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use super::CodexClient;
use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThreadGoalStatus {
    Active,
    Paused,
    Blocked,
    UsageLimited,
    BudgetLimited,
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoal {
    pub thread_id: String,
    pub objective: String,
    pub status: ThreadGoalStatus,
    #[schema(required = true)]
    pub token_budget: Option<i64>,
    pub tokens_used: i64,
    pub time_used_seconds: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadGoalSetRequest {
    #[serde(
        default,
        deserialize_with = "deserialize_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub objective: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub status: Option<Option<ThreadGoalStatus>>,
    #[serde(
        default,
        deserialize_with = "deserialize_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub token_budget: Option<Option<i64>>,
}

fn deserialize_update<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ThreadGoalGetResponse {
    #[schema(required = true)]
    pub goal: Option<ThreadGoal>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ThreadGoalSetResponse {
    pub goal: ThreadGoal,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ThreadGoalClearResponse {
    pub cleared: bool,
}

impl CodexClient {
    pub async fn thread_goal_get(&self, thread_id: String) -> ApiResult<ThreadGoalGetResponse> {
        let payload = self
            .request("thread/goal/get", json!({"threadId":thread_id}))
            .await?;
        decode_response("thread/goal/get", payload)
    }

    pub async fn thread_goal_set(
        &self,
        thread_id: String,
        request: ThreadGoalSetRequest,
    ) -> ApiResult<ThreadGoalSetResponse> {
        let mut params = serde_json::to_value(request)?;
        params["threadId"] = Value::String(thread_id);
        let payload = self.request("thread/goal/set", params).await?;
        decode_response("thread/goal/set", payload)
    }

    pub async fn thread_goal_clear(&self, thread_id: String) -> ApiResult<ThreadGoalClearResponse> {
        let payload = self
            .request("thread/goal/clear", json!({"threadId":thread_id}))
            .await?;
        decode_response("thread/goal/clear", payload)
    }
}

fn decode_response<T: DeserializeOwned>(method: &str, payload: Value) -> ApiResult<T> {
    serde_json::from_value(payload)
        .map_err(|error| ApiError::BadGateway(format!("invalid {method} response: {error}")))
}
