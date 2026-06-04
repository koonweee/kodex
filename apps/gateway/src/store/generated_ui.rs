use chrono::Utc;
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::{
    row_to_generated_ui_session, GeneratedUiSession, GeneratedUiSessionStatus,
    GeneratedUiSessionUpsert, Store,
};

impl Store {
    pub async fn upsert_generated_ui_session(
        &self,
        upsert: GeneratedUiSessionUpsert,
    ) -> ApiResult<GeneratedUiSession> {
        let mut tx = self.pool.begin().await?;
        let now = Utc::now();
        let existing = sqlx::query(
            r#"
            select id, revision, status
            from generated_ui_sessions
            where thread_id = ?
            "#,
        )
        .bind(&upsert.thread_id)
        .fetch_optional(&mut *tx)
        .await?;

        let id = if let Some(row) = existing {
            let id: String = row.try_get("id")?;
            let revision: i64 = row.try_get("revision")?;
            let status: String = row.try_get("status")?;
            if GeneratedUiSessionStatus::from_str(&status)? == GeneratedUiSessionStatus::Submitting
            {
                return Err(ApiError::Conflict(
                    "generated UI submit is in progress".to_string(),
                ));
            }
            sqlx::query(
                r#"
                update generated_ui_sessions
                set title = ?,
                    html = ?,
                    revision = ?,
                    status = ?,
                    submitted_revision = null,
                    submitted_message = null,
                    submitted_metadata_json = null,
                    updated_at = ?,
                    submitted_at = null,
                    archived_at = null
                where id = ?
                "#,
            )
            .bind(&upsert.title)
            .bind(&upsert.html)
            .bind(revision + 1)
            .bind(GeneratedUiSessionStatus::Interactive.as_str())
            .bind(now)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
            id
        } else {
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                r#"
                insert into generated_ui_sessions (
                    id, thread_id, title, html, revision, status,
                    created_at, updated_at
                )
                values (?, ?, ?, ?, 1, ?, ?, ?)
                "#,
            )
            .bind(&id)
            .bind(&upsert.thread_id)
            .bind(&upsert.title)
            .bind(&upsert.html)
            .bind(GeneratedUiSessionStatus::Interactive.as_str())
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await?;
            id
        };

        let row = generated_ui_session_query()
            .push(" where id = ")
            .push_bind(id)
            .build()
            .fetch_one(&mut *tx)
            .await?;
        let session = row_to_generated_ui_session(row)?;
        tx.commit().await?;
        Ok(session)
    }

    pub async fn latest_generated_ui_session(
        &self,
        thread_id: &str,
    ) -> ApiResult<Option<GeneratedUiSession>> {
        let row = generated_ui_session_query()
            .push(" where thread_id = ")
            .push_bind(thread_id.to_string())
            .build()
            .fetch_optional(&self.pool)
            .await?;
        row.map(row_to_generated_ui_session).transpose()
    }

    pub async fn get_generated_ui_session(
        &self,
        session_id: &str,
    ) -> ApiResult<GeneratedUiSession> {
        let row = generated_ui_session_query()
            .push(" where id = ")
            .push_bind(session_id.to_string())
            .build()
            .fetch_optional(&self.pool)
            .await?;
        row.map(row_to_generated_ui_session)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("generated UI session {session_id}")))
    }

    pub async fn archive_latest_generated_ui_session(
        &self,
        thread_id: &str,
    ) -> ApiResult<Option<GeneratedUiSession>> {
        if self
            .latest_generated_ui_session(thread_id)
            .await?
            .is_some_and(|session| session.status == GeneratedUiSessionStatus::Submitting)
        {
            return Err(ApiError::Conflict(
                "generated UI submit is in progress".to_string(),
            ));
        }
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update generated_ui_sessions
            set status = ?, archived_at = ?, updated_at = ?
            where thread_id = ?
              and status != ?
              and archived_at is null
            "#,
        )
        .bind(GeneratedUiSessionStatus::Archived.as_str())
        .bind(now)
        .bind(now)
        .bind(thread_id)
        .bind(GeneratedUiSessionStatus::Submitting.as_str())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        self.latest_generated_ui_session(thread_id).await
    }

    pub async fn claim_generated_ui_submit(
        &self,
        session_id: &str,
        revision: i64,
    ) -> ApiResult<GeneratedUiSession> {
        let mut tx = self.pool.begin().await?;
        let row = generated_ui_session_query()
            .push(" where id = ")
            .push_bind(session_id.to_string())
            .build()
            .fetch_optional(&mut *tx)
            .await?;
        let Some(row) = row else {
            return Err(ApiError::NotFound(format!(
                "generated UI session {session_id}"
            )));
        };
        let session = row_to_generated_ui_session(row)?;
        if session.revision != revision {
            return Err(ApiError::Conflict(format!(
                "generated UI revision {} is not current",
                revision
            )));
        }
        if session.status == GeneratedUiSessionStatus::Archived {
            return Err(ApiError::Conflict(
                "generated UI session is archived".to_string(),
            ));
        }
        if session.status == GeneratedUiSessionStatus::Submitting {
            return Err(ApiError::Conflict(
                "generated UI session submit is already in progress".to_string(),
            ));
        }
        if session.submitted_revision == Some(revision)
            || session.status == GeneratedUiSessionStatus::Submitted
        {
            return Err(ApiError::Conflict(
                "generated UI revision has already been submitted".to_string(),
            ));
        }
        let now = Utc::now();
        let claimed_rows = sqlx::query(
            r#"
            update generated_ui_sessions
            set status = ?, updated_at = ?
            where id = ?
              and revision = ?
              and status = ?
              and submitted_revision is null
              and archived_at is null
            "#,
        )
        .bind(GeneratedUiSessionStatus::Submitting.as_str())
        .bind(now)
        .bind(session_id)
        .bind(revision)
        .bind(GeneratedUiSessionStatus::Interactive.as_str())
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if claimed_rows == 0 {
            return Err(ApiError::Conflict(
                "generated UI revision is not submit-capable".to_string(),
            ));
        }
        let row = generated_ui_session_query()
            .push(" where id = ")
            .push_bind(session_id.to_string())
            .build()
            .fetch_one(&mut *tx)
            .await?;
        let session = row_to_generated_ui_session(row)?;
        tx.commit().await?;
        Ok(session)
    }

    pub async fn finish_generated_ui_submit(
        &self,
        session_id: &str,
        revision: i64,
        message: &str,
        metadata: Option<Value>,
    ) -> ApiResult<GeneratedUiSession> {
        let now = Utc::now();
        let metadata_json = metadata.as_ref().map(serde_json::to_string).transpose()?;
        let result = sqlx::query(
            r#"
            update generated_ui_sessions
            set status = ?,
                submitted_revision = ?,
                submitted_message = ?,
                submitted_metadata_json = ?,
                submitted_at = ?,
                updated_at = ?
            where id = ? and revision = ? and status = ?
            "#,
        )
        .bind(GeneratedUiSessionStatus::Submitted.as_str())
        .bind(revision)
        .bind(message)
        .bind(metadata_json)
        .bind(now)
        .bind(now)
        .bind(session_id)
        .bind(revision)
        .bind(GeneratedUiSessionStatus::Submitting.as_str())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::Conflict(
                "generated UI submit claim is no longer active".to_string(),
            ));
        }
        self.get_generated_ui_session(session_id).await
    }

    pub async fn reset_generated_ui_submit(
        &self,
        session_id: &str,
        revision: i64,
    ) -> ApiResult<()> {
        let now = Utc::now();
        sqlx::query(
            r#"
            update generated_ui_sessions
            set status = ?, updated_at = ?
            where id = ? and revision = ? and status = ?
            "#,
        )
        .bind(GeneratedUiSessionStatus::Interactive.as_str())
        .bind(now)
        .bind(session_id)
        .bind(revision)
        .bind(GeneratedUiSessionStatus::Submitting.as_str())
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

fn generated_ui_session_query() -> sqlx::QueryBuilder<'static, sqlx::Sqlite> {
    sqlx::QueryBuilder::new(
        r#"
        select id, thread_id, title, html, revision, status, submitted_revision,
               submitted_message, submitted_metadata_json, created_at, updated_at,
               submitted_at, archived_at
        from generated_ui_sessions
        "#,
    )
}
