use std::{
    convert::Infallible,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::{
    body::{Body, Bytes},
    extract::{
        ws::{Message as BrowserMessage, WebSocketUpgrade},
        Path,
    },
    http::{HeaderValue, Uri},
    response::Response,
    routing::{get, post},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use tokio::time::{sleep, timeout};

use super::websocket::{
    browser_to_upstream, connect_terminal_websocket, connect_terminal_websocket_with_timeout,
    upstream_to_browser,
};
use super::*;

#[test]
fn allowlist_comes_from_executor_contract_and_excludes_control() {
    let allowlist = ExecutorRouteAllowlist::from_gateway_openapi();
    assert!(allowlist.allows(&Method::GET, "/v1/projects"));
    assert!(allowlist.allows(&Method::POST, "/v1/threads/thread-1/input"));
    assert!(allowlist.allows(
        &Method::GET,
        "/v1/threads/thread-1/files/content/directory/assets/icon.svg"
    ));
    assert!(!allowlist.allows(&Method::GET, "/v1/self-control/status"));
    assert!(!allowlist.allows(&Method::GET, "/v1/federation/executors"));
    assert!(!allowlist.allows(&Method::POST, FRONTEND_UPDATE_PATH));
    assert!(!allowlist.allows(&Method::DELETE, "/v1/projects"));
}

#[test]
fn traversal_and_ambiguous_segments_are_rejected() {
    for path in [
        "",
        "projects/../self-control",
        "projects//id",
        "projects\\id",
    ] {
        assert!(validate_proxy_path(path).is_err(), "{path}");
    }
}

#[tokio::test]
async fn http_proxy_preserves_multipart_ranges_and_errors_but_rejects_redirects() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let executor = Router::new()
        .route(
            "/v1/uploads/images",
            post(|headers: HeaderMap, body: Bytes| async move {
                assert_eq!(headers[EXPECTED_INSTANCE_HEADER], "executor-instance");
                assert_eq!(headers[API_VERSION_HEADER], "4");
                assert_eq!(
                    headers[header::CONTENT_TYPE],
                    "multipart/form-data; boundary=kodex-boundary"
                );
                Response::builder()
                    .status(StatusCode::CREATED)
                    .header(API_VERSION_HEADER, "4")
                    .header(header::CONTENT_TYPE, "application/octet-stream")
                    .header("x-executor-result", "binary")
                    .body(Body::from(body))
                    .unwrap()
            }),
        )
        .route(
            "/v1/threads/{thread_id}/files/preview",
            get(|headers: HeaderMap| async move {
                assert_eq!(headers[header::RANGE], "bytes=4-7");
                Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(API_VERSION_HEADER, "4")
                    .header(header::CONTENT_TYPE, "video/mp4")
                    .header(header::CONTENT_RANGE, "bytes 4-7/12")
                    .header(header::ACCEPT_RANGES, "bytes")
                    .body(Body::from(vec![4_u8, 5, 6, 7]))
                    .unwrap()
            }),
        )
        .route(
            "/v1/projects",
            get(|uri: Uri| async move {
                if uri.query() == Some("mode=redirect") {
                    Response::builder()
                        .status(StatusCode::TEMPORARY_REDIRECT)
                        .header(API_VERSION_HEADER, "4")
                        .header(header::LOCATION, "http://127.0.0.1:1/escape")
                        .body(Body::empty())
                        .unwrap()
                } else {
                    Response::builder()
                        .status(StatusCode::UNPROCESSABLE_ENTITY)
                        .header(API_VERSION_HEADER, "4")
                        .header(header::CONTENT_TYPE, "application/json")
                        .header("x-executor-error", "preserved")
                        .body(Body::from(
                            r#"{"code":"native_error","message":"exact executor body"}"#,
                        ))
                        .unwrap()
                }
            }),
        );
    let executor_task = tokio::spawn(async move { axum::serve(listener, executor).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let config = crate::config::Config {
        data_dir: dir.path().to_path_buf(),
        database_path: dir.path().join("federator.db"),
        ..crate::config::Config::default()
    };
    let (_instance, state) = crate::prepare(&config).await.unwrap();
    state
        .store
        .insert_executor(&ExecutorRecord {
            id: "executor-1".to_string(),
            generation: 1,
            display_name: "Executor".to_string(),
            base_url: format!("http://{address}"),
            instance_id: "executor-instance".to_string(),
            api_version: "4".to_string(),
            app_server_schema_version: "0.160.0".to_string(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        })
        .await
        .unwrap();

    let multipart = vec![
        b'-', b'-', b'k', b'o', b'd', b'e', b'x', b'-', b'b', b'o', b'u', b'n', b'd', b'a', b'r',
        b'y', b'\r', b'\n', 0, 255, 1, 254,
    ];
    let uploaded = proxy_executor_inner(
        &state,
        "executor-1",
        "uploads/images",
        Request::post("/v1/uploads/images")
            .header(
                header::CONTENT_TYPE,
                "multipart/form-data; boundary=kodex-boundary",
            )
            .body(Body::from(multipart.clone()))
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(uploaded.status(), StatusCode::CREATED);
    assert_eq!(uploaded.headers()["x-executor-result"], "binary");
    assert_eq!(
        uploaded.into_body().collect().await.unwrap().to_bytes(),
        multipart
    );

    let ranged = proxy_executor_inner(
        &state,
        "executor-1",
        "threads/thread-1/files/preview",
        Request::get("/v1/threads/thread-1/files/preview?path=video.mp4")
            .header(header::RANGE, "bytes=4-7")
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(ranged.headers()[header::CONTENT_RANGE], "bytes 4-7/12");
    assert_eq!(ranged.headers()[header::ACCEPT_RANGES], "bytes");
    assert_eq!(
        ranged.into_body().collect().await.unwrap().to_bytes(),
        vec![4_u8, 5, 6, 7]
    );

    let error = proxy_executor_inner(
        &state,
        "executor-1",
        "projects",
        Request::get("/v1/projects?mode=error")
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error.headers()["x-executor-error"], "preserved");
    assert_eq!(
        error.into_body().collect().await.unwrap().to_bytes(),
        r#"{"code":"native_error","message":"exact executor body"}"#
    );

    let redirect = proxy_executor_inner(
        &state,
        "executor-1",
        "projects",
        Request::get("/v1/projects?mode=redirect")
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .err()
    .expect("executor redirects fail closed");
    assert_eq!(redirect.status, StatusCode::BAD_GATEWAY);
    assert_eq!(redirect.code, "executor_proxy_failed");
    executor_task.abort();
}

#[test]
fn websocket_close_code_and_reason_are_preserved_in_both_directions() {
    let upstream =
        browser_to_upstream(BrowserMessage::Close(Some(axum::extract::ws::CloseFrame {
            code: 4001,
            reason: "browser reason".into(),
        })));
    let tokio_tungstenite::tungstenite::Message::Close(Some(upstream)) = upstream else {
        panic!("expected close frame");
    };
    assert_eq!(u16::from(upstream.code), 4001);
    assert_eq!(upstream.reason, "browser reason");

    let (browser, close) = upstream_to_browser(tokio_tungstenite::tungstenite::Message::Close(
        Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
            code: 4002.into(),
            reason: "executor reason".into(),
        }),
    ))
    .unwrap();
    let BrowserMessage::Close(Some(browser)) = browser else {
        panic!("expected close frame");
    };
    assert!(close);
    assert_eq!(browser.code, 4002);
    assert_eq!(browser.reason, "executor reason");
}

#[tokio::test]
async fn terminal_websocket_setup_has_one_total_deadline() {
    let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_address = upstream_listener.local_addr().unwrap();
    let accepted = tokio::spawn(async move {
        let (_socket, _) = upstream_listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let dir = tempfile::tempdir().unwrap();
    let config = crate::config::Config {
        data_dir: dir.path().to_path_buf(),
        database_path: dir.path().join("federator.db"),
        ..crate::config::Config::default()
    };
    let (_instance, state) = crate::prepare(&config).await.unwrap();
    state
        .store
        .insert_executor(&ExecutorRecord {
            id: "executor-1".to_string(),
            generation: 1,
            display_name: "Executor".to_string(),
            base_url: format!("http://{upstream_address}"),
            instance_id: "executor-instance".to_string(),
            api_version: "4".to_string(),
            app_server_schema_version: "0.160.0".to_string(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        })
        .await
        .unwrap();
    let error = connect_terminal_websocket_with_timeout(
        &state,
        "executor-1",
        "terminal-1",
        Vec::new(),
        Duration::from_millis(50),
    )
    .await
    .err()
    .expect("stalled handshake times out");
    assert_eq!(error.code, "executor_proxy_failed");
    assert!(error.message.contains("setup timed out"));
    accepted.abort();
}

#[tokio::test]
async fn terminal_websocket_is_bidirectional_and_generation_fenced() {
    let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_address = upstream_listener.local_addr().unwrap();
    let upstream_handshakes = Arc::new(AtomicUsize::new(0));
    let upstream_app = Router::new().route(
        "/v1/terminals/{terminal_id}/ws",
        get({
            let upstream_handshakes = upstream_handshakes.clone();
            move |Path(terminal_id): Path<String>, headers: HeaderMap, ws: WebSocketUpgrade| {
                let upstream_handshakes = upstream_handshakes.clone();
                async move {
                    upstream_handshakes.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(headers[EXPECTED_INSTANCE_HEADER], "executor-instance");
                    assert_eq!(headers[API_VERSION_HEADER], "4");
                    let ws = if terminal_id == "subprotocol" {
                        assert_eq!(headers[header::SEC_WEBSOCKET_PROTOCOL], "v2, v1");
                        ws.protocols(["v1"])
                    } else if terminal_id == "invalid-subprotocol" {
                        let mut ws = ws;
                        ws.set_selected_protocol(HeaderValue::from_static("executor-only"));
                        ws
                    } else {
                        ws
                    };
                    let mut response = ws.on_upgrade(move |mut socket| async move {
                        if terminal_id == "blocked" {
                            std::future::pending::<()>().await;
                        }
                        if terminal_id == "executor-close" {
                            socket
                                .send(BrowserMessage::Close(Some(axum::extract::ws::CloseFrame {
                                    code: 4002,
                                    reason: "executor reason".into(),
                                })))
                                .await
                                .unwrap();
                        }
                        while let Some(Ok(message)) = socket.recv().await {
                            if matches!(message, BrowserMessage::Close(_)) {
                                break;
                            }
                            if socket.send(message).await.is_err() {
                                break;
                            }
                        }
                    });
                    response
                        .headers_mut()
                        .insert(API_VERSION_HEADER, HeaderValue::from_static("4"));
                    response
                }
            }
        }),
    );
    let upstream_task =
        tokio::spawn(async move { axum::serve(upstream_listener, upstream_app).await.unwrap() });

    let public_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let public_address = public_listener.local_addr().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let config = crate::config::Config {
        data_dir: dir.path().to_path_buf(),
        database_path: dir.path().join("federator.db"),
        public_origin: format!("http://{public_address}"),
        ..crate::config::Config::default()
    };
    let (_instance, state) = crate::prepare(&config).await.unwrap();
    state
        .store
        .insert_executor(&ExecutorRecord {
            id: "executor-1".to_string(),
            generation: 1,
            display_name: "Executor".to_string(),
            base_url: format!("http://{upstream_address}"),
            instance_id: "executor-instance".to_string(),
            api_version: "4".to_string(),
            app_server_schema_version: "0.160.0".to_string(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        })
        .await
        .unwrap();
    let changes = state.registry_changes.clone();
    let direct_state = state.clone();
    let app = crate::primary_router(state, None, config.sandbox_public_url);
    let federator_task =
        tokio::spawn(async move { axum::serve(public_listener, app).await.unwrap() });

    let base_url = format!("ws://{public_address}/v1/executors/executor-1/terminals/terminal-1/ws");
    for suffix in ["", "?apiVersion=3"] {
        let mut request =
            tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
                format!("{base_url}{suffix}"),
            )
            .unwrap();
        request.headers_mut().insert(
            header::ORIGIN,
            format!("http://{public_address}").parse().unwrap(),
        );
        let error = tokio_tungstenite::connect_async(request)
            .await
            .expect_err("missing or stale browser API version is rejected");
        let tokio_tungstenite::tungstenite::Error::Http(response) = error else {
            panic!("expected HTTP WebSocket rejection");
        };
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }
    assert_eq!(upstream_handshakes.load(Ordering::SeqCst), 0);

    let (mut declined, _, _, selected) = connect_terminal_websocket(
        &direct_state,
        "executor-1",
        "declined-subprotocol",
        vec!["optional.v1".to_string()],
    )
    .await
    .expect("an executor may decline every offered subprotocol");
    assert!(selected.is_none());
    declined.close(None).await.unwrap();
    let invalid = connect_terminal_websocket(
        &direct_state,
        "executor-1",
        "invalid-subprotocol",
        vec!["browser-only".to_string()],
    )
    .await
    .err()
    .expect("an executor cannot select an unoffered subprotocol");
    assert_eq!(invalid.status, StatusCode::BAD_GATEWAY);
    assert_eq!(upstream_handshakes.load(Ordering::SeqCst), 2);

    let url = format!("{base_url}?apiVersion=4");
    let mut request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
            url.as_str(),
        )
        .unwrap();
    request.headers_mut().insert(
        header::ORIGIN,
        format!("http://{public_address}").parse().unwrap(),
    );
    let (mut client, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    client
        .send(tokio_tungstenite::tungstenite::Message::Binary(
            b"terminal bytes".to_vec().into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        client.next().await.unwrap().unwrap().into_data(),
        b"terminal bytes".as_slice()
    );
    assert_eq!(upstream_handshakes.load(Ordering::SeqCst), 3);

    let browser_close_url = format!(
        "ws://{public_address}/v1/executors/executor-1/terminals/browser-close/ws?apiVersion=4"
    );
    let mut browser_close_request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
            browser_close_url,
        )
        .unwrap();
    browser_close_request.headers_mut().insert(
        header::ORIGIN,
        format!("http://{public_address}").parse().unwrap(),
    );
    let (mut browser_close_client, _) = tokio_tungstenite::connect_async(browser_close_request)
        .await
        .unwrap();
    browser_close_client
        .send(tokio_tungstenite::tungstenite::Message::Close(Some(
            tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: 4001.into(),
                reason: "browser reason".into(),
            },
        )))
        .await
        .unwrap();
    let browser_close = timeout(Duration::from_secs(1), browser_close_client.next())
        .await
        .expect("executor close reply reaches the browser")
        .expect("executor sends a close reply")
        .unwrap();
    let tokio_tungstenite::tungstenite::Message::Close(Some(browser_close)) = browser_close else {
        panic!("expected browser close reply");
    };
    assert_eq!(u16::from(browser_close.code), 4001);
    assert_eq!(browser_close.reason, "browser reason");

    let executor_close_url = format!(
        "ws://{public_address}/v1/executors/executor-1/terminals/executor-close/ws?apiVersion=4"
    );
    let mut executor_close_request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
            executor_close_url,
        )
        .unwrap();
    executor_close_request.headers_mut().insert(
        header::ORIGIN,
        format!("http://{public_address}").parse().unwrap(),
    );
    let (mut executor_close_client, _) = tokio_tungstenite::connect_async(executor_close_request)
        .await
        .unwrap();
    let executor_close = timeout(Duration::from_secs(1), executor_close_client.next())
        .await
        .expect("executor close reaches the browser")
        .expect("executor sends a close")
        .unwrap();
    let tokio_tungstenite::tungstenite::Message::Close(Some(executor_close)) = executor_close
    else {
        panic!("expected executor close");
    };
    assert_eq!(u16::from(executor_close.code), 4002);
    assert_eq!(executor_close.reason, "executor reason");

    let subprotocol_url = format!(
        "ws://{public_address}/v1/executors/executor-1/terminals/subprotocol/ws?apiVersion=4"
    );
    let mut subprotocol_request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
            subprotocol_url,
        )
        .unwrap();
    subprotocol_request.headers_mut().insert(
        header::ORIGIN,
        format!("http://{public_address}").parse().unwrap(),
    );
    subprotocol_request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static("v2, v1"),
    );
    let (mut subprotocol_client, response) = tokio_tungstenite::connect_async(subprotocol_request)
        .await
        .unwrap();
    assert_eq!(response.headers()[header::SEC_WEBSOCKET_PROTOCOL], "v1");
    subprotocol_client.close(None).await.unwrap();

    let blocked_url =
        format!("ws://{public_address}/v1/executors/executor-1/terminals/blocked/ws?apiVersion=4");
    let mut blocked_request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
            blocked_url.as_str(),
        )
        .unwrap();
    blocked_request.headers_mut().insert(
        header::ORIGIN,
        format!("http://{public_address}").parse().unwrap(),
    );
    let (blocked_client, _) = tokio_tungstenite::connect_async(blocked_request)
        .await
        .unwrap();
    assert_eq!(upstream_handshakes.load(Ordering::SeqCst), 7);
    let (mut blocked_sink, mut blocked_stream) = blocked_client.split();
    let blocked_sender = tokio::spawn(async move {
        let payload = vec![0_u8; 1024 * 1024];
        loop {
            if blocked_sink
                .send(tokio_tungstenite::tungstenite::Message::Binary(
                    payload.clone().into(),
                ))
                .await
                .is_err()
            {
                break;
            }
        }
    });
    sleep(Duration::from_millis(50)).await;

    changes
        .send(crate::RegistryChange {
            revision: 2,
            executor_id: "executor-1".to_string(),
            generation: Some(2),
        })
        .unwrap();
    let closed = timeout(Duration::from_secs(1), client.next())
        .await
        .expect("generation change closes the WebSocket");
    assert!(
        closed.is_none()
            || closed.is_some_and(
                |message| message.is_err() || message.is_ok_and(|message| message.is_close())
            )
    );
    let blocked_closed = timeout(Duration::from_secs(1), blocked_stream.next())
        .await
        .expect("generation change interrupts a backpressured executor write");
    assert!(
        blocked_closed.is_none()
            || blocked_closed.is_some_and(
                |message| message.is_err() || message.is_ok_and(|message| message.is_close())
            )
    );

    blocked_sender.abort();
    federator_task.abort();
    upstream_task.abort();
}

#[tokio::test]
async fn streaming_proxy_client_has_no_five_second_total_deadline() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/events",
        get(|| async {
            let stream = async_stream::stream! {
                yield Ok::<_, Infallible>("data: first\n\n");
                sleep(Duration::from_millis(5_100)).await;
                yield Ok::<_, Infallible>("data: second\n\n");
            };
            Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from_stream(stream))
                .unwrap()
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let endpoint = registry::validate_executor_proxy_endpoint(&format!("http://{address}"))
        .await
        .unwrap();
    let response = endpoint
        .client
        .get(format!("http://{address}/events"))
        .send()
        .await
        .unwrap();
    let mut body = response.bytes_stream();
    assert_eq!(body.next().await.unwrap().unwrap(), "data: first\n\n");
    assert_eq!(
        timeout(Duration::from_secs(6), body.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        "data: second\n\n"
    );
    server.abort();
}

#[tokio::test]
async fn registry_generation_change_cancels_an_open_response_body() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/stream",
        get(|| async {
            let stream = async_stream::stream! {
                yield Ok::<_, Infallible>("first");
                sleep(Duration::from_secs(30)).await;
                yield Ok::<_, Infallible>("second");
            };
            Body::from_stream(stream)
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let upstream = reqwest::Client::new()
        .get(format!("http://{address}/stream"))
        .send()
        .await
        .unwrap();
    let binding = ExecutorRecord {
        id: "executor-1".to_string(),
        generation: 1,
        display_name: "Executor".to_string(),
        base_url: format!("http://{address}"),
        instance_id: "instance-1".to_string(),
        api_version: SUPPORTED_EXECUTOR_API_VERSION.to_string(),
        app_server_schema_version: "0.160.0".to_string(),
        enabled: true,
        status: ExecutorStatus::Ready,
        last_error: None,
        last_seen_at: 1,
        created_at: 1,
        updated_at: 1,
    };
    let (changes, receiver) = tokio::sync::broadcast::channel(4);
    let mut body = generation_fenced_body(upstream, binding, receiver);
    assert_eq!(
        body.frame().await.unwrap().unwrap().into_data().unwrap(),
        "first"
    );
    changes
        .send(crate::RegistryChange {
            revision: 1,
            executor_id: "executor-1".to_string(),
            generation: Some(1),
        })
        .unwrap();
    assert!(timeout(Duration::from_millis(50), body.frame())
        .await
        .is_err());
    changes
        .send(crate::RegistryChange {
            revision: 2,
            executor_id: "executor-1".to_string(),
            generation: Some(2),
        })
        .unwrap();
    let frame = timeout(Duration::from_secs(1), body.frame())
        .await
        .expect("generation change must cancel the body")
        .expect("body reports the generation fence");
    assert!(frame.is_err());
    server.abort();
}
