use chrono::{DateTime, Utc};
use sqlx::{Sqlite, Transaction};
use uuid::Uuid;

use crate::{
    error::{ApiError, ApiResult},
    store::{
        next_automation_run_after, row_to_automation, row_to_automation_run, AutomationRun,
        AutomationRunPhase as Phase, Store,
    },
};

pub struct AutomationClaimBatch {
    pub runs: Vec<AutomationRun>,
    pub updated_automation_ids: Vec<String>,
}

impl Store {
    pub async fn claim_due_automation_runs(
        &self,
        now: DateTime<Utc>,
        limit: i64,
    ) -> ApiResult<AutomationClaimBatch> {
        let due = sqlx::query("select * from automations where deleted_at is null and status = 'active' and next_run_at <= ? order by next_run_at, created_at limit ?")
            .bind(now).bind(limit).fetch_all(&self.pool).await?;
        let mut batch = AutomationClaimBatch {
            runs: Vec::new(),
            updated_automation_ids: Vec::new(),
        };
        for row in due {
            let observed = row_to_automation(row)?;
            let next =
                next_automation_run_after(observed.start_at, observed.repeat_every_seconds, now);
            let mut tx = self.pool.begin().await?;
            // Take the write lock before reading pending admissions. Competing
            // connections cannot both claim or hit a deferred read-lock upgrade.
            let current = sqlx::query("update automations set next_run_at = ?, updated_at = ? where id = ? and deleted_at is null and status = 'active' and next_run_at = ? and start_at = ? and repeat_every_seconds = ? returning *")
                .bind(next).bind(now).bind(&observed.id).bind(observed.next_run_at)
                .bind(observed.start_at).bind(observed.repeat_every_seconds)
                .fetch_optional(&mut *tx).await?;
            let Some(current) = current else {
                tx.rollback().await?;
                continue;
            };
            let current = row_to_automation(current)?;
            let pending: bool = sqlx::query_scalar("select exists(select 1 from automation_runs where automation_id = ? and scheduled_for is not null and phase in ('admitting', 'queued', 'startRequested', 'uncertain'))")
                .bind(&current.id).fetch_one(&mut *tx).await?;
            if !pending {
                let run = sqlx::query("insert or ignore into automation_runs (id, automation_id, target_thread_id, scheduled_for, phase, created_at, updated_at) values (?, ?, ?, ?, 'admitting', ?, ?) returning *")
                    .bind(Uuid::new_v4().to_string()).bind(&current.id).bind(&current.target_thread_id)
                    .bind(observed.next_run_at).bind(now).bind(now).fetch_optional(&mut *tx).await?;
                if let Some(run) = run {
                    batch.runs.push(row_to_automation_run(run)?);
                }
            }
            tx.commit().await?;
            batch.updated_automation_ids.push(current.id);
        }
        Ok(batch)
    }

    pub async fn create_automation_run_now(&self, automation_id: &str) -> ApiResult<AutomationRun> {
        let now = Utc::now();
        let row = sqlx::query("insert into automation_runs (id, automation_id, target_thread_id, scheduled_for, phase, created_at, updated_at) select ?, id, target_thread_id, null, 'admitting', ?, ? from automations where id = ? and deleted_at is null returning *")
            .bind(Uuid::new_v4().to_string()).bind(now).bind(now).bind(automation_id)
            .fetch_optional(&self.pool).await?;
        row.map(row_to_automation_run)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("automation {automation_id}")))
    }

    pub async fn get_automation_run(&self, id: &str) -> ApiResult<AutomationRun> {
        sqlx::query("select * from automation_runs where id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .map(row_to_automation_run)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("automation run {id}")))
    }

    pub async fn list_automation_runs(&self, automation_id: &str) -> ApiResult<Vec<AutomationRun>> {
        sqlx::query(
            "select * from automation_runs where automation_id = ? order by created_at desc, id limit 100",
        )
        .bind(automation_id)
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(row_to_automation_run)
        .collect()
    }

    pub async fn list_outstanding_automation_runs(&self) -> ApiResult<Vec<AutomationRun>> {
        sqlx::query("select * from automation_runs where phase in ('admitting', 'queued', 'startRequested', 'uncertain') order by target_thread_id, created_at, id")
            .fetch_all(&self.pool).await?.into_iter().map(row_to_automation_run).collect()
    }

    /// Changes only the expected phase. An early native receipt wins over any
    /// later admission/start ACK or error, including its schedule statistics.
    pub async fn transition_automation_run(
        &self,
        id: &str,
        expected: Phase,
        next: Phase,
        native_queue_id: Option<&str>,
        turn_id: Option<&str>,
        error: Option<&str>,
    ) -> ApiResult<Option<AutomationRun>> {
        if !matches!(
            (expected, next),
            (
                Phase::Admitting,
                Phase::Queued | Phase::Rejected | Phase::Uncertain
            ) | (Phase::Queued, Phase::StartRequested | Phase::Uncertain)
                | (Phase::StartRequested, Phase::Dispatched | Phase::Uncertain)
                | (Phase::Uncertain, Phase::Uncertain)
        ) {
            return Err(ApiError::BadRequest(
                "invalid automation admission transition".into(),
            ));
        }
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query("update automation_runs set phase = ?, native_queue_id = coalesce(?, native_queue_id), turn_id = coalesce(?, turn_id), error = ?, updated_at = ? where id = ? and phase = ? and (native_queue_id is null or ? is null or native_queue_id = ?) returning *")
            .bind(next.as_str()).bind(native_queue_id).bind(turn_id).bind(error).bind(Utc::now())
            .bind(id).bind(expected.as_str()).bind(native_queue_id).bind(native_queue_id)
            .fetch_optional(&mut *tx).await?;
        let run = row.map(row_to_automation_run).transpose()?;
        if let Some(run) = &run {
            update_schedule_statistics(&mut tx, run).await?;
        }
        tx.commit().await?;
        Ok(run)
    }

    pub async fn settle_automation_run_delivery(
        &self,
        thread_id: &str,
        turn_id: &str,
        client_id: Option<&str>,
    ) -> ApiResult<Option<AutomationRun>> {
        let Some(client_id) = client_id else {
            return Ok(None);
        };
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query("update automation_runs set phase = 'dispatched', turn_id = ?, error = null, updated_at = ? where id = ? and target_thread_id = ? and phase != 'dispatched' returning *")
            .bind(turn_id).bind(Utc::now()).bind(client_id).bind(thread_id).fetch_optional(&mut *tx).await?;
        let run = row.map(row_to_automation_run).transpose()?;
        if let Some(run) = &run {
            update_schedule_statistics(&mut tx, run).await?;
        }
        tx.commit().await?;
        Ok(run)
    }

    pub async fn remove_automation_run(
        &self,
        thread_id: &str,
        native_queue_id: &str,
    ) -> ApiResult<Option<AutomationRun>> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query("update automation_runs set phase = 'removed', error = null, updated_at = ? where target_thread_id = ? and native_queue_id = ? and phase in ('queued', 'startRequested', 'uncertain') returning *")
            .bind(Utc::now()).bind(thread_id).bind(native_queue_id).fetch_optional(&mut *tx).await?;
        let run = row.map(row_to_automation_run).transpose()?;
        if let Some(run) = &run {
            update_schedule_statistics(&mut tx, run).await?;
        }
        tx.commit().await?;
        Ok(run)
    }

    pub async fn mark_automation_run_handoff_pending(
        &self,
        thread_id: &str,
        native_queue_id: &str,
    ) -> ApiResult<Option<AutomationRun>> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query("update automation_runs set phase = 'uncertain', error = 'Native queued message is awaiting exact dispatch/delivery evidence', updated_at = ? where target_thread_id = ? and native_queue_id = ? and phase in ('queued', 'startRequested') returning *")
            .bind(Utc::now()).bind(thread_id).bind(native_queue_id).fetch_optional(&mut *tx).await?;
        let run = row.map(row_to_automation_run).transpose()?;
        if let Some(run) = &run {
            update_schedule_statistics(&mut tx, run).await?;
        }
        tx.commit().await?;
        Ok(run)
    }

    /// Called only after a verified native start ACK or the transfer owner's
    /// fresh correlation receipt. The native row links it to this producer.
    pub async fn settle_automation_run_promotion(
        &self,
        thread_id: &str,
        native_queue_id: &str,
        turn_id: &str,
    ) -> ApiResult<Option<AutomationRun>> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query("update automation_runs set phase = 'dispatched', turn_id = ?, error = null, updated_at = ? where target_thread_id = ? and native_queue_id = ? and phase != 'dispatched' returning *")
            .bind(turn_id).bind(Utc::now()).bind(thread_id).bind(native_queue_id).fetch_optional(&mut *tx).await?;
        let run = row.map(row_to_automation_run).transpose()?;
        if let Some(run) = &run {
            update_schedule_statistics(&mut tx, run).await?;
        }
        tx.commit().await?;
        Ok(run)
    }

    pub async fn invalidate_automation_admissions_after_restart(&self) -> ApiResult<()> {
        sqlx::query("update automation_runs set phase = 'uncertain', error = 'Gateway restarted before native admission was confirmed', updated_at = ? where phase in ('admitting', 'startRequested')")
            .bind(Utc::now()).execute(&self.pool).await?;
        Ok(())
    }
}

async fn update_schedule_statistics(
    tx: &mut Transaction<'_, Sqlite>,
    run: &AutomationRun,
) -> ApiResult<()> {
    let Some(scheduled_for) = run.scheduled_for else {
        return Ok(());
    };
    if run.phase == Phase::StartRequested {
        return Ok(());
    }
    // Run-now is excluded. Older late evidence cannot overwrite newer schedule
    // results; a repeated ACK cannot increment failures because its CAS lost.
    sqlx::query("update automations set last_run_at = ?, last_native_queue_id = coalesce(?, last_native_queue_id), last_error = ?, consecutive_failure_count = case when ? = 'rejected' then consecutive_failure_count + 1 when ? in ('queued', 'dispatched') then 0 else consecutive_failure_count end, status = case when ? = 'rejected' and consecutive_failure_count + 1 >= 5 and status = 'active' then 'paused' else status end, paused_reason = case when ? = 'rejected' and consecutive_failure_count + 1 >= 5 and status = 'active' then 'tooManyFailures' else paused_reason end, updated_at = ? where id = ? and deleted_at is null and (last_run_at is null or last_run_at <= ?)")
        .bind(scheduled_for).bind(&run.native_queue_id).bind(&run.error)
        .bind(run.phase.as_str()).bind(run.phase.as_str()).bind(run.phase.as_str()).bind(run.phase.as_str())
        .bind(Utc::now()).bind(&run.automation_id).bind(scheduled_for).execute(&mut **tx).await?;
    Ok(())
}
