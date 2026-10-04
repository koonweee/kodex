use super::*;

async fn hosted_surface(state: &AppState) -> AppSurfaceSession {
    state.store.upsert_app_surface_session(crate::store::AppSurfaceSessionUpsert {
        thread_id: "kodex-chat".into(), provider: AppSurfaceProvider::Mcp,
        title: "Native account app".into(), resource_uri: Some("ui://account/widget".into()),
        resource_mime_type: MCP_APP_MIME_TYPE.into(), html: "<h1>Account app</h1>".into(), fallback_content: "Account app".into(),
        display_modes: vec!["inline".into()], csp: Default::default(), permissions: Default::default(),
        grants: AppSurfaceGrants { tools: vec![AppSurfaceToolGrant {name: Some("lookup".into()), server: "codex_apps".into(), tool: "lookup".into()}], resources: vec![AppSurfaceResourceGrant {server:Some("codex_apps".into()),uri:"ui://account/data".into()}], ..Default::default() },
        provenance: json!({"mcp":{"server":"codex_apps","itemId":"origin-call","originCallId":"origin-call","appContext":{"connectorId":"connector-A","linkId":"account-A"}}}),
    }).await.unwrap()
}

#[tokio::test]
async fn hosted_bridge_cannot_change_the_originating_account_and_resource_scope() {
    let native = std::sync::Arc::new(crate::app_server::tests::RecordingAppServer::default());
    let state = AppState::new(
        crate::config::Config::default(),
        crate::store::Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let session = hosted_surface(&state).await;
    let request = |method: &str, params: Value| AppSurfaceBridgeRequest {
        id: Some(json!(1)),
        revision: session.revision,
        bridge_token: Some(session.bridge_token.clone()),
        method: method.into(),
        params,
    };
    let changed = bridge_tool_call(
        state.clone(),
        session.clone(),
        request(
            "tools/call",
            json!({"name":"lookup","arguments":{"link_id":"account-B"}}),
        ),
    )
    .await;
    assert!(
        matches!(changed, Err(ApiError::BadRequest(_))),
        "iframe-selected foreign account must not reach native tool call"
    );
    assert!(native.requests.lock().unwrap().is_empty());
    *native.next_response.lock().unwrap() = Some(json!({"content":[]}));
    bridge_tool_call(state.clone(), session.clone(), request("tools/call", json!({"name":"lookup","arguments":{"query":"safe"},"_meta":{"trace":"retained","connector_id":"foreign","link_id":"account-B","x-codex-turn-metadata":{"mcp_request_meta":{"selected_connector_ids":["foreign"],"link_id":"account-B"}}}}))).await.unwrap();
    let params = native.requests.lock().unwrap()[0].1.clone();
    assert_eq!(params["threadId"], "kodex-chat");
    assert_eq!(params["_meta"]["trace"], "retained");
    assert_eq!(params["_meta"]["connector_id"], "connector-A");
    assert_eq!(params["_meta"]["link_id"], "account-A");
    assert_eq!(
        params["_meta"]["x-codex-turn-metadata"]["mcp_request_meta"],
        json!({"selected_connector_ids":["connector-A"],"link_id":"account-A"})
    );
    *native.next_response.lock().unwrap() =
        Some(json!({"contents":[{"uri":"ui://account/data","text":"Scoped"}]}));
    bridge_resource_read(state.clone(), session.clone(), request("resources/read",json!({"uri":"ui://account/data","target":{"connectorId":"foreign","linkId":"account-B"}}))).await.unwrap();
    let params = native.requests.lock().unwrap()[1].1.clone();
    assert_eq!(
        params["target"],
        json!({"connectorId":"connector-A","linkId":"account-A"})
    );
    assert!(
        params.get("originCallId").is_none(),
        "native origins authorize only the widget URI, not arbitrary additional resources"
    );
}

#[tokio::test]
async fn verified_explicit_no_auth_account_is_not_inferred_from_missing_context() {
    let native = std::sync::Arc::new(crate::app_server::tests::RecordingAppServer::default());
    let state = AppState::new(
        crate::config::Config::default(),
        crate::store::Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let mut session = hosted_surface(&state).await;
    let request = |method: &str, params: Value| AppSurfaceBridgeRequest {
        id: Some(json!(1)),
        revision: session.revision,
        bridge_token: Some(session.bridge_token.clone()),
        method: method.into(),
        params,
    };
    session.provenance["mcp"]["appContext"]
        .as_object_mut()
        .unwrap()
        .remove("linkId");
    assert!(matches!(
        bridge_resource_read(
            state.clone(),
            session.clone(),
            request("resources/read", json!({"uri":"ui://account/data"}))
        )
        .await,
        Err(ApiError::BadRequest(_))
    ));
    assert!(matches!(
        bridge_tool_call(
            state.clone(),
            session.clone(),
            request("tools/call", json!({"name":"lookup"}))
        )
        .await,
        Err(ApiError::BadRequest(_))
    ));
    assert!(native.requests.lock().unwrap().is_empty());
    session.provenance["mcp"]["appContext"]["linkId"] = Value::Null;
    *native.next_response.lock().unwrap() = Some(json!({"contents":[]}));
    bridge_resource_read(
        state.clone(),
        session.clone(),
        request("resources/read", json!({"uri":"ui://account/data"})),
    )
    .await
    .unwrap();
    let params = native.requests.lock().unwrap()[0].1.clone();
    assert_eq!(
        params["target"],
        json!({"connectorId":"connector-A","linkId":null})
    );
    *native.next_response.lock().unwrap() = Some(json!({"content":[]}));
    bridge_tool_call(
        state.clone(),
        session.clone(),
        request("tools/call", json!({"name":"lookup"})),
    )
    .await
    .unwrap();
    let params = native.requests.lock().unwrap()[1].1.clone();
    assert_eq!(
        params["_meta"]["x-codex-turn-metadata"]["mcp_request_meta"],
        json!({"selected_connector_ids":["connector-A"],"link_id":null})
    );
    session.provenance["mcp"]["originCallId"] = Value::Null;
    assert!(matches!(
        bridge_resource_read(
            state,
            session.clone(),
            request("resources/read", json!({"uri":"ui://account/data"}))
        )
        .await,
        Err(ApiError::BadRequest(_))
    ));
    assert_eq!(
        native.requests.lock().unwrap().len(),
        2,
        "unknown origin must not fall back to a no-auth RPC"
    );
}
