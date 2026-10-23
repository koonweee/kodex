//! Generated artifacts are projected only alongside their verified native anchor.
use super::{ThreadView, ThreadViewPatch, ThreadViewStore};
use crate::{
    app_server_api::{ThreadTimelineSnapshotItem, TimelineDisplayItemPayload},
    error::{ApiError, ApiResult},
    store::{AppSurfaceSession, AppSurfaceSessionUpsert, GeneratedAppOrigin, NewEvent, Store},
};
use serde_json::json;

impl ThreadView {
    pub(crate) fn projection_items(&self) -> Vec<ThreadTimelineSnapshotItem> {
        let mut native = self.items.clone();
        native.sort_by_key(|item| item.display_order);
        if self.generated_apps.is_empty() {
            return native;
        }
        let mut projected = Vec::new();
        for mut item in native {
            item.display_order = projected.len() as i64 + 1;
            projected.push(item.clone());
            for attachment in self
                .generated_apps
                .iter()
                .filter(|app| app.turn_id == item.turn_id && app.item_id == item.item_id)
            {
                let mut card = item.clone();
                card.id = format!("generated-app-{}", attachment.card.id);
                card.item_id = card.id.clone();
                card.item_type = "generatedApp".into();
                card.status = "completed".into();
                card.display_order = projected.len() as i64 + 1;
                card.codex_method = "thread_view/generated_app".into();
                card.payload = item.payload.clone();
                card.payload.item = TimelineDisplayItemPayload {
                    generated_app: Some(attachment.card.clone()),
                    ..Default::default()
                };
                card.payload.client_id = None;
                card.payload.skill_mentions.clear();
                card.payload.file_attachments.clear();
                projected.push(card);
            }
        }
        projected
    }
}

impl ThreadViewStore {
    pub async fn load_generated_apps(
        &self,
        store: &Store,
        thread_id: &str,
        captured_revision: i64,
    ) -> ApiResult<()> {
        let mut sessions = self.sessions.write().await;
        let view = sessions.entry(thread_id.to_owned()).or_default();
        view.ensure_history_current(captured_revision)?;
        view.generated_apps = store.generated_apps(thread_id).await?;
        Ok(())
    }

    pub async fn create_generated_app(
        &self,
        store: &Store,
        upsert: AppSurfaceSessionUpsert,
        origin: &GeneratedAppOrigin,
    ) -> ApiResult<(AppSurfaceSession, ThreadViewPatch)> {
        let mut sessions = self.sessions.write().await;
        let view = sessions.get_mut(&upsert.thread_id).ok_or_else(|| {
            ApiError::Conflict("Generated UI requires a live native originating tool call".into())
        })?;
        if origin.thread_id != upsert.thread_id
            || !view.items.iter().any(|item| {
                item.turn_id == origin.turn_id
                    && item.item_id == origin.item_id
                    && item.item_type == "mcpToolCall"
                    && item.status == "running"
                    && item.payload.item.tool.as_deref() == Some("create_app_surface")
                    && item.payload.item_snapshot.raw_payload["server"] == "kodex-control"
                    && arguments_match(
                        &item.payload.item_snapshot.raw_payload["arguments"],
                        &upsert,
                    )
            })
        {
            return Err(ApiError::Conflict("Generated UI origin must match its live native create_app_surface call in the explicit target thread".into()));
        }
        let session = store
            .create_generated_app(upsert, &origin.turn_id, &origin.item_id)
            .await?;
        view.generated_apps = store.generated_apps(&origin.thread_id).await?;
        let event = store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some(origin.thread_id.clone()),
                turn_id: Some(origin.turn_id.clone()),
                item_id: Some(origin.item_id.clone()),
                kind: "thread_view.cursor".into(),
                codex_method: Some("thread_view/cursor".into()),
                payload: json!({"reason":"generated_app_created","sessionId":session.id}),
            })
            .await?;
        view.revision = view.revision.max(event.seq);
        Ok((session, view.to_patch()))
    }
}

fn arguments_match(args: &serde_json::Value, upsert: &AppSurfaceSessionUpsert) -> bool {
    let Ok(args) = serde_json::from_value::<crate::mcp::AppSurfaceToolParams>(args.clone())
        .and_then(serde_json::to_value)
    else {
        return false;
    };
    let field = |key: &str| args.get(key).and_then(serde_json::Value::as_str);
    let normalize = |key: &str| args.get(key).cloned().unwrap_or_else(|| json!({}));
    field("threadId") == Some(upsert.thread_id.as_str())
        && field("title").map(str::trim) == Some(upsert.title.as_str())
        && field("html") == Some(upsert.html.as_str())
        && field("fallbackContent").map(str::trim) == Some(upsert.fallback_content.as_str())
        && serde_json::from_value::<crate::store::AppSurfaceCsp>(normalize("csp"))
            .ok()
            .and_then(|v| serde_json::to_value(v).ok())
            == serde_json::to_value(&upsert.csp).ok()
        && serde_json::from_value::<crate::store::AppSurfacePermissions>(normalize("permissions"))
            .ok()
            .and_then(|v| serde_json::to_value(v).ok())
            == serde_json::to_value(&upsert.permissions).ok()
        && serde_json::from_value::<crate::store::AppSurfaceGrants>(normalize("grants"))
            .ok()
            .and_then(|v| serde_json::to_value(v).ok())
            == serde_json::to_value(&upsert.grants).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn older_page_refills_restore_cards_only_at_present_anchors_without_duplicates() {
        use crate::app_server_api::ThreadTurnSnapshot;
        use crate::store::{GeneratedAppAttachment, GeneratedAppReference};
        let views = ThreadViewStore::default();
        views.initialize_empty("thread", 1).await;
        views
            .sessions
            .write()
            .await
            .get_mut("thread")
            .unwrap()
            .generated_apps = vec![GeneratedAppAttachment {
            card: GeneratedAppReference {
                id: "A".into(),
                title: "A".into(),
                fallback_content: "A".into(),
            },
            turn_id: "old".into(),
            item_id: "call".into(),
        }];
        let turn = |id: &str, item: serde_json::Value| ThreadTurnSnapshot {
            id: id.into(),
            status: "completed".into(),
            started_at: None,
            completed_at: None,
            raw_payload: json!({}),
            items: vec![crate::app_server_api::ThreadItemSnapshot::from_payload(&item).unwrap()],
        };
        let recent = turn(
            "new",
            json!({"id":"answer","type":"agentMessage","text":"New"}),
        );
        let old = turn(
            "old",
            json!({"id":"call","type":"mcpToolCall","server":"kodex-control","tool":"create_app_surface","arguments":{},"status":"completed"}),
        );
        let head = views
            .refresh_from_history_window("thread", &[recent], None, 2)
            .await
            .unwrap();
        assert!(!head.rows.iter().any(|row| row.kind == "generated_app"));
        for revision in [3, 4] {
            let full = views
                .prepend_history_page("thread", std::slice::from_ref(&old), None, revision)
                .await
                .unwrap();
            let identities = full
                .items
                .iter()
                .map(|item| item.item_id.as_str())
                .collect::<Vec<_>>();
            assert_eq!(identities, vec!["call", "generated-app-A", "answer"]);
            assert_eq!(
                full.rows
                    .iter()
                    .filter(|row| row.kind == "generated_app")
                    .count(),
                1
            );
            assert_eq!(
                serde_json::to_value(views.snapshot("thread").await.unwrap().rows).unwrap(),
                serde_json::to_value(full.rows).unwrap()
            );
        }
        assert!(views.snapshot("other-thread").await.is_none());
    }

    #[test]
    fn origin_arguments_share_mcp_aliases_nullable_defaults_and_preserved_html() {
        let args = json!({"thread_id":"thread","title":"  A  ","html":"\n<main>A</main>\n","fallbackContent":" A ","csp":null,"permissions":null,"grants":{"can_send_message":true}});
        let upsert = AppSurfaceSessionUpsert {
            thread_id: "thread".into(),
            provider: crate::store::AppSurfaceProvider::Generated,
            title: "A".into(),
            html: "\n<main>A</main>\n".into(),
            fallback_content: "A".into(),
            resource_uri: None,
            resource_mime_type: "text/html;profile=mcp-app".into(),
            display_modes: vec!["inline".into()],
            csp: Default::default(),
            permissions: Default::default(),
            grants: crate::store::AppSurfaceGrants {
                can_send_message: true,
                ..Default::default()
            },
            provenance: json!({}),
        };
        assert!(arguments_match(&args, &upsert));
        let mut altered = args.clone();
        altered["html"] = json!("<main>Different</main>");
        assert!(!arguments_match(&altered, &upsert));
        let mut escalated = args;
        escalated["grants"]["canOpenLinks"] = json!(true);
        assert!(!arguments_match(&escalated, &upsert));
    }
}
