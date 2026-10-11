use super::*;
use axum::{routing::post, Router};
use rmcp::service::PeerRequestOptions;
use std::sync::Arc;
use tokio::{net::TcpListener, sync::Notify, time::timeout};

#[tokio::test]
async fn mcp_wait_threads_honors_protocol_cancellation_during_http_read() -> anyhow::Result<()> {
    let entered = Arc::new(Notify::new());
    let notify = entered.clone();
    let app = Router::new().route(
        "/v1/self-control/threads/wait",
        post(move || {
            let notify = notify.clone();
            async move {
                notify.notify_one();
                std::future::pending::<String>().await
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let service = KodexControlMcp::for_test(format!("http://{}", listener.local_addr()?));
    let http = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let (server_transport, client_transport) = tokio::io::duplex(65536);
    let server = tokio::spawn(async move {
        service.serve(server_transport).await?.waiting().await?;
        anyhow::Ok(())
    });
    let client = ().serve(client_transport).await?;
    let args = json!({"targets":[{"threadId":"chat"}],"timeoutMs":60000})
        .as_object()
        .unwrap()
        .clone();
    let request = client
        .send_cancellable_request(
            ClientRequest::CallToolRequest(Request::new(
                CallToolRequestParams::new("wait_threads").with_arguments(args),
            )),
            PeerRequestOptions::no_options(),
        )
        .await?;
    timeout(Duration::from_secs(2), entered.notified()).await?;
    client
        .send_notification(ClientNotification::CancelledNotification(
            CancelledNotification::new(CancelledNotificationParam {
                request_id: request.id.clone(),
                reason: Some("test cancelled".into()),
            }),
        ))
        .await?;
    let response = timeout(Duration::from_secs(2), request.await_response()).await?;
    match response {
        Ok(ServerResult::CallToolResult(result)) => {
            let body: Value = result.into_typed()?;
            assert_eq!(body["status"], "cancelled");
        }
        Err(rmcp::ServiceError::Cancelled { .. }) => {}
        other => anyhow::bail!("unexpected cancellation result: {other:?}"),
    }
    client.cancel().await?;
    server.abort();
    http.abort();
    Ok(())
}
