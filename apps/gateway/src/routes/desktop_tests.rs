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
