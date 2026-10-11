mod schema;
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
        if automation.target_thread_id.is_some() == automation.new_thread.is_some() {
            return Err(ApiError::BadRequest(
                "supply exactly one automation target".into(),
            ));
        }
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            insert into automations (
                id, name, prompt, target_thread_id, new_thread, start_at, repeat_every_seconds,
                next_run_at, status, paused_reason, provenance, consecutive_failure_count,
                created_at, updated_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(automation.name)
        .bind(automation.prompt)
        .bind(automation.target_thread_id)
        .bind(
            automation
                .new_thread
                .map(|value| serde_json::to_string(&value))
                .transpose()?,
        )
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
            "select id, name, prompt, target_thread_id, new_thread, start_at, repeat_every_seconds, next_run_at, status, paused_reason, last_run_at, last_native_queue_id, last_error, consecutive_failure_count, provenance, created_at, updated_at from automations where deleted_at is null",
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
            select id, name, prompt, target_thread_id, new_thread, start_at, repeat_every_seconds,
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
        if update.target_thread_id.is_some() && update.new_thread.is_some() {
            return Err(ApiError::BadRequest(
                "supply exactly one automation target".into(),
            ));
        }
        let target_changed = update.target_thread_id.is_some() || update.new_thread.is_some();
        let result = sqlx::query(
            "update automations set name = coalesce(?, name), prompt = coalesce(?, prompt),
             target_thread_id = case when ? then ? else target_thread_id end,
             new_thread = case when ? then ? else new_thread end,
             start_at = coalesce(?, start_at), repeat_every_seconds = coalesce(?, repeat_every_seconds),
             next_run_at = coalesce(?, next_run_at), status = coalesce(?, status),
             paused_reason = case when ? then ? else paused_reason end,
             provenance = coalesce(?, provenance), updated_at = ? where id = ? and deleted_at is null"
        )
        .bind(update.name).bind(update.prompt)
        .bind(target_changed).bind(update.target_thread_id)
        .bind(target_changed).bind(update.new_thread.map(|value| serde_json::to_string(&value)).transpose()?)
        .bind(update.start_at).bind(update.repeat_every_seconds).bind(update.next_run_at)
        .bind(update.status.map(|value| value.as_str()))
        .bind(update.paused_reason.is_some()).bind(update.paused_reason.flatten())
        .bind(update.provenance.map(|value| value.to_string()))
        .bind(Utc::now()).bind(id).execute(&self.pool).await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::NotFound(format!("automation {id}")));
        }
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
