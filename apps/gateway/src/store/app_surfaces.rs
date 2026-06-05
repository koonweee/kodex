use chrono::Utc;
use serde_json::Value;
use sqlx::Row;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::{
    AppSurfaceCsp, AppSurfaceGrants, AppSurfaceProvider, AppSurfaceSession,
    AppSurfaceSessionStatus, AppSurfaceSessionUpsert, Store,
};

impl Store {
    pub async fn upsert_app_surface_session(
        &self,
        upsert: AppSurfaceSessionUpsert,
    ) -> ApiResult<AppSurfaceSession> {
        let mut tx = self.pool.begin().await?;
        let now = Utc::now();
        let existing = sqlx::query(
            r#"
            select id, revision, status
            from app_surface_sessions
            where thread_id = ?
            "#,
        )
        .bind(&upsert.thread_id)
        .fetch_optional(&mut *tx)
        .await?;

        let display_modes_json = serde_json::to_string(&upsert.display_modes)?;
        let csp_json = serde_json::to_string(&upsert.csp)?;
        let grants_json = serde_json::to_string(&upsert.grants)?;
        let provenance_json = serde_json::to_string(&upsert.provenance)?;

        let bridge_token = Uuid::new_v4().to_string();
        let (id, revision) = if let Some(row) = existing {
            let id: String = row.try_get("id")?;
            let revision: i64 = row.try_get("revision")?;
            let status: String = row.try_get("status")?;
            if AppSurfaceSessionStatus::from_str(&status)? == AppSurfaceSessionStatus::Submitting {
                return Err(ApiError::Conflict(
                    "app surface submit is in progress".to_string(),
                ));
            }
            let next_revision = revision + 1;
            let resource_uri = upsert
                .resource_uri
                .unwrap_or_else(|| generated_resource_uri(&id, next_revision));
            sqlx::query(
                r#"
                update app_surface_sessions
                set provider = ?,
                    bridge_token = ?,
                    title = ?,
                    resource_uri = ?,
                    resource_mime_type = ?,
                    fallback_content = ?,
                    revision = ?,
                    status = ?,
                    display_modes_json = ?,
                    csp_json = ?,
                    grants_json = ?,
                    provenance_json = ?,
                    submitted_revision = null,
                    submitted_message = null,
                    submitted_metadata_json = null,
                    updated_at = ?,
                    submitted_at = null,
                    archived_at = null
                where id = ?
                "#,
            )
            .bind(upsert.provider.as_str())
            .bind(&bridge_token)
            .bind(&upsert.title)
            .bind(&resource_uri)
            .bind(&upsert.resource_mime_type)
            .bind(&upsert.fallback_content)
            .bind(next_revision)
            .bind(AppSurfaceSessionStatus::Active.as_str())
            .bind(&display_modes_json)
            .bind(&csp_json)
            .bind(&grants_json)
            .bind(&provenance_json)
            .bind(now)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
            insert_app_surface_resource(
                &mut tx,
                &id,
                next_revision,
                &resource_uri,
                &upsert.resource_mime_type,
                &upsert.html,
                now,
            )
            .await?;
            (id, next_revision)
        } else {
            let id = Uuid::new_v4().to_string();
            let revision = 1;
            let resource_uri = upsert
                .resource_uri
                .unwrap_or_else(|| generated_resource_uri(&id, revision));
            sqlx::query(
                r#"
                insert into app_surface_sessions (
                    id, thread_id, bridge_token, provider, title, resource_uri, resource_mime_type,
                    fallback_content, revision, status, display_modes_json, csp_json,
                    grants_json, provenance_json, created_at, updated_at
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                "#,
            )
            .bind(&id)
            .bind(&upsert.thread_id)
            .bind(&bridge_token)
            .bind(upsert.provider.as_str())
            .bind(&upsert.title)
            .bind(&resource_uri)
            .bind(&upsert.resource_mime_type)
            .bind(&upsert.fallback_content)
            .bind(revision)
            .bind(AppSurfaceSessionStatus::Active.as_str())
            .bind(&display_modes_json)
            .bind(&csp_json)
            .bind(&grants_json)
            .bind(&provenance_json)
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await?;
            insert_app_surface_resource(
                &mut tx,
                &id,
                revision,
                &resource_uri,
                &upsert.resource_mime_type,
                &upsert.html,
                now,
            )
            .await?;
            (id, revision)
        };

        let session = fetch_app_surface_session_in_tx(&mut tx, &id, revision).await?;
        tx.commit().await?;
        Ok(session)
    }

    pub async fn latest_app_surface_session(
        &self,
        thread_id: &str,
    ) -> ApiResult<Option<AppSurfaceSession>> {
        let row = app_surface_session_query()
            .push(" where s.thread_id = ")
            .push_bind(thread_id.to_string())
            .build()
            .fetch_optional(&self.pool)
            .await?;
        row.map(row_to_app_surface_session).transpose()
    }

    pub async fn get_app_surface_session(&self, session_id: &str) -> ApiResult<AppSurfaceSession> {
        let row = app_surface_session_query()
            .push(" where s.id = ")
            .push_bind(session_id.to_string())
            .build()
            .fetch_optional(&self.pool)
            .await?;
        row.map(row_to_app_surface_session)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("app surface session {session_id}")))
    }

    pub async fn archive_latest_app_surface_session(
        &self,
        thread_id: &str,
    ) -> ApiResult<Option<AppSurfaceSession>> {
        if self
            .latest_app_surface_session(thread_id)
            .await?
            .is_some_and(|session| session.status == AppSurfaceSessionStatus::Submitting)
        {
            return Err(ApiError::Conflict(
                "app surface submit is in progress".to_string(),
            ));
        }
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update app_surface_sessions
            set status = ?, archived_at = ?, updated_at = ?
            where thread_id = ?
              and status != ?
              and archived_at is null
            "#,
        )
        .bind(AppSurfaceSessionStatus::Archived.as_str())
        .bind(now)
        .bind(now)
        .bind(thread_id)
        .bind(AppSurfaceSessionStatus::Submitting.as_str())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        self.latest_app_surface_session(thread_id).await
    }

    pub async fn submit_app_surface_session(
        &self,
        session_id: &str,
        revision: i64,
        message: &str,
        metadata: Option<Value>,
    ) -> ApiResult<AppSurfaceSession> {
        let now = Utc::now();
        let metadata_json = metadata.as_ref().map(serde_json::to_string).transpose()?;
        let result = sqlx::query(
            r#"
            update app_surface_sessions
            set status = ?,
                submitted_revision = ?,
                submitted_message = ?,
                submitted_metadata_json = ?,
                submitted_at = ?,
                updated_at = ?
            where id = ?
              and revision = ?
              and status = ?
              and archived_at is null
            "#,
        )
        .bind(AppSurfaceSessionStatus::Submitted.as_str())
        .bind(revision)
        .bind(message)
        .bind(metadata_json)
        .bind(now)
        .bind(now)
        .bind(session_id)
        .bind(revision)
        .bind(AppSurfaceSessionStatus::Active.as_str())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::Conflict(
                "app surface session is not active at the requested revision".to_string(),
            ));
        }
        self.get_app_surface_session(session_id).await
    }

    pub async fn mark_app_surface_session_errored(
        &self,
        session_id: &str,
        revision: i64,
        error_message: &str,
    ) -> ApiResult<AppSurfaceSession> {
        let now = Utc::now();
        let metadata_json = serde_json::to_string(&serde_json::json!({
            "message": error_message
        }))?;
        let result = sqlx::query(
            r#"
            update app_surface_sessions
            set status = ?,
                submitted_metadata_json = ?,
                updated_at = ?
            where id = ?
              and revision = ?
              and status = ?
              and archived_at is null
            "#,
        )
        .bind(AppSurfaceSessionStatus::Errored.as_str())
        .bind(metadata_json)
        .bind(now)
        .bind(session_id)
        .bind(revision)
        .bind(AppSurfaceSessionStatus::Active.as_str())
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::Conflict(
                "app surface session is not active at the requested revision".to_string(),
            ));
        }
        self.get_app_surface_session(session_id).await
    }
}

async fn insert_app_surface_resource(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    session_id: &str,
    revision: i64,
    uri: &str,
    mime_type: &str,
    text: &str,
    now: chrono::DateTime<Utc>,
) -> ApiResult<()> {
    sqlx::query(
        r#"
        insert into app_surface_resources (
            session_id, revision, uri, mime_type, text, created_at
        )
        values (?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(session_id)
    .bind(revision)
    .bind(uri)
    .bind(mime_type)
    .bind(text)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn fetch_app_surface_session_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    id: &str,
    revision: i64,
) -> ApiResult<AppSurfaceSession> {
    let row = app_surface_session_query()
        .push(" where s.id = ")
        .push_bind(id.to_string())
        .push(" and r.revision = ")
        .push_bind(revision)
        .build()
        .fetch_one(&mut **tx)
        .await?;
    row_to_app_surface_session(row)
}

fn app_surface_session_query() -> sqlx::QueryBuilder<'static, sqlx::Sqlite> {
    sqlx::QueryBuilder::new(
        r#"
        select s.id, s.thread_id, s.bridge_token, s.provider, s.title, s.resource_uri,
               s.resource_mime_type, r.text as html, s.fallback_content, s.revision,
               s.status, s.display_modes_json, s.csp_json, s.grants_json,
               s.provenance_json, s.submitted_revision, s.submitted_message,
               s.submitted_metadata_json, s.created_at, s.updated_at,
               s.submitted_at, s.archived_at
        from app_surface_sessions s
        join app_surface_resources r
          on r.session_id = s.id and r.revision = s.revision
        "#,
    )
}

fn row_to_app_surface_session(row: sqlx::sqlite::SqliteRow) -> ApiResult<AppSurfaceSession> {
    let display_modes_json: String = row.try_get("display_modes_json")?;
    let csp_json: String = row.try_get("csp_json")?;
    let grants_json: String = row.try_get("grants_json")?;
    let provenance_json: String = row.try_get("provenance_json")?;
    let submitted_metadata_json: Option<String> = row.try_get("submitted_metadata_json")?;
    Ok(AppSurfaceSession {
        id: row.try_get("id")?,
        thread_id: row.try_get("thread_id")?,
        bridge_token: row.try_get("bridge_token")?,
        provider: AppSurfaceProvider::from_str(&row.try_get::<String, _>("provider")?)?,
        title: row.try_get("title")?,
        resource_uri: row.try_get("resource_uri")?,
        resource_mime_type: row.try_get("resource_mime_type")?,
        html: row.try_get("html")?,
        fallback_content: row.try_get("fallback_content")?,
        revision: row.try_get("revision")?,
        status: AppSurfaceSessionStatus::from_str(&row.try_get::<String, _>("status")?)?,
        display_modes: serde_json::from_str(&display_modes_json)?,
        csp: serde_json::from_str::<AppSurfaceCsp>(&csp_json)?,
        grants: serde_json::from_str::<AppSurfaceGrants>(&grants_json)?,
        provenance: serde_json::from_str::<Value>(&provenance_json)?,
        submitted_revision: row.try_get("submitted_revision")?,
        submitted_message: row.try_get("submitted_message")?,
        submitted_metadata: submitted_metadata_json
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        submitted_at: row.try_get("submitted_at")?,
        archived_at: row.try_get("archived_at")?,
    })
}

fn generated_resource_uri(session_id: &str, revision: i64) -> String {
    format!("ui://kodex-generated/sessions/{session_id}/revisions/{revision}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::store::Store;

    #[tokio::test]
    async fn app_surface_upsert_replaces_latest_thread_revision() {
        let store = Store::in_memory().await.unwrap();
        let first = store
            .upsert_app_surface_session(AppSurfaceSessionUpsert {
                thread_id: "thread-1".to_string(),
                provider: AppSurfaceProvider::Generated,
                title: "Chooser".to_string(),
                resource_uri: None,
                resource_mime_type: "text/html;profile=mcp-app".to_string(),
                html: "<main>One</main>".to_string(),
                fallback_content: "Choose an option".to_string(),
                display_modes: vec!["inline".to_string()],
                csp: AppSurfaceCsp::default(),
                grants: AppSurfaceGrants {
                    can_send_message: true,
                    ..Default::default()
                },
                provenance: json!({"source": "test"}),
            })
            .await
            .unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(first.provider, AppSurfaceProvider::Generated);
        assert_eq!(
            first.resource_uri,
            format!("ui://kodex-generated/sessions/{}/revisions/1", first.id)
        );

        let second = store
            .upsert_app_surface_session(AppSurfaceSessionUpsert {
                thread_id: "thread-1".to_string(),
                provider: AppSurfaceProvider::Generated,
                title: "Chooser v2".to_string(),
                resource_uri: None,
                resource_mime_type: "text/html;profile=mcp-app".to_string(),
                html: "<main>Two</main>".to_string(),
                fallback_content: "Choose again".to_string(),
                display_modes: vec!["fullscreen".to_string()],
                csp: AppSurfaceCsp {
                    connect_domains: vec!["https://example.test".to_string()],
                    resource_domains: Vec::new(),
                },
                grants: AppSurfaceGrants::default(),
                provenance: json!({"source": "test-2"}),
            })
            .await
            .unwrap();

        assert_eq!(second.id, first.id);
        assert_eq!(second.revision, 2);
        assert_eq!(second.html, "<main>Two</main>");
        assert_eq!(second.fallback_content, "Choose again");
        assert_eq!(second.display_modes, vec!["fullscreen"]);
        assert_eq!(second.csp.connect_domains, vec!["https://example.test"]);

        let latest = store
            .latest_app_surface_session("thread-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.id, first.id);
        assert_eq!(latest.revision, 2);
    }

    #[tokio::test]
    async fn app_surface_submit_marks_exact_active_revision() {
        let store = Store::in_memory().await.unwrap();
        let session = store
            .upsert_app_surface_session(AppSurfaceSessionUpsert {
                thread_id: "thread-1".to_string(),
                provider: AppSurfaceProvider::Generated,
                title: "Chooser".to_string(),
                resource_uri: None,
                resource_mime_type: "text/html;profile=mcp-app".to_string(),
                html: "<main>One</main>".to_string(),
                fallback_content: "Choose an option".to_string(),
                display_modes: vec!["inline".to_string()],
                csp: AppSurfaceCsp::default(),
                grants: AppSurfaceGrants {
                    can_send_message: true,
                    ..Default::default()
                },
                provenance: json!({"source": "test"}),
            })
            .await
            .unwrap();

        let submitted = store
            .submit_app_surface_session(
                &session.id,
                session.revision,
                "Pick A",
                Some(json!({"choice": "a"})),
            )
            .await
            .unwrap();

        assert_eq!(submitted.status, AppSurfaceSessionStatus::Submitted);
        assert_eq!(submitted.submitted_revision, Some(session.revision));
        assert_eq!(submitted.submitted_message.as_deref(), Some("Pick A"));
        assert_eq!(submitted.submitted_metadata, Some(json!({"choice": "a"})));

        let stale = store
            .submit_app_surface_session(&session.id, session.revision, "Again", None)
            .await;
        assert!(matches!(stale, Err(ApiError::Conflict(_))));
    }
}
