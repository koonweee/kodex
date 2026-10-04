use std::sync::Arc;

use anyhow::Context;
use kodex_gateway::{
    app_server::{DynAppServer, InboundMessage, JsonRpcAppServer},
    automations::{recover_automations_after_restart, start_automation_scheduler},
    build_router,
    config::Config,
    events::run_inbound_ingest,
    store::Store,
    terminal::start_terminal_cleanup,
    AppState,
};
use tokio::sync::mpsc;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().skip(1).collect::<Vec<_>>() == ["mcp", "kodex-control"] {
        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| "kodex_gateway=info".into()),
            )
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .init();
        return kodex_gateway::mcp::run_kodex_control_stdio().await;
    }

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "kodex_gateway=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let mut config = Config::from_env();
    let _instance_guard = kodex_gateway::native_runtime::prepare_instance(&mut config)
        .context("preparing fresh isolated Kodex state")?;
    let store = Store::connect(&config.database.path)
        .await
        .with_context(|| format!("opening sqlite database {}", config.database.path.display()))?;

    let listener = tokio::net::TcpListener::bind(config.server.bind)
        .await
        .context("binding the owned gateway listener")?;
    config.server.bind = listener.local_addr()?;
    let (inbound_tx, inbound_rx) = mpsc::channel(1024);
    let supervisor = JsonRpcAppServer::start_with_control(
        &config.codex,
        inbound_tx,
        config.server.bind,
        &std::env::current_exe()?,
    )
    .await
    .context("starting the required isolated Codex app-server")?;
    let app_server: DynAppServer = supervisor.clone();

    let state = AppState::new(config, store, app_server);
    run_gateway(state, supervisor, inbound_rx, listener).await
}

async fn run_gateway(
    state: AppState,
    supervisor: Arc<JsonRpcAppServer>,
    inbound_rx: mpsc::Receiver<InboundMessage>,
    listener: tokio::net::TcpListener,
) -> anyhow::Result<()> {
    let mut import_worker = None;
    let result: anyhow::Result<()> = async {
        kodex_gateway::approvals::initialize(&state).await?;
        import_worker = Some(kodex_gateway::app_surfaces::start_import_worker(&state)?);
        kodex_gateway::queue_transfer::recover(&state).await?;
        recover_automations_after_restart(&state).await?;
        start_automation_scheduler(state.clone());
        start_terminal_cleanup(state.terminals.clone());
        state.notifications.start_delivery_worker(state.clone());
        tokio::spawn(run_inbound_ingest(inbound_rx, state.clone()));

        let app = build_router(state.clone());
        tracing::info!(bind = %state.config.server.bind, "kodex gateway listening");

        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown_signal())
            .await?;
        Ok(())
    }
    .await;
    if let Some(worker) = import_worker {
        worker.shutdown().await;
    }
    let native_shutdown = supervisor.shutdown().await;
    result?;
    native_shutdown?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use kodex_gateway::app_server::AppServer;

    use super::*;

    #[tokio::test]
    async fn initialization_error_shuts_down_the_owned_native_process() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fixture-codex");
        std::fs::write(
            &script,
            r#"#!/bin/bash
if [[ ${1:-} == --version ]]; then printf 'codex-cli 0.160.0\n'; exit 0; fi
IFS= read -r line
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}'
while IFS= read -r line; do :; done
"#,
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut config = Config::default();
        config.codex.binary = script.display().to_string();
        config.codex.home = dir.path().to_path_buf();
        let store = Store::in_memory().await.unwrap();
        let (sender, receiver) = mpsc::channel(8);
        let server = JsonRpcAppServer::start(&config.codex, sender)
            .await
            .unwrap();
        let state = AppState::new(config, store.clone(), server.clone());
        store.pool().close().await;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let result = run_gateway(state, server.clone(), receiver, listener).await;
        let still_ready = server.is_ready();
        server.shutdown().await.unwrap();
        assert!(result.is_err());
        assert!(
            !still_ready,
            "failed startup left the owned native process ready"
        );
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install ctrl-c handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install terminate signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
