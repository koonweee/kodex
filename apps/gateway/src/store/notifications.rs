use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{QueryBuilder, Row};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::{
    apns_device_select_sql, bool_to_i64, notification_delivery_select_sql, row_to_apns_device,
    row_to_notification_delivery, row_to_push_subscription, row_to_thread_notification_setting,
    ApnsDevice, NewApnsDevice, NewNotificationDelivery, NewPushSubscription, NotificationDelivery,
    PushSubscription, PushSubscriptionStatus, Store, ThreadNotificationSetting,
};

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

    pub async fn upsert_push_subscription(
        &self,
        subscription: NewPushSubscription,
    ) -> ApiResult<PushSubscription> {
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            insert into push_subscriptions (
                id, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, 1, ?, ?)
            on conflict(endpoint) do update set
                p256dh = excluded.p256dh,
                auth = excluded.auth,
                user_agent = excluded.user_agent,
                enabled = 1,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(id)
        .bind(&subscription.endpoint)
        .bind(&subscription.p256dh)
        .bind(&subscription.auth)
        .bind(&subscription.user_agent)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;

        self.get_push_subscription_by_endpoint(&subscription.endpoint)
            .await
    }

    pub async fn get_push_subscription_by_endpoint(
        &self,
        endpoint: &str,
    ) -> ApiResult<PushSubscription> {
        let row = sqlx::query(
            r#"
            select id, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at
            from push_subscriptions
            where endpoint = ?
            "#,
        )
        .bind(endpoint)
        .fetch_optional(&self.pool)
        .await?;

        row.map(row_to_push_subscription)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("push subscription endpoint {endpoint}")))
    }

    pub async fn get_push_subscription_status_by_endpoint(
        &self,
        endpoint: &str,
    ) -> ApiResult<PushSubscriptionStatus> {
        let row = sqlx::query(
            r#"
            select id, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at
            from push_subscriptions
            where endpoint = ?
            "#,
        )
        .bind(endpoint)
        .fetch_optional(&self.pool)
        .await?;
        let subscription = row.map(row_to_push_subscription).transpose()?;
        let subscribed = subscription
            .as_ref()
            .is_some_and(|subscription| subscription.enabled);
        Ok(PushSubscriptionStatus {
            subscription,
            subscribed,
        })
    }

    pub async fn list_enabled_push_subscriptions(&self) -> ApiResult<Vec<PushSubscription>> {
        let rows = sqlx::query(
            r#"
            select id, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at
            from push_subscriptions
            where enabled = 1
            order by created_at, id
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_push_subscription).collect()
    }

    pub async fn disable_push_subscription(&self, id: &str) -> ApiResult<Option<PushSubscription>> {
        let now = Utc::now();
        sqlx::query(
            r#"
            update push_subscriptions
            set enabled = 0, updated_at = ?
            where id = ?
            "#,
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;

        let row = sqlx::query(
            r#"
            select id, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at
            from push_subscriptions
            where id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_push_subscription).transpose()
    }

    pub async fn disable_push_subscription_by_endpoint(
        &self,
        endpoint: &str,
    ) -> ApiResult<Option<PushSubscription>> {
        let now = Utc::now();
        sqlx::query(
            r#"
            update push_subscriptions
            set enabled = 0, updated_at = ?
            where endpoint = ?
            "#,
        )
        .bind(now)
        .bind(endpoint)
        .execute(&self.pool)
        .await?;

        let row = sqlx::query(
            r#"
            select id, endpoint, p256dh, auth, user_agent, enabled, created_at, updated_at
            from push_subscriptions
            where endpoint = ?
            "#,
        )
        .bind(endpoint)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_push_subscription).transpose()
    }

    pub async fn upsert_apns_device(&self, device: NewApnsDevice) -> ApiResult<ApnsDevice> {
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            insert into apns_devices (
                id, device_token, bundle_id, environment, device_name, enabled, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, 1, ?, ?)
            on conflict(device_token, bundle_id, environment) do update set
                device_name = excluded.device_name,
                enabled = 1,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(id)
        .bind(&device.device_token)
        .bind(&device.bundle_id)
        .bind(&device.environment)
        .bind(&device.device_name)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;

        self.get_apns_device_by_token_bundle_environment(
            &device.device_token,
            &device.bundle_id,
            &device.environment,
        )
        .await
    }

    pub async fn get_apns_device_by_token_bundle_environment(
        &self,
        device_token: &str,
        bundle_id: &str,
        environment: &str,
    ) -> ApiResult<ApnsDevice> {
        let query =
            apns_device_select_sql("where device_token = ? and bundle_id = ? and environment = ?");
        let row = sqlx::query(&query)
            .bind(device_token)
            .bind(bundle_id)
            .bind(environment)
            .fetch_optional(&self.pool)
            .await?;

        row.map(row_to_apns_device)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound("APNs device".to_string()))
    }

    pub async fn list_enabled_apns_devices(&self) -> ApiResult<Vec<ApnsDevice>> {
        let query = apns_device_select_sql("where enabled = 1 order by updated_at desc, id");
        let rows = sqlx::query(&query).fetch_all(&self.pool).await?;
        rows.into_iter().map(row_to_apns_device).collect()
    }

    pub async fn disable_apns_device(&self, id: &str) -> ApiResult<Option<ApnsDevice>> {
        let now = Utc::now();
        sqlx::query(
            r#"
            update apns_devices
            set enabled = 0, updated_at = ?
            where id = ?
            "#,
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;

        let query = apns_device_select_sql("where id = ?");
        let row = sqlx::query(&query)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.map(row_to_apns_device).transpose()
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

    pub async fn claim_due_notification_deliveries(
        &self,
        limit: i64,
        now: DateTime<Utc>,
        stale_processing_before: DateTime<Utc>,
    ) -> ApiResult<Vec<NotificationDelivery>> {
        let rows = sqlx::query(
            r#"
            select id
            from notification_deliveries
            where (
                status = 'pending' and available_at <= ?
            ) or (
                status = 'processing'
                and processing_started_at is not null
                and processing_started_at <= ?
            )
            order by available_at asc, created_at asc, id asc
            limit ?
            "#,
        )
        .bind(now)
        .bind(stale_processing_before)
        .bind(limit.max(1))
        .fetch_all(&self.pool)
        .await?;

        let mut claimed = Vec::new();
        for row in rows {
            let id: String = row.try_get("id")?;
            let affected = sqlx::query(
                r#"
                update notification_deliveries
                set status = 'processing',
                    attempt_count = attempt_count + 1,
                    processing_started_at = ?,
                    last_error = null,
                    updated_at = ?
                where id = ?
                  and (
                    (status = 'pending' and available_at <= ?)
                    or (
                        status = 'processing'
                        and processing_started_at is not null
                        and processing_started_at <= ?
                    )
                  )
                "#,
            )
            .bind(now)
            .bind(now)
            .bind(&id)
            .bind(now)
            .bind(stale_processing_before)
            .execute(&self.pool)
            .await?
            .rows_affected();
            if affected > 0 {
                claimed.push(self.get_notification_delivery(&id).await?);
            }
        }
        Ok(claimed)
    }

    pub async fn mark_notification_delivery_sent(
        &self,
        id: &str,
        payload: Option<&Value>,
        delivered_subscription_ids: &[String],
    ) -> ApiResult<NotificationDelivery> {
        let now = Utc::now();
        let payload_json = payload.map(serde_json::to_string).transpose()?;
        let delivered_subscription_ids_json = serde_json::to_string(delivered_subscription_ids)?;
        sqlx::query(
            r#"
            update notification_deliveries
            set status = 'sent',
                payload_json = coalesce(?, payload_json),
                delivered_subscription_ids_json = ?,
                processing_started_at = null,
                sent_at = ?,
                last_error = null,
                updated_at = ?
            where id = ?
            "#,
        )
        .bind(payload_json)
        .bind(delivered_subscription_ids_json)
        .bind(now)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.get_notification_delivery(id).await
    }

    pub async fn mark_notification_delivery_retry(
        &self,
        id: &str,
        available_at: DateTime<Utc>,
        error: String,
        delivered_subscription_ids: &[String],
    ) -> ApiResult<NotificationDelivery> {
        let now = Utc::now();
        let delivered_subscription_ids_json = serde_json::to_string(delivered_subscription_ids)?;
        sqlx::query(
            r#"
            update notification_deliveries
            set status = 'pending',
                available_at = ?,
                delivered_subscription_ids_json = ?,
                processing_started_at = null,
                last_error = ?,
                updated_at = ?
            where id = ?
            "#,
        )
        .bind(available_at)
        .bind(delivered_subscription_ids_json)
        .bind(error)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.get_notification_delivery(id).await
    }

    pub async fn mark_notification_delivery_failed(
        &self,
        id: &str,
        error: String,
        payload: Option<&Value>,
        delivered_subscription_ids: &[String],
    ) -> ApiResult<NotificationDelivery> {
        let now = Utc::now();
        let payload_json = payload.map(serde_json::to_string).transpose()?;
        let delivered_subscription_ids_json = serde_json::to_string(delivered_subscription_ids)?;
        sqlx::query(
            r#"
            update notification_deliveries
            set status = 'failed',
                payload_json = coalesce(?, payload_json),
                delivered_subscription_ids_json = ?,
                processing_started_at = null,
                last_error = ?,
                updated_at = ?
            where id = ?
            "#,
        )
        .bind(payload_json)
        .bind(delivered_subscription_ids_json)
        .bind(error)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        self.get_notification_delivery(id).await
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use serde_json::json;
    use tempfile::tempdir;

    use crate::store::{
        NewApnsDevice, NewNotificationDelivery, NewPushSubscription, NotificationDeliveryStatus,
        Store,
    };

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
    async fn push_subscription_upsert_is_idempotent_by_endpoint() {
        let store = Store::in_memory().await.unwrap();
        let first = store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/sub-1".to_string(),
                p256dh: "public-1".to_string(),
                auth: "auth-1".to_string(),
                user_agent: Some("first browser".to_string()),
            })
            .await
            .unwrap();
        let second = store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/sub-1".to_string(),
                p256dh: "public-2".to_string(),
                auth: "auth-2".to_string(),
                user_agent: Some("second browser".to_string()),
            })
            .await
            .unwrap();

        assert_eq!(second.id, first.id);
        assert_eq!(second.p256dh, "public-2");
        assert_eq!(second.auth, "auth-2");
        assert_eq!(second.user_agent.as_deref(), Some("second browser"));
        assert!(second.enabled);
        let enabled = store.list_enabled_push_subscriptions().await.unwrap();
        assert_eq!(enabled.len(), 1);
    }

    #[tokio::test]
    async fn disabled_push_subscription_is_removed_from_enabled_lookup() {
        let store = Store::in_memory().await.unwrap();
        let subscription = store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/stale".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();

        let disabled = store
            .disable_push_subscription(&subscription.id)
            .await
            .unwrap()
            .unwrap();

        assert!(!disabled.enabled);
        assert!(store
            .list_enabled_push_subscriptions()
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn push_subscription_status_tracks_missing_disabled_and_reenabled_endpoint() {
        let store = Store::in_memory().await.unwrap();

        let missing = store
            .get_push_subscription_status_by_endpoint("https://push.example/current")
            .await
            .unwrap();
        assert!(missing.subscription.is_none());
        assert!(!missing.subscribed);

        let subscription = store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/current".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();
        let enabled = store
            .get_push_subscription_status_by_endpoint("https://push.example/current")
            .await
            .unwrap();
        assert_eq!(
            enabled
                .subscription
                .as_ref()
                .map(|subscription| &subscription.id),
            Some(&subscription.id)
        );
        assert!(enabled.subscribed);

        let disabled = store
            .disable_push_subscription_by_endpoint("https://push.example/current")
            .await
            .unwrap()
            .unwrap();
        assert!(!disabled.enabled);
        let status = store
            .get_push_subscription_status_by_endpoint("https://push.example/current")
            .await
            .unwrap();
        assert!(status.subscription.is_some());
        assert!(!status.subscribed);

        let reenabled = store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/current".to_string(),
                p256dh: "public-2".to_string(),
                auth: "auth-2".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();
        assert_eq!(reenabled.id, subscription.id);
        assert!(reenabled.enabled);
        assert!(
            store
                .get_push_subscription_status_by_endpoint("https://push.example/current")
                .await
                .unwrap()
                .subscribed
        );
    }

    #[tokio::test]
    async fn apns_device_upsert_is_idempotent_by_token_bundle_and_environment() {
        let store = Store::in_memory().await.unwrap();
        let first = store
            .upsert_apns_device(NewApnsDevice {
                device_token: "token-1".to_string(),
                bundle_id: "com.example.Kodex".to_string(),
                environment: "sandbox".to_string(),
                device_name: Some("First iPhone".to_string()),
            })
            .await
            .unwrap();
        let second = store
            .upsert_apns_device(NewApnsDevice {
                device_token: "token-1".to_string(),
                bundle_id: "com.example.Kodex".to_string(),
                environment: "sandbox".to_string(),
                device_name: Some("Renamed iPhone".to_string()),
            })
            .await
            .unwrap();

        assert_eq!(second.id, first.id);
        assert_eq!(second.device_token, "token-1");
        assert_eq!(second.bundle_id, "com.example.Kodex");
        assert_eq!(second.environment, "sandbox");
        assert_eq!(second.device_name.as_deref(), Some("Renamed iPhone"));
        assert!(second.enabled);
        assert_eq!(store.list_enabled_apns_devices().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn disabled_apns_device_is_removed_from_enabled_lookup_and_can_reenable() {
        let store = Store::in_memory().await.unwrap();
        let device = store
            .upsert_apns_device(NewApnsDevice {
                device_token: "token-2".to_string(),
                bundle_id: "com.example.Kodex".to_string(),
                environment: "production".to_string(),
                device_name: None,
            })
            .await
            .unwrap();

        let disabled = store
            .disable_apns_device(&device.id)
            .await
            .unwrap()
            .unwrap();
        assert!(!disabled.enabled);
        assert!(store.list_enabled_apns_devices().await.unwrap().is_empty());

        let reenabled = store
            .upsert_apns_device(NewApnsDevice {
                device_token: "token-2".to_string(),
                bundle_id: "com.example.Kodex".to_string(),
                environment: "production".to_string(),
                device_name: Some("Work phone".to_string()),
            })
            .await
            .unwrap();
        assert_eq!(reenabled.id, device.id);
        assert!(reenabled.enabled);
        assert_eq!(store.list_enabled_apns_devices().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn notification_delivery_jobs_create_claim_retry_recover_and_finish() {
        let store = Store::in_memory().await.unwrap();
        let now = Utc::now();
        let created = store
            .create_notification_delivery(NewNotificationDelivery {
                kind: "test".to_string(),
                thread_id: None,
                turn_id: None,
                payload: Some(json!({"kind": "test"})),
                available_at: now,
            })
            .await
            .unwrap();
        assert_eq!(created.status, NotificationDeliveryStatus::Pending);
        assert_eq!(created.attempt_count, 0);

        let claimed = store
            .claim_due_notification_deliveries(10, now, now - chrono::Duration::minutes(5))
            .await
            .unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].id, created.id);
        assert_eq!(claimed[0].status, NotificationDeliveryStatus::Processing);
        assert_eq!(claimed[0].attempt_count, 1);

        let unavailable_until = now + chrono::Duration::seconds(30);
        let retry = store
            .mark_notification_delivery_retry(
                &created.id,
                unavailable_until,
                "temporary push failure".to_string(),
                &["subscription-1".to_string()],
            )
            .await
            .unwrap();
        assert_eq!(retry.status, NotificationDeliveryStatus::Pending);
        assert_eq!(retry.available_at, unavailable_until);
        assert_eq!(retry.last_error.as_deref(), Some("temporary push failure"));
        assert_eq!(
            retry.delivered_subscription_ids,
            vec!["subscription-1".to_string()]
        );

        assert!(store
            .claim_due_notification_deliveries(10, now, now - chrono::Duration::minutes(5))
            .await
            .unwrap()
            .is_empty());
        let reclaimed = store
            .claim_due_notification_deliveries(
                10,
                unavailable_until,
                now - chrono::Duration::minutes(5),
            )
            .await
            .unwrap();
        assert_eq!(reclaimed.len(), 1);
        assert_eq!(reclaimed[0].attempt_count, 2);

        let stale_recovered = store
            .claim_due_notification_deliveries(
                10,
                unavailable_until + chrono::Duration::minutes(10),
                unavailable_until + chrono::Duration::minutes(1),
            )
            .await
            .unwrap();
        assert_eq!(stale_recovered.len(), 1);
        assert_eq!(stale_recovered[0].attempt_count, 3);

        let sent = store
            .mark_notification_delivery_sent(&created.id, None, &["subscription-1".to_string()])
            .await
            .unwrap();
        assert_eq!(sent.status, NotificationDeliveryStatus::Sent);
        assert!(sent.sent_at.is_some());
        assert_eq!(
            sent.delivered_subscription_ids,
            vec!["subscription-1".to_string()]
        );
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
