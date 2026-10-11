use std::path::Path;

use anyhow::bail;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous},
    Pool, Row, Sqlite,
};

use crate::registry::{ExecutorRecord, ExecutorStatus};

const SCHEMA_VERSION: i64 = 2;

#[derive(Clone)]
pub struct Store {
    pool: Pool<Sqlite>,
}

impl Store {
    pub async fn connect(path: &Path) -> anyhow::Result<Self> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&pool)
            .await?;
        if version == 0 {
            let mut transaction = pool.begin().await?;
            sqlx::query("CREATE TABLE federation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                .execute(&mut *transaction)
                .await?;
            install_executor_schema(&mut transaction).await?;
            sqlx::query("PRAGMA user_version = 2")
                .execute(&mut *transaction)
                .await?;
            transaction.commit().await?;
        } else if version == 1 {
            let mut transaction = pool.begin().await?;
            install_executor_schema(&mut transaction).await?;
            sqlx::query("PRAGMA user_version = 2")
                .execute(&mut *transaction)
                .await?;
            transaction.commit().await?;
        } else if version != SCHEMA_VERSION {
            bail!("unsupported federator database schema {version}; expected {SCHEMA_VERSION}");
        }
        let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await?;
        if !journal_mode.eq_ignore_ascii_case("wal") {
            bail!("federator sqlite journal_mode is {journal_mode}, expected wal");
        }
        sqlx::query(
            "UPDATE executors SET status = 'unknown', last_error = 'Executor has not been checked since federator restart.'",
        )
        .execute(&pool)
        .await?;
        Ok(Self { pool })
    }

    pub async fn ready(&self) -> bool {
        sqlx::query_scalar::<_, i64>("SELECT 1")
            .fetch_one(&self.pool)
            .await
            .is_ok()
    }

    pub async fn list_executors(&self) -> anyhow::Result<Vec<ExecutorRecord>> {
        let rows = sqlx::query(
            "SELECT id, generation, display_name, base_url, instance_id, api_version, app_server_schema_version, enabled, status, last_error, last_seen_at, created_at, updated_at FROM executors ORDER BY created_at, id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(decode_executor).collect()
    }

    pub async fn get_executor(&self, id: &str) -> anyhow::Result<Option<ExecutorRecord>> {
        let row = sqlx::query(
            "SELECT id, generation, display_name, base_url, instance_id, api_version, app_server_schema_version, enabled, status, last_error, last_seen_at, created_at, updated_at FROM executors WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(decode_executor).transpose()
    }

    pub async fn insert_executor(&self, record: &ExecutorRecord) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO executors (id, generation, display_name, base_url, instance_id, api_version, app_server_schema_version, enabled, status, last_error, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&record.id)
        .bind(record.generation)
        .bind(&record.display_name)
        .bind(&record.base_url)
        .bind(&record.instance_id)
        .bind(&record.api_version)
        .bind(&record.app_server_schema_version)
        .bind(record.enabled)
        .bind(record.status.as_str())
        .bind(&record.last_error)
        .bind(record.last_seen_at)
        .bind(record.created_at)
        .bind(record.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn update_executor_sparse(
        &self,
        id: &str,
        display_name: Option<&str>,
        enabled: Option<bool>,
        updated_at: i64,
    ) -> anyhow::Result<Option<ExecutorRecord>> {
        let row = sqlx::query(
            "UPDATE executors SET display_name = COALESCE(?, display_name), enabled = COALESCE(?, enabled), generation = generation + 1, updated_at = ? WHERE id = ? RETURNING id, generation, display_name, base_url, instance_id, api_version, app_server_schema_version, enabled, status, last_error, last_seen_at, created_at, updated_at",
        )
        .bind(display_name)
        .bind(enabled)
        .bind(updated_at)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(decode_executor).transpose()
    }

    pub async fn delete_executor(&self, id: &str) -> anyhow::Result<bool> {
        Ok(sqlx::query("DELETE FROM executors WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected()
            > 0)
    }
}

async fn install_executor_schema(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE executors (
            id TEXT PRIMARY KEY,
            generation INTEGER NOT NULL CHECK (generation > 0),
            display_name TEXT NOT NULL,
            base_url TEXT NOT NULL UNIQUE,
            instance_id TEXT NOT NULL UNIQUE,
            api_version TEXT NOT NULL,
            app_server_schema_version TEXT NOT NULL,
            enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
            status TEXT NOT NULL CHECK (status IN ('unknown', 'ready', 'unready', 'incompatible')),
            last_error TEXT,
            last_seen_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
        "#,
    )
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn decode_executor(row: sqlx::sqlite::SqliteRow) -> anyhow::Result<ExecutorRecord> {
    Ok(ExecutorRecord {
        id: row.try_get("id")?,
        generation: row.try_get("generation")?,
        display_name: row.try_get("display_name")?,
        base_url: row.try_get("base_url")?,
        instance_id: row.try_get("instance_id")?,
        api_version: row.try_get("api_version")?,
        app_server_schema_version: row.try_get("app_server_schema_version")?,
        enabled: row.try_get("enabled")?,
        status: ExecutorStatus::parse(row.try_get("status")?)?,
        last_error: row.try_get("last_error")?,
        last_seen_at: row.try_get("last_seen_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fresh_store_uses_wal_and_reopens_at_the_supported_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("federator.db");
        let store = Store::connect(&path).await.unwrap();
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        let journal: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(journal.to_ascii_lowercase(), "wal");
        drop(store);
        assert!(Store::connect(&path).await.unwrap().ready().await);
    }

    #[tokio::test]
    async fn unsupported_schema_is_rejected_without_rewriting_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("federator.db");
        let store = Store::connect(&path).await.unwrap();
        sqlx::query("PRAGMA user_version = 99")
            .execute(&store.pool)
            .await
            .unwrap();
        drop(store);
        let error = Store::connect(&path).await.err().unwrap().to_string();
        assert!(error.contains("unsupported federator database schema 99"));
    }

    #[tokio::test]
    async fn version_one_bootstrap_migrates_to_the_executor_registry_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("federator.db");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE federation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA user_version = 1")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let store = Store::connect(&path).await.unwrap();
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        let executors_table: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'executors'",
        )
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(executors_table, 1);
    }
}
