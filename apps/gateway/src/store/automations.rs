use chrono::Utc;
use sqlx::{QueryBuilder, Sqlite};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::{row_to_automation, Automation, AutomationUpdate, NewAutomation, Store};

#[cfg(test)]
#[path = "automations/native_tests.rs"]
mod native_tests;

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
            "select id, name, prompt, target_thread_id, start_at, repeat_every_seconds, next_run_at, status, paused_reason, last_run_at, last_native_queue_id, last_error, consecutive_failure_count, provenance, created_at, updated_at from automations where deleted_at is null",
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
                   next_run_at, status, paused_reason, last_run_at, last_native_queue_id,
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
}

#[path = "automations/runs.rs"]
mod runs;
