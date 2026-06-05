use std::process::Stdio;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

use axum::{
    body::Bytes,
    extract::State,
    http::{Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use rmcp::{
    model::{
        CallToolRequestParams, JsonObject, Meta, ReadResourceRequestParams, RequestParamsMeta, Tool,
    },
    transport::{ConfigureCommandExt, TokioChildProcess},
    ServiceExt,
};
use serde_json::{json, Value};
use tokio::net::TcpListener;

#[tokio::test]
async fn kodex_control_mcp_stdio_lists_tools() -> anyhow::Result<()> {
    let transport = TokioChildProcess::new(
        tokio::process::Command::new(env!("CARGO_BIN_EXE_kodex-gateway")).configure(|command| {
            command
                .arg("mcp")
                .arg("kodex-control")
                .env("KODEX_GATEWAY_URL", "http://127.0.0.1:8787")
                .stderr(Stdio::null());
        }),
    )?;
    let client = ().serve(transport).await?;
    let tools = client.list_all_tools().await?;
    assert!(tools.iter().any(|tool| tool.name == "get_status"));
    assert_tool_requires(&tools, "send_thread_input", &["threadId", "input"]);
    assert_tool_requires(&tools, "spawn_thread", &["projectId", "input"]);
    assert_tool_requires(&tools, "rename_thread", &["threadId", "name"]);
    assert_tool_requires(&tools, "update_thread_settings", &["threadId", "settings"]);
    assert_tool_requires(
        &tools,
        "open_app_surface",
        &["title", "html", "fallbackContent"],
    );
    assert_tool_does_not_require(&tools, "open_app_surface", "threadId");
    assert_tool_requires(&tools, "open_generated_ui", &["title", "html"]);
    assert_tool_requires(&tools, "deny_approval", &["approvalId"]);
    assert_tool_requires(
        &tools,
        "decide_approval_with_policy",
        &["approvalId", "decision", "requestedBy"],
    );
    assert_tool_requires(
        &tools,
        "wait_for_thread_event",
        &["threadId", "kind", "timeoutMs"],
    );

    let resources = client.list_all_resources().await?;
    assert!(resources
        .iter()
        .any(|resource| resource.uri == "kodex://sidebar/threads"));
    assert!(resources
        .iter()
        .any(|resource| resource.uri == "kodex://approvals"));
    assert!(resources
        .iter()
        .any(|resource| resource.uri == "kodex://events"));

    let templates = client.list_all_resource_templates().await?;
    assert!(templates
        .iter()
        .any(|template| template.uri_template == "kodex://threads?projectId={projectId}"));
    assert!(templates
        .iter()
        .any(|template| template.uri_template == "kodex://threads/{threadId}/timeline"));
    assert!(templates
        .iter()
        .any(|template| template.uri_template == "kodex://threads/{threadId}/queued-inputs"));
    assert!(templates
        .iter()
        .any(|template| template.uri_template == "kodex://approvals/{approvalId}"));
    client.cancel().await?;
    Ok(())
}

#[tokio::test]
async fn kodex_control_mcp_smokes_new_tools_against_fake_gateway() -> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let gateway_url = format!("http://{}", listener.local_addr()?);
    let state = FakeGatewayState::default();
    let router = Router::new()
        .fallback(any(fake_gateway_handler))
        .with_state(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await });

    let transport = TokioChildProcess::new(
        tokio::process::Command::new(env!("CARGO_BIN_EXE_kodex-gateway")).configure(|command| {
            command
                .arg("mcp")
                .arg("kodex-control")
                .env("KODEX_GATEWAY_URL", gateway_url)
                .stderr(Stdio::null());
        }),
    )?;
    let client = ().serve(transport).await?;

    let mut spawn_args = JsonObject::new();
    spawn_args.insert("projectId".to_string(), json!("project-1"));
    spawn_args.insert(
        "input".to_string(),
        json!([{"type": "text", "text": "start work"}]),
    );
    spawn_args.insert(
        "creationOptions".to_string(),
        json!({"model": "gpt-test", "serviceTier": "auto"}),
    );
    spawn_args.insert("idempotencyKey".to_string(), json!("tool-call-1"));
    let spawned: Value = client
        .call_tool(CallToolRequestParams::new("spawn_thread").with_arguments(spawn_args))
        .await?
        .into_typed()?;
    assert_eq!(spawned["thread"]["id"], "thread-spawned");

    let mut rename_args = JsonObject::new();
    rename_args.insert("threadId".to_string(), json!("thread-spawned"));
    rename_args.insert("name".to_string(), json!("Review MCP"));
    let renamed: Value = client
        .call_tool(CallToolRequestParams::new("rename_thread").with_arguments(rename_args))
        .await?
        .into_typed()?;
    assert_eq!(renamed["thread"]["name"], "Review MCP");

    let mut settings_args = JsonObject::new();
    settings_args.insert("threadId".to_string(), json!("thread-spawned"));
    settings_args.insert("settings".to_string(), json!({"model": "gpt-test-2"}));
    let settings: Value = client
        .call_tool(
            CallToolRequestParams::new("update_thread_settings").with_arguments(settings_args),
        )
        .await?
        .into_typed()?;
    assert_eq!(settings["thread"]["model"], "gpt-test-2");

    let mut app_surface_args = JsonObject::new();
    app_surface_args.insert("title".to_string(), json!("Thread UI"));
    app_surface_args.insert("html".to_string(), json!("<!doctype html><main>UI</main>"));
    app_surface_args.insert("fallbackContent".to_string(), json!("Thread UI fallback"));
    let mut app_surface_meta = JsonObject::new();
    app_surface_meta.insert("threadId".to_string(), json!("thread-spawned"));
    let mut app_surface_call =
        CallToolRequestParams::new("open_app_surface").with_arguments(app_surface_args);
    app_surface_call.set_meta(Meta(app_surface_meta));
    let app_surface: Value = client.call_tool(app_surface_call).await?.into_typed()?;
    assert_eq!(app_surface["session"]["threadId"], "thread-spawned");

    let mut deny_args = JsonObject::new();
    deny_args.insert("approvalId".to_string(), json!("approval-1"));
    let denied: Value = client
        .call_tool(CallToolRequestParams::new("deny_approval").with_arguments(deny_args))
        .await?
        .into_typed()?;
    assert_eq!(denied["approvalId"], "approval-1");

    let mut event_wait_args = JsonObject::new();
    event_wait_args.insert("threadId".to_string(), json!("thread-spawned"));
    event_wait_args.insert("kind".to_string(), json!("threadUpserted"));
    event_wait_args.insert("timeoutMs".to_string(), json!(30));
    event_wait_args.insert("pollIntervalMs".to_string(), json!(25));
    let event_waited: Value = client
        .call_tool(
            CallToolRequestParams::new("wait_for_thread_event").with_arguments(event_wait_args),
        )
        .await?
        .into_typed()?;
    assert_eq!(event_waited["status"], "timeout");
    assert_eq!(event_waited["condition"], "threadEvent");

    let mut wait_args = JsonObject::new();
    wait_args.insert("threadId".to_string(), json!("thread-spawned"));
    wait_args.insert("timeoutMs".to_string(), json!(2_000));
    wait_args.insert("pollIntervalMs".to_string(), json!(25));
    let waited: Value = client
        .call_tool(CallToolRequestParams::new("wait_for_queue_empty").with_arguments(wait_args))
        .await?
        .into_typed()?;
    assert_eq!(waited["status"], "matched");
    assert_eq!(waited["condition"], "queueEmpty");

    let status_resource = client
        .read_resource(ReadResourceRequestParams::new("kodex://sidebar/threads"))
        .await?;
    assert_eq!(status_resource.contents.len(), 1);

    let requests = state.requests.lock().unwrap();
    assert!(requests.iter().any(|request| {
        request.method == Method::POST
            && request.path == "/v1/self-control/thread-spawns"
            && request.body["projectId"] == "project-1"
            && request.body["model"] == "gpt-test"
            && request.body.get("creationOptions").is_none()
    }));
    assert!(requests.iter().any(|request| {
        request.method == Method::PATCH
            && request.path == "/v1/self-control/threads/thread-spawned/name"
            && request.body["name"] == "Review MCP"
    }));
    assert!(requests.iter().any(|request| {
        request.method == Method::PATCH
            && request.path == "/v1/self-control/threads/thread-spawned/settings"
            && request.body["model"] == "gpt-test-2"
            && request.body.get("settings").is_none()
    }));
    assert!(requests.iter().any(|request| {
        request.method == Method::POST
            && request.path == "/v1/self-control/threads/thread-spawned/app-surface"
            && request.body["title"] == "Thread UI"
            && request.body["fallbackContent"] == "Thread UI fallback"
            && request.body.get("threadId").is_none()
    }));
    assert!(requests.iter().any(|request| {
        request.method == Method::POST
            && request.path == "/v1/self-control/approvals/approval-1/decision"
            && request.body["decision"]["decision"] == "decline"
            && request.body.get("source").is_none()
    }));
    assert!(requests.iter().any(|request| {
        request.method == Method::GET && request.path == "/v1/self-control/events"
    }));
    assert!(requests.iter().any(|request| {
        request.method == Method::GET
            && request.path == "/v1/self-control/threads/thread-spawned/queued-inputs"
    }));

    client.cancel().await?;
    server.abort();
    Ok(())
}

fn assert_tool_requires(tools: &[Tool], name: &str, required_fields: &[&str]) {
    let tool = tools
        .iter()
        .find(|tool| tool.name == name)
        .unwrap_or_else(|| panic!("missing tool {name}"));
    let required = tool
        .input_schema
        .get("required")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("{name} tool schema missing required fields"));
    for field in required_fields {
        assert!(
            required.iter().any(|value| value.as_str() == Some(*field)),
            "{name} tool schema should require {field}; schema: {:?}",
            tool.input_schema
        );
    }
}

fn assert_tool_does_not_require(tools: &[Tool], name: &str, field: &str) {
    let tool = tools
        .iter()
        .find(|tool| tool.name == name)
        .unwrap_or_else(|| panic!("missing tool {name}"));
    let required = tool
        .input_schema
        .get("required")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("{name} tool schema missing required fields"));
    assert!(
        !required.iter().any(|value| value.as_str() == Some(field)),
        "{name} tool schema should not require {field}; schema: {:?}",
        tool.input_schema
    );
}

#[derive(Clone, Default)]
struct FakeGatewayState {
    requests: Arc<Mutex<Vec<FakeRequest>>>,
    queue_reads: Arc<AtomicUsize>,
}

#[derive(Debug)]
struct FakeRequest {
    method: Method,
    path: String,
    body: Value,
}

async fn fake_gateway_handler(
    State(state): State<FakeGatewayState>,
    method: Method,
    uri: Uri,
    body: Bytes,
) -> Response {
    let request_body = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap_or_else(|_| json!({"invalidJson": true}))
    };
    let path = uri.path().to_string();
    state.requests.lock().unwrap().push(FakeRequest {
        method: method.clone(),
        path: path.clone(),
        body: request_body.clone(),
    });
    let response = match (method, path.as_str()) {
        (Method::POST, "/v1/self-control/thread-spawns") => {
            json!({"thread": {"id": "thread-spawned"}, "action": "started"})
        }
        (Method::PATCH, "/v1/self-control/threads/thread-spawned/name") => {
            json!({"thread": {"id": "thread-spawned", "name": request_body["name"]}})
        }
        (Method::PATCH, "/v1/self-control/threads/thread-spawned/settings") => {
            json!({"thread": {"id": "thread-spawned", "model": request_body["model"]}})
        }
        (Method::POST, "/v1/self-control/threads/thread-spawned/app-surface") => {
            json!({"session": {"threadId": "thread-spawned", "title": request_body["title"]}})
        }
        (Method::POST, "/v1/self-control/approvals/approval-1/decision") => {
            json!({"approvalId": "approval-1", "policy": {"allowed": true}})
        }
        (Method::GET, "/v1/self-control/events") => {
            json!({"events": []})
        }
        (Method::GET, "/v1/self-control/threads/thread-spawned/queued-inputs") => {
            let read = state.queue_reads.fetch_add(1, Ordering::SeqCst);
            if read == 0 {
                json!({"queuedInputs": [{"id": "queue-1"}]})
            } else {
                json!({"queuedInputs": []})
            }
        }
        (Method::GET, "/v1/self-control/sidebar/threads") => {
            json!({"projectThreads": {}, "chatThreads": []})
        }
        _ => {
            return (StatusCode::NOT_FOUND, Json(json!({"error": "not found"}))).into_response();
        }
    };
    Json(response).into_response()
}
