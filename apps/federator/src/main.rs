use anyhow::Context;
use kodex_federator::config::Config;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "kodex_federator=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
    let config = Config::from_env();
    let (instance, state) = kodex_federator::prepare(&config).await?;
    let primary = tokio::net::TcpListener::bind(config.bind)
        .await
        .context("binding federator primary listener")?;
    let sandbox = tokio::net::TcpListener::bind(config.sandbox_bind)
        .await
        .context("binding federator sandbox listener")?;
    tracing::info!(
        primary = %primary.local_addr()?,
        sandbox = %sandbox.local_addr()?,
        instance_id = %instance.identity.id,
        "Kodex federator listening"
    );
    kodex_federator::serve(
        primary,
        sandbox,
        state,
        config.frontend_dist,
        config.sandbox_public_url,
        shutdown_signal(),
    )
    .await
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("installing Ctrl-C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("installing SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}
