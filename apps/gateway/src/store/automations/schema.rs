use crate::{error::ApiResult, store::Store};

const AUTOMATIONS: &str = r#"
            create table if not exists automations (
                id text primary key,
                name text not null,
                prompt text not null,
                provenance text,
                target_thread_id text,
                new_thread text,
                start_at text not null,
                repeat_every_seconds integer not null,
                next_run_at text not null,
                status text not null,
                paused_reason text,
                last_run_at text,
                last_native_queue_id text,
                last_error text,
                consecutive_failure_count integer not null default 0,
                created_at text not null,
                updated_at text not null,
                deleted_at text
            )
            "#;
const RUNS: &str = r#"
            create table if not exists automation_runs (
                id text primary key,
                automation_id text not null,
                target_thread_id text,
                new_thread text,
                scheduled_for text,
                phase text not null check (phase in ('admitting', 'queued', 'startRequested', 'dispatched', 'rejected', 'uncertain', 'removed')),
                native_queue_id text,
                turn_id text,
                error text,
                created_at text not null,
                updated_at text not null,
                unique (automation_id, scheduled_for)
            )
            "#;

impl Store {
    /// Evolve only the current native gateway schema; no legacy roots or IDs are imported.
    pub(in crate::store) async fn install_automation_schema(&self) -> ApiResult<()> {
        let mut tx = self.pool.begin().await?;
        for (table, schema) in [("automations", AUTOMATIONS), ("automation_runs", RUNS)] {
            let columns: Vec<String> =
                sqlx::query_scalar(&format!("select name from pragma_table_info('{table}')"))
                    .fetch_all(&mut *tx)
                    .await?;
            if !columns.is_empty() && !columns.iter().any(|name| name == "new_thread") {
                // SQLite cannot drop NOT NULL in place. Rebuild atomically,
                // copying current rows unchanged and leaving the new field null.
                sqlx::query(&format!(
                    "alter table {table} rename to {table}_before_fresh_chats"
                ))
                .execute(&mut *tx)
                .await?;
                sqlx::query(schema).execute(&mut *tx).await?;
                let columns = columns.join(", ");
                sqlx::query(&format!("insert into {table} ({columns}) select {columns} from {table}_before_fresh_chats")).execute(&mut *tx).await?;
                sqlx::query(&format!("drop table {table}_before_fresh_chats"))
                    .execute(&mut *tx)
                    .await?;
            } else {
                sqlx::query(schema).execute(&mut *tx).await?;
            }
        }
        tx.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{AutomationNewThread, AutomationUpdate};

    #[tokio::test]
    async fn current_native_automation_rows_survive_schema_upgrade_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gateway.db");
        let store = Store::connect(&path).await.unwrap();
        // Reproduce the immediately preceding native schema, not a legacy store.
        for (table, schema) in [("automation_runs", RUNS), ("automations", AUTOMATIONS)] {
            sqlx::query(&format!("drop table {table}"))
                .execute(&store.pool)
                .await
                .unwrap();
            let previous = schema
                .replace("target_thread_id text,", "target_thread_id text not null,")
                .replace("                new_thread text,", "");
            sqlx::query(&previous).execute(&store.pool).await.unwrap();
        }
        sqlx::query(r#"insert into automations (id,name,prompt,target_thread_id,start_at,repeat_every_seconds,next_run_at,status,created_at,updated_at,provenance) values ('a','Report','Keep prompt','existing','2026-10-11T00:00:00Z',60,'2026-10-11T00:00:00Z','paused','2026-10-11T00:00:00Z','2026-10-11T00:00:00Z','{"sourceType":"kodex_control"}')"#).execute(&store.pool).await.unwrap();
        sqlx::query("insert into automation_runs (id,automation_id,target_thread_id,phase,native_queue_id,created_at,updated_at) values ('r','a','existing','uncertain','native-row','2026-10-11T00:00:00Z','2026-10-11T00:00:00Z')").execute(&store.pool).await.unwrap();
        store.migrate().await.unwrap();
        let old = store.get_automation("a").await.unwrap();
        assert_eq!(old.prompt, "Keep prompt");
        assert_eq!(old.target_thread_id.as_deref(), Some("existing"));
        assert_eq!(old.provenance.unwrap()["sourceType"], "kodex_control");
        let receipt = store.get_automation_run("r").await.unwrap();
        assert_eq!(receipt.native_queue_id.as_deref(), Some("native-row"));
        store
            .update_automation(
                "a",
                AutomationUpdate {
                    new_thread: Some(AutomationNewThread {
                        cwd: Some("/fresh".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let fresh = store.create_automation_run_now("a").await.unwrap();
        store
            .update_automation(
                "a",
                AutomationUpdate {
                    target_thread_id: Some("edited".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        drop(store);
        let reopened = Store::connect(&path).await.unwrap();
        let fresh = reopened.get_automation_run(&fresh.id).await.unwrap();
        assert!(fresh.target_thread_id.is_none());
        assert_eq!(fresh.new_thread.unwrap().cwd.as_deref(), Some("/fresh"));
        assert_eq!(
            reopened
                .get_automation_run("r")
                .await
                .unwrap()
                .target_thread_id
                .as_deref(),
            Some("existing")
        );
        assert_eq!(
            reopened
                .get_automation("a")
                .await
                .unwrap()
                .target_thread_id
                .as_deref(),
            Some("edited")
        );
        let bound = reopened
            .bind_automation_run_thread(&fresh.id, "created")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(bound.target_thread_id.as_deref(), Some("created"));
        assert!(reopened
            .bind_automation_run_thread(&fresh.id, "another")
            .await
            .unwrap()
            .is_none());
    }
}
