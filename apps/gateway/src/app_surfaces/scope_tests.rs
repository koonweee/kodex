use super::*;
use serde_json::json;
use std::sync::Arc;

fn item(server: &str) -> Value {
    json!({"type":"mcpToolCall","id":"origin","server":server,"tool":"show","status":"completed","error":null,
        "mcpAppUi":{"resourceUri":"ui://widget","preferredModelDisplayMode":"inline"},
        "appContext":{"connectorId":"app-A","linkId":"account-A","actionName":"Native action"},
        "arguments":{},"result":{"content":[{"type":"text","text":"Ready"}]}})
}
fn resource(origin: Option<&str>) -> Value {
    json!({"originCallId":origin,"contents":[{"uri":"ui://widget","mimeType":MCP_APP_MIME_TYPE,"text":"<h1>Native widget</h1>"}]})
}
fn tool(name: &str, connector: &str, account: &str) -> Value {
    json!({"name":name,"inputSchema":{"type":"object"},"_meta":{"ui":{"visibility":["app"]},"connector_id":connector,"link_id":account}})
}

#[tokio::test]
async fn native_widget_import_verifies_origin_and_limits_grants_to_its_thread_app_and_account() {
    let native = Arc::new(crate::app_server::tests::RecordingAppServer::default());
    let state = AppState::new(
        crate::config::Config::default(),
        crate::store::Store::in_memory().await.unwrap(),
        native.clone(),
    );
    native.queued_responses.lock().unwrap().extend([resource(Some("origin")),json!({"data":[{
        "name":"codex_apps","authStatus":"oAuth","tools":{
            "own":tool("own","app-A","account-A"),"otherApp":tool("otherApp","app-B","account-A"),"otherAccount":tool("otherAccount","app-A","account-B")},
        "resources":[{"name":"own","uri":"ui://own","_meta":{"connector_id":"app-A","link_id":"account-A"}},{"name":"foreign","uri":"ui://foreign","_meta":{"connector_id":"app-B","link_id":"account-A"}}],"resourceTemplates":[]
    }],"nextCursor":null})]);
    let surface = prepare_mcp_app_surface(
        &state,
        "chat",
        McpAppSurfaceCandidate::from_item("turn", &item("codex_apps")).unwrap(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(surface.title, "Native action");
    assert_eq!(surface.provenance["mcp"]["originCallId"], "origin");
    assert_eq!(
        surface
            .grants
            .tools
            .iter()
            .map(|t| t.tool.as_str())
            .collect::<Vec<_>>(),
        vec!["own"]
    );
    assert_eq!(
        surface
            .grants
            .resources
            .iter()
            .map(|r| r.uri.as_str())
            .collect::<Vec<_>>(),
        vec!["ui://own"]
    );
    let calls = native.requests.lock().unwrap();
    assert_eq!(calls[0].1["originCallId"], "origin");
    assert_eq!(calls[0].1["threadId"], "chat");
    assert_eq!(calls[1].0, "mcpServerStatus/list");
    assert_eq!(calls[1].1["threadId"], "chat");
    assert_eq!(calls[1].1["serverName"], "codex_apps");
}

#[tokio::test]
async fn missing_or_wrong_hosted_native_origin_does_not_create_an_artifact_or_discover_grants() {
    for origin in [None, Some("other-call")] {
        let native = Arc::new(crate::app_server::tests::RecordingAppServer::default());
        let state = AppState::new(
            crate::config::Config::default(),
            crate::store::Store::in_memory().await.unwrap(),
            native.clone(),
        );
        *native.next_response.lock().unwrap() = Some(resource(origin));
        assert!(matches!(
            prepare_mcp_app_surface(
                &state,
                "chat",
                McpAppSurfaceCandidate::from_item("turn", &item("codex_apps")).unwrap()
            )
            .await,
            Err(ApiError::BadGateway(_))
        ));
        assert!(state
            .store
            .latest_app_surface_session("chat")
            .await
            .unwrap()
            .is_none());
        assert_eq!(native.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn fresh_regular_mcp_result_widget_needs_no_hosted_account_origin() {
    let native = Arc::new(crate::app_server::tests::RecordingAppServer::default());
    let state = AppState::new(
        crate::config::Config::default(),
        crate::store::Store::in_memory().await.unwrap(),
        native.clone(),
    );
    native.queued_responses.lock().unwrap().extend([resource(None),json!({"data":[{"name":"docs","authStatus":"notLoggedIn","tools":{"show":tool("show","ignored","ignored")},"resources":[],"resourceTemplates":[]}],"nextCursor":null})]);
    let mut item = item("docs");
    item["appContext"] = Value::Null;
    item["mcpAppUi"] = Value::Null;
    item["result"]["_meta"] = json!({"ui":{"resourceUri":"ui://widget"}});
    let surface = prepare_mcp_app_surface(
        &state,
        "chat",
        McpAppSurfaceCandidate::from_item("turn", &item).unwrap(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(surface.grants.tools.len(), 1);
    assert_eq!(surface.provenance["mcp"]["appContext"], Value::Null);
}
