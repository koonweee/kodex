use crate::{
    api::{build_router, AppState},
    app_server::tests::RecordingAppServer,
    config::Config,
    desktop::DesktopConfig,
    store::Store,
};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use std::sync::Arc;
use tower::ServiceExt;

async fn state(password: &str) -> AppState {
    let mut config = Config::default();
    config.desktop = DesktopConfig::with_password(password);
    AppState::new(
        config,
        Store::in_memory().await.unwrap(),
        Arc::new(RecordingAppServer::default()),
    )
}

#[tokio::test]
async fn capabilities_report_only_desktop_configuration_without_credentials() {
    for password in ["", "fixture1", "too-long-fixture"] {
        let app = build_router(state(password).await);
        let response = app
            .oneshot(
                Request::get("/v1/capabilities")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 65536).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body["gateway"]["desktop"]["enabled"],
            cfg!(target_os = "macos") && !password.is_empty()
        );
        assert_eq!(body["gateway"]["desktop"].as_object().unwrap().len(), 1);
        assert!(!String::from_utf8(bytes.to_vec())
            .unwrap()
            .contains("fixture1"));
        assert!(!String::from_utf8(bytes.to_vec())
            .unwrap()
            .contains("too-long-fixture"));
    }
}

#[tokio::test]
async fn websocket_origin_is_required_and_compared_to_the_served_host() {
    use futures_util::StreamExt;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{client::IntoClientRequest, Error, Message},
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = build_router(state("").await);
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for (origin, duplicate, allowed) in [
        (None, false, false),
        (Some("null".to_string()), false, false),
        (Some("https://elsewhere.invalid".to_string()), false, false),
        (Some(format!("http://{address}")), true, false),
        (Some(format!("http://{address}/extra")), false, false),
        (Some(format!("http://user:pass@{address}")), false, false),
        (Some(format!("http://{address}")), false, true),
        (Some(format!("https://{address}")), false, true),
    ] {
        let mut request = format!("ws://{address}/v1/desktop/ws")
            .into_client_request()
            .unwrap();
        if let Some(origin) = origin {
            request
                .headers_mut()
                .insert("origin", origin.parse().unwrap());
            if duplicate {
                request
                    .headers_mut()
                    .append("origin", "https://elsewhere.invalid".parse().unwrap());
            }
        }
        match connect_async(request).await {
            Ok((mut socket, _)) if allowed => {
                // Unconfigured: close before any attempt to reach real Screen Sharing.
                let message = socket.next().await.unwrap().unwrap();
                let Message::Close(Some(frame)) = message else {
                    panic!("expected a typed configuration close")
                };
                assert_eq!(u16::from(frame.code), 4400);
                assert_eq!(frame.reason, "\"configuration\"");
            }
            Err(Error::Http(response)) if !allowed => {
                assert_eq!(response.status(), StatusCode::FORBIDDEN);
            }
            other => panic!("unexpected WebSocket origin result: {other:?}"),
        }
    }
    // Simulate the retained public Host when a reverse proxy terminates TLS.
    let mut request = format!("ws://{address}/v1/desktop/ws")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("host", "mac.example.ts.net".parse().unwrap());
    request
        .headers_mut()
        .insert("origin", "https://mac.example.ts.net".parse().unwrap());
    let (mut socket, _) = connect_async(request).await.unwrap();
    assert!(matches!(
        socket.next().await.unwrap().unwrap(),
        Message::Close(_)
    ));
    server.abort();
}

#[tokio::test]
async fn clipboard_rejects_encoded_body_overflow() {
    let request = Request::post("/v1/desktop/clipboard")
        .header("host", "localhost")
        .header("origin", "http://localhost")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({"text": "x".repeat(512 * 1024)}).to_string(),
        ))
        .unwrap();
    assert_eq!(
        build_router(state("").await)
            .oneshot(request)
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[tokio::test]
async fn clipboard_access_gates_precede_write_and_completion_precedes_204() {
    use super::desktop::clipboard_response;
    use axum::http::HeaderMap;
    let mut headers = HeaderMap::new();
    headers.insert("host", "mac.example.ts.net".parse().unwrap());
    headers.insert("origin", "https://mac.example.ts.net".parse().unwrap());
    for (supported, password) in [(false, "fixture1"), (true, ""), (true, "too-long-password")] {
        let response = clipboard_response(
            &headers,
            &DesktopConfig::with_password(password),
            supported,
            zeroize::Zeroizing::new("fixture".into()),
            |_| async { panic!("must not invoke clipboard writer") },
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let response = clipboard_response(
        &headers,
        &DesktopConfig::with_password("fixture1"),
        true,
        zeroize::Zeroizing::new("Unicode 👋\n你好".into()),
        |text| async move {
            assert_eq!(text.as_str(), "Unicode 👋\n你好");
            tokio::task::yield_now().await;
            Ok(())
        },
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let response = clipboard_response(
        &headers,
        &DesktopConfig::with_password("fixture1"),
        true,
        zeroize::Zeroizing::new("fixture".into()),
        |_| async {
            Err(crate::error::ApiError::BadGateway(
                "The Mac clipboard could not be written.".into(),
            ))
        },
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn clipboard_origin_and_host_reject_all_untrusted_forms_before_write() {
    use super::desktop::clipboard_response;
    use axum::http::HeaderMap;
    let config = DesktopConfig::with_password("fixture1");
    for (origin, host, duplicate) in [
        ("https://mac.example.ts.net", "mac.example.ts.net", "origin"),
        ("https://mac.example.ts.net", "mac.example.ts.net", "host"),
        ("https://mac.example.ts.net?query", "mac.example.ts.net", ""),
        (
            "https://mac.example.ts.net#fragment",
            "mac.example.ts.net",
            "",
        ),
        (
            "https://user:pass@mac.example.ts.net",
            "mac.example.ts.net",
            "",
        ),
        ("https://mac.example.ts.net", "mac.example.ts.net/extra", ""),
        ("file://mac.example.ts.net", "mac.example.ts.net", ""),
        ("null", "mac.example.ts.net", ""),
        ("https://mac.example.ts.net:9", "mac.example.ts.net", ""),
        ("https://mac.example.ts.net/path", "mac.example.ts.net", ""),
        ("https://elsewhere.invalid", "mac.example.ts.net", ""),
    ] {
        let mut headers = HeaderMap::new();
        headers.insert("origin", origin.parse().unwrap());
        headers.insert("host", host.parse().unwrap());
        if !duplicate.is_empty() {
            headers.append(duplicate, headers[duplicate].clone());
        }
        let response = clipboard_response(
            &headers,
            &config,
            true,
            zeroize::Zeroizing::new("fixture".into()),
            |_| async { panic!("untrusted request reached writer") },
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}

#[tokio::test]
async fn clipboard_encoded_limit_allows_worst_case_json_expansion() {
    // Config disabled so this real route can prove decoding without touching OS clipboard.
    let request = Request::post("/v1/desktop/clipboard")
        .header("host", "localhost")
        .header("origin", "http://localhost")
        .header("content-type", "application/json")
        .body(Body::from(
            serde_json::json!({"text": "\0".repeat(65536)}).to_string(),
        ))
        .unwrap();
    assert_eq!(
        build_router(state("").await)
            .oneshot(request)
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn clipboard_decoded_bounds_reject_before_native_process() {
    for text in [String::new(), "👋".repeat(16385)] {
        let response = build_router(state("fixture1").await)
            .oneshot(
                Request::post("/v1/desktop/clipboard")
                    .header("host", "localhost")
                    .header("origin", "http://localhost")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::json!({"text":text}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            if cfg!(target_os = "macos") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::FORBIDDEN
            }
        );
    }
}
