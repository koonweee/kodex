use std::sync::Arc;

use super::*;
use crate::{app_server::tests::RecordingAppServer, config::Config, store::Store};

async fn generated_surface() -> (AppState, Arc<RecordingAppServer>, AppSurfaceSession) {
    let native = Arc::new(RecordingAppServer::default());
    let state = AppState::new(
        Config::default(),
        Store::in_memory().await.unwrap(),
        native.clone(),
    );
    let session = state
        .store
        .upsert_app_surface_session(crate::store::AppSurfaceSessionUpsert {
            thread_id: "kodex-chat".into(),
            provider: AppSurfaceProvider::Generated,
            title: "Generated lookup".into(),
            resource_uri: None,
            resource_mime_type: MCP_APP_MIME_TYPE.into(),
            html: "<h1>Lookup</h1>".into(),
            fallback_content: "Lookup".into(),
            display_modes: vec!["inline".into()],
            csp: Default::default(),
            permissions: Default::default(),
            grants: AppSurfaceGrants {
                tools: vec![AppSurfaceToolGrant {
                    name: Some("lookup".into()),
                    server: "docs".into(),
                    tool: "search".into(),
                }],
                ..Default::default()
            },
            provenance: json!({}),
        })
        .await
        .unwrap();
    (state, native, session)
}

fn request(session: &AppSurfaceSession, params: Value) -> AppSurfaceBridgeRequest {
    AppSurfaceBridgeRequest {
        id: Some(json!(1)),
        revision: session.revision,
        bridge_token: Some(session.bridge_token.clone()),
        method: "tools/call".into(),
        params,
    }
}

async fn approve(state: &AppState, session: &AppSurfaceSession, params: Value) -> String {
    let result = bridge_tool_call(state.clone(), session.clone(), request(session, params))
        .await
        .unwrap();
    assert_eq!(result["approvalRequired"], true);
    let id = result["approvalId"].as_str().unwrap().to_string();
    crate::approvals::decide_approval(state, &id, json!({"decision":"accept"}))
        .await
        .unwrap();
    id
}

fn call_params() -> Value {
    json!({
        "name":"lookup",
        "arguments":{"query":"approved café","filter":{"ids":["one", "two"]}},
        "_meta":{"link_id":"approved-account","trace":{"source":"generated-ui"}}
    })
}

async fn assert_changed_call_rejected(field: &str, replacement: Value) {
    let (state, native, session) = generated_surface().await;
    let mut params = call_params();
    let id = approve(&state, &session, params.clone()).await;
    assert!(native.requests.lock().unwrap().is_empty());
    params["approvalId"] = json!(id);
    params[field] = replacement;
    *native.next_response.lock().unwrap() = Some(json!({"content":[]}));
    let result = bridge_tool_call(state, session.clone(), request(&session, params)).await;
    assert!(
        matches!(result, Err(ApiError::BadRequest(_))),
        "a changed {field} must not reuse the approved call: {result:?}"
    );
    assert!(native.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn generated_approval_rejects_changed_arguments_before_native_call() {
    assert_changed_call_rejected("arguments", json!({"query":"unapproved export"})).await;
}

#[tokio::test]
async fn generated_approval_rejects_changed_metadata_before_native_call() {
    assert_changed_call_rejected("_meta", json!({"link_id":"different-account"})).await;
}

#[tokio::test]
async fn generated_approval_records_and_executes_the_exact_approved_call() {
    let (state, native, session) = generated_surface().await;
    let mut params = call_params();
    let id = approve(&state, &session, params.clone()).await;
    let approval = state.store.get_approval(&id).await.unwrap();
    assert_eq!(approval.payload.get("arguments"), params.get("arguments"));
    assert_eq!(approval.payload.get("_meta"), params.get("_meta"));
    assert!(native.requests.lock().unwrap().is_empty());

    params["approvalId"] = json!(id);
    *native.next_response.lock().unwrap() =
        Some(json!({"content":[{"type":"text","text":"Found"}]}));
    bridge_tool_call(state, session.clone(), request(&session, params.clone()))
        .await
        .unwrap();
    let requests = native.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "mcpServer/tool/call");
    assert_eq!(
        requests[0].1,
        json!({
            "server":"docs", "threadId":"kodex-chat", "tool":"search",
            "arguments":params["arguments"], "_meta":params["_meta"]
        })
    );
}

#[tokio::test]
async fn generated_approval_distinguishes_absent_and_null_call_fields() {
    for field in ["arguments", "_meta"] {
        for originally_present in [false, true] {
            let (state, native, session) = generated_surface().await;
            let mut params = json!({"name":"lookup"});
            if originally_present {
                params[field] = Value::Null;
            }
            let id = approve(&state, &session, params.clone()).await;
            let approval = state.store.get_approval(&id).await.unwrap();
            assert_eq!(approval.payload.get(field), params.get(field));
            let original = params.clone();
            params["approvalId"] = json!(id);
            if originally_present {
                params.as_object_mut().unwrap().remove(field);
            } else {
                params[field] = Value::Null;
            }
            *native.next_response.lock().unwrap() = Some(json!({"content":[]}));
            let result =
                bridge_tool_call(state.clone(), session.clone(), request(&session, params)).await;
            assert!(
                matches!(result, Err(ApiError::BadRequest(_))),
                "changed field presence must require approval"
            );
            assert!(native.requests.lock().unwrap().is_empty());

            let mut exact = original;
            exact["approvalId"] = json!(id);
            bridge_tool_call(state, session.clone(), request(&session, exact))
                .await
                .unwrap();
            assert_eq!(native.requests.lock().unwrap().len(), 1);
        }
    }
}
