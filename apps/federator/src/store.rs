use std::path::Path;

use anyhow::bail;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous},
    Pool, Row, Sqlite,
};

use crate::{
    registry::{ExecutorRecord, ExecutorStatus},
    CatalogChange,
};

const SCHEMA_VERSION: i64 = 6;
const REGISTRY_REVISION_KEY: &str = "executor_registry_revision";
const FRONTEND_REVISION_KEY: &str = "frontend_revision";
const CATALOG_REVISION_KEY: &str = "catalog_revision";
const ORDER_REVISION_KEY: &str = "catalog_order_revision";

#[derive(Clone)]
pub struct Store {
    pub(crate) pool: Pool<Sqlite>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DeleteExecutorOutcome {
    pub(crate) registry_revision: i64,
    pub(crate) catalog_revision: Option<i64>,
    pub(crate) order_revision: Option<i64>,
}

pub(crate) struct ExecutorMutation {
    pub(crate) record: ExecutorRecord,
    pub(crate) registry_revision: i64,
    pub(crate) catalog_change: Option<CatalogChange>,
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
            install_registry_revision(&mut transaction).await?;
            install_catalog_schema(&mut transaction).await?;
            install_notification_schema(&mut transaction).await?;
            sqlx::query("PRAGMA user_version = 6")
                .execute(&mut *transaction)
                .await?;
            transaction.commit().await?;
        } else if version == 1 {
            let mut transaction = pool.begin().await?;
            install_executor_schema(&mut transaction).await?;
            install_registry_revision(&mut transaction).await?;
            install_catalog_schema(&mut transaction).await?;
            install_notification_schema(&mut transaction).await?;
            sqlx::query("PRAGMA user_version = 6")
                .execute(&mut *transaction)
                .await?;
            transaction.commit().await?;
        } else if version == 2 {
            let mut transaction = pool.begin().await?;
            install_registry_revision(&mut transaction).await?;
            install_catalog_schema(&mut transaction).await?;
            install_notification_schema(&mut transaction).await?;
            sqlx::query("PRAGMA user_version = 6")
                .execute(&mut *transaction)
                .await?;
            transaction.commit().await?;
        } else if version == 3 {
            let mut transaction = pool.begin().await?;
            install_catalog_schema(&mut transaction).await?;
            install_notification_schema(&mut transaction).await?;
            sqlx::query("PRAGMA user_version = 6")
                .execute(&mut *transaction)
                .await?;
            transaction.commit().await?;
        } else if version == 4 {
            let mut transaction = pool.begin().await?;
            sqlx::query("ALTER TABLE catalog_snapshots ADD COLUMN refresh_error TEXT")
                .execute(&mut *transaction)
                .await?;
            install_notification_schema(&mut transaction).await?;
            sqlx::query("PRAGMA user_version = 6")
                .execute(&mut *transaction)
                .await?;
            transaction.commit().await?;
        } else if version == 5 {
            let mut transaction = pool.begin().await?;
            install_notification_schema(&mut transaction).await?;
            sqlx::query("PRAGMA user_version = 6")
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
        let mut transaction = pool.begin().await?;
        let reset = sqlx::query(
            "UPDATE executors SET status = 'unknown', last_error = 'Executor has not been checked since federator restart.' WHERE status != 'unknown' OR last_error IS NULL OR last_error != 'Executor has not been checked since federator restart.'",
        )
        .execute(&mut *transaction)
        .await?;
        if reset.rows_affected() > 0 {
            advance_registry_revision(&mut transaction).await?;
            if sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM catalog_snapshots)")
                .fetch_one(&mut *transaction)
                .await?
            {
                advance_revision(&mut transaction, CATALOG_REVISION_KEY).await?;
            }
        }
        transaction.commit().await?;
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

    pub async fn executor_registry_snapshot(&self) -> anyhow::Result<(i64, Vec<ExecutorRecord>)> {
        let mut transaction = self.pool.begin().await?;
        let revision = registry_revision(&mut transaction).await?;
        let rows = sqlx::query(
            "SELECT id, generation, display_name, base_url, instance_id, api_version, app_server_schema_version, enabled, status, last_error, last_seen_at, created_at, updated_at FROM executors ORDER BY created_at, id",
        )
        .fetch_all(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok((
            revision,
            rows.into_iter()
                .map(decode_executor)
                .collect::<anyhow::Result<_>>()?,
        ))
    }

    pub async fn executor_registry_revision(&self) -> anyhow::Result<i64> {
        let mut transaction = self.pool.begin().await?;
        let revision = registry_revision(&mut transaction).await?;
        transaction.commit().await?;
        Ok(revision)
    }

    pub async fn frontend_revision(&self) -> anyhow::Result<Option<String>> {
        Ok(
            sqlx::query_scalar("SELECT value FROM federation_meta WHERE key = ?")
                .bind(FRONTEND_REVISION_KEY)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    pub async fn set_frontend_revision(&self, revision: &str) -> anyhow::Result<()> {
        sqlx::query(
            "INSERT INTO federation_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(FRONTEND_REVISION_KEY)
        .bind(revision)
        .execute(&self.pool)
        .await?;
        Ok(())
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

    pub async fn insert_executor(&self, record: &ExecutorRecord) -> anyhow::Result<i64> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
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
        .execute(&mut *transaction)
        .await?;
        let revision = advance_registry_revision(&mut transaction).await?;
        transaction.commit().await?;
        Ok(revision)
    }

    pub(crate) async fn update_executor_sparse(
        &self,
        id: &str,
        display_name: Option<&str>,
        enabled: Option<bool>,
        updated_at: i64,
    ) -> anyhow::Result<Option<ExecutorMutation>> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = sqlx::query(
            "UPDATE executors SET display_name = COALESCE(?, display_name), enabled = COALESCE(?, enabled), generation = generation + 1, updated_at = ? WHERE id = ? RETURNING id, generation, display_name, base_url, instance_id, api_version, app_server_schema_version, enabled, status, last_error, last_seen_at, created_at, updated_at",
        )
        .bind(display_name)
        .bind(enabled)
        .bind(updated_at)
        .bind(id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(row) = row else {
            transaction.commit().await?;
            return Ok(None);
        };
        let record = decode_executor(row)?;
        let registry_revision = advance_registry_revision(&mut transaction).await?;
        let catalog_change = catalog_change_for_executor(&mut transaction, id).await?;
        transaction.commit().await?;
        Ok(Some(ExecutorMutation {
            record,
            registry_revision,
            catalog_change,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn update_executor_verified_endpoint(
        &self,
        id: &str,
        expected_generation: i64,
        display_name: Option<&str>,
        enabled: Option<bool>,
        base_url: &str,
        api_version: &str,
        app_server_schema_version: &str,
        status: ExecutorStatus,
        last_error: Option<&str>,
        updated_at: i64,
    ) -> anyhow::Result<Option<ExecutorMutation>> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = sqlx::query(
            "UPDATE executors SET display_name = COALESCE(?, display_name), enabled = COALESCE(?, enabled), base_url = ?, api_version = ?, app_server_schema_version = ?, status = ?, last_error = ?, last_seen_at = ?, generation = generation + 1, updated_at = ? WHERE id = ? AND generation = ? RETURNING id, generation, display_name, base_url, instance_id, api_version, app_server_schema_version, enabled, status, last_error, last_seen_at, created_at, updated_at",
        )
        .bind(display_name)
        .bind(enabled)
        .bind(base_url)
        .bind(api_version)
        .bind(app_server_schema_version)
        .bind(status.as_str())
        .bind(last_error)
        .bind(updated_at)
        .bind(updated_at)
        .bind(id)
        .bind(expected_generation)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(row) = row else {
            transaction.commit().await?;
            return Ok(None);
        };
        let record = decode_executor(row)?;
        let registry_revision = advance_registry_revision(&mut transaction).await?;
        let catalog_change = catalog_change_for_executor(&mut transaction, id).await?;
        transaction.commit().await?;
        Ok(Some(ExecutorMutation {
            record,
            registry_revision,
            catalog_change,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn update_executor_probe(
        &self,
        id: &str,
        expected_generation: i64,
        api_version: &str,
        app_server_schema_version: &str,
        status: ExecutorStatus,
        last_error: Option<&str>,
        last_seen_at: i64,
        updated_at: i64,
        bump_generation: bool,
    ) -> anyhow::Result<Option<ExecutorMutation>> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = sqlx::query(
            "UPDATE executors SET api_version = ?, app_server_schema_version = ?, status = ?, last_error = ?, last_seen_at = ?, generation = generation + ?, updated_at = ? WHERE id = ? AND generation = ? RETURNING id, generation, display_name, base_url, instance_id, api_version, app_server_schema_version, enabled, status, last_error, last_seen_at, created_at, updated_at",
        )
        .bind(api_version)
        .bind(app_server_schema_version)
        .bind(status.as_str())
        .bind(last_error)
        .bind(last_seen_at)
        .bind(i64::from(bump_generation))
        .bind(updated_at)
        .bind(id)
        .bind(expected_generation)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(row) = row else {
            transaction.commit().await?;
            return Ok(None);
        };
        let record = decode_executor(row)?;
        let registry_revision = advance_registry_revision(&mut transaction).await?;
        let catalog_change = catalog_change_for_executor(&mut transaction, id).await?;
        transaction.commit().await?;
        Ok(Some(ExecutorMutation {
            record,
            registry_revision,
            catalog_change,
        }))
    }

    pub(crate) async fn delete_executor(
        &self,
        id: &str,
    ) -> anyhow::Result<Option<DeleteExecutorOutcome>> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let had_snapshot: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM catalog_snapshots WHERE executor_id = ?)",
        )
        .bind(id)
        .fetch_one(&mut *transaction)
        .await?;
        let had_order: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog_order WHERE executor_id = ?)")
                .bind(id)
                .fetch_one(&mut *transaction)
                .await?;
        let deleted = sqlx::query("DELETE FROM executors WHERE id = ?")
            .bind(id)
            .execute(&mut *transaction)
            .await?
            .rows_affected()
            > 0;
        let outcome = if deleted {
            let registry_revision = advance_registry_revision(&mut transaction).await?;
            let catalog_revision = if had_snapshot || had_order {
                Some(advance_revision(&mut transaction, CATALOG_REVISION_KEY).await?)
            } else {
                None
            };
            let order_revision = if had_snapshot || had_order {
                Some(if had_order {
                    advance_revision(&mut transaction, ORDER_REVISION_KEY).await?
                } else {
                    revision(&mut transaction, ORDER_REVISION_KEY).await?
                })
            } else {
                None
            };
            Some(DeleteExecutorOutcome {
                registry_revision,
                catalog_revision,
                order_revision,
            })
        } else {
            None
        };
        transaction.commit().await?;
        Ok(outcome)
    }
}

async fn install_registry_revision(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
) -> anyhow::Result<()> {
    sqlx::query("INSERT OR IGNORE INTO federation_meta (key, value) VALUES (?, '0')")
        .bind(REGISTRY_REVISION_KEY)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

async fn registry_revision(transaction: &mut sqlx::Transaction<'_, Sqlite>) -> anyhow::Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT CAST(value AS INTEGER) FROM federation_meta WHERE key = ?")
            .bind(REGISTRY_REVISION_KEY)
            .fetch_one(&mut **transaction)
            .await?,
    )
}

async fn advance_registry_revision(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
) -> anyhow::Result<i64> {
    Ok(sqlx::query_scalar(
        "UPDATE federation_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = ? RETURNING CAST(value AS INTEGER)",
    )
    .bind(REGISTRY_REVISION_KEY)
    .fetch_one(&mut **transaction)
    .await?)
}

async fn advance_revision(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    key: &str,
) -> anyhow::Result<i64> {
    Ok(sqlx::query_scalar(
        "UPDATE federation_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = ? RETURNING CAST(value AS INTEGER)",
    )
    .bind(key)
    .fetch_one(&mut **transaction)
    .await?)
}

async fn revision(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    key: &str,
) -> anyhow::Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT CAST(value AS INTEGER) FROM federation_meta WHERE key = ?")
            .bind(key)
            .fetch_one(&mut **transaction)
            .await?,
    )
}

async fn catalog_change_for_executor(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    executor_id: &str,
) -> anyhow::Result<Option<CatalogChange>> {
    let has_snapshot: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog_snapshots WHERE executor_id = ?)")
            .bind(executor_id)
            .fetch_one(&mut **transaction)
            .await?;
    if !has_snapshot {
        return Ok(None);
    }
    Ok(Some(CatalogChange {
        revision: advance_revision(transaction, CATALOG_REVISION_KEY).await?,
        order_revision: revision(transaction, ORDER_REVISION_KEY).await?,
    }))
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

async fn install_catalog_schema(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
) -> anyhow::Result<()> {
    for key in [CATALOG_REVISION_KEY, ORDER_REVISION_KEY] {
        sqlx::query("INSERT OR IGNORE INTO federation_meta (key, value) VALUES (?, '0')")
            .bind(key)
            .execute(&mut **transaction)
            .await?;
    }
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS catalog_snapshots (
            executor_id TEXT PRIMARY KEY REFERENCES executors(id) ON DELETE CASCADE,
            generation INTEGER NOT NULL,
            snapshot_json TEXT NOT NULL,
            observed_at INTEGER NOT NULL,
            refresh_error TEXT
        )
        "#,
    )
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS catalog_order (
            kind TEXT NOT NULL CHECK (kind IN ('project', 'pinned')),
            executor_id TEXT NOT NULL REFERENCES executors(id) ON DELETE CASCADE,
            native_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (kind, executor_id, native_id),
            UNIQUE (kind, position)
        )
        "#,
    )
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn install_notification_schema(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO federation_meta (key, value) VALUES ('badge_revision', '0')",
    )
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL,
            auth TEXT NOT NULL, user_agent TEXT, enabled INTEGER NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )
        "#,
    )
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS notification_deliveries (
            id TEXT PRIMARY KEY, payload_json TEXT NOT NULL,
            delivered_subscription_ids_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
            available_at INTEGER NOT NULL, processing_started_at INTEGER,
            sent_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )
        "#,
    )
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS notification_deliveries_due_idx ON notification_deliveries(status, available_at, processing_started_at, created_at)",
    )
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS executor_badges (
            executor_id TEXT PRIMARY KEY REFERENCES executors(id) ON DELETE CASCADE,
            generation INTEGER NOT NULL, count INTEGER NOT NULL, native_read_revision INTEGER NOT NULL,
            observed_at INTEGER NOT NULL, last_error TEXT
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

    fn executor(id: &str) -> ExecutorRecord {
        ExecutorRecord {
            id: id.to_string(),
            generation: 1,
            display_name: "Executor".to_string(),
            base_url: format!("http://127.0.0.1:9{id}"),
            instance_id: format!("instance-{id}"),
            api_version: "4".to_string(),
            app_server_schema_version: "0.160.0".to_string(),
            enabled: true,
            status: ExecutorStatus::Ready,
            last_error: None,
            last_seen_at: 1,
            created_at: 1,
            updated_at: 1,
        }
    }

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

    #[tokio::test]
    async fn version_two_registry_migrates_with_a_durable_revision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("federator.db");
        let store = Store::connect(&path).await.unwrap();
        sqlx::query("DELETE FROM federation_meta WHERE key = ?")
            .bind(REGISTRY_REVISION_KEY)
            .execute(&store.pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA user_version = 2")
            .execute(&store.pool)
            .await
            .unwrap();
        store.pool.close().await;

        let migrated = Store::connect(&path).await.unwrap();
        assert_eq!(migrated.executor_registry_revision().await.unwrap(), 0);
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&migrated.pool)
            .await
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[tokio::test]
    async fn verified_endpoint_update_rejects_a_stale_generation_without_partial_changes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::connect(&dir.path().join("federator.db"))
            .await
            .unwrap();
        store.insert_executor(&executor("1")).await.unwrap();
        store
            .update_executor_sparse("1", Some("Concurrent rename"), None, 2)
            .await
            .unwrap();

        let stale = store
            .update_executor_verified_endpoint(
                "1",
                1,
                Some("Stale rename"),
                Some(false),
                "http://127.0.0.1:9999",
                "future",
                "future",
                ExecutorStatus::Incompatible,
                Some("stale"),
                3,
            )
            .await
            .unwrap();
        assert!(stale.is_none());
        let retained = store.get_executor("1").await.unwrap().unwrap();
        assert_eq!(retained.generation, 2);
        assert_eq!(retained.display_name, "Concurrent rename");
        assert_eq!(retained.base_url, "http://127.0.0.1:91");
        assert!(retained.enabled);
        assert_eq!(retained.api_version, "4");
    }

    #[tokio::test]
    async fn executor_registry_revision_advances_atomically_and_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("federator.db");
        let store = Store::connect(&path).await.unwrap();
        assert_eq!(
            store.executor_registry_snapshot().await.unwrap(),
            (0, vec![])
        );

        assert_eq!(store.insert_executor(&executor("1")).await.unwrap(), 1);
        let (revision, rows) = store.executor_registry_snapshot().await.unwrap();
        assert_eq!(revision, 1);
        assert_eq!(rows.len(), 1);
        let mutation = store
            .update_executor_sparse("1", Some("Renamed"), None, 2)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(mutation.registry_revision, 2);
        assert_eq!(mutation.record.display_name, "Renamed");
        assert!(mutation.catalog_change.is_none());
        assert!(store.delete_executor("missing").await.unwrap().is_none());
        assert_eq!(store.executor_registry_revision().await.unwrap(), 2);
        assert_eq!(
            store.delete_executor("1").await.unwrap(),
            Some(DeleteExecutorOutcome {
                registry_revision: 3,
                catalog_revision: None,
                order_revision: None,
            })
        );
        drop(store);

        let reopened = Store::connect(&path).await.unwrap();
        assert_eq!(
            reopened.executor_registry_snapshot().await.unwrap(),
            (3, vec![])
        );
    }
}
