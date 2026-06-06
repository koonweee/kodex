use std::sync::Arc;

use anyhow::Context;
use kodex_gateway::{
    app_server::{DynAppServer, JsonRpcAppServer, UnavailableAppServer},
    automations::{recover_automations_after_restart, start_automation_scheduler},
    build_router,
    config::Config,
    events::run_inbound_ingest,
    queue::recover_queued_inputs,
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

    let config = Config::from_env();
    let store = Store::connect(&config.database.path)
        .await
        .with_context(|| format!("opening sqlite database {}", config.database.path.display()))?;

    let (inbound_tx, inbound_rx) = mpsc::channel(1024);
    let supervisor = match JsonRpcAppServer::start(&config.codex, inbound_tx).await {
        Ok(server) => Some(server),
        Err(error) => {
            tracing::warn!(%error, "starting without a ready Codex app-server");
            None
        }
    };
    let app_server: DynAppServer = match supervisor.clone() {
        Some(server) => server,
        None => Arc::new(UnavailableAppServer),
    };

    let state = AppState::new(config.clone(), store, app_server);
    state.previews.start(&state.store).await?;
    recover_queued_inputs(&state).await?;
    recover_automations_after_restart(&state).await?;
    start_automation_scheduler(state.clone());
    start_terminal_cleanup(state.terminals.clone());
    state.notifications.start_delivery_worker(state.clone());
    tokio::spawn(run_inbound_ingest(inbound_rx, state.clone()));

    let app = build_router(state.clone());
    let listener = tokio::net::TcpListener::bind(config.server.bind).await?;
    tracing::info!(bind = %config.server.bind, "kodex gateway listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    state.previews.shutdown().await?;
    if let Some(supervisor) = supervisor {
        supervisor.shutdown().await?;
    }
    Ok(())
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
