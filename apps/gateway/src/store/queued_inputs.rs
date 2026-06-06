use chrono::Utc;
use sqlx::{QueryBuilder, Sqlite};
use uuid::Uuid;

use crate::{
    app_server_api::{TimelineFileAttachment, TurnStartOptions, UserInput},
    error::{ApiError, ApiResult},
};

use super::{row_to_queued_input, QueuedInput, QueuedInputPriority, QueuedInputStatus, Store};

impl Store {
    pub async fn create_queued_input(
        &self,
        thread_id: &str,
        input: Vec<UserInput>,
        options: TurnStartOptions,
    ) -> ApiResult<QueuedInput> {
        self.create_queued_input_with_attachments(thread_id, input, Vec::new(), options)
            .await
    }

    pub async fn create_queued_input_with_attachments(
        &self,
        thread_id: &str,
        input: Vec<UserInput>,
        attachments: Vec<TimelineFileAttachment>,
        options: TurnStartOptions,
    ) -> ApiResult<QueuedInput> {
        self.create_queued_input_with_source_and_attachments(
            thread_id,
            input,
            attachments,
            options,
            None,
            None,
        )
        .await
    }

    pub async fn create_queued_input_with_source(
        &self,
        thread_id: &str,
        input: Vec<UserInput>,
        options: TurnStartOptions,
        source_type: Option<&str>,
        source_id: Option<&str>,
    ) -> ApiResult<QueuedInput> {
        self.create_queued_input_with_source_and_attachments(
            thread_id,
            input,
            Vec::new(),
            options,
            source_type,
            source_id,
        )
        .await
    }

    pub async fn create_queued_input_with_source_and_attachments(
        &self,
        thread_id: &str,
        input: Vec<UserInput>,
        attachments: Vec<TimelineFileAttachment>,
        options: TurnStartOptions,
        source_type: Option<&str>,
        source_id: Option<&str>,
    ) -> ApiResult<QueuedInput> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let input_json = serde_json::to_string(&input)?;
        let attachments_json = serde_json::to_string(&attachments)?;
        let options_json = serde_json::to_string(&options)?;
        sqlx::query(
            r#"
            insert into queued_turn_inputs (
                id, thread_id, input_json, attachments_json, options_json, status, priority,
                attempt_count, source_type, source_id, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, 'queued', 'normal', 0, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(thread_id)
        .bind(input_json)
        .bind(attachments_json)
        .bind(options_json)
        .bind(source_type)
        .bind(source_id)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_queued_input(thread_id, &id).await
    }

    pub async fn list_queued_inputs(&self, thread_id: &str) -> ApiResult<Vec<QueuedInput>> {
        let rows = sqlx::query(
            r#"
            select id, thread_id, input_json, attachments_json, options_json, source_type, source_id, status, priority,
                   attempt_count, last_error, accepted_turn_id, accepted_at,
                   accepted_event_seq, created_at, updated_at
            from queued_turn_inputs
            where thread_id = ? and deleted_at is null
            order by case priority when 'rejectedSteer' then 0 else 1 end, created_at asc
            "#,
        )
        .bind(thread_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_queued_input).collect()
    }

    pub async fn queued_thread_ids(&self) -> ApiResult<Vec<String>> {
        let thread_ids = sqlx::query_scalar::<_, String>(
            r#"
            select distinct thread_id from queued_turn_inputs
            where deleted_at is null and status = 'queued'
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(thread_ids)
    }

    pub async fn get_queued_input(&self, thread_id: &str, id: &str) -> ApiResult<QueuedInput> {
        let row = sqlx::query(
            r#"
            select id, thread_id, input_json, attachments_json, options_json, source_type, source_id, status, priority,
                   attempt_count, last_error, accepted_turn_id, accepted_at,
                   accepted_event_seq, created_at, updated_at
            from queued_turn_inputs
            where thread_id = ? and id = ? and deleted_at is null
            "#,
        )
        .bind(thread_id)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_queued_input)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("queued input {id}")))
    }

    pub async fn find_queued_input_by_source(
        &self,
        source_type: &str,
        source_id: &str,
    ) -> ApiResult<Option<QueuedInput>> {
        let row = sqlx::query(
            r#"
            select id, thread_id, input_json, attachments_json, options_json, source_type, source_id, status, priority,
                   attempt_count, last_error, accepted_turn_id, accepted_at,
                   accepted_event_seq, created_at, updated_at
            from queued_turn_inputs
            where source_type = ?
              and source_id = ?
            order by created_at asc
            limit 1
            "#,
        )
        .bind(source_type)
        .bind(source_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_queued_input).transpose()
    }

    pub async fn claim_next_queued_input(&self, thread_id: &str) -> ApiResult<Option<QueuedInput>> {
        let now = Utc::now();
        let Some(id) = sqlx::query_scalar::<_, String>(
            r#"
            select id from queued_turn_inputs
            where thread_id = ? and deleted_at is null and status = 'queued'
            order by case priority when 'rejectedSteer' then 0 else 1 end, created_at asc
            limit 1
            "#,
        )
        .bind(thread_id)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        let result = sqlx::query(
            r#"
            update queued_turn_inputs
            set status = 'submitting', attempt_count = attempt_count + 1,
                last_error = null, updated_at = ?
            where thread_id = ? and id = ? and status = 'queued' and deleted_at is null
            "#,
        )
        .bind(now)
        .bind(thread_id)
        .bind(&id)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            return Ok(None);
        }

        self.get_queued_input(thread_id, &id).await.map(Some)
    }

    pub async fn claim_queued_input_for_steering(
        &self,
        thread_id: &str,
        id: &str,
    ) -> ApiResult<QueuedInput> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update queued_turn_inputs
            set status = 'steering',
                attempt_count = attempt_count + 1,
                last_error = null,
                accepted_turn_id = null,
                accepted_at = null,
                accepted_event_seq = null,
                pending_skill_mentions_id = null,
                updated_at = ?
            where thread_id = ? and id = ? and status = 'queued' and deleted_at is null
            "#,
        )
        .bind(now)
        .bind(thread_id)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            self.require_existing_queued_input(thread_id, id).await?;
            return Err(ApiError::BadRequest(format!(
                "queued input {id} is not ready to steer"
            )));
        }
        self.get_queued_input(thread_id, id).await
    }

    pub async fn mark_queued_input_pending_commit(
        &self,
        thread_id: &str,
        id: &str,
        accepted_turn_id: &str,
        accepted_event_seq: Option<i64>,
        pending_skill_mentions_id: Option<&str>,
    ) -> ApiResult<QueuedInput> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update queued_turn_inputs
            set status = 'pendingCommit',
                priority = 'normal',
                last_error = null,
                accepted_turn_id = ?,
                accepted_at = ?,
                accepted_event_seq = ?,
                pending_skill_mentions_id = ?,
                updated_at = ?
            where thread_id = ? and id = ? and status = 'steering' and deleted_at is null
            "#,
        )
        .bind(accepted_turn_id)
        .bind(now)
        .bind(accepted_event_seq)
        .bind(pending_skill_mentions_id)
        .bind(now)
        .bind(thread_id)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            self.require_existing_queued_input(thread_id, id).await?;
            return Err(ApiError::BadRequest(format!(
                "queued input {id} is not waiting for steer acceptance"
            )));
        }
        self.get_queued_input(thread_id, id).await
    }

    pub async fn mark_queued_input_failed(
        &self,
        thread_id: &str,
        id: &str,
        error: String,
    ) -> ApiResult<QueuedInput> {
        self.transition_queued_input(
            thread_id,
            id,
            QueuedInputStatus::Failed,
            Some(QueuedInputPriority::Normal),
            Some(error),
        )
        .await
    }

    pub async fn mark_queued_input_rejected_steer(
        &self,
        thread_id: &str,
        id: &str,
        error: String,
    ) -> ApiResult<QueuedInput> {
        self.transition_queued_input(
            thread_id,
            id,
            QueuedInputStatus::Queued,
            Some(QueuedInputPriority::RejectedSteer),
            Some(error),
        )
        .await
    }

    pub async fn requeue_queued_input(&self, thread_id: &str, id: &str) -> ApiResult<QueuedInput> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update queued_turn_inputs
            set status = 'queued',
                priority = 'normal',
                last_error = null,
                accepted_turn_id = null,
                accepted_at = null,
                accepted_event_seq = null,
                pending_skill_mentions_id = null,
                updated_at = ?
            where thread_id = ? and id = ? and status = 'failed' and deleted_at is null
            "#,
        )
        .bind(now)
        .bind(thread_id)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            self.require_existing_queued_input(thread_id, id).await?;
            return Err(ApiError::BadRequest(format!(
                "queued input {id} is not failed"
            )));
        }
        self.get_queued_input(thread_id, id).await
    }

    pub async fn oldest_pending_commit_input(
        &self,
        thread_id: &str,
        accepted_turn_id: &str,
    ) -> ApiResult<Option<QueuedInput>> {
        let row = sqlx::query(
            r#"
            select id, thread_id, input_json, attachments_json, options_json, source_type, source_id, status, priority,
                   attempt_count, last_error, accepted_turn_id, accepted_at,
                   accepted_event_seq, created_at, updated_at
            from queued_turn_inputs
            where thread_id = ?
              and accepted_turn_id = ?
              and deleted_at is null
              and status = 'pendingCommit'
            order by updated_at asc, created_at asc
            limit 1
            "#,
        )
        .bind(thread_id)
        .bind(accepted_turn_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_queued_input).transpose()
    }

    pub async fn requeue_pending_commit_inputs_for_turn(
        &self,
        thread_id: &str,
        accepted_turn_id: &str,
        error: &str,
    ) -> ApiResult<Vec<QueuedInput>> {
        self.requeue_pending_commit_inputs(
            "thread_id = ? and accepted_turn_id = ?",
            &[thread_id, accepted_turn_id],
            error,
        )
        .await
    }

    pub async fn requeue_pending_commit_inputs_for_thread(
        &self,
        thread_id: &str,
        error: &str,
    ) -> ApiResult<Vec<QueuedInput>> {
        self.requeue_pending_commit_inputs("thread_id = ?", &[thread_id], error)
            .await
    }

    async fn requeue_pending_commit_inputs(
        &self,
        predicate: &str,
        binds: &[&str],
        error: &str,
    ) -> ApiResult<Vec<QueuedInput>> {
        let select = format!(
            r#"
            select id, thread_id, input_json, attachments_json, options_json, source_type, source_id, status, priority,
                   attempt_count, last_error, accepted_turn_id, accepted_at,
                   accepted_event_seq, created_at, updated_at
            from queued_turn_inputs
            where deleted_at is null and status = 'pendingCommit' and {predicate}
            order by updated_at asc, created_at asc
            "#
        );
        let mut query = sqlx::query(&select);
        for bind in binds {
            query = query.bind(*bind);
        }
        let pending = query
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(row_to_queued_input)
            .collect::<ApiResult<Vec<_>>>()?;
        if pending.is_empty() {
            return Ok(Vec::new());
        }
        self.delete_pending_timeline_skill_mentions_for_queued_rows(&pending)
            .await?;

        let now = Utc::now();
        let update = format!(
            r#"
            update queued_turn_inputs
            set status = 'queued',
                priority = 'rejectedSteer',
                last_error = ?,
                accepted_turn_id = null,
                accepted_at = null,
                accepted_event_seq = null,
                pending_skill_mentions_id = null,
                updated_at = ?
            where deleted_at is null and status = 'pendingCommit' and {predicate}
            "#
        );
        let mut query = sqlx::query(&update).bind(error).bind(now);
        for bind in binds {
            query = query.bind(*bind);
        }
        query.execute(&self.pool).await?;

        let mut requeued = Vec::with_capacity(pending.len());
        for row in pending {
            requeued.push(self.get_queued_input(&row.thread_id, &row.id).await?);
        }
        Ok(requeued)
    }

    pub(super) async fn delete_pending_timeline_skill_mentions_for_queued_rows(
        &self,
        queued_inputs: &[QueuedInput],
    ) -> ApiResult<()> {
        if queued_inputs.is_empty() {
            return Ok(());
        }
        let mut builder = QueryBuilder::<Sqlite>::new(
            "select pending_skill_mentions_id from queued_turn_inputs where pending_skill_mentions_id is not null and id in (",
        );
        let mut separated = builder.separated(", ");
        for queued_input in queued_inputs {
            separated.push_bind(&queued_input.id);
        }
        separated.push_unseparated(")");
        let pending_ids = builder
            .build_query_scalar::<String>()
            .fetch_all(&self.pool)
            .await?;
        for pending_id in pending_ids {
            self.delete_pending_timeline_skill_mentions(&pending_id)
                .await?;
        }
        Ok(())
    }

    async fn transition_queued_input(
        &self,
        thread_id: &str,
        id: &str,
        status: QueuedInputStatus,
        priority: Option<QueuedInputPriority>,
        error: Option<String>,
    ) -> ApiResult<QueuedInput> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update queued_turn_inputs
            set status = ?,
                priority = coalesce(?, priority),
                last_error = ?,
                accepted_turn_id = null,
                accepted_at = null,
                accepted_event_seq = null,
                pending_skill_mentions_id = null,
                updated_at = ?
            where thread_id = ? and id = ? and deleted_at is null
            "#,
        )
        .bind(status.as_str())
        .bind(priority.map(QueuedInputPriority::as_str))
        .bind(error)
        .bind(now)
        .bind(thread_id)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::NotFound(format!("queued input {id}")));
        }
        self.get_queued_input(thread_id, id).await
    }

    pub async fn delete_queued_input(&self, thread_id: &str, id: &str) -> ApiResult<()> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update queued_turn_inputs
            set deleted_at = ?, updated_at = ?
            where thread_id = ?
                and id = ?
                and deleted_at is null
                and status not in ('submitting', 'steering', 'pendingCommit')
            "#,
        )
        .bind(now)
        .bind(now)
        .bind(thread_id)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            let existing = sqlx::query_scalar::<_, String>(
                "select status from queued_turn_inputs where thread_id = ? and id = ? and deleted_at is null",
            )
            .bind(thread_id)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
            match existing.as_deref() {
                Some("submitting" | "steering" | "pendingCommit") => {
                    return Err(ApiError::BadRequest(
                        "in-flight queued inputs cannot be deleted".to_string(),
                    ));
                }
                Some(_) => {}
                None => return Err(ApiError::NotFound(format!("queued input {id}"))),
            }
        }
        Ok(())
    }

    pub async fn delete_queued_input_for_gateway(
        &self,
        thread_id: &str,
        id: &str,
    ) -> ApiResult<()> {
        let now = Utc::now();
        let result = sqlx::query(
            "update queued_turn_inputs set deleted_at = ?, updated_at = ? where thread_id = ? and id = ? and deleted_at is null",
        )
        .bind(now)
        .bind(now)
        .bind(thread_id)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            let existing = sqlx::query_scalar::<_, String>(
                "select id from queued_turn_inputs where thread_id = ? and id = ? and deleted_at is null",
            )
            .bind(thread_id)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
            if existing.is_none() {
                return Err(ApiError::NotFound(format!("queued input {id}")));
            }
        }
        Ok(())
    }

    async fn require_existing_queued_input(&self, thread_id: &str, id: &str) -> ApiResult<()> {
        let existing = sqlx::query_scalar::<_, String>(
            "select id from queued_turn_inputs where thread_id = ? and id = ? and deleted_at is null",
        )
        .bind(thread_id)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        if existing.is_none() {
            return Err(ApiError::NotFound(format!("queued input {id}")));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use crate::{
        app_server_api::{TimelineSkillMention, TurnStartOptions, UserInput},
        error::ApiError,
        store::{
            QueuedInputPriority, QueuedInputStatus, Store, ThreadRuntimeState, ThreadRuntimeStatus,
        },
    };

    #[tokio::test]
    async fn requeue_pending_commit_cleans_up_pending_skill_mentions() {
        let store = Store::in_memory().await.unwrap();
        let queued = store
            .create_queued_input(
                "thread-1",
                vec![UserInput::Text {
                    text: "Use $agent-browser".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions::default(),
            )
            .await
            .unwrap();
        store
            .claim_queued_input_for_steering("thread-1", &queued.id)
            .await
            .unwrap();
        let mentions = vec![TimelineSkillMention {
            start: 4,
            end: 18,
            name: "agent-browser".to_string(),
            path: "/skills/agent-browser/SKILL.md".to_string(),
            display_name: Some("Agent Browser".to_string()),
            scope: None,
            short_description: None,
            brand_color: None,
            icon_small_url: None,
        }];
        let pending_id = store
            .insert_pending_timeline_skill_mentions("thread-1", "Use $agent-browser", &mentions)
            .await
            .unwrap();
        store
            .mark_queued_input_pending_commit(
                "thread-1",
                &queued.id,
                "turn-1",
                None,
                pending_id.as_deref(),
            )
            .await
            .unwrap();

        let requeued = store
            .requeue_pending_commit_inputs_for_turn("thread-1", "turn-1", "not committed")
            .await
            .unwrap();
        assert_eq!(requeued[0].status, QueuedInputStatus::Queued);
        let committed = store
            .commit_pending_timeline_skill_mentions(
                "thread-1",
                "turn-1",
                "item-later",
                "Use $agent-browser",
            )
            .await
            .unwrap();
        assert!(committed.is_none());
    }

    #[tokio::test]
    async fn queued_inputs_round_trip_order_and_restart_recovery() {
        let store = Store::in_memory().await.unwrap();
        let first = store
            .create_queued_input(
                "thread-1",
                vec![UserInput::Text {
                    text: "normal".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions::default(),
            )
            .await
            .unwrap();
        let second = store
            .create_queued_input(
                "thread-1",
                vec![UserInput::Text {
                    text: "rejected".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions {
                    model: Some("gpt-5.4".to_string()),
                    ..TurnStartOptions::default()
                },
            )
            .await
            .unwrap();

        let rejected = store
            .mark_queued_input_rejected_steer("thread-1", &second.id, "not steerable".to_string())
            .await
            .unwrap();
        assert_eq!(rejected.priority, QueuedInputPriority::RejectedSteer);

        let listed = store.list_queued_inputs("thread-1").await.unwrap();
        assert_eq!(
            listed.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec![second.id.as_str(), first.id.as_str()]
        );
        assert_eq!(listed[0].options.model.as_deref(), Some("gpt-5.4"));

        let claimed = store
            .claim_next_queued_input("thread-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claimed.id, second.id);
        assert_eq!(claimed.status, QueuedInputStatus::Submitting);
        store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Active,
                active_turn_id: Some("turn-1".to_string()),
                updated_at: Utc::now(),
                last_event_seq: Some(10),
            })
            .await
            .unwrap();
        store.recover_queued_inputs_after_restart().await.unwrap();

        let recovered = store
            .get_queued_input("thread-1", &second.id)
            .await
            .unwrap();
        assert_eq!(recovered.status, QueuedInputStatus::Failed);
        assert!(recovered.last_error.unwrap().contains("Gateway restarted"));
        let runtime = store
            .get_thread_runtime_state("thread-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(runtime.status, ThreadRuntimeStatus::Unknown);
        assert_eq!(runtime.active_turn_id, None);

        let draining = ThreadRuntimeState {
            thread_id: "thread-1".to_string(),
            status: ThreadRuntimeStatus::Draining,
            active_turn_id: None,
            updated_at: Utc::now(),
            last_event_seq: None,
        };
        store
            .upsert_thread_runtime_state(draining.clone())
            .await
            .unwrap();
        let preserved = store
            .upsert_thread_runtime_state_unless_draining(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Idle,
                active_turn_id: None,
                updated_at: Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        assert_eq!(preserved.status, ThreadRuntimeStatus::Draining);

        let failed = store
            .mark_queued_input_failed("thread-1", &first.id, "start failed".to_string())
            .await
            .unwrap();
        assert_eq!(failed.status, QueuedInputStatus::Failed);
        let retried = store
            .requeue_queued_input("thread-1", &first.id)
            .await
            .unwrap();
        assert_eq!(retried.status, QueuedInputStatus::Queued);
        assert!(matches!(
            store.requeue_queued_input("thread-1", &first.id).await,
            Err(ApiError::BadRequest(_))
        ));
        let steered = store
            .claim_queued_input_for_steering("thread-1", &first.id)
            .await
            .unwrap();
        assert_eq!(steered.status, QueuedInputStatus::Steering);
        assert_eq!(steered.attempt_count, 1);
        assert!(matches!(
            store
                .claim_queued_input_for_steering("thread-1", &first.id)
                .await,
            Err(ApiError::BadRequest(_))
        ));

        let pending = store
            .create_queued_input(
                "thread-1",
                vec![UserInput::Text {
                    text: "pending".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions::default(),
            )
            .await
            .unwrap();
        store
            .claim_queued_input_for_steering("thread-1", &pending.id)
            .await
            .unwrap();
        store
            .mark_queued_input_pending_commit("thread-1", &pending.id, "turn-1", Some(42), None)
            .await
            .unwrap();
        let recovered = store.recover_queued_inputs_after_restart().await.unwrap();
        let recovered_pending = recovered
            .iter()
            .find(|row| row.id == pending.id)
            .expect("pendingCommit row should be recovered");
        assert_eq!(recovered_pending.status, QueuedInputStatus::Failed);
        assert!(recovered_pending.accepted_turn_id.is_none());
        assert!(recovered_pending.accepted_at.is_none());
        assert!(recovered_pending.accepted_event_seq.is_none());
        assert!(recovered_pending
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("Gateway restarted"));
    }

    #[tokio::test]
    async fn queued_inputs_preserve_nullable_source_labels() {
        let store = Store::in_memory().await.unwrap();
        let manual = store
            .create_queued_input(
                "thread-1",
                vec![UserInput::Text {
                    text: "manual".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions::default(),
            )
            .await
            .unwrap();
        assert!(manual.source_type.is_none());
        assert!(manual.source_id.is_none());

        let automation = store
            .create_queued_input_with_source(
                "thread-1",
                vec![UserInput::Text {
                    text: "automated".to_string(),
                    text_elements: vec![],
                }],
                TurnStartOptions::default(),
                Some("automation"),
                Some("run-1"),
            )
            .await
            .unwrap();
        assert_eq!(automation.source_type.as_deref(), Some("automation"));
        assert_eq!(automation.source_id.as_deref(), Some("run-1"));
    }
}
