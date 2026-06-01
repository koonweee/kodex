use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use tokio::time::{sleep, Duration};
use utoipa::ToSchema;

use crate::{
    app_server::DynAppServer,
    error::{ApiError, ApiResult},
    schema::validate_client_request_params,
};

const ROLLOUT_LOAD_RETRY_ATTEMPTS: usize = 6;
const ROLLOUT_LOAD_RETRY_DELAY: Duration = Duration::from_millis(50);
const TIMELINE_PREVIEW_STRING_LIMIT: usize = 16_384;

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
                    "sortKey": "updated_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true,
                }),
            )
            .await?;
        ThreadListResponse::from_payload(payload)
    }

    pub async fn thread_list_recent_updated(&self, limit: u32) -> ApiResult<ThreadListResponse> {
        let payload = self
            .request(
                "thread/list",
                json!({
                    "cursor": null,
                    "limit": limit,
                    "cwd": null,
                    "sortKey": "updated_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true,
                }),
            )
            .await?;
        ThreadListResponse::from_payload(payload)
    }

    pub async fn thread_list_cwds_updated(
        &self,
        cwds: Vec<String>,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> ApiResult<ThreadListResponse> {
        let payload = self
            .request(
                "thread/list",
                json!({
                    "cursor": cursor,
                    "limit": limit,
                    "cwd": cwds,
                    "sortKey": "updated_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true,
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
        let payload = require_extended_history(merge_path_payload(
            "cwd",
            cwd,
            merge_path_payload("projectId", project_id, payload),
        ));
        let payload = self.request("thread/start", payload).await?;
        ThreadCommandResponse::from_payload(payload)
    }

    pub async fn thread_start_in_cwd(
        &self,
        cwd: String,
        payload: Value,
    ) -> ApiResult<ThreadCommandResponse> {
        let payload = require_extended_history(merge_path_payload("cwd", cwd, payload));
        let payload = self.request("thread/start", payload).await?;
        ThreadCommandResponse::from_payload(payload)
    }

    pub async fn thread_read(&self, thread_id: String) -> ApiResult<ThreadDetailResponse> {
        let payload = self
            .request_retrying_rollout_load(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": true }),
            )
            .await?;
        ThreadDetailResponse::from_payload(payload)
    }

    pub async fn thread_read_summary(&self, thread_id: String) -> ApiResult<ThreadSummary> {
        let payload = self
            .request_retrying_rollout_load(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": false }),
            )
            .await?;
        let thread = payload
            .get("thread")
            .ok_or_else(|| bad_gateway("thread/read response missing thread"))?;
        ThreadSummary::from_payload(thread)
    }

    pub async fn thread_read_full_history(
        &self,
        thread_id: String,
    ) -> ApiResult<ThreadDetailResponse> {
        let payload = self
            .request_retrying_rollout_load(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": false }),
            )
            .await?;
        let turns = match self.thread_turns_list_full(thread_id).await {
            Ok(turns) => turns,
            Err(error) if is_thread_history_not_materialized_error(&error) => Vec::new(),
            Err(error) => return Err(error),
        };
        ThreadDetailResponse::from_thread_payload_and_turns(payload, turns)
    }

    pub async fn thread_read_history_window(
        &self,
        thread_id: String,
        limit: u32,
    ) -> ApiResult<ThreadDetailResponse> {
        self.thread_read_history_page(thread_id, None, limit).await
    }

    pub async fn thread_read_history_page(
        &self,
        thread_id: String,
        cursor: Option<String>,
        limit: u32,
    ) -> ApiResult<ThreadDetailResponse> {
        let payload = self
            .request_retrying_rollout_load(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": false }),
            )
            .await?;
        let mut page = match self
            .thread_turns_list_page(
                thread_id.clone(),
                cursor,
                SortDirection::Desc,
                ThreadTurnItemsView::Full,
                Some(limit),
            )
            .await
        {
            Ok(page) => page,
            Err(error) if is_thread_history_not_materialized_error(&error) => {
                ThreadTurnsListPage::empty()
            }
            Err(error) => return Err(error),
        };
        page.data.reverse();
        let last_completed_agent_turn_seq =
            self.thread_completed_turn_count_light(thread_id).await?;
        let history_page = ThreadTimelineWindowPage {
            older_cursor: page.next_cursor.clone(),
            newer_cursor: page.backwards_cursor.clone(),
            has_older: page.next_cursor.is_some(),
            limit,
            loaded_turn_count: page.data.len() as u32,
            reset_window: false,
        };
        ThreadDetailResponse::from_thread_payload_turns_and_history(
            payload,
            page.data,
            Some(history_page),
            last_completed_agent_turn_seq,
        )
    }

    pub async fn thread_turns_list_page(
        &self,
        thread_id: String,
        cursor: Option<String>,
        sort_direction: SortDirection,
        items_view: ThreadTurnItemsView,
        limit: Option<u32>,
    ) -> ApiResult<ThreadTurnsListPage> {
        let payload = self
            .request_retrying_rollout_load(
                "thread/turns/list",
                json!({
                    "threadId": thread_id,
                    "cursor": cursor,
                    "sortDirection": sort_direction.as_str(),
                    "itemsView": items_view.as_str(),
                    "limit": limit,
                }),
            )
            .await?;
        ThreadTurnsListPage::from_payload(payload)
    }

    pub async fn thread_turns_list_full(
        &self,
        thread_id: String,
    ) -> ApiResult<Vec<ThreadTurnSnapshot>> {
        let mut turns = Vec::new();
        let mut cursor = None;
        loop {
            let page = self
                .thread_turns_list_page(
                    thread_id.clone(),
                    cursor,
                    SortDirection::Asc,
                    ThreadTurnItemsView::Full,
                    None,
                )
                .await?;
            turns.extend(page.data);
            let Some(next_cursor) = page.next_cursor else {
                break;
            };
            cursor = Some(next_cursor);
        }
        Ok(turns)
    }

    pub async fn thread_completed_turn_count_light(
        &self,
        thread_id: String,
    ) -> ApiResult<Option<i64>> {
        let mut cursor = None;
        let mut completed = 0_i64;
        let mut saw_turns = false;
        loop {
            let payload = match self
                .request_retrying_rollout_load(
                    "thread/turns/list",
                    json!({
                        "threadId": thread_id.clone(),
                        "cursor": cursor,
                        "sortDirection": SortDirection::Desc.as_str(),
                        "itemsView": ThreadTurnItemsView::NotLoaded.as_str(),
                        "limit": 200,
                    }),
                )
                .await
            {
                Ok(payload) => payload,
                Err(error) if is_thread_history_not_materialized_error(&error) => {
                    return Ok(None);
                }
                Err(error) => return Err(error),
            };
            let data = payload
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| bad_gateway("thread/turns/list response missing data array"))?;
            saw_turns |= !data.is_empty();
            completed += data
                .iter()
                .filter(|turn| {
                    is_terminal_turn_status(
                        &status_type(turn.get("status")).unwrap_or_else(|| "unknown".to_string()),
                    )
                })
                .count() as i64;
            let Some(next_cursor) = optional_string(&payload, "nextCursor") else {
                break;
            };
            cursor = Some(next_cursor);
        }
        Ok(saw_turns.then_some(completed))
    }

    pub async fn thread_loaded_list(&self) -> ApiResult<ThreadLoadedListResponse> {
        let payload = self
            .request(
                "thread/loaded/list",
                json!({
                    "cursor": null,
                    "limit": null,
                }),
            )
            .await?;
        ThreadLoadedListResponse::from_payload(payload)
    }

    pub async fn thread_resume(
        &self,
        thread_id: String,
        payload: Value,
    ) -> ApiResult<ThreadCommandResponse> {
        let payload = require_metadata_only_resume(require_extended_history(merge_path_payload(
            "threadId", thread_id, payload,
        )));
        let payload = self.request("thread/resume", payload).await?;
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
                require_extended_history(merge_path_payload("threadId", thread_id, payload)),
            )
            .await?;
        ThreadCommandResponse::from_payload(payload)
    }

    pub async fn thread_archive(&self, thread_id: String) -> ApiResult<RawAppServerResponse> {
        self.raw_request("thread/archive", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn thread_set_name(
        &self,
        thread_id: String,
        name: String,
    ) -> ApiResult<RawAppServerResponse> {
        self.raw_request(
            "thread/name/set",
            json!({ "threadId": thread_id, "name": name }),
        )
        .await
    }

    pub async fn thread_update_settings(
        &self,
        thread_id: String,
        request: ThreadSettingsUpdateRequest,
    ) -> ApiResult<RawAppServerResponse> {
        self.raw_request(
            "thread/settings/update",
            request.into_app_server_payload(thread_id),
        )
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
        let payload = self
            .request_retrying_rollout_load("turn/start", payload)
            .await?;
        Ok(RawAppServerResponse { payload })
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

    pub async fn mcp_server_status_list(
        &self,
        detail: McpServerStatusDetail,
    ) -> ApiResult<McpServerListResponse> {
        let mut cursor: Option<String> = None;
        let mut servers = Vec::new();
        loop {
            let payload = self
                .request(
                    "mcpServerStatus/list",
                    json!({
                        "cursor": cursor,
                        "detail": detail,
                        "limit": 100,
                    }),
                )
                .await?;
            let response = McpServerStatusPage::from_payload(payload)?;
            servers.extend(response.data);
            match response.next_cursor {
                Some(next_cursor) => cursor = Some(next_cursor),
                None => break,
            }
        }
        Ok(McpServerListResponse { servers })
    }

    pub async fn mcp_resource_read(
        &self,
        server: String,
        uri: String,
        thread_id: Option<String>,
    ) -> ApiResult<McpResourceReadResponse> {
        let payload = self
            .request(
                "mcpServer/resource/read",
                json!({
                    "server": server,
                    "threadId": thread_id,
                    "uri": uri,
                }),
            )
            .await?;
        McpResourceReadResponse::from_payload(payload)
    }

    pub async fn mcp_oauth_login(
        &self,
        name: String,
        scopes: Option<Vec<String>>,
        timeout_secs: Option<i64>,
    ) -> ApiResult<McpOAuthLoginResponse> {
        let payload = self
            .request(
                "mcpServer/oauth/login",
                json!({
                    "name": name,
                    "scopes": scopes,
                    "timeoutSecs": timeout_secs,
                }),
            )
            .await?;
        McpOAuthLoginResponse::from_payload(payload)
    }

    pub async fn mcp_reload(&self) -> ApiResult<McpReloadResponse> {
        self.request("config/mcpServer/reload", Value::Null).await?;
        Ok(McpReloadResponse { reloaded: true })
    }

    pub async fn mcp_configured_servers(&self) -> ApiResult<ConfiguredMcpServerListResponse> {
        let payload = self
            .request("config/read", json!({ "cwd": null, "includeLayers": true }))
            .await?;
        ConfiguredMcpServerListResponse::from_config_payload(payload)
    }

    pub async fn mcp_write_server(
        &self,
        name: String,
        request: McpServerInstallRequest,
    ) -> ApiResult<ConfiguredMcpServer> {
        validate_mcp_server_name(&name)?;
        let value = request.config_value();
        self.config_batch_write(vec![config_edit(&format!("mcp_servers.{name}"), value)])
            .await?;
        Ok(request.into_configured(name))
    }

    pub async fn mcp_replace_server(
        &self,
        name: String,
        request: McpServerInstallRequest,
    ) -> ApiResult<ConfiguredMcpServer> {
        validate_mcp_server_name(&name)?;
        let payload = self
            .request("config/read", json!({ "cwd": null, "includeLayers": true }))
            .await?;
        let existing = payload
            .get("config")
            .and_then(|config| config.get("mcp_servers"))
            .and_then(|servers| servers.get(&name));
        let value = request.config_value_with_existing(existing);
        self.config_batch_write(vec![config_edit(
            &format!("mcp_servers.{name}"),
            value.clone(),
        )])
        .await?;
        Ok(
            ConfiguredMcpServer::from_config(&name, &value).unwrap_or(ConfiguredMcpServer {
                name,
                enabled: true,
                required: None,
                startup_timeout_sec: None,
                tool_timeout_sec: None,
                scopes: Vec::new(),
                enabled_tools: Vec::new(),
                has_stored_secrets: false,
                transport: ConfiguredMcpTransport::Unknown,
            }),
        )
    }

    pub async fn mcp_set_server_enabled(
        &self,
        name: String,
        enabled: bool,
    ) -> ApiResult<RawAppServerResponse> {
        validate_mcp_server_name(&name)?;
        self.config_batch_write(vec![config_edit(
            &format!("mcp_servers.{name}.enabled"),
            Value::Bool(enabled),
        )])
        .await
    }

    pub async fn mcp_remove_server(&self, name: String) -> ApiResult<RawAppServerResponse> {
        validate_mcp_server_name(&name)?;
        self.config_batch_write(vec![config_edit(
            &format!("mcp_servers.{name}"),
            Value::Null,
        )])
        .await
    }

    pub async fn composer_settings(
        &self,
        cwd: Option<String>,
    ) -> ApiResult<ComposerSettingsResponse> {
        let payload = self
            .request("config/read", json!({ "cwd": cwd, "includeLayers": false }))
            .await?;
        ComposerSettingsResponse::from_payload(payload)
    }

    pub async fn update_composer_settings(
        &self,
        request: ComposerSettingsUpdateRequest,
    ) -> ApiResult<ComposerSettingsUpdateResponse> {
        let edits = request.config_edits();
        if edits.is_empty() {
            return Ok(ComposerSettingsUpdateResponse { saved: true });
        }

        self.config_batch_write(edits).await?;
        Ok(ComposerSettingsUpdateResponse { saved: true })
    }

    async fn config_batch_write(&self, edits: Vec<Value>) -> ApiResult<RawAppServerResponse> {
        let payload = self
            .request(
                "config/batchWrite",
                json!({ "edits": edits, "reloadUserConfig": true }),
            )
            .await?;
        Ok(RawAppServerResponse { payload })
    }

    pub async fn skills_list(
        &self,
        cwds: Vec<String>,
        force_reload: bool,
    ) -> ApiResult<SkillsListResponse> {
        let payload = self
            .request(
                "skills/list",
                json!({
                    "cwds": cwds,
                    "forceReload": force_reload,
                }),
            )
            .await?;
        SkillsListResponse::from_payload(payload)
    }

    pub async fn marketplace_add(
        &self,
        source: String,
        ref_name: Option<String>,
        sparse_paths: Option<Vec<String>>,
    ) -> ApiResult<MarketplaceAddResponse> {
        let payload = self
            .request(
                "marketplace/add",
                json!({
                    "source": source,
                    "refName": ref_name,
                    "sparsePaths": sparse_paths,
                }),
            )
            .await?;
        MarketplaceAddResponse::from_payload(payload)
    }

    pub async fn plugin_list(&self, cwds: Option<Vec<String>>) -> ApiResult<PluginListResponse> {
        let payload = self.request("plugin/list", json!({ "cwds": cwds })).await?;
        PluginListResponse::from_payload(payload)
    }

    pub async fn plugin_read(
        &self,
        plugin_name: String,
        marketplace_path: Option<String>,
        remote_marketplace_name: Option<String>,
    ) -> ApiResult<PluginReadResponse> {
        let payload = self
            .request(
                "plugin/read",
                json!({
                    "pluginName": plugin_name,
                    "marketplacePath": marketplace_path,
                    "remoteMarketplaceName": remote_marketplace_name,
                }),
            )
            .await?;
        PluginReadResponse::from_payload(payload)
    }

    pub async fn plugin_install(
        &self,
        plugin_name: String,
        marketplace_path: Option<String>,
        remote_marketplace_name: Option<String>,
    ) -> ApiResult<PluginInstallResponse> {
        let payload = self
            .request(
                "plugin/install",
                json!({
                    "pluginName": plugin_name,
                    "marketplacePath": marketplace_path,
                    "remoteMarketplaceName": remote_marketplace_name,
                }),
            )
            .await?;
        PluginInstallResponse::from_payload(payload)
    }

    async fn raw_request(&self, method: &str, params: Value) -> ApiResult<RawAppServerResponse> {
        let payload = self.request(method, params).await?;
        Ok(RawAppServerResponse { payload })
    }

    async fn request_retrying_rollout_load(&self, method: &str, params: Value) -> ApiResult<Value> {
        let mut attempt = 0;
        loop {
            match self.request(method, params.clone()).await {
                Ok(payload) => return Ok(payload),
                Err(error)
                    if attempt + 1 < ROLLOUT_LOAD_RETRY_ATTEMPTS
                        && is_rollout_load_error(&error) =>
                {
                    attempt += 1;
                    sleep(ROLLOUT_LOAD_RETRY_DELAY).await;
                }
                Err(error) => return Err(error),
            }
        }
    }

    async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        validate_client_request_params(method, params.clone())?;
        self.app_server.request(method, params).await
    }
}

fn is_rollout_load_error(error: &ApiError) -> bool {
    let ApiError::BadGateway(message) = error else {
        return false;
    };
    let normalized = message.to_ascii_lowercase();
    normalized.contains("failed to load rollout")
        || normalized.contains("failed to load thread history")
        || (normalized.contains("rollout at") && normalized.contains(" is empty"))
}

fn is_thread_history_not_materialized_error(error: &ApiError) -> bool {
    let ApiError::BadGateway(message) = error else {
        return false;
    };
    let normalized = message.to_ascii_lowercase();
    normalized.contains("not materialized yet")
        && normalized.contains("thread/turns/list")
        && normalized.contains("before first user message")
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

#[derive(Debug, Default, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSettingsUpdateRequest {
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub model: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub effort: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub service_tier: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub approval_policy: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub approvals_reviewer: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub permissions: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_value_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub sandbox_policy: Option<Value>,
}

impl ThreadSettingsUpdateRequest {
    pub fn validate(&self) -> ApiResult<()> {
        let selects_permissions = self
            .permissions
            .as_ref()
            .is_some_and(|permissions| permissions.is_some());
        let selects_sandbox = self
            .sandbox_policy
            .as_ref()
            .is_some_and(|sandbox_policy| !sandbox_policy.is_null());
        if selects_permissions && selects_sandbox {
            return Err(ApiError::BadRequest(
                "permissions and sandboxPolicy cannot be combined".to_string(),
            ));
        }
        Ok(())
    }

    fn into_app_server_payload(self, thread_id: String) -> Value {
        let mut payload = json!({ "threadId": thread_id });
        if let Some(model) = self.model {
            payload["model"] = option_string_value(model);
        }
        if let Some(effort) = self.effort {
            payload["effort"] = option_string_value(effort);
        }
        if let Some(service_tier) = self.service_tier {
            payload["serviceTier"] = option_string_value(service_tier);
        }
        if let Some(approval_policy) = self.approval_policy {
            payload["approvalPolicy"] = option_string_value(approval_policy);
        }
        if let Some(approvals_reviewer) = self.approvals_reviewer {
            payload["approvalsReviewer"] = option_string_value(approvals_reviewer);
        }
        if let Some(permissions) = self.permissions {
            payload["permissions"] = option_string_value(permissions);
        }
        if let Some(sandbox_policy) = self.sandbox_policy {
            payload["sandboxPolicy"] = sandbox_policy;
        }
        payload
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RawAppServerResponse {
    pub payload: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpServerStatusDetail {
    Full,
    ToolsAndAuthOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerListResponse {
    pub servers: Vec<McpServerStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpServerStatusPage {
    data: Vec<McpServerStatus>,
    next_cursor: Option<String>,
}

impl McpServerStatusPage {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("mcpServerStatus/list response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    pub auth_status: McpAuthStatus,
    pub tools: BTreeMap<String, McpTool>,
    pub resources: Vec<McpResource>,
    pub resource_templates: Vec<McpResourceTemplate>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpAuthStatus {
    Unsupported,
    NotLoggedIn,
    BearerToken,
    #[serde(rename = "oAuth")]
    OAuth,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub input_schema: Value,
    #[serde(default)]
    pub output_schema: Option<Value>,
    #[serde(default)]
    pub annotations: Option<Value>,
    #[serde(default)]
    pub icons: Option<Value>,
    #[serde(default, rename = "_meta")]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpResource {
    pub name: String,
    pub uri: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub size: Option<i64>,
    #[serde(default)]
    pub annotations: Option<Value>,
    #[serde(default)]
    pub icons: Option<Value>,
    #[serde(default, rename = "_meta")]
    pub meta: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceTemplate {
    pub name: String,
    pub uri_template: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub annotations: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceReadResponse {
    pub contents: Vec<Value>,
}

impl McpResourceReadResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("mcpServer/resource/read response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthLoginRequest {
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    #[serde(default)]
    pub timeout_secs: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpOAuthLoginResponse {
    pub authorization_url: String,
}

impl McpOAuthLoginResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("mcpServer/oauth/login response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpReloadResponse {
    pub reloaded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredMcpServerListResponse {
    pub servers: Vec<ConfiguredMcpServer>,
}

impl ConfiguredMcpServerListResponse {
    fn from_config_payload(payload: Value) -> ApiResult<Self> {
        let entries = payload
            .get("config")
            .and_then(|config| config.get("mcp_servers"))
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|servers| servers.iter())
            .filter_map(|(name, value)| ConfiguredMcpServer::from_config(name, value))
            .collect();
        Ok(Self { servers: entries })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredMcpServer {
    pub name: String,
    pub enabled: bool,
    #[serde(default)]
    pub required: Option<bool>,
    #[serde(default)]
    pub startup_timeout_sec: Option<i64>,
    #[serde(default)]
    pub tool_timeout_sec: Option<i64>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub enabled_tools: Vec<String>,
    pub has_stored_secrets: bool,
    pub transport: ConfiguredMcpTransport,
}

impl ConfiguredMcpServer {
    fn from_config(name: &str, value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let transport = if object.get("url").and_then(Value::as_str).is_some() {
            ConfiguredMcpTransport::StreamableHttp {
                url: optional_string(value, "url").unwrap_or_default(),
                bearer_token_env_var: optional_string(value, "bearer_token_env_var"),
                oauth_resource: optional_string(value, "oauth_resource"),
                http_headers: masked_secret_map(value.get("http_headers")),
                env_http_headers: string_map(value.get("env_http_headers")),
            }
        } else if object.get("command").and_then(Value::as_str).is_some() {
            ConfiguredMcpTransport::Stdio {
                command: optional_string(value, "command").unwrap_or_default(),
                args: string_vec(value.get("args")),
                cwd: optional_string(value, "cwd"),
                env: masked_secret_map(value.get("env")),
                env_vars: env_var_names(value.get("env_vars")),
            }
        } else {
            ConfiguredMcpTransport::Unknown
        };
        let has_stored_secrets = match &transport {
            ConfiguredMcpTransport::Stdio { env, .. } => !env.is_empty(),
            ConfiguredMcpTransport::StreamableHttp { http_headers, .. } => !http_headers.is_empty(),
            ConfiguredMcpTransport::Unknown => false,
        };
        Some(Self {
            name: name.to_string(),
            enabled: value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            required: value.get("required").and_then(Value::as_bool),
            startup_timeout_sec: optional_i64(value, "startup_timeout_sec"),
            tool_timeout_sec: optional_i64(value, "tool_timeout_sec"),
            scopes: string_vec(value.get("scopes")),
            enabled_tools: string_vec(value.get("enabled_tools")),
            has_stored_secrets,
            transport,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConfiguredMcpTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: BTreeMap<String, ConfiguredMcpSecret>,
        #[serde(default, rename = "envVars")]
        env_vars: Vec<String>,
    },
    StreamableHttp {
        url: String,
        #[serde(default, rename = "bearerTokenEnvVar")]
        bearer_token_env_var: Option<String>,
        #[serde(default, rename = "oauthResource")]
        oauth_resource: Option<String>,
        #[serde(default, rename = "httpHeaders")]
        http_headers: BTreeMap<String, ConfiguredMcpSecret>,
        #[serde(default, rename = "envHttpHeaders")]
        env_http_headers: BTreeMap<String, String>,
    },
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConfiguredMcpSecret {
    pub configured: bool,
    pub masked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInstallRequest {
    pub name: String,
    pub transport: McpServerTransportRequest,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub required: Option<bool>,
    #[serde(default)]
    pub startup_timeout_sec: Option<i64>,
    #[serde(default)]
    pub tool_timeout_sec: Option<i64>,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    #[serde(default)]
    pub enabled_tools: Option<Vec<String>>,
}

impl McpServerInstallRequest {
    fn config_value(&self) -> Value {
        self.config_value_with_existing(None)
    }

    fn config_value_with_existing(&self, existing: Option<&Value>) -> Value {
        let mut value = match &self.transport {
            McpServerTransportRequest::Stdio {
                command,
                args,
                cwd,
                env,
                env_vars,
                clear_env,
            } => json!({
                "command": command,
                "args": args,
                "cwd": cwd,
                "env": merged_secret_object(existing.and_then(|value| value.get("env")), env, clear_env),
                "env_vars": env_vars,
            }),
            McpServerTransportRequest::StreamableHttp {
                url,
                bearer_token_env_var,
                oauth_resource,
                http_headers,
                env_http_headers,
                clear_http_headers,
            } => json!({
                "url": url,
                "bearer_token_env_var": bearer_token_env_var,
                "oauth_resource": oauth_resource,
                "http_headers": merged_secret_object(existing.and_then(|value| value.get("http_headers")), http_headers, clear_http_headers),
                "env_http_headers": env_http_headers,
            }),
        };
        if let Some(enabled) = self.enabled {
            value["enabled"] = Value::Bool(enabled);
        }
        if let Some(required) = self.required {
            value["required"] = Value::Bool(required);
        }
        if let Some(timeout) = self.startup_timeout_sec {
            value["startup_timeout_sec"] = Value::Number(timeout.into());
        } else {
            preserve_existing_field(existing, &mut value, "startup_timeout_sec");
        }
        if let Some(timeout) = self.tool_timeout_sec {
            value["tool_timeout_sec"] = Value::Number(timeout.into());
        } else {
            preserve_existing_field(existing, &mut value, "tool_timeout_sec");
        }
        match &self.scopes {
            Some(scopes) => value["scopes"] = json!(scopes),
            None => preserve_existing_field(existing, &mut value, "scopes"),
        }
        match &self.enabled_tools {
            Some(enabled_tools) => value["enabled_tools"] = json!(enabled_tools),
            None => preserve_existing_field(existing, &mut value, "enabled_tools"),
        }
        prune_nulls(&mut value);
        value
    }

    fn into_configured(self, name: String) -> ConfiguredMcpServer {
        let value = self.config_value();
        ConfiguredMcpServer::from_config(&name, &value).unwrap_or(ConfiguredMcpServer {
            name,
            enabled: true,
            required: None,
            startup_timeout_sec: None,
            tool_timeout_sec: None,
            scopes: Vec::new(),
            enabled_tools: Vec::new(),
            has_stored_secrets: false,
            transport: ConfiguredMcpTransport::Unknown,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpServerTransportRequest {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default, rename = "clearEnv")]
        clear_env: Vec<String>,
        #[serde(default, rename = "envVars")]
        env_vars: Vec<String>,
    },
    StreamableHttp {
        url: String,
        #[serde(default, rename = "bearerTokenEnvVar")]
        bearer_token_env_var: Option<String>,
        #[serde(default, rename = "oauthResource")]
        oauth_resource: Option<String>,
        #[serde(default, rename = "httpHeaders")]
        http_headers: BTreeMap<String, String>,
        #[serde(default, rename = "clearHttpHeaders")]
        clear_http_headers: Vec<String>,
        #[serde(default, rename = "envHttpHeaders")]
        env_http_headers: BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerToggleRequest {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigMutationResponse {
    #[serde(default)]
    pub configured_server: Option<ConfiguredMcpServer>,
    pub reload: McpReloadResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSettingsResponse {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub service_tier: Option<String>,
    pub permissions_preset: Option<ComposerPermissionsPreset>,
}

impl ComposerSettingsResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let config = payload
            .get("config")
            .ok_or_else(|| bad_gateway("config/read response missing config"))?;
        Ok(Self {
            model: optional_string(config, "model"),
            effort: optional_string(config, "model_reasoning_effort"),
            service_tier: optional_string(config, "service_tier"),
            permissions_preset: composer_permissions_preset(config),
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ComposerPermissionsPreset {
    Default,
    AutoReview,
    FullAccess,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSettingsUpdateRequest {
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub model: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub effort: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_string_update",
        skip_serializing_if = "Option::is_none"
    )]
    pub service_tier: Option<Option<String>>,
}

impl ComposerSettingsUpdateRequest {
    fn config_edits(self) -> Vec<Value> {
        let mut edits = Vec::new();
        if let Some(model) = self.model {
            edits.push(config_edit("model", option_string_value(model)));
        }
        if let Some(effort) = self.effort {
            edits.push(config_edit(
                "model_reasoning_effort",
                option_string_value(effort),
            ));
        }
        if let Some(service_tier) = self.service_tier {
            edits.push(config_edit(
                "service_tier",
                option_string_value(service_tier),
            ));
        }
        edits
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComposerSettingsUpdateResponse {
    pub saved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListResponse {
    pub data: Vec<SkillsListEntry>,
}

impl SkillsListResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("skills/list response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListEntry {
    pub cwd: String,
    pub skills: Vec<SkillMetadata>,
    pub errors: Vec<SkillErrorInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillMetadata {
    pub name: String,
    pub path: String,
    pub description: String,
    pub enabled: bool,
    #[serde(default = "default_skill_scope")]
    pub scope: String,
    #[serde(default)]
    pub short_description: Option<String>,
    #[serde(default)]
    pub interface: Option<SkillInterface>,
}

fn default_skill_scope() -> String {
    "user".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillInterface {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub short_description: Option<String>,
    #[serde(default)]
    pub brand_color: Option<String>,
    #[serde(default)]
    pub default_prompt: Option<String>,
    #[serde(default)]
    pub icon_small: Option<String>,
    #[serde(default)]
    pub icon_large: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillErrorInfo {
    pub message: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceAddResponse {
    pub already_added: bool,
    pub installed_root: String,
    pub marketplace_name: String,
}

impl MarketplaceAddResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("marketplace/add response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginListResponse {
    #[serde(default)]
    pub featured_plugin_ids: Vec<String>,
    #[serde(default)]
    pub marketplace_load_errors: Vec<MarketplaceLoadErrorInfo>,
    pub marketplaces: Vec<PluginMarketplaceEntry>,
}

impl PluginListResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("plugin/list response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceLoadErrorInfo {
    pub marketplace_path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarketplaceEntry {
    pub name: String,
    pub path: Option<String>,
    pub plugins: Vec<PluginSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub enabled: bool,
    pub install_policy: String,
    pub auth_policy: String,
    pub source: Value,
    #[serde(default)]
    pub interface: Option<PluginInterface>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginInterface {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub short_description: Option<String>,
    #[serde(default)]
    pub long_description: Option<String>,
    #[serde(default)]
    pub developer_name: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub brand_color: Option<String>,
    #[serde(default)]
    pub default_prompt: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginReadResponse {
    pub plugin: PluginDetail,
}

impl PluginReadResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("plugin/read response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetail {
    pub summary: PluginSummary,
    pub marketplace_name: String,
    pub marketplace_path: Option<String>,
    #[serde(default)]
    pub skills: Vec<SkillMetadata>,
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    #[serde(default)]
    pub apps: Vec<AppSummary>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallResponse {
    pub apps_needing_auth: Vec<AppSummary>,
    pub auth_policy: String,
}

impl PluginInstallResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        serde_json::from_value(payload)
            .map_err(|error| bad_gateway(format!("plugin/install response: {error}")))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSummary {
    pub id: String,
    pub name: String,
    pub needs_auth: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub install_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillsCatalogResponse {
    pub cwd: Option<String>,
    pub skills: Vec<SkillMetadata>,
    pub errors: Vec<SkillErrorInfo>,
    pub invalidation_generation: u64,
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

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSkillMention {
    pub start: u32,
    pub end: u32,
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brand_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_small_url: Option<String>,
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
pub struct ThreadLoadedListResponse {
    pub thread_ids: Vec<String>,
    pub next_cursor: Option<String>,
    pub raw_payload: Value,
}

impl ThreadLoadedListResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let thread_ids = payload
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("thread/loaded/list response missing data array"))?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| bad_gateway("thread/loaded/list data item is not a string"))
            })
            .collect::<ApiResult<Vec<_>>>()?;

        Ok(Self {
            thread_ids,
            next_cursor: optional_string(&payload, "nextCursor"),
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
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub approval_policy: Option<String>,
    pub approvals_reviewer: Option<String>,
    pub agent_nickname: Option<String>,
    pub agent_role: Option<String>,
    pub sandbox: Option<Value>,
    pub git_info: Option<GitInfo>,
    pub pinned_at: Option<DateTime<Utc>>,
    pub preview: Option<Value>,
    pub last_completed_agent_turn_seq: Option<i64>,
    pub seen_completed_agent_turn_seq: i64,
    pub unread_completed_agent_turn: bool,
    pub notifications_enabled: bool,
    pub raw_payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub branch: Option<String>,
    pub origin_url: Option<String>,
    pub sha: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitInfoPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_url: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha: Option<Option<String>>,
}

impl ThreadSummary {
    pub(crate) fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            id: required_string(payload, "id")?,
            name: optional_string(payload, "name"),
            cwd: required_string(payload, "cwd")?,
            status: required_thread_status(payload)?,
            created_at: required_i64(payload, "createdAt")?,
            updated_at: required_i64(payload, "updatedAt")?,
            source: optional_string(payload, "source"),
            model: optional_string(payload, "model"),
            reasoning_effort: optional_string(payload, "reasoningEffort"),
            service_tier: optional_string(payload, "serviceTier"),
            approval_policy: optional_string(payload, "approvalPolicy"),
            approvals_reviewer: optional_string(payload, "approvalsReviewer"),
            agent_nickname: optional_string(payload, "agentNickname"),
            agent_role: optional_string(payload, "agentRole"),
            sandbox: optional_value(payload, "sandbox"),
            git_info: optional_git_info(payload)?,
            pinned_at: None,
            preview: payload.get("preview").cloned(),
            last_completed_agent_turn_seq: None,
            seen_completed_agent_turn_seq: 0,
            unread_completed_agent_turn: false,
            notifications_enabled: true,
            raw_payload: payload.clone(),
        })
    }

    pub fn apply_completed_agent_turn_read_state(
        &mut self,
        last_completed_agent_turn_seq: Option<i64>,
        seen_completed_agent_turn_seq: i64,
    ) {
        self.last_completed_agent_turn_seq = last_completed_agent_turn_seq;
        self.seen_completed_agent_turn_seq = seen_completed_agent_turn_seq.max(0);
        self.unread_completed_agent_turn = last_completed_agent_turn_seq
            .is_some_and(|seq| seq > self.seen_completed_agent_turn_seq);
    }
}

pub(crate) fn optional_git_info(payload: &Value) -> ApiResult<Option<GitInfo>> {
    let Some(value) = payload.get("gitInfo") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let object = value
        .as_object()
        .ok_or_else(|| bad_gateway("thread gitInfo field is not an object"))?;
    Ok(Some(GitInfo {
        branch: object
            .get("branch")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        origin_url: object
            .get("originUrl")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        sha: object
            .get("sha")
            .and_then(Value::as_str)
            .map(ToString::to_string),
    }))
}

pub(crate) fn optional_git_info_patch(payload: &Value) -> ApiResult<Option<GitInfoPatch>> {
    let Some(value) = payload.get("gitInfo") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let object = value
        .as_object()
        .ok_or_else(|| bad_gateway("thread gitInfo field is not an object"))?;
    Ok(Some(GitInfoPatch {
        branch: optional_patch_string(object, "branch")?,
        origin_url: optional_patch_string(object, "originUrl")?,
        sha: optional_patch_string(object, "sha")?,
    }))
}

fn optional_patch_string(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> ApiResult<Option<Option<String>>> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(Some(None));
    }
    let value = value
        .as_str()
        .ok_or_else(|| bad_gateway("thread gitInfo patch field is not a string"))?;
    Ok(Some(Some(value.to_string())))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
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
    pub turns: Vec<ThreadTurnSnapshot>,
    pub live_state: ThreadLiveState,
    pub timeline: ThreadTimelineSnapshot,
    pub history_page: Option<ThreadTimelineWindowPage>,
    pub raw_payload: Value,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadViewResponse {
    pub thread: ThreadViewThreadSummary,
    pub live_state: ThreadLiveState,
    pub timeline: ThreadTimelineSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_page: Option<ThreadTimelineWindowPage>,
}

impl ThreadViewResponse {
    pub(crate) fn from_detail(detail: ThreadDetailResponse) -> Self {
        Self {
            thread: ThreadViewThreadSummary::from(detail.thread),
            live_state: detail.live_state,
            timeline: detail.timeline,
            history_page: detail.history_page,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadViewThreadSummary {
    pub id: String,
    pub name: Option<String>,
    pub cwd: String,
    pub status: ThreadStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub source: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub approval_policy: Option<String>,
    pub approvals_reviewer: Option<String>,
    pub agent_nickname: Option<String>,
    pub agent_role: Option<String>,
    pub sandbox: Option<Value>,
    pub git_info: Option<GitInfo>,
    pub pinned_at: Option<DateTime<Utc>>,
    pub preview: Option<Value>,
    pub last_completed_agent_turn_seq: Option<i64>,
    pub seen_completed_agent_turn_seq: i64,
    pub unread_completed_agent_turn: bool,
    pub notifications_enabled: bool,
}

impl From<ThreadSummary> for ThreadViewThreadSummary {
    fn from(thread: ThreadSummary) -> Self {
        Self {
            id: thread.id,
            name: thread.name,
            cwd: thread.cwd,
            status: thread.status,
            created_at: thread.created_at,
            updated_at: thread.updated_at,
            source: thread.source,
            model: thread.model,
            reasoning_effort: thread.reasoning_effort,
            service_tier: thread.service_tier,
            approval_policy: thread.approval_policy,
            approvals_reviewer: thread.approvals_reviewer,
            agent_nickname: thread.agent_nickname,
            agent_role: thread.agent_role,
            sandbox: thread.sandbox,
            git_info: thread.git_info,
            pinned_at: thread.pinned_at,
            preview: thread.preview,
            last_completed_agent_turn_seq: thread.last_completed_agent_turn_seq,
            seen_completed_agent_turn_seq: thread.seen_completed_agent_turn_seq,
            unread_completed_agent_turn: thread.unread_completed_agent_turn,
            notifications_enabled: thread.notifications_enabled,
        }
    }
}

impl ThreadDetailResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let thread = payload
            .get("thread")
            .ok_or_else(|| bad_gateway("thread/read response missing thread"))?;
        let turns = thread
            .get("turns")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("thread/read response thread missing turns array"))?
            .iter()
            .map(ThreadTurnSnapshot::from_payload)
            .collect::<ApiResult<Vec<_>>>()?;
        let live_state = live_state_from_thread(thread);
        let last_completed_agent_turn_seq = completed_turn_count(&turns);
        let mut thread = ThreadSummary::from_payload(thread)?;
        thread.apply_completed_agent_turn_read_state(last_completed_agent_turn_seq, 0);
        let timeline = ThreadTimelineSnapshot::from_turns(&thread.id, &turns);
        Ok(Self {
            thread,
            turns,
            live_state,
            timeline,
            history_page: None,
            raw_payload: payload,
        })
    }

    fn from_thread_payload_and_turns(
        payload: Value,
        turns: Vec<ThreadTurnSnapshot>,
    ) -> ApiResult<Self> {
        Self::from_thread_payload_turns_and_history(payload, turns, None, None)
    }

    fn from_thread_payload_turns_and_history(
        mut payload: Value,
        turns: Vec<ThreadTurnSnapshot>,
        history_page: Option<ThreadTimelineWindowPage>,
        last_completed_agent_turn_seq: Option<i64>,
    ) -> ApiResult<Self> {
        let thread = payload
            .get_mut("thread")
            .ok_or_else(|| bad_gateway("thread/read response missing thread"))?;
        if let Some(thread) = thread.as_object_mut() {
            thread.insert(
                "turns".to_string(),
                Value::Array(turns.iter().map(|turn| turn.raw_payload.clone()).collect()),
            );
        } else {
            return Err(bad_gateway("thread/read response thread is not an object"));
        }

        let mut response = Self::from_payload(payload)?;
        response.history_page = history_page;
        if last_completed_agent_turn_seq.is_some() {
            response
                .thread
                .apply_completed_agent_turn_read_state(last_completed_agent_turn_seq, 0);
        }
        Ok(response)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineWindowPage {
    pub older_cursor: Option<String>,
    pub newer_cursor: Option<String>,
    pub has_older: bool,
    pub limit: u32,
    pub loaded_turn_count: u32,
    #[serde(default, skip_serializing_if = "is_false")]
    pub reset_window: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineSnapshot {
    pub view_revision: i64,
    pub active_turn_id: Option<String>,
    pub live_state: ThreadLiveState,
    pub pending_approval_requests: Vec<PendingTimelineRequestSummary>,
    pub pending_user_input_requests: Vec<PendingTimelineRequestSummary>,
    pub rows: Vec<ThreadTimelineRow>,
    pub turns: Vec<ThreadTimelineSnapshotTurn>,
    #[serde(default, skip_serializing)]
    #[schema(ignore)]
    pub items: Vec<ThreadTimelineSnapshotItem>,
}

impl ThreadTimelineSnapshot {
    pub(crate) fn from_turns(thread_id: &str, turns: &[ThreadTurnSnapshot]) -> Self {
        let mut display_order = 0;
        let mut items = Vec::new();
        let mut active_turn_id = None;
        let mut timeline_turns = Vec::new();
        for turn in turns {
            let turn_terminal = is_terminal_turn_status(&turn.status);
            if !turn_terminal {
                active_turn_id = Some(turn.id.clone());
            }
            timeline_turns.push(ThreadTimelineSnapshotTurn::from_turn(turn));
            for item in &turn.items {
                display_order += 1;
                items.push(ThreadTimelineSnapshotItem::from_turn_item(
                    thread_id,
                    turn,
                    item,
                    display_order,
                    turn_terminal,
                ));
            }
        }
        let rows = thread_timeline_rows_from_items(
            active_turn_id.as_deref(),
            live_state_from_turns(turns),
            &timeline_turns,
            &items,
        );
        Self {
            // Adapter-only snapshots start at zero; routes replace this with the gateway
            // projection high-water once gateway overlays are applied.
            view_revision: 0,
            active_turn_id,
            live_state: live_state_from_turns(turns),
            pending_approval_requests: Vec::new(),
            pending_user_input_requests: Vec::new(),
            rows,
            turns: timeline_turns,
            items,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineRow {
    pub id: String,
    pub kind: String,
    pub turn_id: Option<String>,
    pub display_order: i64,
    pub status: String,
    pub timestamp_ms: Option<i64>,
    pub item: Option<ThreadTimelineSnapshotItem>,
    pub items: Vec<ThreadTimelineSnapshotItem>,
    pub file_changes: Vec<ThreadTimelineFileChangeEntry>,
    pub work: Option<ThreadTimelineWorkSummary>,
    pub collapsed_rows: Vec<ThreadTimelineWorkDetailRow>,
    pub divider_before: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineWorkDetailRow {
    pub id: String,
    pub kind: String,
    pub turn_id: Option<String>,
    pub display_order: i64,
    pub status: String,
    pub timestamp_ms: Option<i64>,
    pub item: Option<ThreadTimelineSnapshotItem>,
    pub items: Vec<ThreadTimelineSnapshotItem>,
    pub file_changes: Vec<ThreadTimelineFileChangeEntry>,
    pub divider_before: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineWorkSummary {
    pub state: String,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineFileChangeEntry {
    pub id: String,
    pub path: String,
    pub action: String,
    pub additions: i64,
    pub deletions: i64,
    pub diff: String,
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineSnapshotTurn {
    pub id: String,
    pub status: String,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
}

impl ThreadTimelineSnapshotTurn {
    pub(crate) fn from_turn(turn: &ThreadTurnSnapshot) -> Self {
        Self {
            id: turn.id.clone(),
            status: turn.status.clone(),
            started_at: turn.started_at,
            completed_at: turn.completed_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PendingTimelineRequestSummary {
    pub id: String,
    pub request_id: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub method: String,
    pub status: String,
    pub request_kind: String,
    pub title: String,
    pub summary: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTimelineSnapshotItem {
    pub id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub item_type: String,
    pub status: String,
    pub display_order: i64,
    pub codex_method: String,
    pub timestamp_ms: Option<i64>,
    pub payload: TimelineItemUpsertPayload,
}

impl ThreadTimelineSnapshotItem {
    pub(crate) fn from_turn_item(
        thread_id: &str,
        turn: &ThreadTurnSnapshot,
        item: &ThreadItemSnapshot,
        display_order: i64,
        turn_terminal: bool,
    ) -> Self {
        let timestamp_ms = snapshot_item_timestamp_ms(turn, item);
        let codex_method = if turn_terminal {
            "item/completed"
        } else {
            "item/upsert"
        }
        .to_string();
        Self {
            id: canonical_timeline_item_id(&turn.id, &item.id),
            thread_id: thread_id.to_string(),
            turn_id: turn.id.clone(),
            item_id: item.id.clone(),
            item_type: item.item_type.clone(),
            status: if turn_terminal {
                "completed".to_string()
            } else {
                turn.status.clone()
            },
            display_order,
            codex_method,
            timestamp_ms,
            payload: TimelineItemUpsertPayload {
                source: TimelineUpdateSource::AppServerSnapshot,
                turn_id: turn.id.clone(),
                item_id: item.id.clone(),
                item: compact_timeline_item_payload(&item.raw_payload),
                item_snapshot: item.clone(),
            },
        }
    }
}

pub(crate) fn canonical_timeline_item_id(turn_id: &str, item_id: &str) -> String {
    format!("projection-{turn_id}-{item_id}")
}

pub(crate) fn thread_timeline_rows_from_items(
    active_turn_id: Option<&str>,
    live_state: ThreadLiveState,
    turns: &[ThreadTimelineSnapshotTurn],
    items: &[ThreadTimelineSnapshotItem],
) -> Vec<ThreadTimelineRow> {
    let mut ordered_items = items.to_vec();
    ordered_items.sort_by_key(|item| item.display_order);

    let mut rows = Vec::<ThreadTimelineWorkDetailRow>::new();
    let mut current_turn_key: Option<String> = None;
    let mut activity_items = Vec::<ThreadTimelineSnapshotItem>::new();
    let mut file_change_items = Vec::<ThreadTimelineSnapshotItem>::new();
    let mut turn_has_final_response_precursor = HashSet::<String>::new();

    fn flush_activity_items(
        rows: &mut Vec<ThreadTimelineWorkDetailRow>,
        activity_items: &mut Vec<ThreadTimelineSnapshotItem>,
        turn_has_final_response_precursor: &mut HashSet<String>,
    ) {
        if activity_items.is_empty() {
            return;
        }
        let row = activity_row(activity_items);
        turn_has_final_response_precursor.insert(row_turn_key_from_detail(&row));
        rows.push(row);
        activity_items.clear();
    }

    fn flush_file_change_items(
        rows: &mut Vec<ThreadTimelineWorkDetailRow>,
        file_change_items: &mut Vec<ThreadTimelineSnapshotItem>,
        turn_has_final_response_precursor: &mut HashSet<String>,
    ) {
        if file_change_items.is_empty() {
            return;
        }
        let row = file_changes_row(file_change_items);
        turn_has_final_response_precursor.insert(row_turn_key_from_detail(&row));
        rows.push(row);
        file_change_items.clear();
    }

    for item in ordered_items {
        let turn_key = timeline_item_turn_key(&item);
        if current_turn_key
            .as_ref()
            .is_some_and(|current| current != &turn_key)
        {
            flush_activity_items(
                &mut rows,
                &mut activity_items,
                &mut turn_has_final_response_precursor,
            );
            flush_file_change_items(
                &mut rows,
                &mut file_change_items,
                &mut turn_has_final_response_precursor,
            );
        }
        current_turn_key = Some(turn_key.clone());

        if normalized_thread_item_kind(&item) == "file_change" {
            file_change_items.push(item);
            continue;
        }

        if is_timeline_activity_item(&item) {
            activity_items.push(item);
            continue;
        }

        flush_activity_items(
            &mut rows,
            &mut activity_items,
            &mut turn_has_final_response_precursor,
        );
        if is_final_response_item(&item) {
            flush_file_change_items(
                &mut rows,
                &mut file_change_items,
                &mut turn_has_final_response_precursor,
            );
        }

        let mut row = item_row(item.clone());
        if is_final_response_item(&item) && turn_has_final_response_precursor.contains(&turn_key) {
            row.divider_before = Some("final_response".to_string());
        }
        if normalized_thread_item_kind(&item) != "user_message" && !is_final_response_item(&item) {
            turn_has_final_response_precursor.insert(turn_key);
        }
        rows.push(row);
    }

    flush_activity_items(
        &mut rows,
        &mut activity_items,
        &mut turn_has_final_response_precursor,
    );
    flush_file_change_items(
        &mut rows,
        &mut file_change_items,
        &mut turn_has_final_response_precursor,
    );

    insert_work_rows(rows, turns, active_turn_id, live_state)
}

fn insert_work_rows(
    rows: Vec<ThreadTimelineWorkDetailRow>,
    turns: &[ThreadTimelineSnapshotTurn],
    active_turn_id: Option<&str>,
    live_state: ThreadLiveState,
) -> Vec<ThreadTimelineRow> {
    let mut work_rows = turns
        .iter()
        .filter_map(|turn| {
            let is_active_turn = active_turn_id == Some(turn.id.as_str())
                && !matches!(
                    live_state,
                    ThreadLiveState::Idle | ThreadLiveState::NotLoaded
                );
            let is_terminal_turn = is_terminal_turn_status(&turn.status);
            if turn.started_at.is_none() && !is_active_turn {
                return None;
            }
            if !is_active_turn && !is_terminal_turn {
                return None;
            }
            Some((
                turn.id.clone(),
                ThreadTimelineRow {
                    id: format!("work-{}", turn.id),
                    kind: "work".to_string(),
                    turn_id: Some(turn.id.clone()),
                    display_order: i64::MAX,
                    status: if is_active_turn {
                        "running".to_string()
                    } else {
                        "completed".to_string()
                    },
                    timestamp_ms: None,
                    item: None,
                    items: Vec::new(),
                    file_changes: Vec::new(),
                    work: Some(ThreadTimelineWorkSummary {
                        state: if is_active_turn {
                            "running".to_string()
                        } else {
                            "completed".to_string()
                        },
                        started_at: turn.started_at,
                        completed_at: if is_active_turn {
                            None
                        } else {
                            turn.completed_at
                        },
                    }),
                    collapsed_rows: Vec::new(),
                    divider_before: None,
                },
            ))
        })
        .collect::<HashMap<_, _>>();

    if work_rows.is_empty() {
        return rows.into_iter().map(ThreadTimelineRow::from).collect();
    }

    let mut by_turn = HashMap::<String, Vec<ThreadTimelineWorkDetailRow>>::new();
    let mut turn_order = Vec::<String>::new();
    let mut ungrouped = Vec::<ThreadTimelineRow>::new();
    for row in rows {
        let Some(turn_id) = row.turn_id.clone() else {
            ungrouped.push(row.into());
            continue;
        };
        if !work_rows.contains_key(&turn_id) {
            ungrouped.push(row.into());
            continue;
        }
        if !by_turn.contains_key(&turn_id) {
            by_turn.insert(turn_id.clone(), Vec::new());
            turn_order.push(turn_id.clone());
        }
        by_turn
            .get_mut(&turn_id)
            .expect("turn bucket exists")
            .push(row);
    }

    let mut result = ungrouped;
    for turn_id in turn_order {
        let turn_rows = by_turn.remove(&turn_id).unwrap_or_default();
        let Some(work_row) = work_rows.remove(&turn_id) else {
            result.extend(turn_rows.into_iter().map(ThreadTimelineRow::from));
            continue;
        };
        result.extend(rows_for_turn_with_work_row(turn_rows, work_row));
    }
    result.sort_by_key(|row| row.display_order);
    result
}

fn rows_for_turn_with_work_row(
    rows: Vec<ThreadTimelineWorkDetailRow>,
    mut work_row: ThreadTimelineRow,
) -> Vec<ThreadTimelineRow> {
    let Some(first_work_index) = rows.iter().position(row_contains_work_precursor) else {
        return rows.into_iter().map(ThreadTimelineRow::from).collect();
    };
    let final_index = rows
        .iter()
        .enumerate()
        .find(|(index, row)| *index > first_work_index && row_is_final_response(row))
        .map(|(index, _)| index);
    if work_row.status == "completed" {
        if let Some(final_index) = final_index {
            let display_order = rows[first_work_index].display_order.saturating_add(1);
            let rows_after_user = rows[first_work_index + 1..].to_vec();
            let final_offset = final_index - first_work_index - 1;
            let mut work_detail_rows = rows_after_user
                .iter()
                .enumerate()
                .filter(|(index, row)| *index != final_offset && !row_is_prominent_turn_result(row))
                .map(|(_, row)| row.clone())
                .collect::<Vec<_>>();
            work_detail_rows.sort_by_key(|row| row.display_order);
            let prominent_rows = rows_after_user
                .iter()
                .enumerate()
                .filter(|(index, row)| *index != final_offset && row_is_prominent_turn_result(row))
                .map(|(_, row)| row.clone())
                .collect::<Vec<_>>();
            work_row.collapsed_rows = work_detail_rows;
            work_row.display_order = display_order;
            let mut result = rows[..first_work_index + 1]
                .iter()
                .cloned()
                .map(ThreadTimelineRow::from)
                .collect::<Vec<_>>();
            result.push(work_row);
            let mut final_row = rows[final_index].clone();
            final_row.divider_before = None;
            result.push(final_row.into());
            result.extend(prominent_rows.into_iter().map(ThreadTimelineRow::from));
            return result;
        }
    }

    work_row.display_order = rows[first_work_index].display_order.saturating_add(1);
    let mut result = rows[..first_work_index + 1]
        .iter()
        .cloned()
        .map(ThreadTimelineRow::from)
        .collect::<Vec<_>>();
    result.push(work_row);
    result.extend(
        rows[first_work_index + 1..]
            .iter()
            .cloned()
            .map(ThreadTimelineRow::from),
    );
    result
}

impl From<ThreadTimelineWorkDetailRow> for ThreadTimelineRow {
    fn from(row: ThreadTimelineWorkDetailRow) -> Self {
        Self {
            id: row.id,
            kind: row.kind,
            turn_id: row.turn_id,
            display_order: row.display_order,
            status: row.status,
            timestamp_ms: row.timestamp_ms,
            item: row.item,
            items: row.items,
            file_changes: row.file_changes,
            work: None,
            collapsed_rows: Vec::new(),
            divider_before: row.divider_before,
        }
    }
}

fn item_row(item: ThreadTimelineSnapshotItem) -> ThreadTimelineWorkDetailRow {
    let kind = normalized_thread_item_kind(&item);
    ThreadTimelineWorkDetailRow {
        id: format!("item-{}", item.id),
        kind,
        turn_id: Some(item.turn_id.clone()),
        display_order: row_display_order(item.display_order),
        status: item.status.clone(),
        timestamp_ms: item.timestamp_ms,
        item: Some(item),
        items: Vec::new(),
        file_changes: Vec::new(),
        divider_before: None,
    }
}

fn activity_row(items: &[ThreadTimelineSnapshotItem]) -> ThreadTimelineWorkDetailRow {
    let first = items.first().expect("activity row has at least one item");
    ThreadTimelineWorkDetailRow {
        id: format!("activity-{}", first.id),
        kind: "activity".to_string(),
        turn_id: Some(first.turn_id.clone()),
        display_order: row_display_order(first.display_order),
        status: first.status.clone(),
        timestamp_ms: first.timestamp_ms,
        item: None,
        items: items.to_vec(),
        file_changes: Vec::new(),
        divider_before: None,
    }
}

fn file_changes_row(items: &[ThreadTimelineSnapshotItem]) -> ThreadTimelineWorkDetailRow {
    let first = items
        .first()
        .expect("file changes row has at least one item");
    let entries = file_change_entries_for_items(items);
    ThreadTimelineWorkDetailRow {
        id: format!("file-changes-turn-{}", first.turn_id),
        kind: "file_changes".to_string(),
        turn_id: Some(first.turn_id.clone()),
        display_order: row_display_order(first.display_order),
        status: first.status.clone(),
        timestamp_ms: first.timestamp_ms,
        item: None,
        items: Vec::new(),
        file_changes: entries,
        divider_before: None,
    }
}

fn row_display_order(item_display_order: i64) -> i64 {
    item_display_order.saturating_mul(100)
}

fn row_turn_key_from_detail(row: &ThreadTimelineWorkDetailRow) -> String {
    row.turn_id
        .as_ref()
        .map(|turn_id| format!("turn-{turn_id}"))
        .unwrap_or_else(|| format!("row-{}", row.id))
}

fn timeline_item_turn_key(item: &ThreadTimelineSnapshotItem) -> String {
    format!("turn-{}", item.turn_id)
}

fn row_contains_work_precursor(row: &ThreadTimelineWorkDetailRow) -> bool {
    row.kind == "user_message"
}

fn row_is_final_response(row: &ThreadTimelineWorkDetailRow) -> bool {
    row.item.as_ref().is_some_and(is_final_response_item)
}

fn row_is_prominent_turn_result(row: &ThreadTimelineWorkDetailRow) -> bool {
    row.kind == "user_message" || row.kind == "image_generation" || row.kind == "context_compaction"
}

fn is_timeline_activity_item(item: &ThreadTimelineSnapshotItem) -> bool {
    matches!(
        normalized_thread_item_kind(item).as_str(),
        "collab_agent_tool_call"
            | "command_execution"
            | "dynamic_tool_call"
            | "image_view"
            | "mcp_tool_call"
            | "web_search_group"
    )
}

fn is_final_response_item(item: &ThreadTimelineSnapshotItem) -> bool {
    matches!(
        normalized_thread_item_kind(item).as_str(),
        "assistant_message" | "agent_message"
    ) && item.payload.item.phase.as_deref() == Some("final_answer")
}

fn normalized_thread_item_kind(item: &ThreadTimelineSnapshotItem) -> String {
    let item_type = item.item_type.to_ascii_lowercase().replace(['_', '-'], "");
    match item_type.as_str() {
        "agentmessage" | "assistantmessage" => "assistant_message",
        "collabagenttoolcall" => "collab_agent_tool_call",
        "commandexecution" => "command_execution",
        "contextcompaction" => "context_compaction",
        "dynamictoolcall" => "dynamic_tool_call",
        "enteredreviewmode" => "review_mode_started",
        "exitedreviewmode" => "review_mode_finished",
        "filechange" => "file_change",
        "hookprompt" => "hook_prompt",
        "imagegeneration" | "imagegenerationcall" => "image_generation",
        "imageview" => "image_view",
        "mcptoolcall" => "mcp_tool_call",
        "plan" => "plan",
        "reasoning" => "reasoning_summary",
        "usermessage" => "user_message",
        "websearch" => "web_search_group",
        _ => item.item_type.as_str(),
    }
    .to_string()
}

fn file_change_entries_for_items(
    items: &[ThreadTimelineSnapshotItem],
) -> Vec<ThreadTimelineFileChangeEntry> {
    let mut entries_by_key =
        HashMap::<(String, String), (i64, ThreadTimelineFileChangeEntry)>::new();
    for item in items {
        for mut entry in file_change_entries_for_item(item) {
            entry.path = normalize_file_change_path(&entry.path);
            let key = (entry.path.clone(), entry.action.clone());
            if let Some((first_order, existing)) = entries_by_key.get_mut(&key) {
                *first_order = (*first_order).min(item.display_order);
                existing.additions += entry.additions;
                existing.deletions += entry.deletions;
                append_unique_diff_chunk(&mut existing.diff, &entry.diff);
                existing.item_ids.extend(entry.item_ids);
            } else {
                entries_by_key.insert(key, (item.display_order, entry));
            }
        }
    }
    let mut entries = entries_by_key
        .into_iter()
        .map(|((path, action), (display_order, entry))| (display_order, path, action, entry))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
    });
    entries.into_iter().map(|(_, _, _, entry)| entry).collect()
}

fn normalize_file_change_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    normalized.trim_start_matches("./").to_string()
}

fn append_unique_diff_chunk(existing: &mut String, incoming: &str) {
    if incoming.is_empty() || existing.split("\n\n").any(|chunk| chunk == incoming) {
        return;
    }
    if !existing.is_empty() {
        existing.push_str("\n\n");
    }
    existing.push_str(incoming);
}

fn file_change_entries_for_item(
    item: &ThreadTimelineSnapshotItem,
) -> Vec<ThreadTimelineFileChangeEntry> {
    let Some(changes) = item.payload.item.changes.as_ref().and_then(Value::as_array) else {
        let path = item.payload.item.path.clone().unwrap_or_default();
        let action = file_change_action_label(item.payload.item.action.as_ref());
        if path.is_empty() && action.is_empty() {
            return Vec::new();
        }
        let diff = item
            .payload
            .item
            .diff
            .clone()
            .or_else(|| item.payload.item.output.clone())
            .unwrap_or_default();
        let (additions, deletions) = diff_line_counts(&diff);
        return vec![ThreadTimelineFileChangeEntry {
            id: format!("file-change-{}-{path}-{action}", item.id),
            path,
            action,
            additions,
            deletions,
            diff,
            item_ids: vec![item.id.clone()],
        }];
    };

    changes
        .iter()
        .filter_map(|change| {
            let path = string_field(change, "path")?;
            let action = file_change_action_label(change.get("kind"));
            let diff = string_field(change, "diff").unwrap_or_default();
            let (additions, deletions) = diff_line_counts(&diff);
            Some(ThreadTimelineFileChangeEntry {
                id: format!("file-change-{}-{path}-{action}", item.id),
                path,
                action,
                additions,
                deletions,
                diff,
                item_ids: vec![item.id.clone()],
            })
        })
        .collect()
}

fn file_change_action_label(value: Option<&Value>) -> String {
    let raw = match value {
        Some(Value::Object(object)) => object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        Some(Value::String(value)) => value.clone(),
        _ => String::new(),
    };
    let normalized = raw.to_ascii_lowercase();
    match normalized.as_str() {
        "add" | "added" => "Added".to_string(),
        "delete" | "deleted" | "remove" | "removed" => "Deleted".to_string(),
        "update" | "modify" | "modified" => "Modified".to_string(),
        _ if raw.is_empty() => String::new(),
        _ => {
            let mut chars = raw.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        }
    }
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimelineDisplayItemPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub item_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_thread_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents_states: Option<Value>,
    #[serde(
        default,
        rename = "agent_nickname",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_nickname_snake: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_nickname: Option<String>,
    #[serde(
        default,
        rename = "agent_role",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_role_snake: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_path: Option<String>,
    #[serde(
        default,
        rename = "saved_path",
        skip_serializing_if = "Option::is_none"
    )]
    pub saved_path_snake: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revised_prompt: Option<String>,
    #[serde(
        default,
        rename = "revised_prompt",
        skip_serializing_if = "Option::is_none"
    )]
    pub revised_prompt_snake: Option<String>,
}

pub(crate) fn compact_timeline_item_payload(item: &Value) -> TimelineDisplayItemPayload {
    let Some(object) = item.as_object() else {
        return TimelineDisplayItemPayload::default();
    };
    TimelineDisplayItemPayload {
        id: display_string(object, "id"),
        item_type: display_string(object, "type"),
        status: display_string(object, "status"),
        phase: display_string(object, "phase"),
        text: display_string(object, "text"),
        message: display_string(object, "message"),
        content: display_value(object, "content"),
        summary: display_value(object, "summary"),
        review: display_string(object, "review"),
        command: display_string(object, "command"),
        cwd: display_string(object, "cwd"),
        output: display_string(object, "output")
            .or_else(|| display_string(object, "aggregatedOutput")),
        diff: display_string(object, "diff"),
        stdout: display_string(object, "stdout"),
        stderr: display_string(object, "stderr"),
        path: display_string(object, "path"),
        action: display_value(object, "action"),
        change: display_value(object, "change"),
        changes: display_value(object, "changes"),
        query: display_string(object, "query"),
        tool: display_string(object, "tool"),
        tool_name: display_string(object, "toolName"),
        name: display_string(object, "name"),
        arguments: display_value(object, "arguments"),
        args: display_value(object, "args"),
        result: display_string(object, "result"),
        receiver_thread_ids: object.get("receiverThreadIds").and_then(|value| {
            value.as_array().map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
        }),
        agents_states: display_value(object, "agentsStates"),
        agent_nickname_snake: display_string(object, "agent_nickname"),
        agent_nickname: display_string(object, "agentNickname"),
        agent_role_snake: display_string(object, "agent_role"),
        agent_role: display_string(object, "agentRole"),
        prompt: display_string(object, "prompt"),
        model: display_string(object, "model"),
        reasoning_effort: display_string(object, "reasoningEffort"),
        saved_path: display_string(object, "savedPath"),
        saved_path_snake: display_string(object, "saved_path"),
        revised_prompt: display_string(object, "revisedPrompt"),
        revised_prompt_snake: display_string(object, "revised_prompt"),
    }
}

fn display_string(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(compact_preview_string)
}

fn display_value(object: &serde_json::Map<String, Value>, key: &str) -> Option<Value> {
    object.get(key).map(compact_timeline_preview_value)
}

fn compact_timeline_preview_value(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(compact_preview_string(text)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(compact_timeline_preview_value)
                .collect::<Vec<_>>(),
        ),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), compact_timeline_preview_value(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn compact_preview_string(value: &str) -> String {
    if value.len() <= TIMELINE_PREVIEW_STRING_LIMIT {
        return value.to_string();
    }
    let mut end = TIMELINE_PREVIEW_STRING_LIMIT;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...[truncated]", &value[..end])
}

fn diff_line_counts(diff: &str) -> (i64, i64) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in diff.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            additions += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            deletions += 1;
        }
    }
    (additions, deletions)
}

fn live_state_from_turns(turns: &[ThreadTurnSnapshot]) -> ThreadLiveState {
    turns
        .iter()
        .rev()
        .find(|turn| !is_terminal_turn_status(&turn.status))
        .map(|turn| thread_live_state_from_turn_status(&turn.status))
        .unwrap_or(ThreadLiveState::Idle)
}

pub(crate) fn thread_live_state_from_turn_status(status: &str) -> ThreadLiveState {
    match status {
        "completed" | "failed" | "cancelled" | "canceled" | "interrupted" => ThreadLiveState::Idle,
        "unknown" => ThreadLiveState::NotLoaded,
        _ => ThreadLiveState::Streaming,
    }
}

fn snapshot_item_timestamp_ms(turn: &ThreadTurnSnapshot, item: &ThreadItemSnapshot) -> Option<i64> {
    let item_type = item.item_type.to_lowercase();
    if item_type.contains("user") {
        return turn.started_at.map(unix_seconds_to_ms);
    }
    if item_type.contains("agent") || item_type.contains("assistant") {
        return turn
            .completed_at
            .or(turn.started_at)
            .map(unix_seconds_to_ms);
    }
    turn.started_at.map(unix_seconds_to_ms)
}

fn unix_seconds_to_ms(seconds: i64) -> i64 {
    seconds.saturating_mul(1000)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDirection {
    Asc,
    Desc,
}

impl SortDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Asc => "asc",
            Self::Desc => "desc",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadTurnItemsView {
    NotLoaded,
    Summary,
    Full,
}

impl ThreadTurnItemsView {
    fn as_str(self) -> &'static str {
        match self {
            Self::NotLoaded => "notLoaded",
            Self::Summary => "summary",
            Self::Full => "full",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ThreadTurnsListPage {
    pub data: Vec<ThreadTurnSnapshot>,
    pub next_cursor: Option<String>,
    pub backwards_cursor: Option<String>,
    pub raw_payload: Value,
}

impl ThreadTurnsListPage {
    fn empty() -> Self {
        Self {
            data: Vec::new(),
            next_cursor: None,
            backwards_cursor: None,
            raw_payload: json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
        }
    }

    fn from_payload(payload: Value) -> ApiResult<Self> {
        let data = payload
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("thread/turns/list response missing data array"))?
            .iter()
            .map(ThreadTurnSnapshot::from_payload)
            .collect::<ApiResult<Vec<_>>>()?;
        let next_cursor = payload
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        let backwards_cursor = payload
            .get("backwardsCursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        Ok(Self {
            data,
            next_cursor,
            backwards_cursor,
            raw_payload: payload,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTurnSnapshot {
    pub id: String,
    pub status: String,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub items: Vec<ThreadItemSnapshot>,
    pub raw_payload: Value,
}

impl ThreadTurnSnapshot {
    fn from_payload(payload: &Value) -> ApiResult<Self> {
        let items = payload
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(|| bad_gateway("turn missing items array"))?
            .iter()
            .map(ThreadItemSnapshot::from_payload)
            .collect::<ApiResult<Vec<_>>>()?;
        Ok(Self {
            id: required_string(payload, "id")?,
            status: status_type(payload.get("status")).unwrap_or_else(|| "unknown".to_string()),
            started_at: optional_i64(payload, "startedAt"),
            completed_at: optional_i64(payload, "completedAt"),
            items,
            raw_payload: payload.clone(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadItemSnapshot {
    pub id: String,
    pub item_type: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skill_mentions: Vec<TimelineSkillMention>,
    #[schema(ignore)]
    #[serde(default, skip_serializing)]
    pub raw_payload: Value,
}

impl ThreadItemSnapshot {
    pub(crate) fn from_payload(payload: &Value) -> ApiResult<Self> {
        Ok(Self {
            id: required_string(payload, "id")?,
            item_type: required_string(payload, "type")?,
            skill_mentions: skill_mentions_from_thread_item(payload),
            raw_payload: payload.clone(),
        })
    }
}

pub(crate) fn timeline_skill_mentions_from_user_input(
    input: &[UserInput],
    skills: &[SkillMetadata],
) -> Option<(String, Vec<TimelineSkillMention>)> {
    let content = serde_json::to_value(input).ok()?;
    let content = content.as_array()?;
    let text = visible_text_from_user_content(content)?;
    Some((text, skill_mentions_from_user_content(content, skills)))
}

pub(crate) fn visible_text_from_thread_item(item: &Value) -> Option<String> {
    if item.get("type").and_then(Value::as_str) != Some("userMessage") {
        return None;
    }
    let content = item.get("content").and_then(Value::as_array)?;
    visible_text_from_user_content(content)
}

pub(crate) fn timeline_skill_mentions_from_text(
    text: &str,
    catalog: &[SkillMetadata],
) -> Vec<TimelineSkillMention> {
    let skills = unambiguous_enabled_catalog_skills_by_name(catalog);
    if skills.is_empty() {
        return Vec::new();
    }
    let bytes = text.as_bytes();
    let mut mentions = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'$' {
            index += 1;
            continue;
        }
        let name_start = index + 1;
        let Some(first) = bytes.get(name_start) else {
            index += 1;
            continue;
        };
        if !is_skill_name_char(*first) {
            index += 1;
            continue;
        }
        let mut name_end = name_start + 1;
        while bytes
            .get(name_end)
            .is_some_and(|next| is_skill_name_char(*next))
        {
            name_end += 1;
        }
        let name = &text[name_start..name_end];
        if let Some(skill) = skills.get(name) {
            let mention = TimelineSkillMention {
                start: text[..index].encode_utf16().count() as u32,
                end: text[..name_end].encode_utf16().count() as u32,
                name: name.to_string(),
                path: skill.path.clone(),
                display_name: None,
                scope: None,
                short_description: None,
                brand_color: None,
                icon_small_url: None,
            };
            mentions.push(enrich_timeline_skill_mention(mention, catalog));
        }
        index = name_end;
    }
    mentions
}

fn skill_mentions_from_thread_item(item: &Value) -> Vec<TimelineSkillMention> {
    if item.get("type").and_then(Value::as_str) != Some("userMessage") {
        return Vec::new();
    }
    let Some(content) = item.get("content").and_then(Value::as_array) else {
        return Vec::new();
    };
    skill_mentions_from_user_content(content, &[])
}

fn unambiguous_enabled_catalog_skills_by_name(
    catalog: &[SkillMetadata],
) -> HashMap<String, &SkillMetadata> {
    let mut skills_by_name: HashMap<String, Option<&SkillMetadata>> = HashMap::new();
    for skill in catalog.iter().filter(|skill| skill.enabled) {
        skills_by_name
            .entry(skill.name.clone())
            .and_modify(|existing| {
                if existing
                    .as_ref()
                    .is_some_and(|existing| existing.path != skill.path)
                {
                    *existing = None;
                }
            })
            .or_insert_with(|| Some(skill));
    }
    skills_by_name
        .into_iter()
        .filter_map(|(name, skill)| skill.map(|skill| (name, skill)))
        .collect()
}

fn is_skill_name_char(byte: u8) -> bool {
    matches!(byte, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'-' | b':')
}

fn visible_text_from_user_content(content: &[Value]) -> Option<String> {
    let parts = content
        .iter()
        .filter_map(|input| {
            if input.get("type").and_then(Value::as_str) != Some("text") {
                return None;
            }
            input
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
        })
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn skill_mentions_from_user_content(
    content: &[Value],
    catalog: &[SkillMetadata],
) -> Vec<TimelineSkillMention> {
    let skills = skills_by_unambiguous_name(content);
    if skills.is_empty() {
        return Vec::new();
    }

    let mut mentions = Vec::new();
    let mut display_offset = 0u32;
    let mut first_visible_text = true;
    for input in content {
        if input.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(text) = input.get("text").and_then(Value::as_str) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        if first_visible_text {
            first_visible_text = false;
        } else {
            display_offset = display_offset.saturating_add(1);
        }
        let Some(elements) = input.get("text_elements").and_then(Value::as_array) else {
            display_offset = display_offset.saturating_add(text.encode_utf16().count() as u32);
            continue;
        };
        for element in elements {
            if let Some(mention) =
                skill_mention_from_text_element(text, display_offset, element, &skills)
            {
                mentions.push(enrich_timeline_skill_mention(mention, catalog));
            }
        }
        display_offset = display_offset.saturating_add(text.encode_utf16().count() as u32);
    }
    mentions
}

pub(crate) fn enrich_timeline_skill_mentions(
    mentions: Vec<TimelineSkillMention>,
    catalog: &[SkillMetadata],
) -> Vec<TimelineSkillMention> {
    mentions
        .into_iter()
        .map(|mention| enrich_timeline_skill_mention(mention, catalog))
        .collect()
}

fn enrich_timeline_skill_mention(
    mut mention: TimelineSkillMention,
    catalog: &[SkillMetadata],
) -> TimelineSkillMention {
    let Some(skill) = matching_enabled_skill_for_mention(&mention, catalog) else {
        mention.display_name = None;
        mention.scope = None;
        mention.short_description = None;
        mention.brand_color = None;
        mention.icon_small_url = None;
        return mention;
    };

    mention.display_name = skill
        .interface
        .as_ref()
        .and_then(|interface| trimmed_optional(interface.display_name.as_deref()));
    mention.scope = trimmed_optional(Some(&skill.scope));
    mention.short_description = skill
        .interface
        .as_ref()
        .and_then(|interface| trimmed_optional(interface.short_description.as_deref()))
        .or_else(|| trimmed_optional(skill.short_description.as_deref()))
        .or_else(|| trimmed_optional(Some(&skill.description)));
    mention.brand_color = skill
        .interface
        .as_ref()
        .and_then(|interface| trimmed_optional(interface.brand_color.as_deref()));
    mention.icon_small_url = skill
        .interface
        .as_ref()
        .and_then(|interface| trimmed_optional(interface.icon_small.as_deref()))
        .map(|path| format!("/v1/skills/icon?path={}", percent_encode_query_value(&path)));
    mention
}

fn matching_enabled_skill_for_mention<'a>(
    mention: &TimelineSkillMention,
    catalog: &'a [SkillMetadata],
) -> Option<&'a SkillMetadata> {
    catalog
        .iter()
        .find(|skill| skill.enabled && skill.path == mention.path && skill.name == mention.name)
}

fn trimmed_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn percent_encode_query_value(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                output.push(byte as char);
            }
            _ => {
                output.push('%');
                output.push_str(&format!("{byte:02X}"));
            }
        }
    }
    output
}

fn skills_by_unambiguous_name(content: &[Value]) -> HashMap<String, String> {
    let mut paths_by_name: HashMap<String, Option<String>> = HashMap::new();
    for input in content {
        if input.get("type").and_then(Value::as_str) != Some("skill") {
            continue;
        }
        let (Some(name), Some(path)) = (
            input.get("name").and_then(Value::as_str),
            input.get("path").and_then(Value::as_str),
        ) else {
            continue;
        };
        paths_by_name
            .entry(name.to_string())
            .and_modify(|existing| {
                if existing.as_deref() != Some(path) {
                    *existing = None;
                }
            })
            .or_insert_with(|| Some(path.to_string()));
    }
    paths_by_name
        .into_iter()
        .filter_map(|(name, path)| path.map(|path| (name, path)))
        .collect()
}

fn skill_mention_from_text_element(
    text: &str,
    display_offset: u32,
    element: &Value,
    skills_by_name: &HashMap<String, String>,
) -> Option<TimelineSkillMention> {
    let range = element.get("byteRange")?;
    let start_byte = range.get("start")?.as_u64()? as usize;
    let end_byte = range.get("end")?.as_u64()? as usize;
    if start_byte >= end_byte
        || end_byte > text.len()
        || !text.is_char_boundary(start_byte)
        || !text.is_char_boundary(end_byte)
    {
        return None;
    }
    let token = &text[start_byte..end_byte];
    let name = token.strip_prefix('$')?;
    let path = skills_by_name.get(name)?;
    let start = text[..start_byte].encode_utf16().count() as u32;
    let end = start + token.encode_utf16().count() as u32;
    Some(TimelineSkillMention {
        start: display_offset + start,
        end: display_offset + end,
        name: name.to_string(),
        path: path.clone(),
        display_name: None,
        scope: None,
        short_description: None,
        brand_color: None,
        icon_small_url: None,
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum TimelineUpdateSource {
    GatewayStream,
    AppServerSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTurnUpsertPayload {
    pub source: TimelineUpdateSource,
    pub turn: ThreadTurnSnapshot,
    pub live_state: ThreadLiveState,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItemUpsertPayload {
    pub source: TimelineUpdateSource,
    pub turn_id: String,
    pub item_id: String,
    pub item: TimelineDisplayItemPayload,
    pub item_snapshot: ThreadItemSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimelineItemDeltaPayload {
    pub source: TimelineUpdateSource,
    pub delta: String,
    pub raw_payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimelineThreadStatusPayload {
    pub source: TimelineUpdateSource,
    pub status: ThreadStatus,
    pub live_state: ThreadLiveState,
    pub raw_payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimelineThreadMetadataPayload {
    pub source: TimelineUpdateSource,
    pub thread_id: String,
    pub thread: Option<ThreadSummary>,
    pub git_info: Option<GitInfoPatch>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThreadLiveState {
    Idle,
    Streaming,
    Syncing,
    NotLoaded,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCommandResponse {
    pub thread: ThreadSummary,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub approval_policy: Option<String>,
    pub approvals_reviewer: Option<String>,
    pub sandbox: Option<Value>,
    pub raw_payload: Value,
}

impl ThreadCommandResponse {
    fn from_payload(payload: Value) -> ApiResult<Self> {
        let thread = payload
            .get("thread")
            .ok_or_else(|| bad_gateway("thread command response missing thread"))?;
        let mut thread = ThreadSummary::from_payload(thread)?;
        overlay_thread_composer_state(&mut thread, &payload);
        Ok(Self {
            thread,
            cwd: optional_string(&payload, "cwd"),
            model: optional_string(&payload, "model"),
            model_provider: optional_string(&payload, "modelProvider"),
            reasoning_effort: optional_string(&payload, "reasoningEffort"),
            service_tier: optional_string(&payload, "serviceTier"),
            approval_policy: optional_string(&payload, "approvalPolicy"),
            approvals_reviewer: optional_string(&payload, "approvalsReviewer"),
            sandbox: optional_value(&payload, "sandbox"),
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

fn require_extended_history(mut payload: Value) -> Value {
    payload["persistExtendedHistory"] = Value::Bool(true);
    payload
}

fn require_metadata_only_resume(mut payload: Value) -> Value {
    payload["excludeTurns"] = Value::Bool(true);
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

fn optional_value(payload: &Value, field: &str) -> Option<Value> {
    payload.get(field).filter(|value| !value.is_null()).cloned()
}

fn string_vec(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
        .collect()
}

fn masked_secret_map(value: Option<&Value>) -> BTreeMap<String, ConfiguredMcpSecret> {
    value
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(key, _)| {
            (
                key.clone(),
                ConfiguredMcpSecret {
                    configured: true,
                    masked: true,
                },
            )
        })
        .collect()
}

fn merged_secret_object(
    existing: Option<&Value>,
    replacements: &BTreeMap<String, String>,
    clear: &[String],
) -> BTreeMap<String, Value> {
    let mut merged = existing
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();
    for key in clear {
        merged.remove(key);
    }
    for (key, value) in replacements {
        merged.insert(key.clone(), Value::String(value.clone()));
    }
    merged
}

fn preserve_existing_field(existing: Option<&Value>, value: &mut Value, field: &str) {
    if let Some(existing_value) = existing.and_then(|existing| existing.get(field)) {
        value[field] = existing_value.clone();
    }
}

fn env_var_names(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            value.as_str().map(str::to_string).or_else(|| {
                value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        })
        .collect()
}

fn prune_nulls(value: &mut Value) {
    if let Value::Object(map) = value {
        let keys = map
            .iter()
            .filter_map(|(key, value)| {
                if value.is_null() {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        for key in keys {
            map.remove(&key);
        }
    }
}

fn validate_mcp_server_name(name: &str) -> ApiResult<()> {
    if name.is_empty()
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(ApiError::BadRequest(
            "MCP server name must contain only ASCII letters, digits, '-' or '_'".to_string(),
        ));
    }
    Ok(())
}

fn config_edit(key_path: &str, value: Value) -> Value {
    json!({
        "keyPath": key_path,
        "mergeStrategy": "replace",
        "value": value,
    })
}

fn option_string_value(value: Option<String>) -> Value {
    value.map(Value::String).unwrap_or(Value::Null)
}

fn deserialize_optional_string_update<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

fn deserialize_optional_value_update<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

fn composer_permissions_preset(payload: &Value) -> Option<ComposerPermissionsPreset> {
    let approval_policy = optional_string(payload, "approval_policy");
    let approvals_reviewer = optional_string(payload, "approvals_reviewer");
    let sandbox_mode = optional_string(payload, "sandbox_mode");

    if approval_policy.as_deref() == Some("never")
        || sandbox_mode.as_deref() == Some("danger-full-access")
    {
        return Some(ComposerPermissionsPreset::FullAccess);
    }

    if matches!(
        approvals_reviewer.as_deref(),
        Some("auto_review" | "guardian_subagent")
    ) {
        return Some(ComposerPermissionsPreset::AutoReview);
    }

    if approval_policy.is_some() || approvals_reviewer.is_some() || sandbox_mode.is_some() {
        return Some(ComposerPermissionsPreset::Default);
    }

    None
}

fn overlay_thread_composer_state(thread: &mut ThreadSummary, payload: &Value) {
    if let Some(model) = optional_string(payload, "model") {
        thread.model = Some(model);
    }
    if let Some(reasoning_effort) = optional_string(payload, "reasoningEffort") {
        thread.reasoning_effort = Some(reasoning_effort);
    }
    if let Some(service_tier) = optional_string(payload, "serviceTier") {
        thread.service_tier = Some(service_tier);
    }
    if let Some(approval_policy) = optional_string(payload, "approvalPolicy") {
        thread.approval_policy = Some(approval_policy);
    }
    if let Some(approvals_reviewer) = optional_string(payload, "approvalsReviewer") {
        thread.approvals_reviewer = Some(approvals_reviewer);
    }
    if let Some(sandbox) = optional_value(payload, "sandbox") {
        thread.sandbox = Some(sandbox);
    }
}

fn completed_turn_count(turns: &[ThreadTurnSnapshot]) -> Option<i64> {
    if turns.is_empty() {
        return None;
    }
    Some(
        turns
            .iter()
            .filter(|turn| is_terminal_turn_status(&turn.status))
            .count() as i64,
    )
}

fn is_terminal_turn_status(status: &str) -> bool {
    matches!(
        status.to_lowercase().as_str(),
        "completed" | "failed" | "cancelled" | "canceled" | "interrupted"
    )
}

fn live_state_from_thread(thread: &Value) -> ThreadLiveState {
    if thread
        .get("turns")
        .and_then(Value::as_array)
        .is_some_and(|turns| turns.iter().any(turn_is_active))
    {
        return ThreadLiveState::Streaming;
    }

    match status_type(thread.get("status")).as_deref() {
        Some("notLoaded") => ThreadLiveState::NotLoaded,
        Some("active" | "idle" | "systemError") => ThreadLiveState::Idle,
        _ => ThreadLiveState::NotLoaded,
    }
}

fn turn_is_active(turn: &Value) -> bool {
    match status_type(turn.get("status")).as_deref() {
        Some("completed" | "failed" | "cancelled" | "canceled" | "interrupted") => false,
        Some(_) => true,
        None => false,
    }
}

fn status_type(value: Option<&Value>) -> Option<String> {
    value.and_then(|status| {
        status.as_str().map(str::to_string).or_else(|| {
            status
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
    })
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

    use crate::{
        app_server::AppServer,
        error::{ApiError, ApiResult},
    };

    use super::*;

    #[derive(Default)]
    struct RecordingServer {
        ready: AtomicBool,
        requests: StdMutex<Vec<(String, Value)>>,
        queued_responses: StdMutex<Vec<Value>>,
        response: StdMutex<Value>,
    }

    #[async_trait]
    impl AppServer for RecordingServer {
        fn is_ready(&self) -> bool {
            self.ready.load(Ordering::SeqCst)
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
            self.requests
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            let mut queued_responses = self.queued_responses.lock().unwrap();
            if !queued_responses.is_empty() {
                return Ok(queued_responses.remove(0));
            }
            drop(queued_responses);
            Ok(self.response.lock().unwrap().clone())
        }

        async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct NotMaterializedHistoryServer {
        requests: StdMutex<Vec<(String, Value)>>,
    }

    #[async_trait]
    impl AppServer for NotMaterializedHistoryServer {
        fn is_ready(&self) -> bool {
            true
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
            self.requests
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            if method == "thread/turns/list" {
                return Err(ApiError::BadGateway(
                    "app-server error -32600: thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message".to_string(),
                ));
            }
            Ok(json!({
                "thread": {
                    "id": "thread-1",
                    "cliVersion": "0.130.0",
                    "cwd": "/workspace",
                    "ephemeral": false,
                    "modelProvider": "openai",
                    "preview": "pending",
                    "source": "cli",
                    "status": {"type": "active"},
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_600_i64
                }
            }))
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
        assert_eq!(requests[0].1["persistExtendedHistory"], true);
        assert_eq!(requests[1].0, "thread/resume");
        assert_eq!(requests[1].1["persistExtendedHistory"], true);
        assert_eq!(requests[1].1["excludeTurns"], true);
        assert_eq!(requests[2].0, "thread/fork");
        assert_eq!(requests[2].1["persistExtendedHistory"], true);
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
        client.thread_list_recent_updated(10).await.unwrap();
        client
            .thread_list_cwds_updated(
                vec!["/chat/a".to_string(), "/chat/b".to_string()],
                None,
                Some(50),
            )
            .await
            .unwrap();
        *server.response.lock().unwrap() = json!({"thread": thread_summary_payload("thread-1")});
        client.thread_read("thread-1".to_string()).await.unwrap();
        *server.response.lock().unwrap() = json!({"thread": thread_summary_payload("thread-1")});
        client
            .thread_read_summary("thread-1".to_string())
            .await
            .unwrap();
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
                json!({
                    "cursor": "cursor-1",
                    "limit": 25,
                    "cwd": "/workspace",
                    "sortKey": "updated_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true
                })
            )
        );
        assert_eq!(
            requests[1],
            (
                "thread/list".to_string(),
                json!({
                    "cursor": null,
                    "limit": 10,
                    "cwd": null,
                    "sortKey": "updated_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true
                })
            )
        );
        assert_eq!(
            requests[2],
            (
                "thread/list".to_string(),
                json!({
                    "cursor": null,
                    "limit": 50,
                    "cwd": ["/chat/a", "/chat/b"],
                    "sortKey": "updated_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true
                })
            )
        );
        assert_eq!(
            requests[3],
            (
                "thread/read".to_string(),
                json!({"threadId": "thread-1", "includeTurns": true})
            )
        );
        assert_eq!(
            requests[4],
            (
                "thread/read".to_string(),
                json!({"threadId": "thread-1", "includeTurns": false})
            )
        );
        assert_eq!(
            requests[5],
            (
                "thread/archive".to_string(),
                json!({"threadId": "thread-1"})
            )
        );
        assert_eq!(
            requests[6],
            (
                "turn/start".to_string(),
                json!({"threadId": "thread-1", "input": [{"type": "text", "text": "hi"}]})
            )
        );
        assert_eq!(
            requests[7],
            (
                "turn/interrupt".to_string(),
                json!({"threadId": "thread-1", "turnId": "turn-1"})
            )
        );
    }

    #[tokio::test]
    async fn adapter_uses_schema_values_for_thread_turns_list() {
        let server = Arc::new(RecordingServer {
            ready: AtomicBool::new(true),
            response: StdMutex::new(
                json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
            ),
            ..Default::default()
        });
        let client = CodexClient::new(server.clone());

        client
            .thread_turns_list_page(
                "thread-1".to_string(),
                Some("cursor-1".to_string()),
                SortDirection::Desc,
                ThreadTurnItemsView::NotLoaded,
                Some(10),
            )
            .await
            .unwrap();
        client
            .thread_turns_list_page(
                "thread-1".to_string(),
                None,
                SortDirection::Asc,
                ThreadTurnItemsView::Summary,
                None,
            )
            .await
            .unwrap();
        client
            .thread_turns_list_page(
                "thread-1".to_string(),
                None,
                SortDirection::Asc,
                ThreadTurnItemsView::Full,
                None,
            )
            .await
            .unwrap();

        let requests = server.requests.lock().unwrap();
        assert_eq!(
            requests[0],
            (
                "thread/turns/list".to_string(),
                json!({
                    "threadId": "thread-1",
                    "cursor": "cursor-1",
                    "sortDirection": "desc",
                    "itemsView": "notLoaded",
                    "limit": 10
                })
            )
        );
        assert_eq!(requests[1].1["itemsView"], "summary");
        assert_eq!(requests[2].1["itemsView"], "full");
    }

    #[tokio::test]
    async fn adapter_reads_bounded_recent_history_window_and_counts_lightly() {
        let server = Arc::new(RecordingServer {
            ready: AtomicBool::new(true),
            queued_responses: StdMutex::new(vec![
                json!({
                    "thread": {
                        "id": "thread-1",
                        "cliVersion": "0.130.0",
                        "cwd": "/workspace",
                        "status": {"type": "idle"},
                        "source": "cli",
                        "preview": "hi",
                        "createdAt": 1_i64,
                        "updatedAt": 2_i64
                    }
                }),
                json!({
                    "data": [{
                        "id": "turn-2",
                        "status": {"type": "completed"},
                        "items": [{"id": "agent-2", "type": "agentMessage", "text": "new"}]
                    }],
                    "nextCursor": "older",
                    "backwardsCursor": "newer"
                }),
                json!({
                    "data": [
                        {"id": "turn-2", "status": {"type": "completed"}},
                        {"id": "turn-1", "status": {"type": "completed"}}
                    ],
                    "nextCursor": null,
                    "backwardsCursor": null
                }),
            ]),
            ..Default::default()
        });
        let client = CodexClient::new(server.clone());

        let response = client
            .thread_read_history_window("thread-1".to_string(), 50)
            .await
            .unwrap();

        assert_eq!(response.turns[0].id, "turn-2");
        assert_eq!(response.thread.last_completed_agent_turn_seq, Some(2));
        let history_page = response.history_page.unwrap();
        assert_eq!(history_page.older_cursor.as_deref(), Some("older"));
        assert!(history_page.has_older);

        let requests = server.requests.lock().unwrap();
        assert_eq!(requests[1].0, "thread/turns/list");
        assert_eq!(requests[1].1["sortDirection"], "desc");
        assert_eq!(requests[1].1["itemsView"], "full");
        assert_eq!(requests[1].1["limit"], 50);
        assert_eq!(requests[2].0, "thread/turns/list");
        assert_eq!(requests[2].1["itemsView"], "notLoaded");
        assert_eq!(requests[2].1["limit"], 200);
    }

    #[tokio::test]
    async fn thread_read_full_history_returns_thread_shell_when_turns_not_materialized() {
        let server = Arc::new(NotMaterializedHistoryServer::default());
        let client = CodexClient::new(server.clone());

        let response = client
            .thread_read_full_history("thread-1".to_string())
            .await
            .unwrap();

        assert_eq!(response.thread.id, "thread-1");
        assert!(response.turns.is_empty());
        assert_eq!(response.timeline.items.len(), 0);
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[1].0, "thread/turns/list");
    }

    #[test]
    fn user_message_snapshot_projects_skill_mentions_from_text_elements() {
        let item = ThreadItemSnapshot::from_payload(&json!({
            "id": "user-1",
            "type": "userMessage",
            "content": [
                {
                    "type": "text",
                    "text": "Use 🚀 $review-fix",
                    "text_elements": [{
                        "byteRange": {
                            "start": "Use 🚀 ".len(),
                            "end": "Use 🚀 $review-fix".len()
                        },
                        "placeholder": "$review-fix"
                    }]
                },
                {"type": "skill", "name": "review-fix", "path": "/skills/review-fix/SKILL.md"}
            ]
        }))
        .unwrap();

        assert_eq!(
            item.skill_mentions,
            vec![TimelineSkillMention {
                start: "Use 🚀 ".encode_utf16().count() as u32,
                end: "Use 🚀 $review-fix".encode_utf16().count() as u32,
                name: "review-fix".to_string(),
                path: "/skills/review-fix/SKILL.md".to_string(),
                display_name: None,
                scope: None,
                short_description: None,
                brand_color: None,
                icon_small_url: None,
            }]
        );
    }

    #[test]
    fn timeline_snapshot_item_serializes_compact_display_payload() {
        let large_output = "x".repeat(TIMELINE_PREVIEW_STRING_LIMIT + 1024);
        let turn = ThreadTurnSnapshot {
            id: "turn-1".to_string(),
            status: "completed".to_string(),
            started_at: Some(1),
            completed_at: Some(2),
            items: Vec::new(),
            raw_payload: json!({}),
        };
        let item = ThreadItemSnapshot::from_payload(&json!({
            "id": "command-1",
            "type": "commandExecution",
            "command": "cargo test",
            "aggregatedOutput": large_output,
            "internal": { "unbounded": "raw payload ballast" }
        }))
        .unwrap();

        let snapshot =
            ThreadTimelineSnapshotItem::from_turn_item("thread-1", &turn, &item, 1, true);
        let serialized = serde_json::to_value(&snapshot).unwrap();

        assert_eq!(serialized["payload"]["item"]["command"], "cargo test");
        assert!(serialized["payload"]["item"]["output"]
            .as_str()
            .unwrap()
            .ends_with("...[truncated]"));
        assert!(serialized["payload"]["item"]["internal"].is_null());
        assert!(serialized["payload"]["itemSnapshot"]["rawPayload"].is_null());
        assert!(
            serde_json::to_vec(&serialized).unwrap().len() < TIMELINE_PREVIEW_STRING_LIMIT + 2_000
        );
    }

    #[test]
    fn user_message_snapshot_ignores_unstructured_or_mismatched_skill_ranges() {
        let manual = ThreadItemSnapshot::from_payload(&json!({
            "id": "user-1",
            "type": "userMessage",
            "content": [{"type": "text", "text": "Use $review-fix"}]
        }))
        .unwrap();
        assert!(manual.skill_mentions.is_empty());

        let mismatched = ThreadItemSnapshot::from_payload(&json!({
            "id": "user-1",
            "type": "userMessage",
            "content": [
                {
                    "type": "text",
                    "text": "Use $other",
                    "text_elements": [{"byteRange": {"start": 4, "end": 10}}]
                },
                {"type": "skill", "name": "review-fix", "path": "/skills/review-fix/SKILL.md"}
            ]
        }))
        .unwrap();
        assert!(mismatched.skill_mentions.is_empty());
    }

    #[test]
    fn skill_mention_enrichment_requires_enabled_name_and_path_match() {
        let mentions = vec![TimelineSkillMention {
            start: 4,
            end: 15,
            name: "review-fix".to_string(),
            path: "/skills/review-fix/SKILL.md".to_string(),
            display_name: None,
            scope: None,
            short_description: None,
            brand_color: None,
            icon_small_url: None,
        }];
        let skill = SkillMetadata {
            name: "other".to_string(),
            path: "/skills/review-fix/SKILL.md".to_string(),
            description: "Should not apply".to_string(),
            enabled: true,
            scope: "user".to_string(),
            short_description: Some("Wrong skill".to_string()),
            interface: Some(SkillInterface {
                display_name: Some("Wrong".to_string()),
                short_description: Some("Wrong skill".to_string()),
                brand_color: Some("#f00".to_string()),
                default_prompt: None,
                icon_small: Some("/skills/review-fix/icon.png".to_string()),
                icon_large: None,
            }),
        };

        let enriched = enrich_timeline_skill_mentions(mentions, &[skill]);

        assert!(enriched[0].display_name.is_none());
        assert!(enriched[0].scope.is_none());
        assert!(enriched[0].short_description.is_none());
        assert!(enriched[0].brand_color.is_none());
        assert!(enriched[0].icon_small_url.is_none());
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

    #[tokio::test]
    async fn adapter_reads_and_writes_composer_settings_without_permissions() {
        let server = Arc::new(RecordingServer {
            ready: AtomicBool::new(true),
            response: StdMutex::new(json!({
                "config": {
                    "model": "gpt-5.4",
                    "model_reasoning_effort": "high",
                    "service_tier": "fast",
                    "approval_policy": "on-request",
                    "approvals_reviewer": "auto_review",
                    "sandbox_mode": "workspace-write"
                },
                "origins": {}
            })),
            ..Default::default()
        });
        let client = CodexClient::new(server.clone());

        let settings = client
            .composer_settings(Some("/workspace".to_string()))
            .await
            .unwrap();
        assert_eq!(settings.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(settings.effort.as_deref(), Some("high"));
        assert_eq!(settings.service_tier.as_deref(), Some("fast"));
        assert_eq!(
            settings.permissions_preset,
            Some(ComposerPermissionsPreset::AutoReview)
        );

        *server.response.lock().unwrap() = json!({"ok": true});
        client
            .update_composer_settings(ComposerSettingsUpdateRequest {
                model: Some(Some("gpt-5.4".to_string())),
                effort: Some(Some("medium".to_string())),
                service_tier: Some(None),
            })
            .await
            .unwrap();

        let requests = server.requests.lock().unwrap();
        assert_eq!(
            requests[0],
            (
                "config/read".to_string(),
                json!({"cwd": "/workspace", "includeLayers": false})
            )
        );
        assert_eq!(requests[1].0, "config/batchWrite");
        assert_eq!(
            requests[1].1,
            json!({
                "edits": [
                    {"keyPath": "model", "mergeStrategy": "replace", "value": "gpt-5.4"},
                    {"keyPath": "model_reasoning_effort", "mergeStrategy": "replace", "value": "medium"},
                    {"keyPath": "service_tier", "mergeStrategy": "replace", "value": null}
                ],
                "reloadUserConfig": true
            })
        );
    }

    #[test]
    fn composer_settings_permission_hint_is_read_only_and_conservative() {
        let default = ComposerSettingsResponse::from_payload(json!({
            "config": {
                "approval_policy": "on-request",
                "approvals_reviewer": "user",
                "sandbox_mode": "workspace-write"
            },
            "origins": {}
        }))
        .unwrap();
        assert_eq!(
            default.permissions_preset,
            Some(ComposerPermissionsPreset::Default)
        );

        let full_access = ComposerSettingsResponse::from_payload(json!({
            "config": {
                "approval_policy": "never",
                "approvals_reviewer": "user",
                "sandbox_mode": "workspace-write"
            },
            "origins": {}
        }))
        .unwrap();
        assert_eq!(
            full_access.permissions_preset,
            Some(ComposerPermissionsPreset::FullAccess)
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
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "gitInfo": {
                    "branch": "feature/git-underflow",
                    "originUrl": "git@github.com:example/kodex.git",
                    "sha": "abc123"
                },
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
        assert_eq!(
            thread
                .git_info
                .as_ref()
                .and_then(|git_info| git_info.branch.as_deref()),
            Some("feature/git-underflow")
        );
    }

    #[test]
    fn thread_list_normalization_does_not_derive_completed_marker_from_turns() {
        let mut thread = thread_summary_payload("thread-1");
        thread["turns"] = json!([{
            "id": "turn-1",
            "status": {"type": "completed"},
            "items": []
        }]);
        let response = ThreadListResponse::from_payload(json!({"data": [thread]})).unwrap();

        assert_eq!(response.threads[0].last_completed_agent_turn_seq, None);
        assert_eq!(response.threads[0].seen_completed_agent_turn_seq, 0);
        assert!(!response.threads[0].unread_completed_agent_turn);
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
    fn thread_detail_builds_canonical_timeline_snapshot_from_turns() {
        let mut thread = thread_summary_payload("thread-1");
        thread["turns"] = json!([{
            "id": "turn-1",
            "status": {"type": "completed"},
            "startedAt": 10,
            "completedAt": 12,
            "items": [
                {
                    "id": "user-1",
                    "type": "userMessage",
                    "content": [{"type": "text", "text": "Hello"}]
                },
                {
                    "id": "agent-1",
                    "type": "agentMessage",
                    "text": "Hi"
                }
            ]
        }]);

        let response = ThreadDetailResponse::from_payload(json!({ "thread": thread })).unwrap();

        assert_eq!(response.timeline.view_revision, 0);
        assert_eq!(response.timeline.items.len(), 2);
        assert_eq!(response.timeline.items[0].id, "projection-turn-1-user-1");
        assert_eq!(response.timeline.items[0].display_order, 1);
        assert_eq!(response.timeline.items[0].codex_method, "item/completed");
        assert_eq!(response.timeline.items[0].timestamp_ms, Some(10_000));
        assert_eq!(
            response.timeline.items[0].payload.source,
            TimelineUpdateSource::AppServerSnapshot
        );
        assert_eq!(response.timeline.items[1].id, "projection-turn-1-agent-1");
        assert_eq!(response.timeline.items[1].display_order, 2);
        assert_eq!(response.timeline.items[1].timestamp_ms, Some(12_000));
        let serialized_timeline = serde_json::to_value(&response.timeline).unwrap();
        assert!(
            serialized_timeline.get("items").is_none(),
            "selected-thread timeline responses should serialize rows without duplicate flat items"
        );
    }

    #[test]
    fn thread_detail_live_state_requires_active_turn_not_just_active_thread() {
        let response = ThreadDetailResponse::from_payload(json!({
            "thread": {
                "id": "thread-1",
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "preview": "hello",
                "source": "cli",
                "status": {"type": "active"},
                "turns": [{
                    "id": "turn-1",
                    "status": {"type": "completed"},
                    "items": []
                }],
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }
        }))
        .unwrap();
        assert_eq!(response.live_state, ThreadLiveState::Idle);

        let response = ThreadDetailResponse::from_payload(json!({
            "thread": {
                "id": "thread-1",
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "preview": "hello",
                "source": "cli",
                "status": {"type": "active"},
                "turns": [{
                    "id": "turn-1",
                    "status": {"type": "running"},
                    "items": []
                }],
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }
        }))
        .unwrap();
        assert_eq!(response.live_state, ThreadLiveState::Streaming);
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
        let response =
            ThreadCommandResponse::from_payload(thread_command_payload("thread-1")).unwrap();
        assert_eq!(response.thread.model.as_deref(), Some("gpt-5.4"));
        assert_eq!(response.thread.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(response.thread.service_tier.as_deref(), Some("fast"));
        assert_eq!(
            response.thread.approvals_reviewer.as_deref(),
            Some("auto_review")
        );
        assert_eq!(response.sandbox, Some(json!({"type": "dangerFullAccess"})));
        assert_eq!(
            response.thread.sandbox,
            Some(json!({"type": "dangerFullAccess"}))
        );
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
            "modelProvider": "openai",
            "reasoningEffort": "high",
            "serviceTier": "fast",
            "approvalPolicy": "on-request",
            "approvalsReviewer": "auto_review",
            "sandbox": {"type": "dangerFullAccess"}
        })
    }

    fn thread_summary_payload(id: &str) -> Value {
        json!({
            "id": id,
            "cliVersion": "0.130.0",
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
