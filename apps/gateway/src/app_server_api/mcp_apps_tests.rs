use super::*;
use serde_json::json;

#[test]
fn native_mcp_runtime_and_resource_provenance_survive_projection() {
    let native = json!({
        "name":"account-apps","authStatus":"oAuth","tools":{},"resources":[],"resourceTemplates":[],
        "runtimeStatus":"failed","toolsError":"Account selection required",
        "serverCapabilities":{"resources":{"subscribe":true},"future":42},
        "serverInfo":{"name":"provider","version":"1","futurePresentation":"kept"},
        "httpOrigin":"https://apps.example.test","pluginId":"provider:plugin",
        "futureNativeStatus":{"opaque":"kept"}
    });
    let row: McpServerStatus = serde_json::from_value(native.clone()).unwrap();
    let projected = serde_json::to_value(row).unwrap();
    for field in [
        "runtimeStatus",
        "toolsError",
        "serverCapabilities",
        "serverInfo",
        "httpOrigin",
        "pluginId",
        "futureNativeStatus",
    ] {
        assert_eq!(
            projected.get(field),
            native.get(field),
            "native field {field}"
        );
    }
    let resource = json!({"contents":[{"uri":"ui://shared","text":"Scoped","_meta":{"ui":{"future":true}}}],"originCallId":"origin-call","futureResourceResult":{"retained":true}});
    let response: McpResourceReadResponse = serde_json::from_value(resource.clone()).unwrap();
    assert_eq!(serde_json::to_value(response).unwrap(), resource);
}

#[tokio::test]
async fn explicit_native_thread_commands_cannot_import_foreign_path_or_history() {
    let native = std::sync::Arc::new(crate::app_server::tests::RecordingAppServer::default());
    let client = CodexClient::new(native.clone());
    for payload in [
        json!({"path":"/foreign/desktop/rollout.jsonl"}),
        json!({"history":[]}),
    ] {
        for fork in [false, true] {
            let result = if fork {
                client
                    .thread_fork("kodex-owned-id".into(), payload.clone())
                    .await
            } else {
                client
                    .thread_resume("kodex-owned-id".into(), payload.clone())
                    .await
            };
            assert!(
                matches!(result, Err(ApiError::BadRequest(_))),
                "import selector accepted: {payload}, fork={fork}"
            );
        }
    }
    assert!(native.requests.lock().unwrap().is_empty());
    let response = client
        .thread_resume(
            "kodex-owned-id".into(),
            json!({"path":null,"history":null,"model":"native-model"}),
        )
        .await;
    assert!(
        response.is_ok(),
        "null selectors remain ordinary native ID targeting"
    );
    let requests = native.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].1["threadId"], "kodex-owned-id");
    assert_eq!(requests[0].1["model"], "native-model");
}
