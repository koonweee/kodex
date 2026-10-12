use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{QueryBuilder, Row};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::{
    bool_to_i64, notification_delivery_select_sql, row_to_notification_delivery,
    row_to_thread_notification_setting, NewNotificationDelivery, NotificationDelivery, Store,
    ThreadNotificationSetting,
};

#[derive(Debug, Clone)]
pub struct FederatedNotificationClaim {
    pub delivery: NotificationDelivery,
    pub claim_id: String,
}

impl Store {
    pub async fn thread_notifications_enabled(&self, thread_id: &str) -> ApiResult<bool> {
        let row = sqlx::query(
            "select notifications_enabled from thread_notification_settings where thread_id = ?",
        )
        .bind(thread_id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row
            .map(|row| {
                row.try_get::<i64, _>("notifications_enabled")
                    .map(|value| value != 0)
            })
            .transpose()?
            .unwrap_or(true))
    }

    pub async fn thread_notification_settings(
        &self,
        thread_ids: &[String],
    ) -> ApiResult<HashMap<String, bool>> {
        if thread_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let mut builder = QueryBuilder::new(
            "select thread_id, notifications_enabled from thread_notification_settings where thread_id in (",
        );
        {
            let mut separated = builder.separated(", ");
            for thread_id in thread_ids {
                separated.push_bind(thread_id);
            }
        }
        builder.push(")");

        let mut settings = thread_ids
            .iter()
            .map(|thread_id| (thread_id.clone(), true))
            .collect::<HashMap<_, _>>();
        for row in builder.build().fetch_all(&self.pool).await? {
            let thread_id: String = row.try_get("thread_id")?;
            let enabled: i64 = row.try_get("notifications_enabled")?;
            settings.insert(thread_id, enabled != 0);
        }

        Ok(settings)
    }

    pub async fn set_thread_notifications_enabled(
        &self,
        thread_id: &str,
        enabled: bool,
    ) -> ApiResult<ThreadNotificationSetting> {
        let updated_at = Utc::now();
        sqlx::query(
            r#"
            insert into thread_notification_settings (
                thread_id, notifications_enabled, updated_at
            )
            values (?, ?, ?)
            on conflict(thread_id) do update set
                notifications_enabled = excluded.notifications_enabled,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(thread_id)
        .bind(bool_to_i64(enabled))
        .bind(updated_at)
        .execute(&self.pool)
        .await?;

        self.get_thread_notification_setting(thread_id).await
    }

    pub async fn get_thread_notification_setting(
        &self,
        thread_id: &str,
    ) -> ApiResult<ThreadNotificationSetting> {
        let row = sqlx::query(
            r#"
            select thread_id, notifications_enabled, updated_at
            from thread_notification_settings
            where thread_id = ?
            "#,
        )
        .bind(thread_id)
        .fetch_optional(&self.pool)
        .await?;

        row.map(row_to_thread_notification_setting)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("thread notification setting {thread_id}")))
    }

    pub async fn create_notification_delivery(
        &self,
        delivery: NewNotificationDelivery,
    ) -> ApiResult<NotificationDelivery> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let payload_json = delivery
            .payload
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        sqlx::query(
            r#"
            insert into notification_deliveries (
                id, kind, thread_id, turn_id, payload_json, delivered_subscription_ids_json,
                status, attempt_count,
                available_at, processing_started_at, sent_at, last_error, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, '[]', 'pending', 0, ?, null, null, null, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(delivery.kind)
        .bind(delivery.thread_id)
        .bind(delivery.turn_id)
        .bind(payload_json)
        .bind(delivery.available_at)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_notification_delivery(&id).await
    }

    pub async fn get_notification_delivery(&self, id: &str) -> ApiResult<NotificationDelivery> {
        let query = notification_delivery_select_sql("where id = ?");
        let row = sqlx::query(&query)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.map(row_to_notification_delivery)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("notification delivery {id}")))
    }

    pub async fn list_notification_deliveries(&self) -> ApiResult<Vec<NotificationDelivery>> {
        let query = notification_delivery_select_sql("order by created_at asc, id asc");
        let rows = sqlx::query(&query).fetch_all(&self.pool).await?;
        rows.into_iter().map(row_to_notification_delivery).collect()
    }

    pub async fn claim_due_notification_deliveries_for_federator(
        &self,
        limit: i64,
        now: DateTime<Utc>,
        stale_processing_before: DateTime<Utc>,
    ) -> ApiResult<Vec<FederatedNotificationClaim>> {
        let rows = sqlx::query(
            r#"
            select id
            from notification_deliveries
            where (status = 'pending' and available_at <= ?)
               or (status = 'processing' and processing_started_at is not null and processing_started_at <= ?)
            order by available_at asc, created_at asc, id asc
            limit ?
            "#,
        )
        .bind(now)
        .bind(stale_processing_before)
        .bind(limit.max(1))
        .fetch_all(&self.pool)
        .await?;
        let mut claims = Vec::new();
        for row in rows {
            let id: String = row.try_get("id")?;
            let claim_id = Uuid::new_v4().to_string();
            let affected = sqlx::query(
                r#"
                update notification_deliveries
                set status = 'processing', attempt_count = attempt_count + 1,
                    processing_started_at = ?, claim_id = ?, last_error = null, updated_at = ?
                where id = ? and (
                    (status = 'pending' and available_at <= ?)
                    or (status = 'processing' and processing_started_at is not null and processing_started_at <= ?)
                )
                "#,
            )
            .bind(now)
            .bind(&claim_id)
            .bind(now)
            .bind(&id)
            .bind(now)
            .bind(stale_processing_before)
            .execute(&self.pool)
            .await?
            .rows_affected();
            if affected > 0 {
                claims.push(FederatedNotificationClaim {
                    delivery: self.get_notification_delivery(&id).await?,
                    claim_id,
                });
            }
        }
        Ok(claims)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn complete_federated_notification_claim(
        &self,
        id: &str,
        claim_id: &str,
        delivered_subscription_ids: &[String],
        temporary_failure_count: usize,
        stale_endpoint_count: usize,
        payload: Option<&Value>,
    ) -> ApiResult<bool> {
        let Some(current) = sqlx::query(&notification_delivery_select_sql(
            "where id = ? and status = 'processing' and claim_id = ?",
        ))
        .bind(id)
        .bind(claim_id)
        .fetch_optional(&self.pool)
        .await?
        .map(row_to_notification_delivery)
        .transpose()?
        else {
            return Ok(false);
        };
        let mut delivered = current.delivered_subscription_ids;
        for subscription_id in delivered_subscription_ids {
            if !delivered.contains(subscription_id) {
                delivered.push(subscription_id.clone());
            }
        }
        let now = Utc::now();
        let delivered_json = serde_json::to_string(&delivered)?;
        let payload_json = payload.map(serde_json::to_string).transpose()?;
        let (status, available_at, sent_at, error) = if temporary_failure_count > 0 {
            if current.attempt_count < 3 {
                (
                    "pending",
                    now + chrono::Duration::seconds((current.attempt_count.max(1) * 2).min(30)),
                    None,
                    Some(format!(
                        "{temporary_failure_count} temporary push delivery failure(s)"
                    )),
                )
            } else {
                (
                    "failed",
                    current.available_at,
                    None,
                    Some(format!(
                        "{temporary_failure_count} temporary push delivery failure(s)"
                    )),
                )
            }
        } else if stale_endpoint_count > 0 && delivered.is_empty() {
            (
                "failed",
                current.available_at,
                None,
                Some(format!("{stale_endpoint_count} stale push endpoint(s)")),
            )
        } else {
            ("sent", current.available_at, Some(now), None)
        };
        let affected = sqlx::query(
            r#"
            update notification_deliveries
            set status = ?, available_at = ?, payload_json = coalesce(?, payload_json),
                delivered_subscription_ids_json = ?, processing_started_at = null, claim_id = null,
                sent_at = ?, last_error = ?, updated_at = ?
            where id = ? and status = 'processing' and claim_id = ?
            "#,
        )
        .bind(status)
        .bind(available_at)
        .bind(payload_json)
        .bind(delivered_json)
        .bind(sent_at)
        .bind(error)
        .bind(now)
        .bind(id)
        .bind(claim_id)
        .execute(&self.pool)
        .await?
        .rows_affected();
        Ok(affected == 1)
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;
    use tempfile::tempdir;

    use crate::store::{NewNotificationDelivery, NotificationDeliveryStatus, Store};

    #[tokio::test]
    async fn thread_notification_settings_default_enabled_and_round_trip() {
        let store = Store::in_memory().await.unwrap();
        assert!(store
            .thread_notifications_enabled("thread-1")
            .await
            .unwrap());

        let disabled = store
            .set_thread_notifications_enabled("thread-1", false)
            .await
            .unwrap();
        assert_eq!(disabled.thread_id, "thread-1");
        assert!(!disabled.notifications_enabled);
        assert!(!store
            .thread_notifications_enabled("thread-1")
            .await
            .unwrap());

        let enabled = store
            .set_thread_notifications_enabled("thread-1", true)
            .await
            .unwrap();
        assert!(enabled.notifications_enabled);
        assert!(store
            .thread_notifications_enabled("thread-1")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn federator_claims_are_reissued_with_new_tokens_and_reject_late_outcomes() {
        let store = Store::in_memory().await.unwrap();
        let delivery = store
            .create_notification_delivery(NewNotificationDelivery {
                kind: "unreadAgentMessage".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                payload: Some(json!({"title": "Ready"})),
                available_at: Utc::now(),
            })
            .await
            .unwrap();
        let now = Utc::now();
        let first = store
            .claim_due_notification_deliveries_for_federator(10, now, now)
            .await
            .unwrap();
        assert_eq!(first.len(), 1);

        let second = store
            .claim_due_notification_deliveries_for_federator(10, now, now)
            .await
            .unwrap();
        assert_eq!(second.len(), 1);
        assert_ne!(first[0].claim_id, second[0].claim_id);
        assert!(!store
            .complete_federated_notification_claim(
                &delivery.id,
                &first[0].claim_id,
                &[],
                0,
                0,
                None,
            )
            .await
            .unwrap());
        assert!(store
            .complete_federated_notification_claim(
                &delivery.id,
                &second[0].claim_id,
                &["browser-a".to_string()],
                0,
                0,
                None,
            )
            .await
            .unwrap());
        let saved = store.get_notification_delivery(&delivery.id).await.unwrap();
        assert_eq!(saved.status, NotificationDeliveryStatus::Sent);
        assert_eq!(saved.delivered_subscription_ids, vec!["browser-a"]);
    }

    #[tokio::test]
    async fn thread_notification_settings_batch_defaults_missing_rows_enabled() {
        let store = Store::in_memory().await.unwrap();
        store
            .set_thread_notifications_enabled("thread-1", false)
            .await
            .unwrap();
        store
            .set_thread_notifications_enabled("thread-2", true)
            .await
            .unwrap();

        let settings = store
            .thread_notification_settings(&[
                "thread-1".to_string(),
                "thread-2".to_string(),
                "thread-3".to_string(),
            ])
            .await
            .unwrap();

        assert_eq!(settings.get("thread-1"), Some(&false));
        assert_eq!(settings.get("thread-2"), Some(&true));
        assert_eq!(settings.get("thread-3"), Some(&true));
    }

    #[tokio::test]
    async fn pending_notification_delivery_survives_store_reopen() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("gateway.db");
        let store = Store::connect(&path).await.unwrap();
        let created = store
            .create_notification_delivery(NewNotificationDelivery {
                kind: "unreadAgentMessage".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                payload: None,
                available_at: Utc::now() + chrono::Duration::minutes(5),
            })
            .await
            .unwrap();
        drop(store);

        let reopened = Store::connect(&path).await.unwrap();
        let deliveries = reopened.list_notification_deliveries().await.unwrap();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].id, created.id);
        assert_eq!(deliveries[0].status, NotificationDeliveryStatus::Pending);
        assert_eq!(deliveries[0].thread_id.as_deref(), Some("thread-1"));
        assert_eq!(deliveries[0].turn_id.as_deref(), Some("turn-1"));
    }
}
