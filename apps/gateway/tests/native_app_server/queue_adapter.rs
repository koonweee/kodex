use kodex_gateway::app_server_api::CodexClient;
use serde_json::{json, Value};

// Keep native envelopes at the test boundary so the original behavior proof
// now exercises the production typed adapter without changing its assertions.
pub(super) async fn request(
    client: &CodexClient,
    operation: &str,
    params: Value,
) -> anyhow::Result<Value> {
    let thread_id = serde_json::from_value(params["threadId"].clone())?;
    match operation {
        "add" => Ok(json!({"queuedSubmission": client.queue_add(
            thread_id,
            serde_json::from_value(params["input"].clone())?,
            serde_json::from_value(params["clientUserMessageId"].clone())?,
        ).await?})),
        "list" => Ok(serde_json::to_value(
            client
                .queue_list(
                    thread_id,
                    serde_json::from_value(params["cursor"].clone())?,
                    serde_json::from_value(params["limit"].clone())?,
                )
                .await?,
        )?),
        "update" => Ok(json!({"queuedSubmission": client.queue_update(
            thread_id,
            serde_json::from_value(params["queuedSubmissionId"].clone())?,
            serde_json::from_value(params["input"].clone())?,
        ).await?})),
        "delete" => Ok(json!({"deleted": client.queue_delete(
            thread_id,
            serde_json::from_value(params["queuedSubmissionId"].clone())?,
        ).await?})),
        "reorder" => {
            client
                .queue_reorder(
                    thread_id,
                    serde_json::from_value(params["queuedSubmissionIds"].clone())?,
                )
                .await?;
            Ok(json!({}))
        }
        "start" => Ok(client
            .queue_start(
                thread_id,
                serde_json::from_value(params["queuedSubmissionId"].clone())?,
            )
            .await?
            .payload),
        _ => anyhow::bail!("unsupported fixture queue operation"),
    }
}
