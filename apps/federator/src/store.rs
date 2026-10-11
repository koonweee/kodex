use std::path::Path;

use anyhow::bail;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous},
    Pool, Sqlite,
};

const SCHEMA_VERSION: i64 = 1;

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
            sqlx::query("PRAGMA user_version = 1")
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
        Ok(Self { pool })
    }

    pub async fn ready(&self) -> bool {
        sqlx::query_scalar::<_, i64>("SELECT 1")
            .fetch_one(&self.pool)
            .await
            .is_ok()
    }
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
}
