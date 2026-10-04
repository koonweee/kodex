use std::sync::{Arc, Mutex};

use axum::{extract::State, http::Uri, routing::any, Json, Router};
use tokio::net::TcpListener;

use super::*;

#[derive(Default)]
struct WaitFixture {
    paths: Mutex<Vec<String>>,
    runs_reads: Mutex<usize>,
    return_new_run: bool,
}

fn run(id: &str, scheduled: bool) -> Value {
    json!({
        "id":id,"automationId":"automation","targetThreadId":"owned-chat",
        "scheduledFor":if scheduled { json!("2026-10-05T00:00:00Z") } else { Value::Null },
        "phase":"uncertain","nativeQueueId":null,"turnId":null,"error":"Acknowledgement unavailable",
        "createdAt":"2026-10-05T00:00:00Z","updatedAt":"2026-10-05T00:00:00Z"
    })
}

async fn gateway(
    fixture: Arc<WaitFixture>,
) -> anyhow::Result<(KodexControlMcp, tokio::task::JoinHandle<()>)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let router = Router::new().fallback(any(
        |State(fixture): State<Arc<WaitFixture>>, uri: Uri| async move {
            fixture.paths.lock().unwrap().push(uri.to_string());
            let body = match uri.path() {
                "/v1/automations/automation/runs" => {
                    let mut reads = fixture.runs_reads.lock().unwrap();
                    *reads += 1;
                    if fixture.return_new_run && *reads > 1 {
                        json!({"runs":[run("manual-run", false),run("scheduled-run", true)]})
                    } else {
                        json!({"runs":[run("scheduled-run", true)]})
                    }
                }
                "/v1/self-control/automations/automation" => json!({"automation":{
                    "id":"automation","lastRunAt":"2026-10-05T00:00:00Z","lastNativeQueueId":"scheduled-row"
                }}),
                "/v1/self-control/events" => json!({"events":[{
                    "id":"event","seq":5,"receivedAt":"2026-10-05T00:00:00Z",
                    "threadId":"owned-chat","projectId":null,"turnId":null,"itemId":null,
                    "kind":"turn_queue.changed","codexMethod":"thread/queue/changed",
                    "payload":{"threadId":"owned-chat"}
                }]}),
                _ => json!({"unexpectedPath":uri.path()}),
            };
            Json(body)
        }
    )).with_state(fixture);
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    Ok((KodexControlMcp::for_test(url), server))
}

#[tokio::test]
async fn native_control_wait_observes_run_now_without_schedule_summary_changes(
) -> anyhow::Result<()> {
    let fixture = Arc::new(WaitFixture {
        return_new_run: true,
        ..Default::default()
    });
    let (service, server) = gateway(fixture.clone()).await?;
    let params = serde_json::from_value(json!({
        "automationId":"automation","afterRunId":"scheduled-run","timeoutMs":1000,"pollIntervalMs":25
    }))?;
    let response = service.wait_for_automation_run(Parameters(params)).await;
    server.abort();
    let response: Value = response?.into_typed()?;
    assert_eq!(response["status"], "matched");
    assert_eq!(response["run"], run("manual-run", false));
    assert!(response["run"]["scheduledFor"].is_null());
    assert_eq!(
        fixture.paths.lock().unwrap().as_slice(),
        [
            "/v1/automations/automation/runs",
            "/v1/automations/automation/runs"
        ]
    );
    Ok(())
}

#[tokio::test]
async fn native_control_wait_does_not_report_an_existing_run_as_new() -> anyhow::Result<()> {
    let fixture = Arc::new(WaitFixture::default());
    let (service, server) = gateway(fixture.clone()).await?;
    let params = serde_json::from_value(json!({
        "automationId":"automation","afterRunId":"scheduled-run","timeoutMs":0
    }))?;
    let response = service.wait_for_automation_run(Parameters(params)).await;
    server.abort();
    let response: Value = response?.into_typed()?;
    assert_eq!(response["status"], "timeout");
    assert_eq!(response["lastResponse"]["runs"][0]["id"], "scheduled-run");
    assert_eq!(
        fixture.paths.lock().unwrap().as_slice(),
        ["/v1/automations/automation/runs"]
    );
    Ok(())
}

#[test]
fn native_control_wait_schema_rejects_removed_schedule_counter_parameters() {
    for removed in ["afterLastRunAt", "afterLastNativeQueueId"] {
        let mut args = json!({"automationId":"automation","timeoutMs":0});
        args[removed] = json!("previous");
        assert!(
            serde_json::from_value::<WaitForAutomationRunToolParams>(args).is_err(),
            "{removed}"
        );
    }
    let schema =
        serde_json::to_value(schemars::schema_for!(WaitForAutomationRunToolParams)).unwrap();
    assert!(schema["properties"].get("afterRunId").is_some());
    assert!(schema["properties"].get("afterLastRunAt").is_none());
    assert!(schema["properties"].get("afterLastNativeQueueId").is_none());
}

#[tokio::test]
async fn native_control_wait_matches_native_queue_invalidations_and_rejects_retired_rows(
) -> anyhow::Result<()> {
    let fixture = Arc::new(WaitFixture::default());
    let (service, server) = gateway(fixture.clone()).await?;
    let params = serde_json::from_value(json!({
        "threadId":"owned-chat","kind":"queueChanged","cursor":4,"timeoutMs":0
    }))?;
    let response = service.wait_for_thread_event(Parameters(params)).await;
    let mut retired_rejected = Vec::new();
    for kind in [
        "queueItemUpsert",
        "turn_queue.item_upsert",
        "queueItemDeleted",
        "turn_queue.item_deleted",
    ] {
        let params =
            serde_json::from_value(json!({"threadId":"owned-chat","kind":kind,"timeoutMs":0}))?;
        retired_rejected.push(
            service
                .wait_for_thread_event(Parameters(params))
                .await
                .is_err(),
        );
    }
    server.abort();
    let response: Value = response?.into_typed()?;
    assert_eq!(response["status"], "matched");
    assert_eq!(response["kind"], "turn_queue.changed");
    assert_eq!(
        response["event"]["payload"],
        json!({"threadId":"owned-chat"})
    );
    assert!(retired_rejected.iter().all(|rejected| *rejected));
    assert_eq!(
        fixture.paths.lock().unwrap().as_slice(),
        ["/v1/self-control/events?cursor=4&threadId=owned-chat"]
    );
    Ok(())
}
