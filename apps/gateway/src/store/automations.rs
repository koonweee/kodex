use chrono::{DateTime, Utc};
use sqlx::{QueryBuilder, Sqlite};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::{
    next_automation_run_after, row_to_automation, row_to_automation_run, Automation, AutomationRun,
    AutomationStatus, AutomationUpdate, NewAutomation, Store,
};

impl Store {
    pub async fn create_automation(&self, automation: NewAutomation) -> ApiResult<Automation> {
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            insert into automations (
                id, name, prompt, target_thread_id, start_at, repeat_every_seconds,
                next_run_at, status, paused_reason, provenance, consecutive_failure_count,
                created_at, updated_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(automation.name)
        .bind(automation.prompt)
        .bind(automation.target_thread_id)
        .bind(automation.start_at)
        .bind(automation.repeat_every_seconds)
        .bind(automation.next_run_at)
        .bind(automation.status.as_str())
        .bind(automation.paused_reason)
        .bind(automation.provenance.map(|value| value.to_string()))
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_automation(&id).await
    }

    pub async fn list_automations(
        &self,
        target_thread_id: Option<&str>,
    ) -> ApiResult<Vec<Automation>> {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "select id, name, prompt, target_thread_id, start_at, repeat_every_seconds, next_run_at, status, paused_reason, last_run_at, last_queued_input_id, last_error, consecutive_failure_count, provenance, created_at, updated_at from automations where deleted_at is null",
        );
        if let Some(target_thread_id) = target_thread_id {
            builder.push(" and target_thread_id = ");
            builder.push_bind(target_thread_id);
        }
        builder.push(" order by created_at desc, id");
        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.into_iter().map(row_to_automation).collect()
    }

    pub async fn get_automation(&self, id: &str) -> ApiResult<Automation> {
        let row = sqlx::query(
            r#"
            select id, name, prompt, target_thread_id, start_at, repeat_every_seconds,
                   next_run_at, status, paused_reason, last_run_at, last_queued_input_id,
                   last_error, consecutive_failure_count, provenance, created_at, updated_at
            from automations
            where id = ? and deleted_at is null
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_automation)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("automation {id}")))
    }

    pub async fn update_automation(
        &self,
        id: &str,
        update: AutomationUpdate,
    ) -> ApiResult<Automation> {
        let existing = self.get_automation(id).await?;
        let now = Utc::now();
        sqlx::query(
            r#"
            update automations
            set name = ?,
                prompt = ?,
                target_thread_id = ?,
                start_at = ?,
                repeat_every_seconds = ?,
                next_run_at = ?,
                status = ?,
                paused_reason = ?,
                provenance = ?,
                updated_at = ?
            where id = ? and deleted_at is null
            "#,
        )
        .bind(update.name.unwrap_or(existing.name))
        .bind(update.prompt.unwrap_or(existing.prompt))
        .bind(update.target_thread_id.unwrap_or(existing.target_thread_id))
        .bind(update.start_at.unwrap_or(existing.start_at))
        .bind(
            update
                .repeat_every_seconds
                .unwrap_or(existing.repeat_every_seconds),
        )
        .bind(update.next_run_at.unwrap_or(existing.next_run_at))
        .bind(update.status.unwrap_or(existing.status).as_str())
        .bind(update.paused_reason.unwrap_or(existing.paused_reason))
        .bind(
            update
                .provenance
                .or(existing.provenance)
                .map(|value| value.to_string()),
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.get_automation(id).await
    }

    pub async fn pause_automation(
        &self,
        id: &str,
        paused_reason: Option<&str>,
    ) -> ApiResult<Automation> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update automations
            set status = 'paused', paused_reason = ?, updated_at = ?
            where id = ? and deleted_at is null
            "#,
        )
        .bind(paused_reason)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::NotFound(format!("automation {id}")));
        }
        self.get_automation(id).await
    }

    pub async fn resume_automation(&self, id: &str) -> ApiResult<Automation> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update automations
            set status = 'active', paused_reason = null, updated_at = ?
            where id = ? and deleted_at is null
            "#,
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::NotFound(format!("automation {id}")));
        }
        self.get_automation(id).await
    }

    pub async fn delete_automation(&self, id: &str) -> ApiResult<()> {
        let now = Utc::now();
        let result = sqlx::query(
            "update automations set deleted_at = ?, updated_at = ? where id = ? and deleted_at is null",
        )
        .bind(now)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::NotFound(format!("automation {id}")));
        }
        Ok(())
    }

    pub async fn claim_due_automation_runs(
        &self,
        now: DateTime<Utc>,
        limit: i64,
    ) -> ApiResult<Vec<AutomationRun>> {
        let rows = sqlx::query(
            r#"
            select id, name, prompt, target_thread_id, start_at, repeat_every_seconds,
                   next_run_at, status, paused_reason, last_run_at, last_queued_input_id,
                   last_error, consecutive_failure_count, provenance, created_at, updated_at
            from automations
            where deleted_at is null and status = 'active' and next_run_at <= ?
            order by next_run_at asc, created_at asc
            limit ?
            "#,
        )
        .bind(now)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let mut claimed = Vec::new();
        for row in rows {
            let automation = row_to_automation(row)?;
            let scheduled_for = automation.next_run_at;
            let next_run_at = next_automation_run_after(
                automation.start_at,
                automation.repeat_every_seconds,
                now,
            );
            let mut tx = self.pool.begin().await?;

            let pending_count: i64 = sqlx::query_scalar(
                r#"
                select count(*)
                from automation_runs runs
                left join queued_turn_inputs queue on queue.id = runs.queued_input_id
                where runs.automation_id = ?
                  and (
                    runs.status = 'pending'
                    or (
                      runs.status = 'queued'
                      and queue.deleted_at is null
                      and queue.status in ('queued', 'submitting', 'steering', 'pendingCommit')
                    )
                  )
                "#,
            )
            .bind(&automation.id)
            .fetch_one(&mut *tx)
            .await?;

            let update = sqlx::query(
                r#"
                update automations
                set next_run_at = ?, updated_at = ?
                where id = ?
                  and deleted_at is null
                  and status = 'active'
                  and next_run_at = ?
                "#,
            )
            .bind(next_run_at)
            .bind(now)
            .bind(&automation.id)
            .bind(scheduled_for)
            .execute(&mut *tx)
            .await?;

            if update.rows_affected() == 0 {
                tx.rollback().await?;
                continue;
            }

            if pending_count > 0 {
                tx.commit().await?;
                continue;
            }

            let run_id = Uuid::new_v4().to_string();
            let result = sqlx::query(
                r#"
                insert or ignore into automation_runs (
                    id, automation_id, scheduled_for, status, created_at, updated_at
                )
                values (?, ?, ?, 'pending', ?, ?)
                "#,
            )
            .bind(&run_id)
            .bind(&automation.id)
            .bind(scheduled_for)
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            if result.rows_affected() > 0 {
                claimed.push(self.get_automation_run(&run_id).await?);
            }
        }
        Ok(claimed)
    }

    pub async fn get_automation_run(&self, id: &str) -> ApiResult<AutomationRun> {
        let row = sqlx::query(
            r#"
            select id, automation_id, scheduled_for, status, queued_input_id,
                   error, created_at, updated_at
            from automation_runs
            where id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_automation_run)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("automation run {id}")))
    }

    pub async fn automation_for_run(&self, run_id: &str) -> ApiResult<Automation> {
        let automation_id: String =
            sqlx::query_scalar("select automation_id from automation_runs where id = ?")
                .bind(run_id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or_else(|| ApiError::NotFound(format!("automation run {run_id}")))?;
        self.get_automation(&automation_id).await
    }

    pub async fn mark_automation_run_queued(
        &self,
        run_id: &str,
        queued_input_id: &str,
    ) -> ApiResult<Automation> {
        let now = Utc::now();
        let run = self.get_automation_run(run_id).await?;
        let result = sqlx::query(
            r#"
            update automation_runs
            set status = 'queued', queued_input_id = ?, error = null, updated_at = ?
            where id = ? and status = 'pending'
            "#,
        )
        .bind(queued_input_id)
        .bind(now)
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::BadRequest(format!(
                "automation run {run_id} is not pending"
            )));
        }
        sqlx::query(
            r#"
            update automations
            set last_run_at = ?,
                last_queued_input_id = ?,
                last_error = null,
                consecutive_failure_count = 0,
                updated_at = ?
            where id = ? and deleted_at is null
            "#,
        )
        .bind(run.scheduled_for)
        .bind(queued_input_id)
        .bind(now)
        .bind(&run.automation_id)
        .execute(&self.pool)
        .await?;
        self.get_automation(&run.automation_id).await
    }

    pub async fn mark_automation_run_failed(
        &self,
        run_id: &str,
        error: String,
        auto_pause_after_failures: i64,
    ) -> ApiResult<Automation> {
        let now = Utc::now();
        let run = self.get_automation_run(run_id).await?;
        let result = sqlx::query(
            r#"
            update automation_runs
            set status = 'failed', error = ?, updated_at = ?
            where id = ? and status = 'pending'
            "#,
        )
        .bind(&error)
        .bind(now)
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::BadRequest(format!(
                "automation run {run_id} is not pending"
            )));
        }
        sqlx::query(
            r#"
            update automations
            set last_run_at = ?,
                last_error = ?,
                consecutive_failure_count = consecutive_failure_count + 1,
                updated_at = ?
            where id = ? and deleted_at is null
            "#,
        )
        .bind(run.scheduled_for)
        .bind(&error)
        .bind(now)
        .bind(&run.automation_id)
        .execute(&self.pool)
        .await?;
        let automation = self.get_automation(&run.automation_id).await?;
        if automation.consecutive_failure_count >= auto_pause_after_failures
            && automation.status == AutomationStatus::Active
        {
            return self
                .pause_automation(&run.automation_id, Some("tooManyFailures"))
                .await;
        }
        Ok(automation)
    }

    pub async fn recover_pending_automation_runs_after_restart(
        &self,
        source_type: &str,
        auto_pause_after_failures: i64,
    ) -> ApiResult<Vec<Automation>> {
        let run_ids = sqlx::query_scalar::<_, String>(
            "select id from automation_runs where status = 'pending' order by created_at asc",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut automations = Vec::with_capacity(run_ids.len());
        for run_id in run_ids {
            if let Some(queued_input) = self
                .find_queued_input_by_source(source_type, &run_id)
                .await?
            {
                automations.push(
                    self.mark_automation_run_queued(&run_id, &queued_input.id)
                        .await?,
                );
            } else {
                automations.push(
                    self.mark_automation_run_failed(
                        &run_id,
                        "Gateway restarted before this automation run could queue input."
                            .to_string(),
                        auto_pause_after_failures,
                    )
                    .await?,
                );
            }
        }
        Ok(automations)
    }
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use crate::{
        app_server_api::{TurnStartOptions, UserInput},
        store::{AutomationStatus, NewAutomation, QueuedInputStatus, Store},
    };

    #[tokio::test]
    async fn automation_due_claims_coalesce_and_advance_wall_clock_cadence() {
        let store = Store::in_memory().await.unwrap();
        let start_at = Utc.with_ymd_and_hms(2026, 5, 7, 9, 0, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 5, 7, 9, 2, 5).unwrap();
        let automation = store
            .create_automation(NewAutomation {
                name: "status".to_string(),
                prompt: "summarize".to_string(),
                target_thread_id: "thread-1".to_string(),
                start_at,
                repeat_every_seconds: 60,
                next_run_at: start_at,
                status: AutomationStatus::Active,
                paused_reason: None,
                provenance: None,
            })
            .await
            .unwrap();

        let runs = store.claim_due_automation_runs(now, 10).await.unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].scheduled_for, start_at);
        let advanced = store.get_automation(&automation.id).await.unwrap();
        assert_eq!(
            advanced.next_run_at,
            Utc.with_ymd_and_hms(2026, 5, 7, 9, 3, 0).unwrap()
        );

        let repeated_tick = store.claim_due_automation_runs(now, 10).await.unwrap();
        assert!(repeated_tick.is_empty());

        let queued = store
            .create_queued_input_with_source(
                "thread-1",
                vec![UserInput::Text {
                    text: "summarize".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions::default(),
                Some("automation"),
                Some(&runs[0].id),
            )
            .await
            .unwrap();
        store
            .mark_automation_run_queued(&runs[0].id, &queued.id)
            .await
            .unwrap();
        let future = Utc.with_ymd_and_hms(2026, 5, 7, 9, 4, 0).unwrap();
        assert!(store
            .claim_due_automation_runs(future, 10)
            .await
            .unwrap()
            .is_empty());

        store
            .delete_queued_input_for_gateway("thread-1", &queued.id)
            .await
            .unwrap();
        let after_delete = store
            .claim_due_automation_runs(future + chrono::Duration::minutes(1), 10)
            .await
            .unwrap();
        assert_eq!(after_delete.len(), 1);
    }

    #[tokio::test]
    async fn automation_failures_auto_pause_after_threshold() {
        let store = Store::in_memory().await.unwrap();
        let start_at = Utc.with_ymd_and_hms(2026, 5, 7, 9, 0, 0).unwrap();
        let automation = store
            .create_automation(NewAutomation {
                name: "status".to_string(),
                prompt: "summarize".to_string(),
                target_thread_id: "thread-1".to_string(),
                start_at,
                repeat_every_seconds: 30,
                next_run_at: start_at,
                status: AutomationStatus::Active,
                paused_reason: None,
                provenance: None,
            })
            .await
            .unwrap();

        for index in 0..5 {
            let now = start_at + chrono::Duration::seconds(30 * index);
            let run = store.claim_due_automation_runs(now, 10).await.unwrap();
            assert_eq!(run.len(), 1);
            store
                .mark_automation_run_failed(&run[0].id, "thread missing".to_string(), 5)
                .await
                .unwrap();
        }

        let paused = store.get_automation(&automation.id).await.unwrap();
        assert_eq!(paused.status, AutomationStatus::Paused);
        assert_eq!(paused.paused_reason.as_deref(), Some("tooManyFailures"));
        assert_eq!(paused.consecutive_failure_count, 5);
        assert!(store
            .claim_due_automation_runs(start_at + chrono::Duration::minutes(5), 10)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn pending_automation_run_recovery_marks_failed_or_links_existing_queue_row() {
        let store = Store::in_memory().await.unwrap();
        let start_at = Utc.with_ymd_and_hms(2026, 5, 7, 9, 0, 0).unwrap();
        let failed_automation = store
            .create_automation(NewAutomation {
                name: "missing queue".to_string(),
                prompt: "summarize".to_string(),
                target_thread_id: "thread-1".to_string(),
                start_at,
                repeat_every_seconds: 30,
                next_run_at: start_at,
                status: AutomationStatus::Active,
                paused_reason: None,
                provenance: None,
            })
            .await
            .unwrap();
        let failed_run = store.claim_due_automation_runs(start_at, 10).await.unwrap();
        assert_eq!(failed_run.len(), 1);

        let queued_automation = store
            .create_automation(NewAutomation {
                name: "existing queue".to_string(),
                prompt: "summarize".to_string(),
                target_thread_id: "thread-2".to_string(),
                start_at,
                repeat_every_seconds: 30,
                next_run_at: start_at,
                status: AutomationStatus::Active,
                paused_reason: None,
                provenance: None,
            })
            .await
            .unwrap();
        let queued_run = store.claim_due_automation_runs(start_at, 10).await.unwrap();
        assert_eq!(queued_run.len(), 1);
        let queued_input = store
            .create_queued_input_with_source(
                "thread-2",
                vec![UserInput::Text {
                    text: "summarize".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions::default(),
                Some("automation"),
                Some(&queued_run[0].id),
            )
            .await
            .unwrap();
        store
            .claim_next_queued_input("thread-2")
            .await
            .unwrap()
            .unwrap();
        let recovered_queue_rows = store.recover_queued_inputs_after_restart().await.unwrap();
        assert!(recovered_queue_rows
            .iter()
            .any(|row| row.id == queued_input.id && row.status == QueuedInputStatus::Failed));
        store
            .delete_queued_input_for_gateway("thread-2", &queued_input.id)
            .await
            .unwrap();

        let recovered = store
            .recover_pending_automation_runs_after_restart("automation", 5)
            .await
            .unwrap();
        assert_eq!(recovered.len(), 2);

        let failed = store.get_automation(&failed_automation.id).await.unwrap();
        assert_eq!(failed.consecutive_failure_count, 1);
        assert!(failed
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("Gateway restarted"));

        let queued = store.get_automation(&queued_automation.id).await.unwrap();
        assert_eq!(
            queued.last_queued_input_id.as_deref(),
            Some(queued_input.id.as_str())
        );
        assert_eq!(queued.consecutive_failure_count, 0);
        let recovered_run = store.get_automation_run(&queued_run[0].id).await.unwrap();
        assert_eq!(recovered_run.status, "queued");
    }
}
