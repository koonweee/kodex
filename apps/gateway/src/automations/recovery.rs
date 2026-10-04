use std::collections::BTreeMap;

use crate::{
    api::AppState,
    app_server_api::{self, SortDirection},
    error::ApiResult,
    store::{AutomationRun, AutomationRunPhase as Phase},
};

use super::{activate_target, broadcast_run_update, change, start_if_idle};

/// Recover producer correlation, never queue payloads or admission writes.
/// Native reads are bounded once per immutable target; absent/truncated history
/// cannot prove non-delivery or authorize replay of an ambiguous start.
pub async fn recover_automations_after_restart(state: &AppState) -> ApiResult<()> {
    state
        .store
        .invalidate_automation_admissions_after_restart()
        .await?;
    let runs = state.store.list_outstanding_automation_runs().await?;
    let mut targets = BTreeMap::<String, Vec<AutomationRun>>::new();
    for run in runs {
        targets
            .entry(run.target_thread_id.clone())
            .or_default()
            .push(run);
    }
    let client = app_server_api::client(&state.app_server);
    for (target, runs) in targets {
        let queue = client.queue_list(target.clone(), None, Some(100)).await;
        let items = client
            .thread_items_list_page(target.clone(), None, None, SortDirection::Desc, Some(25))
            .await;
        let mut queued = Vec::new();
        for run in runs {
            let receipts = items
                .as_ref()
                .ok()
                .into_iter()
                .flat_map(|page| &page.data)
                .filter(|entry| {
                    entry.item.item_type == "userMessage"
                        && entry.item.client_id.as_deref() == Some(run.id.as_str())
                })
                .collect::<Vec<_>>();
            if receipts.len() == 1 {
                if let Some(delivered) = state
                    .store
                    .settle_automation_run_delivery(&target, &receipts[0].turn_id, Some(&run.id))
                    .await?
                {
                    broadcast_run_update(state, &delivered).await;
                }
                continue;
            }
            let rows = queue
                .as_ref()
                .ok()
                .into_iter()
                .flat_map(|page| &page.data)
                .filter(|row| {
                    row.client_user_message_id == run.id
                        && run.native_queue_id.as_ref().is_none_or(|id| id == &row.id)
                })
                .collect::<Vec<_>>();
            if run.phase == Phase::Queued && rows.len() == 1 && receipts.is_empty() && items.is_ok()
            {
                queued.push(run);
                continue;
            }
            // Native dispatch can accept input before deleting its queue row.
            // Presence after a lost ACK supplies correlation, not permission
            // to activate/start again, even when bounded history is empty.
            if run.phase == Phase::Uncertain && run.native_queue_id.is_none() && rows.len() == 1 {
                change(
                    state,
                    &run,
                    Phase::Uncertain,
                    Some(&rows[0].id),
                    None,
                    run.error.as_deref(),
                )
                .await?;
                continue;
            }
            if run.phase == Phase::Queued {
                change(state, &run, Phase::Uncertain, None, None, Some("Native delivery is unknown in the bounded recovery snapshot; no resubmission will occur")).await?;
            } else {
                broadcast_run_update(state, &run).await;
            }
        }
        if queued.is_empty() {
            continue;
        }
        // Only admitted automation targets are activated. Ordinary queues in
        // other chats remain unloaded; edited definitions are never consulted.
        if activate_target(state, &target).await.is_err() {
            for run in queued {
                change(state, &run, Phase::Uncertain, None, None, Some("Automation target could not be reactivated; queued delivery remains unknown")).await?;
            }
            continue;
        }
        for run in queued {
            start_if_idle(state, &run).await?;
        }
    }
    Ok(())
}
