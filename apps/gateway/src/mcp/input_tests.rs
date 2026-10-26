use super::*;
use jsonschema::JSONSchema;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

#[test]
fn control_input_schemas_describe_native_content_and_provenance() {
    for schema in [
        rmcp::handler::server::tool::schema_for_type::<SendThreadInputToolParams>(),
        rmcp::handler::server::tool::schema_for_type::<SpawnThreadToolParams>(),
    ] {
        let validator = JSONSchema::compile(&Value::Object((*schema).clone())).unwrap();
        let mut good = json!({"threadId":"chat","input":[{"type":"text","text":"hello"}],
            "source":{"requestedBy":"user","sourceThreadId":"side","reason":"handoff"}});
        // Spawn accepts additional creation fields; send requires the explicit target.
        assert!(validator.is_valid(&good));
        good["input"] = json!(["hello"]);
        assert!(
            !validator.is_valid(&good),
            "plain strings must not be advertised as valid input"
        );
        good["input"] = json!([{"type":"text","text":"hello"}]);
        good["source"] = json!("handoff");
        assert!(!validator.is_valid(&good), "provenance must be an object");
    }
}

#[tokio::test]
async fn malformed_control_input_can_be_corrected_without_a_gateway_write() -> anyhow::Result<()> {
    let writes = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = writes.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let service = KodexControlMcp::for_test(format!("http://{}", listener.local_addr()?));
    let router = axum::Router::new().fallback(axum::routing::post(
        move |axum::Json(body): axum::Json<Value>| {
            let captured = captured.clone();
            async move {
                captured.lock().unwrap().push(body);
                axum::Json(json!({"action":"queued"}))
            }
        },
    ));
    let gateway = tokio::spawn(async move { axum::serve(listener, router).await });
    let (server_transport, client_transport) = tokio::io::duplex(65536);
    let server = tokio::spawn(async move {
        service.serve(server_transport).await?.waiting().await?;
        anyhow::Ok(())
    });
    let client = ().serve(client_transport).await?;
    for name in ["send_thread_input", "spawn_thread"] {
        let error = client
            .call_tool(
                CallToolRequestParams::new(name).with_arguments(
                    json!({"threadId":"chat","input":["private-message"]})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("input[0]") && error.contains("text"),
            "{error}"
        );
        assert!(!error.contains("private-message"));
    }
    for name in ["send_thread_input", "spawn_thread"] {
        let error = client.call_tool(CallToolRequestParams::new(name).with_arguments(
            json!({"threadId":"chat","input":[{"type":"text","text":"hello"}],"source":"private-reason"}).as_object().unwrap().clone()
        )).await.unwrap_err().to_string();
        assert!(
            error.contains("source")
                && error.contains("provenance object")
                && error.contains("not_attempted"),
            "{error}"
        );
        assert!(!error.contains("private-reason"));
    }
    assert!(writes.lock().unwrap().is_empty());
    let result = client
        .call_tool(
            CallToolRequestParams::new("send_thread_input").with_arguments(
                json!({"threadId":"chat","input":[{"type":"text","text":"corrected"}],
            "source":{"requestedBy":"user","sourceThreadId":"side","reason":"handoff"}})
                .as_object()
                .unwrap()
                .clone(),
            ),
        )
        .await?;
    assert_ne!(result.is_error, Some(true));
    assert_eq!(writes.lock().unwrap().len(), 1);
    assert_eq!(writes.lock().unwrap()[0]["source"]["requestedBy"], "user");
    client.cancel().await?;
    server.abort();
    gateway.abort();
    Ok(())
}

#[tokio::test]
async fn input_response_failures_never_authorize_automatic_resubmission_or_expose_bodies(
) -> anyhow::Result<()> {
    use axum::{http::StatusCode, routing::post, Router};
    for (status, body) in [
        (StatusCode::NO_CONTENT, ""),
        (StatusCode::OK, "private malformed success body"),
        (StatusCode::BAD_GATEWAY, "private upstream diagnostic"),
        (StatusCode::CONFLICT, "private uncertain spawn intent"),
    ] {
        let writes = Arc::new(Mutex::new(0));
        let captured = writes.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let service = KodexControlMcp::for_test(format!("http://{}", listener.local_addr()?));
        let router = Router::new().fallback(post(move || {
            *captured.lock().unwrap() += 1;
            async move { (status, body) }
        }));
        let gateway = tokio::spawn(async move { axum::serve(listener, router).await });
        let error = service
            .post_input_json(
                "/input",
                json!({"input":[{"type":"text","text":"private user input"}]}),
                RequestPolicy::Input,
            )
            .await
            .unwrap_err();
        assert_eq!(error.data.as_ref().unwrap()["delivery"], "uncertain");
        assert_eq!(error.data.as_ref().unwrap()["retryable"], false);
        assert!(
            error.message.contains("queue and history")
                && error.message.contains("Do not automatically retry")
        );
        assert!(!error.to_string().contains("private"));
        assert_eq!(*writes.lock().unwrap(), 1);
        gateway.abort();
    }
    // A socket closed after reading the request can have admitted it already.
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let service = KodexControlMcp::for_test(format!("http://{}", listener.local_addr()?));
    let gateway = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = [0u8; 4096];
        assert!(socket.read(&mut bytes).await.unwrap() > 0);
        socket.shutdown().await.unwrap();
    });
    let error = service
        .post_input_json(
            "/input",
            json!({"input":[{"type":"text","text":"hello"}]}),
            RequestPolicy::Input,
        )
        .await
        .unwrap_err();
    assert_eq!(error.data.as_ref().unwrap()["delivery"], "uncertain");
    assert_eq!(error.data.as_ref().unwrap()["retryable"], false);
    gateway.await?;
    Ok(())
}

#[tokio::test]
async fn spawn_rejection_can_follow_creation_and_must_not_authorize_a_new_attempt(
) -> anyhow::Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let service = KodexControlMcp::for_test(format!("http://{}", listener.local_addr()?));
    let router = axum::Router::new().fallback(axum::routing::post(|| async {
        (
            axum::http::StatusCode::BAD_REQUEST,
            axum::Json(json!({"code":"bad_request","message":"queue rejected","retryable":false})),
        )
    }));
    let gateway = tokio::spawn(async move { axum::serve(listener, router).await });
    let error = service
        .post_input_json("/spawn", json!({}), RequestPolicy::Spawn)
        .await
        .unwrap_err();
    assert_eq!(error.data.as_ref().unwrap()["delivery"], "uncertain");
    assert!(error.message.contains("native threads") && error.message.contains("new spawn key"));
    let error = service
        .post_input_json("/input", json!({}), RequestPolicy::Input)
        .await
        .unwrap_err();
    assert_eq!(error.data.as_ref().unwrap()["delivery"], "rejected");
    assert_eq!(error.message, "queue rejected");
    gateway.abort();
    Ok(())
}

#[test]
fn openapi_and_mcp_input_contracts_preserve_native_text_and_media_acceptance() {
    let native: Value = serde_json::from_str(include_str!(
        "../../app-server-schema/0.160.0/json/v2/ThreadQueueAddParams.json"
    ))
    .unwrap();
    let native = JSONSchema::compile(&native).unwrap();
    let openapi =
        serde_json::to_value(crate::app_server_api::native_input::openapi_schema()).unwrap();
    let openapi = JSONSchema::compile(&openapi).unwrap();
    let mcp = rmcp::handler::server::tool::schema_for_type::<SendThreadInputToolParams>();
    let mcp = JSONSchema::compile(&Value::Object((*mcp).clone())).unwrap();
    for input in [
        json!([{"type":"text","text":"hello"}]),
        json!([{"type":"image","url":"https://example.test/image.png"}]),
        json!([{"type":"image","fileId":"file","detail":"original"}]),
        json!([{"type":"image","fileId":"file","url":"https://example.test/image.png"}]),
        json!([{"type":"localImage","path":"/tmp/image.png","detail":"high"}]),
        json!([{"type":"audio","url":"data:audio/wav;base64,fixture"}]),
        json!([{"type":"localAudio","path":"/tmp/audio.wav"}]),
        json!([{"type":"skill","name":"skill","path":"/tmp/SKILL.md"}]),
        json!([{"type":"mention","name":"resource","path":"mcp://resource"}]),
        json!([{"type":"image"}]),
        json!([{"type":"text"}]),
        json!(["bad"]),
    ] {
        let request = json!({"threadId":"chat","clientUserMessageId":"attempt","input":input});
        let expected = native.is_valid(&request);
        assert_eq!(openapi.is_valid(&input), expected, "OpenAPI: {input}");
        let request = json!({"threadId":"chat","input":input});
        assert_eq!(mcp.is_valid(&request), expected, "MCP: {input}");
    }
}
