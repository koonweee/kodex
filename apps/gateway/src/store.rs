use std::{collections::HashMap, path::Path};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{sqlite::SqlitePoolOptions, Pool, QueryBuilder, Row, Sqlite};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    app_server_api::{TurnStartOptions, UserInput},
    error::{ApiError, ApiResult},
};

const EVENT_REPLAY_LIMIT: i64 = 500;

#[derive(Debug, Clone)]
pub struct Store {
    pool: Pool<Sqlite>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub seq: i64,
    pub id: String,
    pub received_at: DateTime<Utc>,
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub kind: String,
    pub codex_method: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct NewEvent {
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub kind: String,
    pub codex_method: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub request_id: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub method: String,
    pub status: String,
    pub payload: Value,
    pub response: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRead {
    pub thread_id: String,
    pub seen_completed_agent_turn_seq: i64,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default)]
pub struct ThreadReadState {
    pub seen_completed_agent_turn_seq: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum QueuedInputStatus {
    Queued,
    Submitting,
    Steering,
    Failed,
}

impl QueuedInputStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Submitting => "submitting",
            Self::Steering => "steering",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum QueuedInputPriority {
    Normal,
    RejectedSteer,
}

impl QueuedInputPriority {
    fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::RejectedSteer => "rejectedSteer",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueuedInput {
    pub id: String,
    pub thread_id: String,
    pub input: Vec<UserInput>,
    pub options: TurnStartOptions,
    pub status: QueuedInputStatus,
    pub priority: QueuedInputPriority,
    pub attempt_count: i64,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct ThreadRuntimeState {
    pub thread_id: String,
    pub status: String,
    pub active_turn_id: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub last_event_seq: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct NewApproval {
    pub request_id: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub method: String,
    pub payload: Value,
}

impl Store {
    pub async fn connect(path: &Path) -> ApiResult<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let url = format!("sqlite://{}?mode=rwc", path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await?;
        let store = Self { pool };
        store.migrate().await?;
        store.assert_wal().await?;
        Ok(store)
    }

    pub async fn in_memory() -> ApiResult<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        let store = Self { pool };
        store.migrate().await?;
        Ok(store)
    }

    pub fn pool(&self) -> &Pool<Sqlite> {
        &self.pool
    }

    pub async fn migrate(&self) -> ApiResult<()> {
        sqlx::query("pragma journal_mode = wal")
            .execute(&self.pool)
            .await?;
        sqlx::query(
            r#"
            create table if not exists events (
                seq integer primary key autoincrement,
                id text not null unique,
                received_at text not null,
                project_id text,
                thread_id text,
                turn_id text,
                item_id text,
                kind text not null,
                codex_method text,
                payload_json text not null
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists projects (
                id text primary key,
                name text not null,
                cwd text not null unique,
                created_at text not null,
                updated_at text not null
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists approvals (
                id text primary key,
                request_id text not null,
                thread_id text,
                turn_id text,
                item_id text,
                method text not null,
                status text not null,
                payload_json text not null,
                response_json text,
                created_at text not null,
                resolved_at text
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists thread_reads (
                thread_id text primary key,
                seen_completed_agent_turn_seq integer not null default 0,
                updated_at text not null
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists queued_turn_inputs (
                id text primary key,
                thread_id text not null,
                input_json text not null,
                options_json text not null,
                status text not null,
                priority text not null default 'normal',
                attempt_count integer not null default 0,
                last_error text,
                created_at text not null,
                updated_at text not null,
                deleted_at text
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            r#"
            create table if not exists thread_runtime_state (
                thread_id text primary key,
                status text not null,
                active_turn_id text,
                updated_at text not null,
                last_event_seq integer
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "create index if not exists queued_turn_inputs_active_idx on queued_turn_inputs (thread_id, deleted_at, status, priority, created_at)"
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn assert_wal(&self) -> ApiResult<()> {
        let mode: String = sqlx::query_scalar("pragma journal_mode")
            .fetch_one(&self.pool)
            .await?;
        if mode.eq_ignore_ascii_case("wal") || mode.eq_ignore_ascii_case("memory") {
            Ok(())
        } else {
            Err(ApiError::Other(anyhow::anyhow!(
                "sqlite journal_mode is {mode}, expected wal"
            )))
        }
    }

    pub async fn append_event(&self, event: NewEvent) -> ApiResult<EventEnvelope> {
        let id = Uuid::new_v4().to_string();
        let received_at = Utc::now();
        let payload_json = serde_json::to_string(&event.payload)?;

        let result = sqlx::query(
            r#"
            insert into events (
                id, received_at, project_id, thread_id, turn_id, item_id,
                kind, codex_method, payload_json
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(received_at)
        .bind(&event.project_id)
        .bind(&event.thread_id)
        .bind(&event.turn_id)
        .bind(&event.item_id)
        .bind(&event.kind)
        .bind(&event.codex_method)
        .bind(payload_json)
        .execute(&self.pool)
        .await?;

        Ok(EventEnvelope {
            seq: result.last_insert_rowid(),
            id,
            received_at,
            project_id: event.project_id,
            thread_id: event.thread_id,
            turn_id: event.turn_id,
            item_id: event.item_id,
            kind: event.kind,
            codex_method: event.codex_method,
            payload: event.payload,
        })
    }

    pub async fn replay_events(
        &self,
        cursor: Option<i64>,
        project_id: Option<String>,
        thread_id: Option<String>,
    ) -> ApiResult<Vec<EventEnvelope>> {
        self.replay_events_page(
            cursor,
            project_id.as_deref(),
            thread_id.as_deref(),
            EVENT_REPLAY_LIMIT,
        )
        .await
    }

    pub async fn replay_events_page(
        &self,
        cursor: Option<i64>,
        project_id: Option<&str>,
        thread_id: Option<&str>,
        limit: i64,
    ) -> ApiResult<Vec<EventEnvelope>> {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "select seq, id, received_at, project_id, thread_id, turn_id, item_id, kind, codex_method, payload_json from events where seq > ",
        );
        builder.push_bind(cursor.unwrap_or(0));

        if let Some(project_id) = project_id {
            builder.push(" and project_id = ");
            builder.push_bind(project_id);
        }
        if let Some(thread_id) = thread_id {
            builder.push(" and thread_id = ");
            builder.push_bind(thread_id);
        }
        builder.push(" order by seq asc limit ");
        builder.push_bind(limit);

        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.into_iter().map(row_to_event).collect()
    }

    pub async fn create_project(&self, name: String, cwd: String) -> ApiResult<Project> {
        let now = Utc::now();
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name,
            cwd,
            created_at: now,
            updated_at: now,
        };

        sqlx::query(
            "insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)",
        )
        .bind(&project.id)
        .bind(&project.name)
        .bind(&project.cwd)
        .bind(project.created_at)
        .bind(project.updated_at)
        .execute(&self.pool)
        .await?;

        Ok(project)
    }

    pub async fn list_projects(&self) -> ApiResult<Vec<Project>> {
        let rows = sqlx::query(
            "select id, name, cwd, created_at, updated_at from projects order by created_at desc",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_project).collect()
    }

    pub async fn get_project(&self, id: &str) -> ApiResult<Project> {
        let row =
            sqlx::query("select id, name, cwd, created_at, updated_at from projects where id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;

        row.map(row_to_project)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("project {id}")))
    }

    pub async fn thread_read_states(
        &self,
        thread_ids: &[String],
    ) -> ApiResult<HashMap<String, ThreadReadState>> {
        if thread_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let mut states = HashMap::new();

        let mut read_builder = QueryBuilder::<Sqlite>::new(
            "select thread_id, seen_completed_agent_turn_seq from thread_reads where thread_id in (",
        );
        {
            let mut separated = read_builder.separated(", ");
            for thread_id in thread_ids {
                separated.push_bind(thread_id);
            }
        }
        read_builder.push(")");

        for row in read_builder.build().fetch_all(&self.pool).await? {
            let thread_id: String = row.try_get("thread_id")?;
            states
                .entry(thread_id)
                .or_insert_with(ThreadReadState::default)
                .seen_completed_agent_turn_seq = row.try_get("seen_completed_agent_turn_seq")?;
        }

        Ok(states)
    }

    pub async fn mark_thread_seen_completed_agent_turns(
        &self,
        thread_id: &str,
        seen_completed_agent_turn_seq: i64,
    ) -> ApiResult<ThreadRead> {
        let updated_at = Utc::now();
        sqlx::query(
            r#"
            insert into thread_reads (thread_id, seen_completed_agent_turn_seq, updated_at)
            values (?, ?, ?)
            on conflict(thread_id) do update set
                seen_completed_agent_turn_seq = max(
                    thread_reads.seen_completed_agent_turn_seq,
                    excluded.seen_completed_agent_turn_seq
                ),
                updated_at = excluded.updated_at
            "#,
        )
        .bind(thread_id)
        .bind(seen_completed_agent_turn_seq.max(0))
        .bind(updated_at)
        .execute(&self.pool)
        .await?;

        self.get_thread_read(thread_id).await
    }

    pub async fn get_thread_read(&self, thread_id: &str) -> ApiResult<ThreadRead> {
        let row = sqlx::query(
            "select thread_id, seen_completed_agent_turn_seq, updated_at from thread_reads where thread_id = ?",
        )
        .bind(thread_id)
        .fetch_optional(&self.pool)
        .await?;

        row.map(row_to_thread_read)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("thread read state {thread_id}")))
    }

    pub async fn create_queued_input(
        &self,
        thread_id: &str,
        input: Vec<UserInput>,
        options: TurnStartOptions,
    ) -> ApiResult<QueuedInput> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let input_json = serde_json::to_string(&input)?;
        let options_json = serde_json::to_string(&options)?;
        sqlx::query(
            r#"
            insert into queued_turn_inputs (
                id, thread_id, input_json, options_json, status, priority,
                attempt_count, created_at, updated_at
            )
            values (?, ?, ?, ?, 'queued', 'normal', 0, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(thread_id)
        .bind(input_json)
        .bind(options_json)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_queued_input(thread_id, &id).await
    }

    pub async fn list_queued_inputs(&self, thread_id: &str) -> ApiResult<Vec<QueuedInput>> {
        let rows = sqlx::query(
            r#"
            select id, thread_id, input_json, options_json, status, priority,
                   attempt_count, last_error, created_at, updated_at
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
            select id, thread_id, input_json, options_json, status, priority,
                   attempt_count, last_error, created_at, updated_at
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
                "select id from queued_turn_inputs where thread_id = ? and id = ?",
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

    pub async fn upsert_thread_runtime_state(&self, state: ThreadRuntimeState) -> ApiResult<()> {
        sqlx::query(
            r#"
            insert into thread_runtime_state (
                thread_id, status, active_turn_id, updated_at, last_event_seq
            )
            values (?, ?, ?, ?, ?)
            on conflict(thread_id) do update set
                status = excluded.status,
                active_turn_id = excluded.active_turn_id,
                updated_at = excluded.updated_at,
                last_event_seq = excluded.last_event_seq
            "#,
        )
        .bind(state.thread_id)
        .bind(state.status)
        .bind(state.active_turn_id)
        .bind(state.updated_at)
        .bind(state.last_event_seq)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn upsert_thread_runtime_state_unless_draining(
        &self,
        state: ThreadRuntimeState,
    ) -> ApiResult<ThreadRuntimeState> {
        let thread_id = state.thread_id.clone();
        sqlx::query(
            r#"
            insert into thread_runtime_state (
                thread_id, status, active_turn_id, updated_at, last_event_seq
            )
            values (?, ?, ?, ?, ?)
            on conflict(thread_id) do update set
                status = excluded.status,
                active_turn_id = excluded.active_turn_id,
                updated_at = excluded.updated_at,
                last_event_seq = excluded.last_event_seq
            where thread_runtime_state.status != 'draining'
            "#,
        )
        .bind(state.thread_id)
        .bind(state.status)
        .bind(state.active_turn_id)
        .bind(state.updated_at)
        .bind(state.last_event_seq)
        .execute(&self.pool)
        .await?;
        self.get_thread_runtime_state(&thread_id)
            .await?
            .ok_or_else(|| ApiError::NotFound(format!("thread runtime state {thread_id}")))
    }

    pub async fn set_thread_runtime_pending(&self, thread_id: &str, status: &str) -> ApiResult<()> {
        self.upsert_thread_runtime_state(ThreadRuntimeState {
            thread_id: thread_id.to_string(),
            status: status.to_string(),
            active_turn_id: None,
            updated_at: Utc::now(),
            last_event_seq: None,
        })
        .await
    }

    pub async fn claim_idle_thread_runtime_for_queue_drain(
        &self,
        thread_id: &str,
    ) -> ApiResult<bool> {
        let now = Utc::now();
        let result = sqlx::query(
            r#"
            update thread_runtime_state
            set status = 'draining',
                active_turn_id = null,
                updated_at = ?
            where thread_id = ? and status = 'idle'
            "#,
        )
        .bind(now)
        .bind(thread_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn clear_queue_drain_runtime_claim(&self, thread_id: &str) -> ApiResult<()> {
        let now = Utc::now();
        sqlx::query(
            r#"
            update thread_runtime_state
            set status = 'idle',
                active_turn_id = null,
                updated_at = ?
            where thread_id = ? and status = 'draining'
            "#,
        )
        .bind(now)
        .bind(thread_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_thread_runtime_state(
        &self,
        thread_id: &str,
    ) -> ApiResult<Option<ThreadRuntimeState>> {
        let row = sqlx::query(
            "select thread_id, status, active_turn_id, updated_at, last_event_seq from thread_runtime_state where thread_id = ?",
        )
        .bind(thread_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_thread_runtime_state).transpose()
    }

    pub async fn recover_queued_inputs_after_restart(&self) -> ApiResult<Vec<QueuedInput>> {
        let now = Utc::now();
        let rows = sqlx::query(
            r#"
            select id, thread_id, input_json, options_json, status, priority,
                   attempt_count, last_error, created_at, updated_at
            from queued_turn_inputs
            where deleted_at is null and status in ('submitting', 'steering')
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        let recovering = rows
            .into_iter()
            .map(row_to_queued_input)
            .collect::<ApiResult<Vec<_>>>()?;
        sqlx::query(
            r#"
            update queued_turn_inputs
            set status = 'failed',
                last_error = 'Gateway restarted before this queued input could be confirmed. Retry manually to avoid duplicate sends.',
                updated_at = ?
            where deleted_at is null and status in ('submitting', 'steering')
            "#,
        )
        .bind(now)
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "update thread_runtime_state set status = 'unknown', active_turn_id = null, updated_at = ?",
        )
        .bind(now)
        .execute(&self.pool)
        .await?;
        let mut recovered = Vec::with_capacity(recovering.len());
        for row in recovering {
            recovered.push(self.get_queued_input(&row.thread_id, &row.id).await?);
        }
        Ok(recovered)
    }

    pub async fn insert_approval(&self, approval: NewApproval) -> ApiResult<Approval> {
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        let payload_json = serde_json::to_string(&approval.payload)?;

        sqlx::query(
            r#"
            insert into approvals (
                id, request_id, thread_id, turn_id, item_id, method,
                status, payload_json, created_at
            )
            values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&approval.request_id)
        .bind(&approval.thread_id)
        .bind(&approval.turn_id)
        .bind(&approval.item_id)
        .bind(&approval.method)
        .bind(payload_json)
        .bind(now)
        .execute(&self.pool)
        .await?;

        self.get_approval(&id).await
    }

    pub async fn list_approvals(
        &self,
        status: Option<String>,
        thread_id: Option<String>,
    ) -> ApiResult<Vec<Approval>> {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "select id, request_id, thread_id, turn_id, item_id, method, status, payload_json, response_json, created_at, resolved_at from approvals where 1 = 1",
        );
        if let Some(status) = status {
            builder.push(" and status = ");
            builder.push_bind(status);
        }
        if let Some(thread_id) = thread_id {
            builder.push(" and thread_id = ");
            builder.push_bind(thread_id);
        }
        builder.push(" order by created_at desc");

        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.into_iter().map(row_to_approval).collect()
    }

    pub async fn get_approval(&self, id: &str) -> ApiResult<Approval> {
        let row = sqlx::query(
            r#"
            select id, request_id, thread_id, turn_id, item_id, method, status,
                   payload_json, response_json, created_at, resolved_at
            from approvals
            where id = ?
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        row.map(row_to_approval)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("approval {id}")))
    }

    pub async fn resolve_approval(&self, id: &str, response: Value) -> ApiResult<Approval> {
        self.claim_approval_resolution(id, response).await?;
        self.finish_approval_resolution(id).await
    }

    pub async fn claim_approval_resolution(
        &self,
        id: &str,
        response: Value,
    ) -> ApiResult<Approval> {
        let response_json = serde_json::to_string(&response)?;
        let resolved_at = Utc::now();
        let result = sqlx::query(
            "update approvals set status = 'resolving', response_json = ?, resolved_at = ? where id = ? and status = 'pending'",
        )
        .bind(response_json)
        .bind(resolved_at)
        .bind(id)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            let existing = self.get_approval(id).await?;
            return Err(ApiError::BadRequest(format!(
                "approval {id} is not pending; current status is {}",
                existing.status
            )));
        }

        self.get_approval(id).await
    }

    pub async fn finish_approval_resolution(&self, id: &str) -> ApiResult<Approval> {
        let result = sqlx::query(
            "update approvals set status = 'resolved' where id = ? and status = 'resolving'",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            let existing = self.get_approval(id).await?;
            return Err(ApiError::BadRequest(format!(
                "approval {id} is not resolving; current status is {}",
                existing.status
            )));
        }

        self.get_approval(id).await
    }

    pub async fn reset_approval_resolution(&self, id: &str) -> ApiResult<()> {
        sqlx::query(
            "update approvals set status = 'pending', response_json = null, resolved_at = null where id = ? and status = 'resolving'",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

fn row_to_event(row: sqlx::sqlite::SqliteRow) -> ApiResult<EventEnvelope> {
    let payload_json: String = row.try_get("payload_json")?;
    Ok(EventEnvelope {
        seq: row.try_get("seq")?,
        id: row.try_get("id")?,
        received_at: row.try_get("received_at")?,
        project_id: row.try_get("project_id")?,
        thread_id: row.try_get("thread_id")?,
        turn_id: row.try_get("turn_id")?,
        item_id: row.try_get("item_id")?,
        kind: row.try_get("kind")?,
        codex_method: row.try_get("codex_method")?,
        payload: serde_json::from_str(&payload_json)?,
    })
}

fn row_to_project(row: sqlx::sqlite::SqliteRow) -> ApiResult<Project> {
    Ok(Project {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        cwd: row.try_get("cwd")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_queued_input(row: sqlx::sqlite::SqliteRow) -> ApiResult<QueuedInput> {
    let input_json: String = row.try_get("input_json")?;
    let options_json: String = row.try_get("options_json")?;
    let status: String = row.try_get("status")?;
    let priority: String = row.try_get("priority")?;
    Ok(QueuedInput {
        id: row.try_get("id")?,
        thread_id: row.try_get("thread_id")?,
        input: serde_json::from_str(&input_json)?,
        options: serde_json::from_str(&options_json)?,
        status: queued_input_status(&status)?,
        priority: queued_input_priority(&priority)?,
        attempt_count: row.try_get("attempt_count")?,
        last_error: row.try_get("last_error")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn queued_input_status(status: &str) -> ApiResult<QueuedInputStatus> {
    match status {
        "queued" => Ok(QueuedInputStatus::Queued),
        "submitting" => Ok(QueuedInputStatus::Submitting),
        "steering" => Ok(QueuedInputStatus::Steering),
        "failed" => Ok(QueuedInputStatus::Failed),
        other => Err(ApiError::BadGateway(format!(
            "unknown queued input status {other}"
        ))),
    }
}

fn queued_input_priority(priority: &str) -> ApiResult<QueuedInputPriority> {
    match priority {
        "normal" => Ok(QueuedInputPriority::Normal),
        "rejectedSteer" => Ok(QueuedInputPriority::RejectedSteer),
        other => Err(ApiError::BadGateway(format!(
            "unknown queued input priority {other}"
        ))),
    }
}

fn row_to_thread_runtime_state(row: sqlx::sqlite::SqliteRow) -> ApiResult<ThreadRuntimeState> {
    Ok(ThreadRuntimeState {
        thread_id: row.try_get("thread_id")?,
        status: row.try_get("status")?,
        active_turn_id: row.try_get("active_turn_id")?,
        updated_at: row.try_get("updated_at")?,
        last_event_seq: row.try_get("last_event_seq")?,
    })
}

fn row_to_thread_read(row: sqlx::sqlite::SqliteRow) -> ApiResult<ThreadRead> {
    Ok(ThreadRead {
        thread_id: row.try_get("thread_id")?,
        seen_completed_agent_turn_seq: row.try_get("seen_completed_agent_turn_seq")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn row_to_approval(row: sqlx::sqlite::SqliteRow) -> ApiResult<Approval> {
    let payload_json: String = row.try_get("payload_json")?;
    let response_json: Option<String> = row.try_get("response_json")?;
    Ok(Approval {
        id: row.try_get("id")?,
        request_id: row.try_get("request_id")?,
        thread_id: row.try_get("thread_id")?,
        turn_id: row.try_get("turn_id")?,
        item_id: row.try_get("item_id")?,
        method: row.try_get("method")?,
        status: row.try_get("status")?,
        payload: serde_json::from_str(&payload_json)?,
        response: response_json
            .map(|json| serde_json::from_str(&json))
            .transpose()?,
        created_at: row.try_get("created_at")?,
        resolved_at: row.try_get("resolved_at")?,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    #[tokio::test]
    async fn file_database_migration_creates_tables_and_enables_wal() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("gateway.db");
        let store = Store::connect(&path).await.unwrap();

        store.assert_wal().await.unwrap();
        let tables: Vec<String> = sqlx::query_scalar(
            "select name from sqlite_master where type = 'table' and name in ('events', 'projects', 'approvals', 'thread_reads', 'queued_turn_inputs', 'thread_runtime_state') order by name",
        )
        .fetch_all(store.pool())
        .await
        .unwrap();
        assert_eq!(
            tables,
            vec![
                "approvals",
                "events",
                "projects",
                "queued_turn_inputs",
                "thread_reads",
                "thread_runtime_state"
            ]
        );
    }

    #[tokio::test]
    async fn appending_events_assigns_monotonic_seq() {
        let store = Store::in_memory().await.unwrap();

        let first = store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("turn/completed".to_string()),
                payload: json!({"ok": true}),
            })
            .await
            .unwrap();
        let second = store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "gateway.warning".to_string(),
                codex_method: None,
                payload: json!({"warning": "test"}),
            })
            .await
            .unwrap();

        assert!(second.seq > first.seq);
        let replay = store
            .replay_events(Some(first.seq), None, Some("thread-1".to_string()))
            .await
            .unwrap();
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].seq, second.seq);
    }

    #[tokio::test]
    async fn migration_keeps_thread_reads_independent_from_event_replay() {
        let store = Store::in_memory().await.unwrap();
        store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: None,
                kind: "codex.notification".to_string(),
                codex_method: Some("turn/completed".to_string()),
                payload: json!({"threadId": "thread-1"}),
            })
            .await
            .unwrap();

        sqlx::query("drop table thread_reads")
            .execute(store.pool())
            .await
            .unwrap();
        store.migrate().await.unwrap();

        let thread_ids = vec!["thread-1".to_string()];
        let states = store.thread_read_states(&thread_ids).await.unwrap();
        assert!(!states.contains_key("thread-1"));
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
                status: "active".to_string(),
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
        assert_eq!(runtime.status, "unknown");
        assert_eq!(runtime.active_turn_id, None);

        let draining = ThreadRuntimeState {
            thread_id: "thread-1".to_string(),
            status: "draining".to_string(),
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
                status: "idle".to_string(),
                active_turn_id: None,
                updated_at: Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        assert_eq!(preserved.status, "draining");

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
    }

    #[tokio::test]
    async fn approval_resolve_is_single_use() {
        let store = Store::in_memory().await.unwrap();
        let approval = store
            .insert_approval(NewApproval {
                request_id: "1".to_string(),
                thread_id: None,
                turn_id: None,
                item_id: None,
                method: "item/permissions/requestApproval".to_string(),
                payload: json!({"kind": "test"}),
            })
            .await
            .unwrap();

        let resolved = store
            .resolve_approval(&approval.id, json!({"decision": "approved"}))
            .await
            .unwrap();
        assert_eq!(resolved.status, "resolved");

        let duplicate = store
            .resolve_approval(&approval.id, json!({"decision": "approved"}))
            .await;
        assert!(matches!(duplicate, Err(ApiError::BadRequest(_))));

        let unknown = store
            .resolve_approval("missing", json!({"decision": "approved"}))
            .await;
        assert!(matches!(unknown, Err(ApiError::NotFound(_))));
    }
}
