use std::sync::{Arc, Mutex};

use axum::{extract::State, http::Uri, routing::any, Json, Router};
use tokio::net::TcpListener;

use super::*;

fn surface_calls() -> Vec<(&'static str, Value)> {
    vec![
        (
            "open_app_surface",
            json!({"title":"View","html":"<!doctype html><main>View</main>","fallbackContent":"View"}),
        ),
        (
            "update_app_surface",
            json!({"title":"View","html":"<!doctype html><main>View</main>","fallbackContent":"View"}),
        ),
        ("get_app_surface", json!({})),
        ("show_app_surface", json!({"action":"focus"})),
        ("archive_app_surface", json!({})),
    ]
}

#[tokio::test]
async fn native_control_surface_schemas_require_an_explicit_target() -> anyhow::Result<()> {
    let service = KodexControlMcp::for_test("http://127.0.0.1:1".into());
    let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
    let server = tokio::spawn(async move {
        service.serve(server_transport).await?.waiting().await?;
        anyhow::Ok(())
    });
    let client = ().serve(client_transport).await?;
    let tools = client.list_all_tools().await?;
    client.cancel().await?;
    server.abort();
    for (name, _) in surface_calls() {
        let tool = tools.iter().find(|tool| tool.name == name).unwrap();
        assert!(
            tool.input_schema["required"]
                .as_array()
                .is_some_and(|fields| fields.contains(&json!("threadId"))),
            "{name} must advertise an explicit Kodex target"
        );
    }
    Ok(())
}

#[tokio::test]
async fn native_control_surface_calls_never_default_to_foreign_mcp_metadata() -> anyhow::Result<()>
{
    let requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let gateway_url = format!("http://{}", listener.local_addr()?);
    let router = Router::new()
        .fallback(any(
            |State(requests): State<Arc<Mutex<Vec<String>>>>, uri: Uri| async move {
                requests.lock().unwrap().push(uri.path().to_owned());
                Json(json!({"ok":true}))
            },
        ))
        .with_state(requests.clone());
    let gateway = tokio::spawn(async move { axum::serve(listener, router).await });
    let service = KodexControlMcp::for_test(gateway_url);
    let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
    let server = tokio::spawn(async move {
        service.serve(server_transport).await?.waiting().await?;
        anyhow::Ok(())
    });
    let client = ().serve(client_transport).await?;
    let mut rejected = Vec::new();
    for (name, args) in surface_calls() {
        for target in [None, Some("   ")] {
            let mut args = args.as_object().unwrap().clone();
            if let Some(target) = target {
                args.insert("threadId".into(), json!(target));
            }
            let mut call = CallToolRequestParams::new(name).with_arguments(args);
            call.set_meta(Meta(
                json!({"threadId":"foreign-desktop-chat"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ));
            rejected.push((name, target, client.call_tool(call).await.is_err()));
        }
    }
    let requests_before_explicit = requests.lock().unwrap().clone();
    for (name, args) in surface_calls() {
        let mut args = args.as_object().unwrap().clone();
        args.insert("threadId".into(), json!("kodex-owned-chat"));
        let mut call = CallToolRequestParams::new(name).with_arguments(args);
        call.set_meta(Meta(
            json!({"threadId":"foreign-desktop-chat"})
                .as_object()
                .unwrap()
                .clone(),
        ));
        client.call_tool(call).await?;
    }
    client.cancel().await?;
    server.abort();
    gateway.abort();
    assert!(
        rejected.iter().all(|(_, _, rejected)| *rejected),
        "{rejected:?}"
    );
    assert!(
        requests_before_explicit.is_empty(),
        "{requests_before_explicit:?}"
    );
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 5);
    assert!(requests
        .iter()
        .all(|path| path.starts_with("/v1/self-control/threads/kodex-owned-chat/app-surface")));
    Ok(())
}
