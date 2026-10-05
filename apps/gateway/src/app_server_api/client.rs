use std::sync::Arc;

use serde_json::{json, Value};

use crate::{
    app_server::DynAppServer,
    error::{ApiError, ApiResult},
    schema::validate_client_request_params,
};

use super::*;

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

    pub async fn thread_start(
        &self,
        project_id: String,
        cwd: String,
        payload: Value,
    ) -> ApiResult<ThreadCommandResponse> {
        let payload = require_paginated_history(merge_path_payload(
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
        let mut payload = require_paginated_history(merge_path_payload("cwd", cwd, payload));
        payload["projectId"] = Value::Null;
        let payload = self.request("thread/start", payload).await?;
        ThreadCommandResponse::from_payload(payload)
    }

    pub async fn thread_read(&self, thread_id: String) -> ApiResult<ThreadDetailResponse> {
        let payload = self
            .request(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": true }),
            )
            .await?;
        ThreadDetailResponse::from_payload(payload)
    }

    pub async fn thread_read_summary(&self, thread_id: String) -> ApiResult<ThreadSummary> {
        let payload = self
            .request(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": false }),
            )
            .await?;
        let thread = payload
            .get("thread")
            .ok_or_else(|| bad_gateway("thread/read response missing thread"))?;
        ThreadSummary::from_payload(thread)
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
            .request(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": false }),
            )
            .await?;
        let page = match self
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
        Self::thread_detail_from_turns_page(payload, page, limit)
    }

    /// Rejoin native execution and receive its ordered recent history page in
    /// the same response. History-only observers use thread_read_history_window.
    pub async fn thread_resume_history_window(
        &self,
        thread_id: String,
        limit: u32,
    ) -> ApiResult<ThreadDetailResponse> {
        let payload = match self.request(
            "thread/resume",
            json!({
                "threadId": thread_id,
                "excludeTurns": true,
                "initialTurnsPage": {"limit": limit, "sortDirection": "desc", "itemsView": "full"},
            }),
        ).await {
            Ok(payload) => payload,
            // The pinned native runtime cannot resume a fresh loaded shell
            // before persistence. A native read must independently prove that
            // it exists; never fabricate an empty view from this rejection.
            Err(ApiError::BadGateway(message)) if message.split("; data: ").next() == Some(
                format!("app-server error -32600: no rollout found for thread id {thread_id}").as_str()
            ) => return self.thread_read_history_window(thread_id, limit).await,
            Err(error) => return Err(error),
        };
        let mut page = ThreadTurnsListPage::from_payload(
            payload
                .get("initialTurnsPage")
                .cloned()
                .ok_or_else(|| bad_gateway("thread/resume response missing initialTurnsPage"))?,
        )?;
        // The pinned runtime reconstructs active resume items with item-N IDs,
        // unlike live receipts and durable full history. Read native persisted
        // IDs for active rejoins rather than maintaining a second alias table.
        if page.data.iter().any(|turn| turn.status == "inProgress") {
            page = match self
                .thread_turns_list_page(
                    thread_id.clone(),
                    None,
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
        }
        Self::thread_detail_from_turns_page(payload, page, limit)
    }

    fn thread_detail_from_turns_page(
        payload: Value,
        mut page: ThreadTurnsListPage,
        limit: u32,
    ) -> ApiResult<ThreadDetailResponse> {
        page.data.reverse();
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
            .request(
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

    /// Observe a bounded native completion head without transcript hydration.
    /// A truncated page without a terminal header cannot prove an empty head.
    pub async fn thread_completion_head(&self, thread_id: String) -> ApiResult<Vec<String>> {
        let page = match self
            .thread_turns_list_page(
                thread_id,
                None,
                SortDirection::Desc,
                ThreadTurnItemsView::NotLoaded,
                Some(8),
            )
            .await
        {
            Ok(page) => page,
            Err(error) if is_thread_history_not_materialized_error(&error) => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        super::validate_native_next_cursor(&page.raw_payload)?;
        // The pinned Turn contract requires a native string status. The
        // timeline's tolerant parser is unsuitable evidence of an empty head.
        if page.data.iter().any(|turn| {
            !matches!(
                turn.raw_payload.get("status").and_then(Value::as_str),
                Some("completed" | "interrupted" | "failed" | "inProgress")
            )
        }) {
            return Err(bad_gateway(
                "native completion header has a missing or invalid required status",
            ));
        }
        let terminal_ids = page
            .data
            .into_iter()
            .filter(|turn| is_terminal_turn_status(&turn.status))
            .map(|turn| turn.id)
            .collect::<Vec<_>>();
        if !terminal_ids.is_empty() {
            return Ok(terminal_ids);
        }
        if page.next_cursor.is_some() {
            return Err(bad_gateway(
                "native completion head is unknown in the bounded header page",
            ));
        }
        Ok(Vec::new())
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
        reject_external_thread_import(&payload)?;
        let payload =
            require_metadata_only_thread(merge_path_payload("threadId", thread_id, payload));
        let payload = self.request("thread/resume", payload).await?;
        ThreadCommandResponse::from_payload(payload)
    }

    pub async fn thread_fork(
        &self,
        thread_id: String,
        payload: Value,
    ) -> ApiResult<ThreadCommandResponse> {
        reject_external_thread_import(&payload)?;
        let payload = self
            .request(
                "thread/fork",
                require_metadata_only_thread(merge_path_payload("threadId", thread_id, payload)),
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
        client_id: Option<String>,
    ) -> ApiResult<RawAppServerResponse> {
        options.validate()?;
        let mut payload = json!({ "threadId": thread_id, "input": input });
        options.apply_to_payload(&mut payload);
        if let Some(client_id) = client_id {
            payload["clientUserMessageId"] = json!(client_id);
        }
        let payload = self.request("turn/start", payload).await?;
        Ok(RawAppServerResponse { payload })
    }

    pub async fn turn_steer(
        &self,
        thread_id: String,
        expected_turn_id: String,
        input: Vec<UserInput>,
        client_id: Option<String>,
    ) -> ApiResult<RawAppServerResponse> {
        self.raw_request(
            "turn/steer",
            json!({
                "threadId": thread_id,
                "expectedTurnId": expected_turn_id,
                "input": input,
                "clientUserMessageId": client_id,
            }),
        )
        .await
    }

    /// Queue promotion preserves the native input envelope and must never
    /// replace its original turn guard after rejection or an ambiguous reply.
    pub async fn turn_steer_native_input(
        &self,
        thread_id: String,
        expected_turn_id: String,
        input: Vec<Value>,
        client_id: String,
    ) -> ApiResult<RawAppServerResponse> {
        let payload = self
            .request(
                "turn/steer",
                json!({
                    "threadId": thread_id,
                    "expectedTurnId": expected_turn_id,
                    "input": input,
                    "clientUserMessageId": client_id,
                }),
            )
            .await?;
        // The pinned TurnSteerResponse requires one string turnId. Receiving
        // an ACK for another turn cannot authorize changing the intended turn.
        if payload.get("turnId").and_then(Value::as_str) != Some(expected_turn_id.as_str()) {
            return Err(super::bad_gateway(
                "turn/steer response did not acknowledge the original turn",
            ));
        }
        Ok(RawAppServerResponse { payload })
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

    pub async fn login_start(&self) -> ApiResult<LoginStartResponse> {
        let payload = self
            .request(
                "account/login/start",
                json!({ "type": "chatgptDeviceCode" }),
            )
            .await?;
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
        self.mcp_server_status_list_scoped(detail, None, None).await
    }

    pub(crate) async fn mcp_server_status_list_scoped(
        &self,
        detail: McpServerStatusDetail,
        thread_id: Option<&str>,
        server_name: Option<&str>,
    ) -> ApiResult<McpServerListResponse> {
        let mut cursor: Option<String> = None;
        let mut servers = Vec::new();
        loop {
            let mut params = json!({"cursor": cursor, "detail": detail, "limit": 100});
            if let Some(thread_id) = thread_id {
                params["threadId"] = json!(thread_id);
            }
            if let Some(server_name) = server_name {
                params["serverName"] = json!(server_name);
            }
            let payload = self.request("mcpServerStatus/list", params).await?;
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
        request: McpResourceReadRequest,
    ) -> ApiResult<McpResourceReadResponse> {
        let payload = self
            .request("mcpServer/resource/read", serde_json::to_value(request)?)
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

    pub(super) async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
        validate_client_request_params(method, params.clone())?;
        self.app_server.request(method, params).await
    }
}

fn reject_external_thread_import(payload: &Value) -> ApiResult<()> {
    if ["path", "history"]
        .iter()
        .any(|key| payload.get(key).is_some_and(|value| !value.is_null()))
    {
        return Err(ApiError::BadRequest(
            "Thread commands require a native ID from the dedicated Kodex home; path/history imports are unavailable".into(),
        ));
    }
    Ok(())
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
