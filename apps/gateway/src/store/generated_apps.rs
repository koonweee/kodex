//! Immutable generated artifacts, separate from the external provider's latest pane.
use super::{
    AppSurfaceSession, AppSurfaceSessionStatus, AppSurfaceSessionUpsert, GeneratedAppAttachment,
    GeneratedAppOrigin, GeneratedAppReference, Store,
};
use crate::error::ApiResult;
use chrono::Utc;
use sqlx::Row;
use uuid::Uuid;

impl Store {
    pub async fn create_generated_app(
        &self,
        upsert: AppSurfaceSessionUpsert,
        turn_id: &str,
        item_id: &str,
    ) -> ApiResult<AppSurfaceSession> {
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        let session = AppSurfaceSession {
            resource_uri: format!("ui://kodex-generated/cards/{id}"),
            id,
            thread_id: upsert.thread_id,
            bridge_token: Uuid::new_v4().to_string(),
            provider: super::AppSurfaceProvider::Generated,
            title: upsert.title,
            resource_mime_type: upsert.resource_mime_type,
            html: upsert.html,
            fallback_content: upsert.fallback_content,
            revision: 1,
            status: AppSurfaceSessionStatus::Active,
            display_modes: vec!["inline".into()],
            csp: upsert.csp,
            permissions: upsert.permissions,
            grants: upsert.grants,
            provenance: upsert.provenance,
            created_at: now,
            updated_at: now,
            archived_at: None,
        };
        sqlx::query("insert into generated_app_surfaces (id,thread_id,turn_id,item_id,title,fallback_content,session_json) values (?,?,?,?,?,?,?)")
            .bind(&session.id).bind(&session.thread_id).bind(turn_id).bind(item_id)
            .bind(&session.title).bind(&session.fallback_content).bind(serde_json::to_string(&session)?)
            .execute(&self.pool).await?;
        Ok(session)
    }

    pub async fn generated_apps(&self, thread_id: &str) -> ApiResult<Vec<GeneratedAppAttachment>> {
        let rows = sqlx::query("select id,title,fallback_content,turn_id,item_id from generated_app_surfaces where thread_id = ? order by sequence")
            .bind(thread_id).fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|row| {
                Ok(GeneratedAppAttachment {
                    card: GeneratedAppReference {
                        id: row.try_get("id")?,
                        title: row.try_get("title")?,
                        fallback_content: row.try_get("fallback_content")?,
                    },
                    turn_id: row.try_get("turn_id")?,
                    item_id: row.try_get("item_id")?,
                })
            })
            .collect()
    }

    pub async fn generated_app_session(&self, id: &str) -> ApiResult<Option<AppSurfaceSession>> {
        let json: Option<String> =
            sqlx::query_scalar("select session_json from generated_app_surfaces where id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
        json.map(|json| serde_json::from_str(&json).map_err(Into::into))
            .transpose()
    }

    pub async fn generated_app_origin(&self, id: &str) -> ApiResult<Option<GeneratedAppOrigin>> {
        let row = sqlx::query(
            "select thread_id,turn_id,item_id from generated_app_surfaces where id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            Ok(GeneratedAppOrigin {
                thread_id: row.try_get("thread_id")?,
                turn_id: row.try_get("turn_id")?,
                item_id: row.try_get("item_id")?,
            })
        })
        .transpose()
    }
}
