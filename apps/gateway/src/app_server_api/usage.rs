use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::ToSchema;

use super::{bad_gateway, CodexClient};
use crate::error::ApiResult;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitResetCreditsSummary {
    pub available_count: i64,
    pub credits: Option<Vec<RateLimitResetCredit>>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitResetCredit {
    pub id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub granted_at: i64,
    pub expires_at: Option<i64>,
    pub reset_type: String,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConsumeRateLimitResetCreditRequest {
    pub credit_id: String,
    pub idempotency_key: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ConsumeRateLimitResetCreditOutcome {
    Reset,
    NothingToReset,
    NoCredit,
    AlreadyRedeemed,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConsumeRateLimitResetCreditResponse {
    pub outcome: ConsumeRateLimitResetCreditOutcome,
}

impl CodexClient {
    pub async fn consume_rate_limit_reset_credit(
        &self,
        request: ConsumeRateLimitResetCreditRequest,
    ) -> ApiResult<ConsumeRateLimitResetCreditResponse> {
        let payload = self
            .request("account/rateLimitResetCredit/consume", json!(request))
            .await?;
        serde_json::from_value(payload)
            .map_err(|_| bad_gateway("invalid account/rateLimitResetCredit/consume response"))
    }
}
