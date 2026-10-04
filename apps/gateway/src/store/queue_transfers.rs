use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{sqlite::SqliteRow, QueryBuilder, Row, Sqlite};
use utoipa::ToSchema;
use uuid::Uuid;

use super::Store;
use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum QueueTransferPhase {
    Deleting,
    Deleted,
    Steering,
    Accepted,
    Uncertain,
}

impl QueueTransferPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Deleting => "deleting",
            Self::Deleted => "deleted",
            Self::Steering => "steering",
            Self::Accepted => "accepted",
            Self::Uncertain => "uncertain",
        }
    }

    fn from_persisted(value: &str) -> ApiResult<Self> {
        match value {
            "deleting" => Ok(Self::Deleting),
            "deleted" => Ok(Self::Deleted),
            "steering" => Ok(Self::Steering),
            "accepted" => Ok(Self::Accepted),
            "uncertain" => Ok(Self::Uncertain),
            _ => Err(ApiError::Other(anyhow::anyhow!(
                "invalid stored queue transfer phase"
            ))),
        }
    }

    fn can_advance_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Deleting, Self::Deleted)
                | (Self::Deleted, Self::Steering)
                | (Self::Steering, Self::Accepted)
        ) || (self != Self::Uncertain && next == Self::Uncertain)
    }
}

/// Recoverable input for one native-queue-to-steer transfer. Ordinary queued
/// messages remain exclusively in native storage.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueTransfer {
    /// Fresh operation identity, also used as the steered user message client ID.
    pub id: String,
    pub thread_id: String,
    pub native_queue_id: String,
    /// Original native queue correlation for provenance; it is not unique and
    /// cannot establish delivery of this transfer.
    pub client_user_message_id: String,
    pub expected_turn_id: String,
    pub input: Vec<Value>,
    pub phase: QueueTransferPhase,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Store {
    /// Explicit abandonment only. Dismissing accepted/in-flight input could
    /// conceal eventual delivery, so only persisted uncertainty is removable.
    pub async fn dismiss_uncertain_queue_transfer(&self, id: &str) -> ApiResult<bool> {
        let result =
            sqlx::query("delete from queue_transfers where id = ? and phase = 'uncertain'")
                .bind(id)
                .execute(&self.pool)
                .await?;
        Ok(result.rows_affected() == 1)
    }

    pub(super) async fn install_queue_transfer_schema(&self) -> ApiResult<()> {
        sqlx::query(
            r#"
            create table if not exists queue_transfers (
                id text primary key not null,
                thread_id text not null,
                native_queue_id text not null,
                client_user_message_id text not null,
                expected_turn_id text not null,
                input_json text not null,
                phase text not null check (phase in ('deleting', 'deleted', 'steering', 'accepted', 'uncertain')),
                error text,
                created_at text not null,
                updated_at text not null,
                unique (thread_id, native_queue_id)
            )
            "#,
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "create index if not exists queue_transfers_thread_turn on queue_transfers (thread_id, expected_turn_id)",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn create_queue_transfer(
        &self,
        thread_id: &str,
        native_queue_id: &str,
        client_user_message_id: &str,
        expected_turn_id: &str,
        input: Vec<Value>,
    ) -> ApiResult<QueueTransfer> {
        let now = Utc::now();
        let row = sqlx::query(
            r#"
            insert into queue_transfers (
                id, thread_id, native_queue_id, client_user_message_id,
                expected_turn_id, input_json, phase, created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?, 'deleting', ?, ?)
            on conflict(thread_id, native_queue_id) do nothing
            returning *
            "#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(thread_id)
        .bind(native_queue_id)
        .bind(client_user_message_id)
        .bind(expected_turn_id)
        .bind(serde_json::to_string(&input)?)
        .bind(now)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_transfer).transpose()?.ok_or_else(|| {
            ApiError::Conflict("a transfer already owns this native queued submission".into())
        })
    }

    pub async fn get_queue_transfer(&self, id: &str) -> ApiResult<Option<QueueTransfer>> {
        sqlx::query("select * from queue_transfers where id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .map(row_to_transfer)
            .transpose()
    }

    pub async fn get_queue_transfer_for_row(
        &self,
        thread_id: &str,
        native_queue_id: &str,
    ) -> ApiResult<Option<QueueTransfer>> {
        sqlx::query("select * from queue_transfers where thread_id = ? and native_queue_id = ?")
            .bind(thread_id)
            .bind(native_queue_id)
            .fetch_optional(&self.pool)
            .await?
            .map(row_to_transfer)
            .transpose()
    }

    pub async fn list_queue_transfers(
        &self,
        thread_id: Option<&str>,
    ) -> ApiResult<Vec<QueueTransfer>> {
        let mut query = QueryBuilder::<Sqlite>::new("select * from queue_transfers");
        if let Some(thread_id) = thread_id {
            query.push(" where thread_id = ").push_bind(thread_id);
        }
        query.push(" order by created_at, id");
        query
            .build()
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(row_to_transfer)
            .collect()
    }

    pub async fn advance_queue_transfer(
        &self,
        id: &str,
        expected_phase: QueueTransferPhase,
        next_phase: QueueTransferPhase,
        error: Option<&str>,
    ) -> ApiResult<Option<QueueTransfer>> {
        if !expected_phase.can_advance_to(next_phase) {
            return Err(ApiError::BadRequest(
                "invalid queue transfer phase transition".into(),
            ));
        }
        // UPDATE RETURNING is one conditional write: a receipt may delete the
        // row before an RPC acknowledgement, and that acknowledgement must not
        // recreate it or overwrite reset/disconnect uncertainty.
        sqlx::query(
            "update queue_transfers set phase = ?, error = ?, updated_at = ? where id = ? and phase = ? returning *",
        )
        .bind(next_phase.as_str())
        .bind(error)
        .bind(Utc::now())
        .bind(id)
        .bind(expected_phase.as_str())
        .fetch_optional(&self.pool)
        .await?
        .map(row_to_transfer)
        .transpose()
    }

    pub async fn settle_queue_transfer_delivery(
        &self,
        thread_id: &str,
        turn_id: &str,
        client_id: Option<&str>,
    ) -> ApiResult<bool> {
        let Some(client_id) = client_id else {
            return Ok(false);
        };
        // The primary key is fresh for this transfer. Original queue client IDs
        // can be reused, so they must never match a delivery receipt here.
        let result = sqlx::query(
            "delete from queue_transfers where id = ? and thread_id = ? and expected_turn_id = ?",
        )
        .bind(client_id)
        .bind(thread_id)
        .bind(turn_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn invalidate_queue_transfers(
        &self,
        thread_id: Option<&str>,
        reason: &str,
    ) -> ApiResult<u64> {
        let result = sqlx::query(
            "update queue_transfers set phase = 'uncertain', error = ?, updated_at = ? where phase != 'uncertain' and (? is null or thread_id = ?)",
        )
        .bind(reason)
        .bind(Utc::now())
        .bind(thread_id)
        .bind(thread_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn invalidate_queue_transfers_for_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        reason: &str,
    ) -> ApiResult<u64> {
        let result = sqlx::query(
            "update queue_transfers set phase = 'uncertain', error = ?, updated_at = ? where thread_id = ? and expected_turn_id = ? and phase != 'uncertain'",
        )
        .bind(reason)
        .bind(Utc::now())
        .bind(thread_id)
        .bind(turn_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Bulk recovery returns only changed thread identities for refill events;
    /// it does not load recoverable input into the ingestion path.
    pub async fn invalidate_queue_transfers_for_restart(
        &self,
        reason: &str,
    ) -> ApiResult<Vec<String>> {
        let threads = sqlx::query_scalar::<_, String>(
            "update queue_transfers set phase = 'uncertain', error = ?, updated_at = ? where phase != 'uncertain' returning thread_id",
        )
        .bind(reason)
        .bind(Utc::now())
        .fetch_all(&self.pool)
        .await?;
        Ok(threads
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect())
    }
}

fn row_to_transfer(row: SqliteRow) -> ApiResult<QueueTransfer> {
    let phase: String = row.try_get("phase")?;
    let input: String = row.try_get("input_json")?;
    Ok(QueueTransfer {
        id: row.try_get("id")?,
        thread_id: row.try_get("thread_id")?,
        native_queue_id: row.try_get("native_queue_id")?,
        client_user_message_id: row.try_get("client_user_message_id")?,
        expected_turn_id: row.try_get("expected_turn_id")?,
        input: serde_json::from_str(&input)?,
        phase: QueueTransferPhase::from_persisted(&phase)?,
        error: row.try_get("error")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

#[cfg(test)]
mod tests;
use std::collections::BTreeSet;
