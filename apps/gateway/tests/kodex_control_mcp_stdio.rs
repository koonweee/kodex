use std::process::Stdio;

use rmcp::{
    transport::{ConfigureCommandExt, TokioChildProcess},
    ServiceExt,
};

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
    client.cancel().await?;
    Ok(())
}
