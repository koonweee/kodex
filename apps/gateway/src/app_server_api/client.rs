use std::sync::Arc;

use serde_json::{json, Value};
use tokio::time::{sleep, Duration};

use crate::{
    app_server::DynAppServer,
    error::{ApiError, ApiResult},
    schema::validate_client_request_params,
};

use super::*;

const ROLLOUT_LOAD_RETRY_ATTEMPTS: usize = 6;
const ROLLOUT_LOAD_RETRY_DELAY: Duration = Duration::from_millis(50);
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

    pub async fn thread_compact_start(&self, thread_id: String) -> ApiResult<RawAppServerResponse> {
        self.raw_request("thread/compact/start", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn permission_profile_list(
        &self,
        cwd: Option<String>,
        cursor: Option<String>,
        limit: Option<u32>,
    ) -> ApiResult<PermissionProfileListPage> {
        let payload = self
            .request(
                "permissionProfile/list",
                json!({
                    "cwd": cwd,
                    "cursor": cursor,
                    "limit": limit,
                }),
            )
            .await?;
        PermissionProfileListPage::from_payload(payload)
    }

    pub async fn turn_start(
        &self,
        thread_id: String,
        input: Vec<UserInput>,
        options: TurnStartOptions,
    ) -> ApiResult<RawAppServerResponse> {
        options.validate()?;
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

    pub async fn mcp_tool_call(
        &self,
        request: McpServerToolCallRequest,
    ) -> ApiResult<McpServerToolCallResponse> {
        let payload = self
            .request(
                "mcpServer/tool/call",
                json!({
                    "server": request.server,
                    "threadId": request.thread_id,
                    "tool": request.tool,
                    "arguments": request.arguments,
                    "_meta": request.meta,
                }),
            )
            .await?;
        McpServerToolCallResponse::from_payload(payload)
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
    let Some(normalized) = normalized_bad_gateway_message(error) else {
        return false;
    };
    is_thread_not_materialized_before_first_user_message(error)
        && normalized.contains("thread/turns/list")
}

pub(crate) fn is_thread_not_materialized_before_first_user_message(error: &ApiError) -> bool {
    let Some(normalized) = normalized_bad_gateway_message(error) else {
        return false;
    };
    normalized.contains("not materialized yet") && normalized.contains("before first user message")
}

fn normalized_bad_gateway_message(error: &ApiError) -> Option<String> {
    let ApiError::BadGateway(message) = error else {
        return None;
    };
    Some(message.to_ascii_lowercase())
}

pub fn client(app_server: &DynAppServer) -> CodexClient {
    CodexClient::new(Arc::clone(app_server))
}
