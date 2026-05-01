use std::{collections::BTreeMap, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use utoipa::ToSchema;

use crate::{
    app_server::DynAppServer,
    error::{ApiError, ApiResult},
    schema::validate_client_request_params,
};

#[derive(Clone)]
pub struct CodexClient {
    app_server: DynAppServer,
}

impl CodexClient {
    pub fn new(app_server: DynAppServer) -> Self {
        Self { app_server }
    }

    pub async fn thread_list(
        &self,
        cwd: Option<String>,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> ApiResult<ThreadListResponse> {
        let payload = self
            .request(
                "thread/list",
                json!({
                    "cursor": cursor,
                    "limit": limit,
                    "cwd": cwd,
                }),
            )
            .await?;
        ThreadListResponse::from_payload(payload)
    }

    pub async fn thread_start(
        &self,
        project_id: String,
        cwd: String,
        payload: Value,
    ) -> ApiResult<ThreadCommandResponse> {
        let payload = merge_path_payload(
            "cwd",
            cwd,
            merge_path_payload("projectId", project_id, payload),
        );
        let payload = self.request("thread/start", payload).await?;
        ThreadCommandResponse::from_payload(payload)
    }

    pub async fn thread_read(&self, thread_id: String) -> ApiResult<ThreadDetailResponse> {
        let payload = self
            .request("thread/read", json!({ "threadId": thread_id }))
            .await?;
        ThreadDetailResponse::from_payload(payload)
    }

    pub async fn thread_resume(
        &self,
        thread_id: String,
        payload: Value,
    ) -> ApiResult<ThreadCommandResponse> {
        let payload = self
            .request(
                "thread/resume",
                merge_path_payload("threadId", thread_id, payload),
            )
            .await?;
        ThreadCommandResponse::from_payload(payload)
    }

    pub async fn thread_fork(
        &self,
        thread_id: String,
        payload: Value,
    ) -> ApiResult<ThreadCommandResponse> {
        let payload = self
            .request(
                "thread/fork",
                merge_path_payload("threadId", thread_id, payload),
            )
            .await?;
        ThreadCommandResponse::from_payload(payload)
    }

    pub async fn thread_archive(&self, thread_id: String) -> ApiResult<RawAppServerResponse> {
        self.raw_request("thread/archive", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn turn_start(
        &self,
        thread_id: String,
        input: Vec<UserInput>,
        options: TurnStartOptions,
    ) -> ApiResult<RawAppServerResponse> {
        let mut payload = json!({ "threadId": thread_id, "input": input });
        options.apply_to_payload(&mut payload);
        self.raw_request("turn/start", payload).await
    }

    pub async fn turn_steer(
        &self,
        thread_id: String,
        expected_turn_id: String,
        input: Vec<UserInput>,
    ) -> ApiResult<RawAppServerResponse> {
        self.raw_request(
            "turn/steer",
            json!({
                "threadId": thread_id,
                "expectedTurnId": expected_turn_id,
                "input": input,
            }),
        )
        .await
    }

    pub async fn turn_interrupt(
        &self,
        thread_id: String,
        turn_id: String,
    ) -> ApiResult<RawAppServerResponse> {
        self.raw_request(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": turn_id }),
        )
        .await
    }

    pub async fn account_read(&self, refresh_token: bool) -> ApiResult<AccountResponse> {
        let payload = self
            .request("account/read", json!({ "refreshToken": refresh_token }))
            .await?;
        AccountResponse::from_payload(payload)
    }

    pub async fn login_start(
        &self,
        codex_streamlined_login: Option<bool>,
    ) -> ApiResult<LoginStartResponse> {
        let mut payload = json!({ "type": "chatgpt" });
        if let Some(codex_streamlined_login) = codex_streamlined_login {
            payload["codexStreamlinedLogin"] = Value::Bool(codex_streamlined_login);
        }
        let payload = self.request("account/login/start", payload).await?;
        LoginStartResponse::from_payload(payload)
    }

    pub async fn login_cancel(&self, login_id: String) -> ApiResult<RawAppServerResponse> {
        self.raw_request("account/login/cancel", json!({ "loginId": login_id }))
            .await
    }

    pub async fn logout(&self) -> ApiResult<RawAppServerResponse> {
        self.raw_request("account/logout", Value::Null).await
    }

    pub async fn rate_limits_read(&self) -> ApiResult<RateLimitsResponse> {
        let payload = self.request("account/rateLimits/read", Value::Null).await?;
        RateLimitsResponse::from_payload(payload)
    }

    pub async fn model_list(&self, include_hidden: bool) -> ApiResult<ModelListResponse> {
        let payload = self
            .request("model/list", json!({ "includeHidden": include_hidden }))
            .await?;
        ModelListResponse::from_payload(payload, include_hidden)
    }

    async fn raw_request(&self, method: &str, params: Value) -> ApiResult<RawAppServerResponse> {
        let payload = self.request(method, params).await?;
        Ok(RawAppServerResponse { payload })
    }

    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        validate_client_request_params(method, params.clone())?;
        self.app_server.request(method, params).await
    }
}

pub fn client(app_server: &DynAppServer) -> CodexClient {
    CodexClient::new(Arc::clone(app_server))
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_policy: Option<Value>,
}

impl TurnStartOptions {
    fn apply_to_payload(self, payload: &mut Value) {
        if let Some(model) = self.model {
            payload["model"] = Value::String(model);
        }
        if let Some(effort) = self.effort {
            payload["effort"] = Value::String(effort);
        }
        if let Some(service_tier) = self.service_tier {
            payload["serviceTier"] = Value::String(service_tier);
        }
        if let Some(approval_policy) = self.approval_policy {
            payload["approvalPolicy"] = Value::String(approval_policy);
        }
        if let Some(approvals_reviewer) = self.approvals_reviewer {
            payload["approvalsReviewer"] = Value::String(approvals_reviewer);
        }
        if let Some(sandbox_policy) = self.sandbox_policy {
            payload["sandboxPolicy"] = sandbox_policy;
        }
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RawAppServerResponse {
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UserInput {
    Text {
        text: String,
        #[serde(
            default,
            rename = "text_elements",
            skip_serializing_if = "Vec::is_empty"
        )]
        text_elements: Vec<TextElement>,
    },
    Image {
        url: String,
    },
    LocalImage {
        path: String,
    },
    Skill {
        name: String,
        path: String,
    },
    Mention {
        name: String,
        path: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextElement {
    #[serde(rename = "byteRange")]
    pub byte_range: ByteRange,
    pub placeholder: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ByteRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListResponse {
    pub threads: Vec<ThreadSummary>,
    pub next_cursor: Option<String>,
    pub backwards_cursor: Option<String>,
    pub raw_payload: Value,
}

impl ThreadListResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let threads = payload
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("thread/list response missing data array"))?
            .iter()
            .map(ThreadSummary::from_payload)
            .collect::<ApiResult<Vec<_>>>()?;

        Ok(Self {
            threads,
            next_cursor: optional_string(&payload, "nextCursor"),
            backwards_cursor: optional_string(&payload, "backwardsCursor"),
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub name: Option<String>,
    pub cwd: String,
    pub status: ThreadStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub source: Option<String>,
    pub preview: Option<Value>,
    pub raw_payload: Value,
}

impl ThreadSummary {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            id: required_string(payload, "id")?,
            name: optional_string(payload, "name"),
            cwd: required_string(payload, "cwd")?,
            status: required_thread_status(payload)?,
            created_at: required_i64(payload, "createdAt")?,
            updated_at: required_i64(payload, "updatedAt")?,
            source: optional_string(payload, "source"),
            preview: payload.get("preview").cloned(),
            raw_payload: payload.clone(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThreadStatus {
    NotLoaded,
    Idle,
    SystemError,
    Active,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDetailResponse {
    pub thread: ThreadSummary,
    pub raw_payload: Value,
}

impl ThreadDetailResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let thread = payload
            .get("thread")
            .ok_or_else(|| bad_gateway("thread/read response missing thread"))?;
        Ok(Self {
            thread: ThreadSummary::from_payload(thread)?,
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCommandResponse {
    pub thread: ThreadSummary,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub raw_payload: Value,
}

impl ThreadCommandResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let thread = payload
            .get("thread")
            .ok_or_else(|| bad_gateway("thread command response missing thread"))?;
        Ok(Self {
            thread: ThreadSummary::from_payload(thread)?,
            cwd: optional_string(&payload, "cwd"),
            model: optional_string(&payload, "model"),
            model_provider: optional_string(&payload, "modelProvider"),
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountResponse {
    pub requires_openai_auth: bool,
    pub account: Option<AccountSummary>,
    pub raw_payload: Value,
}

impl AccountResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let requires_openai_auth = payload
            .get("requiresOpenaiAuth")
            .and_then(Value::as_bool)
            .ok_or_else(|| bad_gateway("account/read response missing requiresOpenaiAuth"))?;
        let account = payload
            .get("account")
            .filter(|account| !account.is_null())
            .map(AccountSummary::from_payload)
            .transpose()?;
        Ok(Self {
            requires_openai_auth,
            account,
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub account_type: String,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub raw_payload: Value,
}

impl AccountSummary {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            account_type: required_string(payload, "type")?,
            email: optional_string(payload, "email"),
            plan_type: optional_string(payload, "planType"),
            raw_payload: payload.clone(),
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartResponse {
    pub login_type: String,
    pub login_id: Option<String>,
    pub auth_url: Option<String>,
    pub user_code: Option<String>,
    pub verification_url: Option<String>,
    pub raw_payload: Value,
}

impl LoginStartResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        Ok(Self {
            login_type: required_string(&payload, "type")?,
            login_id: optional_string(&payload, "loginId"),
            auth_url: optional_string(&payload, "authUrl"),
            user_code: optional_string(&payload, "userCode"),
            verification_url: optional_string(&payload, "verificationUrl"),
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelListResponse {
    pub models: Vec<ModelSummary>,
    pub next_cursor: Option<String>,
    pub raw_payload: Value,
}

impl ModelListResponse {
    fn from_payload(payload: Value, include_hidden: bool) -> ApiResult<Self> {
        let models = payload
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("model/list response missing data array"))?
            .iter()
            .map(ModelSummary::from_payload)
            .filter_map(|model| match model {
                Ok(model) if include_hidden || !model.hidden => Some(Ok(model)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<ApiResult<Vec<_>>>()?;

        Ok(Self {
            models,
            next_cursor: optional_string(&payload, "nextCursor"),
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub hidden: bool,
    pub is_default: bool,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<ReasoningEffortOption>,
    pub input_modalities: Vec<String>,
    pub upgrade: Option<String>,
    pub raw_payload: Value,
}

impl ModelSummary {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            id: required_string(payload, "id")?,
            model: required_string(payload, "model")?,
            display_name: required_string(payload, "displayName")?,
            description: required_string(payload, "description")?,
            hidden: required_bool(payload, "hidden")?,
            is_default: required_bool(payload, "isDefault")?,
            default_reasoning_effort: required_string(payload, "defaultReasoningEffort")?,
            supported_reasoning_efforts: payload
                .get("supportedReasoningEfforts")
                .and_then(Value::as_array)
                .ok_or_else(|| bad_gateway("model missing supportedReasoningEfforts"))?
                .iter()
                .map(ReasoningEffortOption::from_payload)
                .collect::<ApiResult<Vec<_>>>()?,
            input_modalities: payload
                .get("inputModalities")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_else(|| vec!["text".to_string(), "image".to_string()]),
            upgrade: optional_string(payload, "upgrade"),
            raw_payload: payload.clone(),
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEffortOption {
    pub reasoning_effort: String,
    pub description: String,
}

impl ReasoningEffortOption {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            reasoning_effort: required_string(payload, "reasoningEffort")?,
            description: required_string(payload, "description")?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitsResponse {
    pub rate_limits: Option<RateLimitSnapshot>,
    pub rate_limits_by_limit_id: Option<BTreeMap<String, RateLimitSnapshot>>,
    pub raw_payload: Value,
}

impl RateLimitsResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        if payload.get("rateLimits").is_none() {
            return Err(bad_gateway(
                "account/rateLimits/read response missing rateLimits",
            ));
        }
        let rate_limits = payload
            .get("rateLimits")
            .filter(|value| !value.is_null())
            .map(RateLimitSnapshot::from_payload)
            .transpose()?;
        let rate_limits_by_limit_id = payload
            .get("rateLimitsByLimitId")
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .map(|(key, value)| Ok((key.clone(), RateLimitSnapshot::from_payload(value)?)))
                    .collect::<ApiResult<BTreeMap<_, _>>>()
            })
            .transpose()?;
        Ok(Self {
            rate_limits,
            rate_limits_by_limit_id,
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitSnapshot {
    pub limit_id: Option<String>,
    pub limit_name: Option<String>,
    pub plan_type: Option<String>,
    pub rate_limit_reached_type: Option<String>,
    pub primary: Option<RateLimitWindow>,
    pub secondary: Option<RateLimitWindow>,
    pub credits: Option<CreditsSnapshot>,
}

impl RateLimitSnapshot {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            limit_id: optional_string(payload, "limitId"),
            limit_name: optional_string(payload, "limitName"),
            plan_type: optional_string(payload, "planType"),
            rate_limit_reached_type: optional_string(payload, "rateLimitReachedType"),
            primary: payload
                .get("primary")
                .filter(|value| !value.is_null())
                .map(RateLimitWindow::from_payload)
                .transpose()?,
            secondary: payload
                .get("secondary")
                .filter(|value| !value.is_null())
                .map(RateLimitWindow::from_payload)
                .transpose()?,
            credits: payload
                .get("credits")
                .filter(|value| !value.is_null())
                .map(CreditsSnapshot::from_payload)
                .transpose()?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    pub used_percent: i64,
    pub resets_at: Option<i64>,
    pub window_duration_mins: Option<i64>,
}

impl RateLimitWindow {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            used_percent: required_i64(payload, "usedPercent")?,
            resets_at: optional_i64(payload, "resetsAt"),
            window_duration_mins: optional_i64(payload, "windowDurationMins"),
        })
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreditsSnapshot {
    pub has_credits: bool,
    pub unlimited: bool,
    pub balance: Option<String>,
}

impl CreditsSnapshot {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            has_credits: required_bool(payload, "hasCredits")?,
            unlimited: required_bool(payload, "unlimited")?,
            balance: optional_string(payload, "balance"),
        })
    }
}

fn merge_path_payload(field: &str, value: String, payload: Value) -> Value {
    let mut payload = match payload {
        Value::Object(map) => Value::Object(map),
        other => json!({ "payload": other }),
    };
    payload[field] = Value::String(value);
    payload
}

fn required_string(payload: &Value, field: &str) -> ApiResult<String> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| bad_gateway(format!("missing string field {field}")))
}

fn optional_string(payload: &Value, field: &str) -> Option<String> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn required_bool(payload: &Value, field: &str) -> ApiResult<bool> {
    payload
        .get(field)
        .and_then(Value::as_bool)
        .ok_or_else(|| bad_gateway(format!("missing boolean field {field}")))
}

fn required_thread_status(payload: &Value) -> ApiResult<ThreadStatus> {
    let status_type = payload
        .get("status")
        .and_then(|status| status.get("type"))
        .and_then(Value::as_str)
        .ok_or_else(|| bad_gateway("missing thread status type"))?;

    match status_type {
        "notLoaded" => Ok(ThreadStatus::NotLoaded),
        "idle" => Ok(ThreadStatus::Idle),
        "systemError" => Ok(ThreadStatus::SystemError),
        "active" => Ok(ThreadStatus::Active),
        other => Err(bad_gateway(format!("unknown thread status type {other}"))),
    }
}

fn required_i64(payload: &Value, field: &str) -> ApiResult<i64> {
    payload
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| bad_gateway(format!("missing integer field {field}")))
}

fn optional_i64(payload: &Value, field: &str) -> Option<i64> {
    payload.get(field).and_then(Value::as_i64)
}

fn bad_gateway(message: impl Into<String>) -> ApiError {
    ApiError::BadGateway(format!("unexpected app-server payload: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex as StdMutex,
    };

    use async_trait::async_trait;

    use crate::{app_server::AppServer, error::ApiResult};

    use super::*;

    #[derive(Default)]
    struct RecordingServer {
        ready: AtomicBool,
        requests: StdMutex<Vec<(String, Value)>>,
        response: StdMutex<Value>,
    }

    #[async_trait]
    impl AppServer for RecordingServer {
        fn is_ready(&self) -> bool {
            self.ready.load(Ordering::SeqCst)
        }

        async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
            self.requests
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            Ok(self.response.lock().unwrap().clone())
        }

        async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn adapter_maps_thread_and_turn_methods() {
        let server = Arc::new(RecordingServer {
            ready: AtomicBool::new(true),
            response: StdMutex::new(thread_command_payload("thread-1")),
            ..Default::default()
        });
        let client = CodexClient::new(server.clone());

        let _ = client
            .thread_start(
                "project-1".to_string(),
                "/workspace".to_string(),
                json!({"prompt": "hi"}),
            )
            .await
            .unwrap();
        let _ = client
            .thread_resume("thread-1".to_string(), json!({"target": "latest"}))
            .await
            .unwrap();
        let _ = client
            .thread_fork("thread-1".to_string(), json!({"fromItemId": "item-1"}))
            .await
            .unwrap();
        let _ = client
            .turn_steer(
                "thread-1".to_string(),
                "turn-1".to_string(),
                vec![UserInput::Text {
                    text: "continue".to_string(),
                    text_elements: Vec::new(),
                }],
            )
            .await
            .unwrap();

        let requests = server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/start");
        assert_eq!(requests[0].1["projectId"], "project-1");
        assert_eq!(requests[0].1["cwd"], "/workspace");
        assert_eq!(requests[1].0, "thread/resume");
        assert_eq!(requests[2].0, "thread/fork");
        assert_eq!(requests[3].0, "turn/steer");
        assert_eq!(requests[3].1["expectedTurnId"], "turn-1");
    }

    #[tokio::test]
    async fn adapter_maps_thread_list_read_archive_and_turn_start_interrupt_methods() {
        let server = Arc::new(RecordingServer {
            ready: AtomicBool::new(true),
            response: StdMutex::new(json!({"data": [], "nextCursor": null})),
            ..Default::default()
        });
        let client = CodexClient::new(server.clone());

        client
            .thread_list(
                Some("/workspace".to_string()),
                Some("cursor-1".to_string()),
                Some(25),
            )
            .await
            .unwrap();
        *server.response.lock().unwrap() = json!({"thread": thread_summary_payload("thread-1")});
        client.thread_read("thread-1".to_string()).await.unwrap();
        *server.response.lock().unwrap() = json!({"archived": true});
        client.thread_archive("thread-1".to_string()).await.unwrap();
        client
            .turn_start(
                "thread-1".to_string(),
                vec![UserInput::Text {
                    text: "hi".to_string(),
                    text_elements: Vec::new(),
                }],
                TurnStartOptions::default(),
            )
            .await
            .unwrap();
        client
            .turn_interrupt("thread-1".to_string(), "turn-1".to_string())
            .await
            .unwrap();

        let requests = server.requests.lock().unwrap();
        assert_eq!(
            requests[0],
            (
                "thread/list".to_string(),
                json!({"cursor": "cursor-1", "limit": 25, "cwd": "/workspace"})
            )
        );
        assert_eq!(
            requests[1],
            ("thread/read".to_string(), json!({"threadId": "thread-1"}))
        );
        assert_eq!(
            requests[2],
            (
                "thread/archive".to_string(),
                json!({"threadId": "thread-1"})
            )
        );
        assert_eq!(
            requests[3],
            (
                "turn/start".to_string(),
                json!({"threadId": "thread-1", "input": [{"type": "text", "text": "hi"}]})
            )
        );
        assert_eq!(
            requests[4],
            (
                "turn/interrupt".to_string(),
                json!({"threadId": "thread-1", "turnId": "turn-1"})
            )
        );
    }

    #[tokio::test]
    async fn adapter_maps_account_login_rate_limit_and_model_methods() {
        let server = Arc::new(RecordingServer {
            ready: AtomicBool::new(true),
            response: StdMutex::new(json!({"requiresOpenaiAuth": true, "account": null})),
            ..Default::default()
        });
        let client = CodexClient::new(server.clone());

        client.account_read(true).await.unwrap();
        *server.response.lock().unwrap() =
            json!({"type": "chatgpt", "loginId": "login-1", "authUrl": "https://example.test"});
        client.login_start(Some(false)).await.unwrap();
        client.login_cancel("login-1".to_string()).await.unwrap();
        client.logout().await.unwrap();
        *server.response.lock().unwrap() = json!({"rateLimits": null, "rateLimitsByLimitId": null});
        client.rate_limits_read().await.unwrap();
        *server.response.lock().unwrap() = json!({"data": [], "nextCursor": null});
        client.model_list(false).await.unwrap();

        let requests = server.requests.lock().unwrap();
        assert_eq!(
            requests[0],
            ("account/read".to_string(), json!({"refreshToken": true}))
        );
        assert_eq!(
            requests[1],
            (
                "account/login/start".to_string(),
                json!({"type": "chatgpt", "codexStreamlinedLogin": false})
            )
        );
        assert_eq!(
            requests[2],
            (
                "account/login/cancel".to_string(),
                json!({"loginId": "login-1"})
            )
        );
        assert_eq!(requests[3], ("account/logout".to_string(), Value::Null));
        assert_eq!(
            requests[4],
            ("account/rateLimits/read".to_string(), Value::Null)
        );
        assert_eq!(
            requests[5],
            ("model/list".to_string(), json!({"includeHidden": false}))
        );
    }

    #[test]
    fn thread_list_normalization_accepts_missing_optional_fields_and_rejects_drift() {
        let response = ThreadListResponse::from_payload(json!({
            "data": [thread_summary_payload("thread-1")]
        }))
        .unwrap();

        assert_eq!(response.threads[0].id, "thread-1");
        assert_eq!(response.threads[0].name, None);
        assert_eq!(response.next_cursor, None);
        assert!(
            ThreadListResponse::from_payload(json!({"data": [{"cwd": "/workspace"}]})).is_err()
        );
        assert!(ThreadListResponse::from_payload(json!({
            "data": [{
                "id": "thread-1",
                "cwd": "/workspace",
                "status": "idle",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }]
        }))
        .is_err());
        assert!(ThreadListResponse::from_payload(json!({
            "data": [{
                "id": "thread-1",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": 1_767_225_600_i64
            }]
        }))
        .is_err());
        assert!(ThreadListResponse::from_payload(json!({
            "data": [{
                "id": "thread-1",
                "cwd": "/workspace",
                "status": {"type": "unknown"},
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }]
        }))
        .is_err());
    }

    #[test]
    fn thread_normalization_accepts_schema_correct_status_and_timestamps() {
        let response = ThreadListResponse::from_payload(json!({
            "data": [{
                "id": "thread-1",
                "cliVersion": "0.128.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "preview": "hello",
                "source": "cli",
                "status": {"type": "active", "activeFlags": ["waitingOnUserInput"]},
                "turns": [],
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_660_i64
            }]
        }))
        .unwrap();

        let thread = &response.threads[0];
        assert_eq!(thread.status, ThreadStatus::Active);
        assert_eq!(thread.created_at, 1_767_225_600);
        assert_eq!(thread.updated_at, 1_767_225_660);
    }

    #[test]
    fn thread_detail_normalization_accepts_missing_optional_fields_and_rejects_drift() {
        let response = ThreadDetailResponse::from_payload(json!({
            "thread": thread_summary_payload("thread-1")
        }))
        .unwrap();

        assert_eq!(response.thread.id, "thread-1");
        assert_eq!(response.thread.source.as_deref(), Some("cli"));
        assert!(ThreadDetailResponse::from_payload(json!({"thread": {"id": "thread-1"}})).is_err());
        assert!(ThreadDetailResponse::from_payload(json!({})).is_err());
    }

    #[test]
    fn thread_command_normalization_accepts_missing_optional_fields_and_rejects_drift() {
        let response = ThreadCommandResponse::from_payload(json!({
            "thread": thread_summary_payload("thread-1")
        }))
        .unwrap();

        assert_eq!(response.thread.id, "thread-1");
        assert_eq!(response.model, None);
        assert_eq!(response.model_provider, None);
        assert!(
            ThreadCommandResponse::from_payload(json!({"thread": {"id": "thread-1"}})).is_err()
        );
        assert!(ThreadCommandResponse::from_payload(json!({})).is_err());
    }

    #[test]
    fn model_list_normalization_accepts_optional_fields_and_rejects_drift() {
        let response = ModelListResponse::from_payload(
            json!({
                "data": [model_payload("visible", false), model_payload("hidden", true)]
            }),
            false,
        )
        .unwrap();

        assert_eq!(response.models.len(), 1);
        assert_eq!(response.models[0].input_modalities, vec!["text", "image"]);
        assert_eq!(response.models[0].upgrade, None);
        assert!(
            ModelListResponse::from_payload(json!({"data": [{"id": "model"}]}), false).is_err()
        );
    }

    #[test]
    fn account_normalization_accepts_optional_account_fields_and_rejects_drift() {
        let unauthenticated = AccountResponse::from_payload(json!({
            "requiresOpenaiAuth": true,
            "account": null
        }))
        .unwrap();
        assert!(unauthenticated.account.is_none());

        let authenticated = AccountResponse::from_payload(json!({
            "requiresOpenaiAuth": false,
            "account": {"type": "chatgpt"}
        }))
        .unwrap();
        let account = authenticated.account.unwrap();
        assert_eq!(account.account_type, "chatgpt");
        assert_eq!(account.email, None);
        assert!(AccountResponse::from_payload(json!({"account": null})).is_err());
        assert!(AccountResponse::from_payload(json!({
            "requiresOpenaiAuth": false,
            "account": {}
        }))
        .is_err());
    }

    #[test]
    fn rate_limit_normalization_accepts_optional_fields_and_rejects_drift() {
        let empty = RateLimitsResponse::from_payload(json!({
            "rateLimits": null,
            "rateLimitsByLimitId": null
        }))
        .unwrap();
        assert!(empty.rate_limits.is_none());

        let response = RateLimitsResponse::from_payload(json!({
            "rateLimits": {
                "primary": {"usedPercent": 42},
                "credits": {"hasCredits": false, "unlimited": true}
            },
            "rateLimitsByLimitId": {
                "codex": {"limitId": "codex"}
            }
        }))
        .unwrap();
        assert_eq!(
            response.rate_limits.unwrap().primary.unwrap().used_percent,
            42
        );
        assert!(RateLimitsResponse::from_payload(json!({})).is_err());
        assert!(RateLimitsResponse::from_payload(json!({
            "rateLimits": {"primary": {}}
        }))
        .is_err());
        assert!(RateLimitsResponse::from_payload(json!({
            "rateLimits": {"credits": {"hasCredits": true}}
        }))
        .is_err());
    }

    #[test]
    fn login_start_normalization_accepts_optional_fields_and_rejects_drift() {
        let response = LoginStartResponse::from_payload(json!({"type": "chatgpt"})).unwrap();

        assert_eq!(response.login_type, "chatgpt");
        assert_eq!(response.login_id, None);
        assert_eq!(response.auth_url, None);
        assert!(LoginStartResponse::from_payload(json!({"loginId": "login-1"})).is_err());
    }

    fn thread_command_payload(id: &str) -> Value {
        json!({
            "thread": thread_summary_payload(id),
            "cwd": "/workspace",
            "model": "gpt-5.4",
            "modelProvider": "openai"
        })
    }

    fn thread_summary_payload(id: &str) -> Value {
        json!({
            "id": id,
            "cliVersion": "0.128.0",
            "cwd": "/workspace",
            "ephemeral": false,
            "modelProvider": "openai",
            "preview": "hello",
            "source": "cli",
            "status": {"type": "idle"},
            "turns": [],
            "createdAt": 1_767_225_600_i64,
            "updatedAt": 1_767_225_600_i64
        })
    }

    fn model_payload(id: &str, hidden: bool) -> Value {
        json!({
            "id": id,
            "model": id,
            "displayName": id,
            "description": "Test model",
            "hidden": hidden,
            "isDefault": false,
            "defaultReasoningEffort": "medium",
            "supportedReasoningEfforts": [
                {"reasoningEffort": "medium", "description": "Balanced"}
            ]
        })
    }
}
