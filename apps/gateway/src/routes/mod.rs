pub mod account;
#[cfg(test)]
mod account_usage_tests;
pub mod app_surfaces;
pub mod approvals;
pub mod automations;
pub mod capabilities;
pub mod composer_settings;
mod config_writes;
pub mod directories;
pub mod events;
pub(crate) mod file_content;
pub mod file_preview;
#[cfg(test)]
mod file_preview_tests;
pub mod frontend_updates;
pub mod health;
pub mod kodex_control_plugin;
pub mod mcp;
pub mod models;
#[cfg(test)]
mod native_compaction_tests;
#[cfg(test)]
mod native_config_tests;
#[cfg(test)]
mod native_control_target_tests;
#[cfg(test)]
mod native_control_tests;
#[cfg(test)]
mod native_history_tests;
#[cfg(test)]
mod native_identity_tests;
#[cfg(test)]
mod native_mcp_history_tests;
#[cfg(test)]
mod native_pins_tests;
#[cfg(test)]
mod native_read_errors_tests;
#[cfg(test)]
mod native_read_markers_tests;
#[cfg(test)]
mod native_reads_tests;
#[cfg(test)]
mod native_revert_tests;
#[cfg(test)]
mod native_skill_tests;
#[cfg(test)]
mod native_subagent_tests;
#[cfg(test)]
mod native_thread_goal_tests;
#[cfg(test)]
mod native_thread_settings_tests;
pub mod notifications;
pub mod permission_profiles;
pub mod pins;
pub mod projects;
#[cfg(test)]
mod removed_previews_tests;
pub mod self_control;
pub mod skills;
pub mod subagents;
pub mod terminals;
pub mod thread_goals;
pub mod thread_presence;
pub mod thread_settings;
pub mod threads;
pub mod turns;
pub mod uploads;
#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex as StdMutex,
        },
    };

    use async_trait::async_trait;
    use axum::{
        body::{to_bytes, Body},
        http::{
            header::{
                ACCEPT_ENCODING, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_SECURITY_POLICY,
                CONTENT_TYPE,
            },
            Request, StatusCode,
        },
    };
    use chrono::TimeZone;
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use tempfile::tempdir;
    use tokio::sync::Notify;
    use tokio::time::{timeout, Duration};
    use tower::ServiceExt;

    use crate::{
        api::{build_router, AppState},
        app_server::{tests::RecordingAppServer, AppServer, InboundMessage},
        app_server_api::{ThreadLiveState, UserInput},
        automations,
        config::Config,
        error::{ApiError, ApiResult},
        events::ingest_inbound,
        notifications::{
            process_due_deliveries, NotificationKind, NotificationPayload, PushDeliveryOutcome,
            PushSender,
        },
        store::{
            EventEnvelope, NewApproval, NewAutomation, NewEvent, NewNotificationDelivery,
            NewPushSubscription, NotificationDeliveryStatus, PushSubscription, Store,
        },
        thread_view,
    };

    async fn test_state() -> (AppState, Arc<RecordingAppServer>) {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(RecordingAppServer::default());
        app_server.ready.store(true, Ordering::SeqCst);
        (
            AppState::new(Config::default(), store, app_server.clone()),
            app_server,
        )
    }

    #[tokio::test]
    async fn health_and_openapi_routes_exist() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let health = app
            .clone()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let openapi = app
            .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(openapi.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn thread_view_presence_route_tracks_visible_and_hidden_clients() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let visible = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/view-presence")
                    .body(Body::from(
                        json!({"clientId": "client-1", "visible": true}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(visible.status(), StatusCode::NO_CONTENT);
        let body = to_bytes(visible.into_body(), usize::MAX).await.unwrap();
        assert!(body.is_empty());
        assert_eq!(state.thread_presence.foreground_viewer_count("thread-1"), 1);

        let hidden = app
            .oneshot(
                Request::post("/v1/threads/thread-1/view-presence")
                    .body(Body::from(
                        json!({"clientId": "client-1", "visible": false}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(hidden.status(), StatusCode::NO_CONTENT);
        assert_eq!(state.thread_presence.foreground_viewer_count("thread-1"), 0);
    }

    #[tokio::test]
    async fn thread_view_presence_snapshot_route_replaces_visible_threads_for_client() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let visible = app
            .clone()
            .oneshot(
                Request::put("/v1/thread-view-presence")
                    .body(Body::from(
                        json!({
                            "clientId": "client-1",
                            "visibleThreadIds": ["thread-1", "thread-2"]
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(visible.status(), StatusCode::NO_CONTENT);
        assert_eq!(state.thread_presence.foreground_viewer_count("thread-1"), 1);
        assert_eq!(state.thread_presence.foreground_viewer_count("thread-2"), 1);

        let replaced = app
            .oneshot(
                Request::put("/v1/thread-view-presence")
                    .body(Body::from(
                        json!({
                            "clientId": "client-1",
                            "visibleThreadIds": ["thread-2"]
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(replaced.status(), StatusCode::NO_CONTENT);
        assert_eq!(state.thread_presence.foreground_viewer_count("thread-1"), 0);
        assert_eq!(state.thread_presence.foreground_viewer_count("thread-2"), 1);
    }

    #[tokio::test]
    async fn default_routes_do_not_emit_wildcard_cors() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let response = app
            .clone()
            .oneshot(
                Request::get("/healthz")
                    .header("origin", "https://example.test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_ne!(
            response
                .headers()
                .get("access-control-allow-origin")
                .and_then(|value| value.to_str().ok()),
            Some("*")
        );
    }

    #[tokio::test]
    async fn kodex_control_plugin_reports_unavailable_app_server() {
        let (state, app_server) = test_state().await;
        app_server.ready.store(false, Ordering::SeqCst);
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/kodex-control-plugin")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["status"], "appServerUnavailable");
        assert_eq!(body["appServerReady"], false);
    }

    #[tokio::test]
    async fn notification_status_reports_vapid_configuration() {
        let (mut state, _) = test_state().await;
        Arc::make_mut(&mut state.config)
            .notifications
            .vapid_public_key = Some("public-key".to_string());
        Arc::make_mut(&mut state.config)
            .notifications
            .vapid_private_key = Some("private-key".to_string());
        Arc::make_mut(&mut state.config).notifications.vapid_subject =
            Some("mailto:admin@example.test".to_string());
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/notifications/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["configured"], true);
        assert_eq!(body["subscriptionsEnabled"], true);
        assert_eq!(body["vapidPublicKey"], "public-key");
    }

    #[tokio::test]
    async fn notification_subscription_routes_create_update_and_delete() {
        let (state, _) = test_state().await;
        let app = build_router(state);
        let create_body = json!({
            "endpoint": "https://push.example/sub-1",
            "keys": {
                "p256dh": "public-1",
                "auth": "auth-1"
            },
            "userAgent": "browser one"
        });

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/notifications/subscriptions")
                    .header("content-type", "application/json")
                    .body(Body::from(create_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let body = response_json(response).await;
        let subscription_id = body["subscription"]["id"].as_str().unwrap().to_string();
        assert_eq!(
            body["subscription"]["endpoint"],
            "https://push.example/sub-1"
        );

        let update_body = json!({
            "endpoint": "https://push.example/sub-1",
            "keys": {
                "p256dh": "public-2",
                "auth": "auth-2"
            },
            "userAgent": "browser two"
        });
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/notifications/subscriptions")
                    .header("content-type", "application/json")
                    .body(Body::from(update_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let body = response_json(response).await;
        assert_eq!(body["subscription"]["id"], subscription_id);
        assert!(body["subscription"].get("p256dh").is_none());
        assert!(body["subscription"].get("auth").is_none());
        assert_eq!(body["subscription"]["enabled"], true);

        let response = app
            .oneshot(
                Request::delete(format!("/v1/notifications/subscriptions/{subscription_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["subscription"]["id"], subscription_id);
        assert_eq!(body["subscription"]["enabled"], false);
    }

    #[tokio::test]
    async fn current_notification_subscription_reports_endpoint_status_and_disables_by_endpoint() {
        let (mut state, _) = test_state().await;
        Arc::make_mut(&mut state.config)
            .notifications
            .vapid_public_key = Some("public-key".to_string());
        Arc::make_mut(&mut state.config)
            .notifications
            .vapid_private_key = Some("private-key".to_string());
        Arc::make_mut(&mut state.config).notifications.vapid_subject =
            Some("mailto:admin@example.test".to_string());
        state
            .store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/current".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: Some("browser".to_string()),
            })
            .await
            .unwrap();
        let app = build_router(state);

        let missing = app
            .clone()
            .oneshot(
                Request::get(
                    "/v1/notifications/subscription/current?endpoint=https%3A%2F%2Fpush.example%2Fmissing",
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::OK);
        let body = response_json(missing).await;
        assert_eq!(body["configured"], true);
        assert_eq!(body["subscribed"], false);
        assert!(body["subscription"].is_null());

        let enabled = app
            .clone()
            .oneshot(
                Request::get(
                    "/v1/notifications/subscription/current?endpoint=https%3A%2F%2Fpush.example%2Fcurrent",
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(enabled.status(), StatusCode::OK);
        let body = response_json(enabled).await;
        assert_eq!(body["configured"], true);
        assert_eq!(body["subscribed"], true);
        assert_eq!(
            body["subscription"]["endpoint"],
            "https://push.example/current"
        );

        let disabled = app
            .clone()
            .oneshot(
                Request::delete(
                    "/v1/notifications/subscription/current?endpoint=https%3A%2F%2Fpush.example%2Fcurrent",
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(disabled.status(), StatusCode::OK);
        let body = response_json(disabled).await;
        assert_eq!(body["subscribed"], false);
        assert_eq!(body["subscription"]["enabled"], false);

        let disabled_status = app
            .oneshot(
                Request::get(
                    "/v1/notifications/subscription/current?endpoint=https%3A%2F%2Fpush.example%2Fcurrent",
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        let body = response_json(disabled_status).await;
        assert_eq!(body["subscribed"], false);
        assert_eq!(body["subscription"]["enabled"], false);
    }

    #[tokio::test]
    async fn current_notification_subscription_reports_unconfigured_state() {
        let (state, _) = test_state().await;
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get(
                    "/v1/notifications/subscription/current?endpoint=https%3A%2F%2Fpush.example%2Fcurrent",
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["configured"], false);
        assert_eq!(body["subscribed"], false);
    }

    #[tokio::test]
    async fn test_notification_route_reports_configuration_and_enqueues_for_active_subscriptions() {
        let (state, _) = test_state().await;
        let app = build_router(state);
        let unconfigured = app
            .oneshot(
                Request::post("/v1/notifications/test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unconfigured.status(), StatusCode::OK);
        let body = response_json(unconfigured).await;
        assert_eq!(body["configured"], false);
        assert_eq!(body["enqueued"], false);

        let (mut state, _) = test_state().await;
        Arc::make_mut(&mut state.config)
            .notifications
            .vapid_public_key = Some("public-key".to_string());
        Arc::make_mut(&mut state.config)
            .notifications
            .vapid_private_key = Some("private-key".to_string());
        Arc::make_mut(&mut state.config).notifications.vapid_subject =
            Some("mailto:admin@example.test".to_string());
        let app = build_router(state.clone());
        let no_active = app
            .oneshot(
                Request::post("/v1/notifications/test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = response_json(no_active).await;
        assert_eq!(body["configured"], true);
        assert_eq!(body["activeSubscriptionCount"], 0);
        assert_eq!(body["enqueued"], false);

        state
            .store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/active".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();
        let sender = Arc::new(RecordingPushSender::new(PushDeliveryOutcome::Sent));
        state = state.with_notification_sender(sender);
        let app = build_router(state.clone());
        let active = app
            .oneshot(
                Request::post("/v1/notifications/test")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = response_json(active).await;
        assert_eq!(body["configured"], true);
        assert_eq!(body["activeSubscriptionCount"], 1);
        assert_eq!(body["enqueued"], true);
        let delivery_id = body["deliveryIds"][0].as_str().unwrap();
        let delivery = state
            .store
            .get_notification_delivery(delivery_id)
            .await
            .unwrap();
        assert_eq!(delivery.kind, "test");
    }

    #[tokio::test]
    async fn terminal_turn_upsert_schedules_unread_agent_message_delivery() {
        let (mut state, app_server) = test_state().await;
        Arc::make_mut(&mut state.config)
            .notifications
            .recheck_delay_ms = 0;
        let sender = Arc::new(RecordingPushSender::new(PushDeliveryOutcome::Sent));
        state = state.with_notification_sender(sender.clone());
        state
            .store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/sub-1".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();
        app_server.queued_responses.lock().unwrap().extend([
            notification_thread_summary_response(
                "thread-1",
                "Octopus Heart Facts With An Overly Long Thread Title That Should Not Fill The Banner",
                json!("cli"),
                None,
            ),
            json!({"data": [
                {"turnId": "turn-1", "item": {"id": "item-agent-1", "type": "agentMessage", "phase": "final_answer", "text": "Yes, octopuses actually have three hearts.\n\nThey use two for their gills."}},
                {"turnId": "turn-1", "item": {"id": "item-tool-1", "type": "commandExecution", "aggregatedOutput": "Tool output should stay hidden."}}
            ], "nextCursor": null, "backwardsCursor": null}),
            json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
        ]);

        ingest_inbound(
            InboundMessage::Notification {
                method: "turn/upsert".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turn": {
                        "id": "turn-1",
                        "status": {"type": "completed"},
                        "items": []
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        process_due_deliveries(state.clone()).await.unwrap();
        let payloads = sender.payloads.lock().unwrap();
        assert_eq!(payloads.len(), 1);
        assert_eq!(payloads[0].kind, NotificationKind::UnreadAgentMessage);
        assert_eq!(payloads[0].thread_id.as_deref(), Some("thread-1"));
        assert_eq!(
            payloads[0].title,
            "Octopus Heart Facts With An Overly Long Thread T..."
        );
        assert_eq!(
            payloads[0].body.as_deref(),
            Some("Yes, octopuses actually have three hearts. They use two for their gills.")
        );
        assert_eq!(payloads[0].route, "/threads/thread-1");
        assert_eq!(payloads[0].badge_count, Some(0));
        assert!(payloads[0]
            .read_revision
            .is_some_and(|revision| revision > 0));
        assert_eq!(
            app_server
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(method, _)| method == "thread/read")
                .count(),
            1
        );

        let events = state
            .store
            .replay_events(None, None, Some("thread-1".to_string()))
            .await
            .unwrap();
        assert!(events
            .iter()
            .any(|event| event.kind == "notification.planned"));
    }

    #[tokio::test]
    async fn terminal_turn_planning_persists_pending_notification_delivery_before_worker_runs() {
        let (mut state, _) = test_state().await;
        Arc::make_mut(&mut state.config)
            .notifications
            .recheck_delay_ms = 60_000;

        ingest_inbound(
            InboundMessage::Notification {
                method: "turn/upsert".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turn": {
                        "id": "turn-1",
                        "status": {"type": "completed"},
                        "items": []
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let deliveries = state.store.list_notification_deliveries().await.unwrap();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].kind, "unreadAgentMessage");
        assert_eq!(deliveries[0].thread_id.as_deref(), Some("thread-1"));
        assert_eq!(deliveries[0].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(deliveries[0].status, NotificationDeliveryStatus::Pending);
        assert_eq!(deliveries[0].attempt_count, 0);
    }

    #[tokio::test]
    async fn duplicate_terminal_turn_notifications_enqueue_one_unread_agent_message_delivery() {
        let (mut state, _app_server) = test_state().await;
        Arc::make_mut(&mut state.config)
            .notifications
            .recheck_delay_ms = 60_000;

        for method in ["turn/upsert", "turn/completed"] {
            ingest_inbound(
                InboundMessage::Notification {
                    method: method.to_string(),
                    params: json!({
                        "threadId": "thread-1",
                        "turn": {
                            "id": "turn-1",
                            "status": {"type": "completed"},
                            "items": []
                        }
                    }),
                },
                &state,
            )
            .await
            .unwrap();
        }

        let deliveries = state.store.list_notification_deliveries().await.unwrap();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].kind, "unreadAgentMessage");
        assert_eq!(deliveries[0].thread_id.as_deref(), Some("thread-1"));
        assert_eq!(deliveries[0].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(deliveries[0].status, NotificationDeliveryStatus::Pending);
    }

    #[tokio::test]
    async fn already_seen_recheck_still_sends_unread_agent_message_delivery() {
        let (mut state, app_server) = test_state().await;
        Arc::make_mut(&mut state.config)
            .notifications
            .recheck_delay_ms = 0;
        let sender = Arc::new(RecordingPushSender::new(PushDeliveryOutcome::Sent));
        state = state.with_notification_sender(sender.clone());
        state
            .store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/sub-1".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();
        let completed = state
            .store
            .record_thread_completion("thread-1", "turn-1")
            .await
            .unwrap();
        state
            .store
            .mark_thread_seen("thread-1", "turn-1", completed.read_revision)
            .await
            .unwrap();
        app_server.queued_responses.lock().unwrap().extend([
            thread_read_response("thread-1", 0),
            json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
            json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
        ]);

        ingest_inbound(
            InboundMessage::Notification {
                method: "turn/upsert".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turn": {
                        "id": "turn-1",
                        "status": {"type": "completed"},
                        "items": []
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        process_due_deliveries(state.clone()).await.unwrap();
        assert_eq!(sender.payloads.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn disabled_thread_notification_setting_skips_unread_agent_message_delivery() {
        let (mut state, app_server) = test_state().await;
        Arc::make_mut(&mut state.config)
            .notifications
            .recheck_delay_ms = 0;
        let sender = Arc::new(RecordingPushSender::new(PushDeliveryOutcome::Sent));
        state = state.with_notification_sender(sender.clone());
        state
            .store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/sub-1".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();
        state
            .store
            .set_thread_notifications_enabled("thread-1", false)
            .await
            .unwrap();
        ingest_inbound(
            InboundMessage::Notification {
                method: "turn/upsert".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turn": {
                        "id": "turn-1",
                        "status": {"type": "completed"},
                        "items": []
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        process_due_deliveries(state.clone()).await.unwrap();
        assert!(sender.payloads.lock().unwrap().is_empty());
        assert!(app_server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn foreground_thread_view_presence_skips_unread_agent_message_delivery() {
        let (mut state, app_server) = test_state().await;
        Arc::make_mut(&mut state.config)
            .notifications
            .recheck_delay_ms = 0;
        let sender = Arc::new(RecordingPushSender::new(PushDeliveryOutcome::Sent));
        state = state.with_notification_sender(sender.clone());
        state
            .store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/sub-1".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();
        state
            .thread_presence
            .record_view("client-1", "thread-1", true);
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(thread_read_response("thread-1", 0));

        ingest_inbound(
            InboundMessage::Notification {
                method: "turn/upsert".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turn": {
                        "id": "turn-1",
                        "status": {"type": "completed"},
                        "items": []
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        process_due_deliveries(state.clone()).await.unwrap();
        assert!(sender.payloads.lock().unwrap().is_empty());
        assert_eq!(
            app_server.requests.lock().unwrap().as_slice(),
            &[(
                "thread/read".to_string(),
                json!({"threadId": "thread-1", "includeTurns": false}),
            )]
        );
    }

    #[tokio::test]
    async fn expired_thread_view_presence_allows_unread_agent_message_delivery() {
        let (mut state, app_server) = test_state().await;
        Arc::make_mut(&mut state.config)
            .notifications
            .recheck_delay_ms = 0;
        let sender = Arc::new(RecordingPushSender::new(PushDeliveryOutcome::Sent));
        state = state.with_notification_sender(sender.clone());
        state
            .store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/sub-1".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();
        state.thread_presence.record_view_at(
            "client-1",
            "thread-1",
            true,
            chrono::Utc::now()
                - crate::thread_presence::thread_view_presence_ttl()
                - chrono::Duration::milliseconds(1),
        );
        app_server.queued_responses.lock().unwrap().extend([
            thread_read_response("thread-1", 0),
            json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
            json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
        ]);

        ingest_inbound(
            InboundMessage::Notification {
                method: "turn/upsert".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turn": {
                        "id": "turn-1",
                        "status": {"type": "completed"},
                        "items": []
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        process_due_deliveries(state.clone()).await.unwrap();
        assert_eq!(sender.payloads.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn subagent_recheck_skips_unread_agent_message_delivery() {
        for (source, thread_source) in [
            (
                json!({
                    "subAgent": {
                        "thread_spawn": {
                            "parent_thread_id": "thread-parent",
                            "depth": 1
                        }
                    }
                }),
                None,
            ),
            (json!("cli"), Some("subagent")),
            (json!("cli"), Some("memory_consolidation")),
        ] {
            let (mut state, app_server) = test_state().await;
            Arc::make_mut(&mut state.config)
                .notifications
                .recheck_delay_ms = 0;
            let sender = Arc::new(RecordingPushSender::new(PushDeliveryOutcome::Sent));
            state = state.with_notification_sender(sender.clone());
            state
                .store
                .upsert_push_subscription(NewPushSubscription {
                    endpoint: "https://push.example/sub-1".to_string(),
                    p256dh: "public".to_string(),
                    auth: "auth".to_string(),
                    user_agent: None,
                })
                .await
                .unwrap();
            *app_server.next_response.lock().unwrap() = Some(notification_thread_summary_response(
                "thread-subagent",
                "Subagent",
                source,
                thread_source,
            ));

            ingest_inbound(
                InboundMessage::Notification {
                    method: "turn/upsert".to_string(),
                    params: json!({
                        "threadId": "thread-subagent",
                        "turn": {
                            "id": "turn-1",
                            "status": {"type": "completed"},
                            "items": []
                        }
                    }),
                },
                &state,
            )
            .await
            .unwrap();

            process_due_deliveries(state.clone()).await.unwrap();
            assert!(sender.payloads.lock().unwrap().is_empty());
            let deliveries = state.store.list_notification_deliveries().await.unwrap();
            assert_eq!(deliveries.len(), 1);
            assert_eq!(deliveries[0].status, NotificationDeliveryStatus::Sent);
            assert!(deliveries[0].last_error.is_none());
            assert!(deliveries[0].delivered_subscription_ids.is_empty());
            assert_eq!(
                app_server.requests.lock().unwrap().as_slice(),
                &[(
                    "thread/read".to_string(),
                    json!({"threadId":"thread-subagent","includeTurns":false}),
                )]
            );
        }
    }

    #[tokio::test]
    async fn permanent_push_failure_disables_stale_subscription() {
        let (state, _) = test_state().await;
        let sender = Arc::new(RecordingPushSender::new(PushDeliveryOutcome::StaleEndpoint));
        let state = state.with_notification_sender(sender);
        state
            .store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/stale".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();

        state
            .notifications
            .deliver_payload(
                &state,
                NotificationPayload {
                    kind: NotificationKind::UnreadAgentMessage,
                    thread_id: Some("thread-1".to_string()),
                    title: "Thread".to_string(),
                    body: Some("Thread\nAgent has a new message.".to_string()),
                    route: "/threads/thread-1".to_string(),
                    badge_count: Some(1),
                    read_revision: Some(1),
                },
            )
            .await
            .unwrap();
        assert!(state
            .store
            .list_enabled_push_subscriptions()
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn temporary_push_failure_keeps_subscription_enabled() {
        let (state, _) = test_state().await;
        let sender = Arc::new(RecordingPushSender::new(
            PushDeliveryOutcome::TemporaryFailure,
        ));
        let state = state.with_notification_sender(sender);
        state
            .store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/temporary".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();

        state
            .notifications
            .deliver_payload(
                &state,
                NotificationPayload {
                    kind: NotificationKind::UnreadAgentMessage,
                    thread_id: Some("thread-1".to_string()),
                    title: "Thread".to_string(),
                    body: Some("Thread\nAgent has a new message.".to_string()),
                    route: "/threads/thread-1".to_string(),
                    badge_count: Some(1),
                    read_revision: Some(1),
                },
            )
            .await
            .unwrap();

        let subscriptions = state.store.list_enabled_push_subscriptions().await.unwrap();
        assert_eq!(subscriptions.len(), 1);
        assert_eq!(subscriptions[0].endpoint, "https://push.example/temporary");
    }

    #[tokio::test]
    async fn durable_notification_delivery_retries_temporary_failure_without_disabling_subscription(
    ) {
        let (state, _) = test_state().await;
        let sender = Arc::new(RecordingPushSender::new(
            PushDeliveryOutcome::TemporaryFailure,
        ));
        let state = state.with_notification_sender(sender);
        state
            .store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/temporary".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();
        let delivery = state
            .store
            .create_notification_delivery(NewNotificationDelivery {
                kind: "test".to_string(),
                thread_id: None,
                turn_id: None,
                payload: Some(json!({
                    "kind": "test",
                    "title": "Kodex test notification",
                    "body": "Push notifications are working.",
                    "route": "/",
                    "badgeCount": 0
                })),
                available_at: chrono::Utc::now(),
            })
            .await
            .unwrap();

        process_due_deliveries(state.clone()).await.unwrap();

        let delivery = state
            .store
            .get_notification_delivery(&delivery.id)
            .await
            .unwrap();
        assert_eq!(delivery.status, NotificationDeliveryStatus::Pending);
        assert_eq!(delivery.attempt_count, 1);
        assert!(delivery
            .last_error
            .as_deref()
            .unwrap()
            .contains("temporary"));
        let subscriptions = state.store.list_enabled_push_subscriptions().await.unwrap();
        assert_eq!(subscriptions.len(), 1);
    }

    #[tokio::test]
    async fn durable_notification_delivery_disables_only_stale_endpoint() {
        let (state, _) = test_state().await;
        state
            .store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/stale".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();
        state
            .store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/active".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();
        let sender = Arc::new(SelectivePushSender {
            stale_endpoint: "https://push.example/stale".to_string(),
            payloads: StdMutex::new(Vec::new()),
        });
        let state = state.with_notification_sender(sender);
        let delivery = state
            .store
            .create_notification_delivery(NewNotificationDelivery {
                kind: "test".to_string(),
                thread_id: None,
                turn_id: None,
                payload: Some(json!({
                    "kind": "test",
                    "title": "Kodex test notification",
                    "body": "Push notifications are working.",
                    "route": "/",
                    "badgeCount": 0
                })),
                available_at: chrono::Utc::now(),
            })
            .await
            .unwrap();

        process_due_deliveries(state.clone()).await.unwrap();

        let delivery = state
            .store
            .get_notification_delivery(&delivery.id)
            .await
            .unwrap();
        assert_eq!(delivery.status, NotificationDeliveryStatus::Sent);
        let subscriptions = state.store.list_enabled_push_subscriptions().await.unwrap();
        assert_eq!(subscriptions.len(), 1);
        assert_eq!(subscriptions[0].endpoint, "https://push.example/active");
    }

    #[tokio::test]
    async fn durable_notification_delivery_retry_skips_already_sent_subscription() {
        let (state, _) = test_state().await;
        state
            .store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/active".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();
        state
            .store
            .upsert_push_subscription(NewPushSubscription {
                endpoint: "https://push.example/flaky".to_string(),
                p256dh: "public".to_string(),
                auth: "auth".to_string(),
                user_agent: None,
            })
            .await
            .unwrap();
        let sender = Arc::new(FlakyEndpointPushSender {
            flaky_endpoint: "https://push.example/flaky".to_string(),
            attempts_by_endpoint: StdMutex::new(HashMap::new()),
        });
        let state = state.with_notification_sender(sender.clone());
        let delivery = state
            .store
            .create_notification_delivery(NewNotificationDelivery {
                kind: "test".to_string(),
                thread_id: None,
                turn_id: None,
                payload: Some(json!({
                    "kind": "test",
                    "title": "Kodex test notification",
                    "body": "Push notifications are working.",
                    "route": "/",
                    "badgeCount": 0
                })),
                available_at: chrono::Utc::now(),
            })
            .await
            .unwrap();

        process_due_deliveries(state.clone()).await.unwrap();
        let retry = state
            .store
            .get_notification_delivery(&delivery.id)
            .await
            .unwrap();
        assert_eq!(retry.status, NotificationDeliveryStatus::Pending);
        assert_eq!(retry.delivered_subscription_ids.len(), 1);

        state
            .store
            .mark_notification_delivery_retry(
                &delivery.id,
                chrono::Utc::now(),
                "retry now".to_string(),
                &retry.delivered_subscription_ids,
            )
            .await
            .unwrap();
        process_due_deliveries(state.clone()).await.unwrap();

        let delivery = state
            .store
            .get_notification_delivery(&delivery.id)
            .await
            .unwrap();
        assert_eq!(delivery.status, NotificationDeliveryStatus::Sent);
        let attempts_by_endpoint = sender.attempts_by_endpoint.lock().unwrap();
        assert_eq!(
            attempts_by_endpoint.get("https://push.example/active"),
            Some(&1)
        );
        assert_eq!(
            attempts_by_endpoint.get("https://push.example/flaky"),
            Some(&2)
        );
    }

    #[tokio::test]
    async fn kodex_control_plugin_reports_not_installed() {
        let (mut state, app_server) = test_state().await;
        let marketplace_root = tempdir().unwrap();
        let marketplace_dir = marketplace_root.path().join(".agents/plugins");
        std::fs::create_dir_all(&marketplace_dir).unwrap();
        let marketplace_path = marketplace_dir.join("marketplace.json");
        std::fs::write(
            &marketplace_path,
            json!({"name": "kodex-local", "plugins": []}).to_string(),
        )
        .unwrap();
        Arc::make_mut(&mut state.config)
            .plugins
            .kodex_control_marketplace_path = Some(marketplace_path.clone());
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(plugin_read_response(false, &marketplace_path, None));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/kodex-control-plugin")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["status"], "notInstalled");
        assert_eq!(body["plugin"]["installed"], false);
        assert_eq!(body["skills"], json!(["generative-ui"]));
    }

    #[tokio::test]
    async fn kodex_control_plugin_reports_missing_marketplace_path() {
        let (mut state, _) = test_state().await;
        Arc::make_mut(&mut state.config)
            .plugins
            .kodex_control_marketplace_path = Some(tempdir().unwrap().path().join("missing.json"));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/kodex-control-plugin")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["status"], "setupError");
        assert!(body["setupError"]
            .as_str()
            .unwrap()
            .contains("marketplace was not found"));
    }

    #[tokio::test]
    async fn kodex_control_plugin_install_adds_marketplace_installs_and_broadcasts_skills() {
        let (mut state, app_server) = test_state().await;
        let marketplace_root = tempdir().unwrap();
        let marketplace_dir = marketplace_root.path().join(".agents/plugins");
        std::fs::create_dir_all(&marketplace_dir).unwrap();
        let marketplace_path = marketplace_dir.join("marketplace.json");
        std::fs::write(
            &marketplace_path,
            json!({
                "name": "kodex-local",
                "plugins": []
            })
            .to_string(),
        )
        .unwrap();
        Arc::make_mut(&mut state.config)
            .plugins
            .kodex_control_marketplace_path = Some(marketplace_path.clone());
        app_server.queued_responses.lock().unwrap().extend([
            json!({
                "alreadyAdded": false,
                "installedRoot": marketplace_root.path().display().to_string(),
                "marketplaceName": "kodex-local"
            }),
            json!({"appsNeedingAuth": [], "authPolicy": "onInstall"}),
            plugin_read_response(
                true,
                &marketplace_path,
                Some(
                    &marketplace_root
                        .path()
                        .join("installed/kodex-control/0.1.0"),
                ),
            ),
        ]);
        let mut receiver = state.events.subscribe();
        let skills = state.skills.clone();
        assert_eq!(skills.generation().await, 0);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/kodex-control-plugin/install")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["status"]["status"], "installed");
        assert_eq!(body["status"]["skills"], json!(["generative-ui"]));
        assert_eq!(body["status"]["mcpServers"][0], "kodex-control");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "marketplace/add");
        assert_eq!(
            requests[0].1["source"],
            marketplace_root.path().display().to_string()
        );
        assert_eq!(requests[1].0, "plugin/install");
        assert_eq!(
            requests[1].1["marketplacePath"],
            marketplace_path.display().to_string()
        );
        assert_eq!(requests[2].0, "plugin/read");
        assert_eq!(
            requests[2].1["marketplacePath"],
            marketplace_path.display().to_string()
        );

        let event = timeout(Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.kind, "skills.changed");
        assert_eq!(skills.generation().await, 1);
    }

    #[tokio::test]
    async fn self_control_status_reports_gateway_and_app_server_readiness() {
        let (state, app_server) = test_state().await;
        app_server.ready.store(false, Ordering::SeqCst);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/self-control/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["gatewayReady"], true);
        assert_eq!(body["appServerReady"], false);
        assert!(body["capabilities"].get("projectPreviewApply").is_none());
    }

    #[tokio::test]
    async fn shell_routes_report_readiness_capabilities_docs_and_openapi_paths() {
        let (state, app_server) = test_state().await;
        app_server.ready.store(false, Ordering::SeqCst);
        let app = build_router(state.clone());

        let ready = app
            .clone()
            .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(ready.status(), StatusCode::OK);
        let ready_body = response_json(ready).await;
        assert_eq!(ready_body["ready"], false);

        let capabilities = app
            .clone()
            .oneshot(
                Request::get("/v1/capabilities")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(capabilities.status(), StatusCode::OK);
        let capabilities_body = response_json(capabilities).await;
        assert_eq!(capabilities_body["gateway"]["sse"], true);
        assert_eq!(capabilities_body["appServer"]["ready"], false);
        assert_eq!(capabilities_body["appServer"]["schemaVersion"], "0.160.0");
        assert_eq!(
            capabilities_body["appServer"]["detectedVersionMatchesSchema"],
            Value::Null
        );

        let docs = app
            .clone()
            .oneshot(Request::get("/docs").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(docs.status().is_success() || docs.status().is_redirection());

        let openapi = app
            .oneshot(Request::get("/openapi.json").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let openapi = response_json(openapi).await;
        for path in [
            "/healthz",
            "/readyz",
            "/v1/capabilities",
            "/v1/composer-settings",
            "/v1/events",
            "/v1/debug/events",
            "/v1/projects",
            "/v1/projects/{projectId}",
            "/v1/threads",
            "/v1/sidebar/threads",
            "/v1/chats/threads",
            "/v1/pinned-threads",
            "/v1/threads/{threadId}",
            "/v1/threads/{threadId}/timeline/pages",
            "/v1/threads/{threadId}/subagents",
            "/v1/threads/{threadId}/name",
            "/v1/threads/{threadId}/settings",
            "/v1/threads/{threadId}/notifications",
            "/v1/threads/{threadId}/attach",
            "/v1/threads/{threadId}/resume",
            "/v1/threads/{threadId}/fork",
            "/v1/threads/{threadId}/archive",
            "/v1/threads/{threadId}/pin",
            "/v1/threads/{threadId}/turns",
            "/v1/threads/{threadId}/compact",
            "/v1/threads/{threadId}/turns/{turnId}/steer",
            "/v1/threads/{threadId}/turns/{turnId}/interrupt",
            "/v1/threads/{threadId}/queued-inputs",
            "/v1/threads/{threadId}/queued-inputs/{queueId}",
            "/v1/threads/{threadId}/queued-inputs/reorder",
            "/v1/threads/{threadId}/queued-inputs/start",
            "/v1/queue-transfers/{transferId}",
            "/v1/queue-transfers/{transferId}/reconcile",
            "/v1/threads/{threadId}/queued-inputs/{queueId}/steer",
            "/v1/threads/{threadId}/files/preview",
            "/v1/threads/{threadId}/files/content/{directory}/{filePath}",
            "/v1/threads/{threadId}/uploads/files",
            "/v1/uploads/images",
            "/v1/approvals",
            "/v1/approvals/{approvalId}",
            "/v1/approvals/{approvalId}/decision",
            "/v1/automations",
            "/v1/automations/{automationId}",
            "/v1/automations/{automationId}/pause",
            "/v1/automations/{automationId}/resume",
            "/v1/account",
            "/v1/account/login",
            "/v1/account/login/{loginId}/cancel",
            "/v1/account/logout",
            "/v1/account/rate-limits",
            "/v1/models",
            "/v1/permission-profiles",
            "/v1/notifications/status",
            "/v1/notifications/subscription/current",
            "/v1/notifications/subscriptions",
            "/v1/notifications/subscriptions/{subscriptionId}",
            "/v1/notifications/test",
            "/v1/skills",
            "/v1/kodex-control-plugin",
            "/v1/kodex-control-plugin/install",
            "/v1/mcp/configured-servers",
            "/v1/mcp/servers",
            "/v1/mcp/servers/{server}",
            "/v1/mcp/servers/{server}/enabled",
            "/v1/mcp/servers/{server}/resources/read",
            "/v1/mcp/servers/{server}/oauth-login",
            "/v1/mcp/reload",
            "/v1/self-control/status",
            "/v1/self-control/projects",
            "/v1/self-control/projects/{projectId}",
            "/v1/self-control/threads",
            "/v1/self-control/sidebar/threads",
            "/v1/self-control/threads/{threadId}",
            "/v1/self-control/threads/{threadId}/timeline/pages",
            "/v1/self-control/threads/{threadId}/subagents",
            "/v1/self-control/threads/{threadId}/queued-inputs",
            "/v1/self-control/threads/{threadId}/attach",
            "/v1/self-control/threads/{threadId}/resume",
            "/v1/self-control/threads/{threadId}/fork",
            "/v1/self-control/threads/{threadId}/name",
            "/v1/self-control/threads/{threadId}/settings",
            "/v1/self-control/threads/{threadId}/archive",
            "/v1/self-control/threads/{threadId}/pin",
            "/v1/self-control/threads/{threadId}/seen",
            "/v1/self-control/threads/{threadId}/compact",
            "/v1/self-control/threads/{threadId}/interrupt-current",
            "/v1/self-control/threads/{threadId}/input",
            "/v1/self-control/thread-spawns",
            "/v1/self-control/automations",
            "/v1/self-control/automations/{automationId}",
            "/v1/self-control/automations/{automationId}/pause",
            "/v1/self-control/automations/{automationId}/resume",
            "/v1/self-control/automations/{automationId}/run-now",
            "/v1/self-control/automations/validate",
            "/v1/self-control/approvals",
            "/v1/self-control/approvals/{approvalId}",
            "/v1/self-control/approvals/{approvalId}/decision",
            "/v1/self-control/events",
        ] {
            assert!(openapi["paths"].get(path).is_some(), "missing {path}");
        }
        for schema in [
            "ActivePermissionProfile",
            "PermissionProfileListResponse",
            "PermissionProfileSummary",
            "ThreadSettingsUpdateRequest",
            "ThreadSettingsUpdateResponse",
            "TimelineFileAttachment",
            "FileUploadResponse",
            "ThreadCompactDisposition",
            "ThreadCompactResponse",
        ] {
            assert!(
                openapi["components"]["schemas"].get(schema).is_some(),
                "missing {schema}"
            );
        }
        assert_eq!(
            openapi["paths"]["/v1/threads/{threadId}/compact"]["post"]["responses"]["409"]
                ["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/ApiErrorBody"
        );

        let upload_request_schema = &openapi["paths"]["/v1/uploads/images"]["post"]["requestBody"]
            ["content"]["multipart/form-data"]["schema"];
        let upload_request_schema = if let Some(reference) = upload_request_schema["$ref"].as_str()
        {
            let schema_name = reference.trim_start_matches("#/components/schemas/");
            &openapi["components"]["schemas"][schema_name]
        } else {
            upload_request_schema
        };
        assert_eq!(upload_request_schema["type"], "object");
        assert_eq!(
            upload_request_schema["properties"]["images"]["type"],
            "array"
        );
        assert_eq!(
            upload_request_schema["properties"]["images"]["items"]["type"],
            "string"
        );
        assert_eq!(
            upload_request_schema["properties"]["images"]["items"]["format"],
            "binary"
        );
        assert!(upload_request_schema["required"]
            .as_array()
            .is_some_and(|required| required.iter().any(|value| value == "images")));
        let file_upload_request_schema = &openapi["paths"]["/v1/threads/{threadId}/uploads/files"]
            ["post"]["requestBody"]["content"]["multipart/form-data"]["schema"];
        let file_upload_request_schema =
            if let Some(reference) = file_upload_request_schema["$ref"].as_str() {
                let schema_name = reference.trim_start_matches("#/components/schemas/");
                &openapi["components"]["schemas"][schema_name]
            } else {
                file_upload_request_schema
            };
        assert_eq!(file_upload_request_schema["type"], "object");
        assert_eq!(
            file_upload_request_schema["properties"]["files"]["type"],
            "array"
        );
        assert_eq!(
            file_upload_request_schema["properties"]["files"]["items"]["type"],
            "string"
        );
        assert_eq!(
            file_upload_request_schema["properties"]["files"]["items"]["format"],
            "binary"
        );
        assert!(file_upload_request_schema["required"]
            .as_array()
            .is_some_and(|required| required.iter().any(|value| value == "files")));
        assert!(openapi["components"]["schemas"]
            .get("QueuedInputStatus")
            .is_none());
        assert!(openapi["paths"]
            .get("/v1/threads/{threadId}/queued-inputs/{queueId}/retry")
            .is_none());
        assert_eq!(
            openapi["paths"]["/v1/threads/{threadId}/queued-inputs/{queueId}/steer"]["post"]
                ["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/PromotionOutcome"
        );
        assert_eq!(
            openapi["paths"]["/v1/threads/{threadId}/queued-inputs/{queueId}"]["delete"]
                ["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/QueuedInputDeleteResponse"
        );
    }

    #[tokio::test]
    async fn readyz_reports_app_server_incompatibility() {
        let (state, app_server) = test_state().await;
        *app_server.readiness_error.lock().unwrap() = Some(
            "configured Codex executable reports 0.159.0; required version is 0.160.0".to_string(),
        );
        let app = build_router(state.clone());

        let ready = app
            .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(ready.status(), StatusCode::OK);
        let body = response_json(ready).await;
        assert_eq!(body["ready"], false);
        assert_eq!(
            body["message"],
            "configured Codex executable reports 0.159.0; required version is 0.160.0"
        );
    }

    #[tokio::test]
    async fn project_routes_create_list_get_and_require_native_create_fields() {
        let (state, _) = test_state().await;
        let cwd = std::env::current_dir().unwrap().display().to_string();
        let app = build_router(state);

        let missing = app
            .clone()
            .oneshot(
                Request::post("/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(!missing.status().is_success());

        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"name": "Kodex", "roots": [{"path":cwd}], "idempotencyKey":"create-kodex"}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        let project = response_json(created).await;
        let project_id = project["id"].as_str().unwrap();

        let listed = app
            .clone()
            .oneshot(Request::get("/v1/projects").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let listed = response_json(listed).await;
        assert_eq!(listed["projects"][0]["id"], project_id);

        let fetched = app
            .oneshot(
                Request::get(format!("/v1/projects/{project_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let fetched = response_json(fetched).await;
        assert_eq!(fetched["id"], project_id);
    }

    #[tokio::test]
    async fn thread_start_maps_to_app_server() {
        let (state, app_server) = test_state().await;
        let project = app_server.seed_project(
            "Kodex".to_string(),
            std::env::current_dir().unwrap().display().to_string(),
        );
        let app = build_router(state);

        let body = json!({"projectId": project.id, "payload": {"prompt": "hi"}}).to_string();
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "project/read");
        assert_eq!(requests[0].1["projectId"], project.id);
        let requests = &requests[1..];
        assert_eq!(requests[0].0, "thread/start");
        assert_eq!(requests[0].1["historyMode"], "paginated");
        assert!(requests[0].1.get("cwd").is_some());
        assert!(requests[0].1.get("persistExtendedHistory").is_none());
    }

    #[tokio::test]
    async fn rename_thread_rejects_blank_name_before_app_server_call() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::patch("/v1/threads/thread-1/name")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"   "}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(app_server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn rename_thread_sets_trimmed_name_and_returns_canonical_summary() {
        let (state, app_server) = test_state().await;
        let mut renamed_thread = thread_summary("thread-1");
        renamed_thread["name"] = json!("Renamed thread");
        renamed_thread["preview"] = json!("The original user message");
        renamed_thread["updatedAt"] = json!(1_767_225_700_i64);
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .extend([json!({}), json!({ "thread": renamed_thread })]);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::patch("/v1/threads/thread-1/name")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"name":"  Renamed thread  "}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["thread"]["id"], "thread-1");
        assert_eq!(body["thread"]["name"], "Renamed thread");
        assert_eq!(body["thread"]["preview"], "The original user message");
        assert_eq!(body["thread"]["updatedAt"], 1_767_225_700_i64);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].0, "thread/name/set");
        assert_eq!(requests[0].1["threadId"], "thread-1");
        assert_eq!(requests[0].1["name"], "Renamed thread");
        assert_eq!(requests[1].0, "thread/read");
        assert_eq!(requests[1].1["threadId"], "thread-1");
        assert_eq!(requests[1].1["includeTurns"], false);
        assert_completion_head_request(&requests[2], "thread-1");
    }

    #[tokio::test]
    async fn thread_start_broadcasts_and_replays_thread_upserted_event() {
        let (state, app_server) = test_state().await;
        let project = app_server.seed_project(
            "Kodex".to_string(),
            std::env::current_dir().unwrap().display().to_string(),
        );
        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": thread_summary("project-thread-1"),
            "cwd": "/workspace"
        }));
        let mut receiver = state.events.subscribe();
        let app = build_router(state);

        let body = json!({"projectId": project.id, "payload": {"prompt": "hi"}}).to_string();
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let event = recv_event_kind(&mut receiver, "thread.upserted").await;
        assert_eq!(event.project_id.as_deref(), Some(project.id.as_str()));
        assert_eq!(event.thread_id.as_deref(), Some("project-thread-1"));
        assert_eq!(event.payload["scope"], "project");
        assert_eq!(event.payload["projectId"], project.id);
        assert_eq!(event.payload["thread"]["id"], "project-thread-1");

        let replay = app
            .oneshot(
                Request::get(format!(
                    "/v1/events?projectId={}&threadId=project-thread-1",
                    project.id
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::OK);
        let replay = response_json(replay).await;
        let replayed = replay["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|event| event["kind"] == "thread.upserted")
            .unwrap();
        assert_eq!(replayed["payload"]["thread"]["id"], "project-thread-1");
    }

    #[tokio::test]
    async fn self_control_thread_create_and_input_preserve_native_queue_and_source_audit() {
        let (state, app_server) = test_state().await;
        let project = app_server.seed_project("Kodex".to_string(), "/workspace/kodex".to_string());
        let app = build_router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "projectId":project.id,"model":"gpt-5.4",
                            "source":{"sourceToolCallId":"tool-create"},
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        let created = response_json(created).await;
        assert_eq!(created["thread"]["id"], "thread-1");
        assert_eq!(created["thread"]["model"], "gpt-5.4");
        let mut inputs = Vec::new();
        for (text, source) in [("start now", "tool-first"), ("follow up", "tool-second")] {
            if source == "tool-second" {
                mark_thread_session_active(&state, "thread-1", "user-active-turn").await;
                let mut active = thread_summary("thread-1");
                active["status"] = json!({"type":"active","activeFlags":[]});
                app_server
                    .queued_responses
                    .lock()
                    .unwrap()
                    .extend([json!({"thread":active}), json!({"thread":active})]);
            }
            let response = app.clone().oneshot(Request::post("/v1/self-control/threads/thread-1/input")
                .header("content-type", "application/json").body(Body::from(json!({
                    "input":[{"type":"text","text":text}],"source":{"sourceToolCallId":source},
                }).to_string())).unwrap()).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = response_json(response).await;
            assert_eq!(body["action"], "queued");
            assert!(body.get("turn").is_none());
            assert_eq!(
                body["queuedInput"]["input"],
                json!([{"type":"text","text":text}])
            );
            assert!(body["queuedInput"].get("sourceType").is_none());
            assert!(body["queuedInput"].get("sourceId").is_none());
            inputs.push((source, body["queuedInput"].clone()));
        }
        let requests = app_server.requests.lock().unwrap().clone();
        let adds = requests
            .iter()
            .filter(|(method, _)| method == "thread/queue/add")
            .collect::<Vec<_>>();
        assert_eq!(adds.len(), 2);
        assert!(requests.iter().all(|(method, _)| method != "turn/start"
            && method != "turn/steer"
            && method != "thread/resume"));
        let audit = state
            .store
            .replay_events(None, None, Some("thread-1".into()))
            .await
            .unwrap();
        for ((source, queued), (_, add)) in inputs.iter().zip(adds) {
            assert_eq!(
                add,
                &json!({"threadId":"thread-1","clientUserMessageId":queued["clientUserMessageId"],"input":queued["input"]})
            );
            let admitting = audit
                .iter()
                .find(|event| {
                    event.kind == "self_control.thread_input_admitting"
                        && event.payload["source"]["sourceToolCallId"] == *source
                })
                .unwrap();
            assert_eq!(
                admitting.payload["clientUserMessageId"],
                queued["clientUserMessageId"]
            );
            let accepted = audit
                .iter()
                .find(|event| {
                    event.kind == "self_control.thread_input"
                        && event.payload["source"]["sourceToolCallId"] == *source
                })
                .unwrap();
            assert_eq!(accepted.payload["action"], "queued");
            assert_eq!(accepted.payload["queuedInputId"], queued["id"]);
        }
        assert_ne!(
            inputs[0].1["clientUserMessageId"],
            inputs[1].1["clientUserMessageId"]
        );
    }

    #[tokio::test]
    async fn self_control_thread_input_returns_stale_thread_errors() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::NotFound("thread stale-thread".to_string()));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/self-control/threads/stale-thread/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"input": [{"type": "text", "text": "hi"}]}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn self_control_thread_input_queues_loaded_fresh_shell_without_resume() {
        let (state, app_server) = test_state().await;
        let response = build_router(state)
            .oneshot(
                Request::post("/v1/self-control/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "input":[{"type":"text","text":"first message"}],
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["action"], "queued");
        assert!(body.get("turn").is_none());
        assert_eq!(body["queuedInput"]["input"][0]["text"], "first message");
        let calls = app_server.requests.lock().unwrap();
        assert_eq!(
            calls
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            vec![
                "thread/read",
                "thread/read",
                "thread/queue/add",
                "thread/read",
                "thread/turns/list"
            ]
        );
        assert_eq!(
            calls[4].1,
            json!({"threadId":"thread-1","cursor":null,"sortDirection":"desc","itemsView":"notLoaded","limit":1})
        );
        assert!(calls
            .iter()
            .filter(|(method, _)| method == "thread/read")
            .all(|(_, params)| params["includeTurns"] == false));
    }

    #[tokio::test]
    async fn self_control_thread_input_activates_only_an_unloaded_target_before_admission() {
        let (state, app_server) = test_state().await;
        let mut cold = thread_summary("thread-1");
        cold["status"] = json!({"type":"notLoaded"});
        app_server.queued_responses.lock().unwrap().extend([
            json!({"thread":cold}),
            json!({"thread":thread_summary("thread-1"),"cwd":"/workspace"}),
        ]);
        let response = build_router(state)
            .oneshot(
                Request::post("/v1/self-control/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"input":[{"type":"text","text":"cold admission"}]}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let calls = app_server.requests.lock().unwrap();
        assert_eq!(
            calls
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            vec![
                "thread/read",
                "thread/resume",
                "thread/read",
                "thread/queue/add",
                "thread/read",
                "thread/turns/list"
            ]
        );
        assert_eq!(
            calls[1].1,
            json!({"threadId":"thread-1","excludeTurns":true})
        );
    }

    #[tokio::test]
    async fn self_control_thread_input_rejects_per_message_execution_options_before_admission() {
        let (state, app_server) = test_state().await;
        for extra in [
            json!({"model":"stale-model"}),
            json!({"options":{"effort":"high"}}),
            json!({"permissions":"full-access","sandboxPolicy":{"type":"dangerFullAccess"}}),
        ] {
            let mut body = extra;
            body["input"] = json!([{"type":"text","text":"invalid"}]);
            let response = build_router(state.clone())
                .oneshot(
                    Request::post("/v1/self-control/threads/thread-1/input")
                        .header("content-type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(matches!(
                response.status(),
                StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY
            ));
        }
        assert!(app_server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn self_control_source_type_must_be_kodex_control() {
        let (state, app_server) = test_state().await;
        let project = app_server.seed_project("Kodex".to_string(), "/workspace/kodex".to_string());
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/self-control/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "projectId": project.id,
                            "payload": {"prompt": "hi"},
                            "source": {"sourceType": "manual"}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(!response.status().is_success());
    }

    #[tokio::test]
    async fn self_control_read_discovery_routes_wrap_gateway_state() {
        let (state, app_server) = test_state().await;
        let project = app_server.seed_project("Kodex".to_string(), "/workspace/kodex".to_string());
        app_server
            .thread_list_responses_by_project_id
            .lock()
            .unwrap()
            .insert(
                project.id.clone(),
                json!({
                    "data": [thread_summary_with_cwd("thread-project", "/workspace/kodex")],
                    "nextCursor": null,
                    "backwardsCursor": null
                }),
            );
        let app = build_router(state);

        let projects = app
            .clone()
            .oneshot(
                Request::get("/v1/self-control/projects")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(projects.status(), StatusCode::OK);
        let body = response_json(projects).await;
        assert_eq!(body["projects"][0]["id"], project.id);

        let project_read = app
            .clone()
            .oneshot(
                Request::get(format!("/v1/self-control/projects/{}", project.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(project_read.status(), StatusCode::OK);

        let threads = app
            .clone()
            .oneshot(
                Request::get(format!("/v1/self-control/threads?projectId={}", project.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(threads.status(), StatusCode::OK);
        let body = response_json(threads).await;
        assert_eq!(body["threads"][0]["id"], "thread-project");

        let timeline_without_cursor = app
            .clone()
            .oneshot(
                Request::get("/v1/self-control/threads/thread-project/timeline/pages")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(timeline_without_cursor.status(), StatusCode::BAD_REQUEST);

        *app_server.next_response.lock().unwrap() = Some(json!({"data":[{
            "id":"native-queued-row", "clientUserMessageId":"native-client",
            "input":[{"type":"text","text":"queued"}]
        }],"nextCursor":null}));
        let queued = app
            .oneshot(
                Request::get("/v1/self-control/threads/thread-project/queued-inputs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(queued.status(), StatusCode::OK);
        let body = response_json(queued).await;
        assert_eq!(body["queuedInputs"][0]["input"][0]["text"], "queued");
    }

    #[tokio::test]
    async fn self_control_thread_lifecycle_routes_append_audit_events() {
        let (state, app_server) = test_state().await;
        let app = build_router(state.clone());
        let thread_id = "thread-1";
        let source_value = json!({
            "sourceThreadId": "source-thread",
            "sourceTurnId": "source-turn",
            "sourceToolCallId": "lifecycle-tool",
            "requestedBy": "user",
            "reason": "verify lifecycle provenance"
        });
        let source = json!({ "source": source_value.clone() });

        for (method, path, body) in [
            ("POST", "attach", source.clone()),
            ("POST", "resume", source.clone()),
            ("POST", "fork", source.clone()),
            (
                "PATCH",
                "name",
                json!({"name": "Lifecycle Thread", "source": source_value.clone()}),
            ),
            (
                "PATCH",
                "settings",
                json!({"model": "gpt-test", "source": source_value.clone()}),
            ),
            ("POST", "archive", source.clone()),
            (
                "POST",
                "pin",
                json!({"pinned":false,"source":source_value.clone()}),
            ),
            (
                "POST",
                "seen",
                json!({"completedTurnId": "control-completion", "readRevision": 0, "source": source_value.clone()}),
            ),
            ("POST", "compact", source.clone()),
            ("POST", "interrupt-current", source.clone()),
        ] {
            if path == "attach" {
                *app_server.next_response.lock().unwrap() = Some(json!({
                    "thread": thread_summary(thread_id),
                    "initialTurnsPage": {"data": [{
                        "id": "native-control-turn", "status": "completed",
                        "items": [{"id": "native-control-user", "type": "userMessage",
                            "clientId": "control-client", "content": [{"type": "text", "text": "Control history"}]}]
                    }], "nextCursor": null, "backwardsCursor": null}
                }));
            }
            let mut body = body;
            if path == "seen" {
                let head = state
                    .store
                    .record_thread_completion(thread_id, "control-completion")
                    .await
                    .unwrap();
                body["readRevision"] = json!(head.read_revision);
                app_server.queued_responses.lock().unwrap().push(json!({"data":[{"id":"control-completion", "status":"completed", "items":[]}], "nextCursor":null, "backwardsCursor":null}));
            }
            let uri = format!("/v1/self-control/threads/{thread_id}/{path}");
            let request = match method {
                "PATCH" => Request::patch(uri),
                "DELETE" => Request::delete(uri),
                _ => Request::post(uri),
            }
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                if path == "settings" {
                    StatusCode::ACCEPTED
                } else if path == "pin" {
                    StatusCode::NO_CONTENT
                } else {
                    StatusCode::OK
                },
                "{method} /{path} should succeed"
            );
            if path == "attach" {
                let body = response_json(response).await;
                assert!(body.get("disposition").is_none());
                assert_eq!(body["thread"]["id"], thread_id);
                let items = serialized_timeline_items(&body["timeline"]);
                assert_eq!(items.len(), 1);
                assert_eq!(items[0]["itemId"], "native-control-user");
                assert_eq!(items[0]["payload"]["clientId"], "control-client");
                let requests = app_server.requests.lock().unwrap();
                assert_eq!(
                    requests[0],
                    (
                        "thread/resume".to_string(),
                        json!({
                            "threadId": thread_id, "excludeTurns": true,
                            "initialTurnsPage": {"limit": 50, "sortDirection": "desc", "itemsView": "full"}
                        })
                    )
                );
            }
        }

        let event_kinds = state
            .store
            .replay_events(None, None, Some(thread_id.to_string()))
            .await
            .unwrap()
            .into_iter()
            .map(|event| (event.kind, event.payload))
            .collect::<Vec<_>>();
        for expected in [
            "self_control.thread_attached",
            "self_control.thread_resumed",
            "self_control.thread_forked",
            "self_control.thread_renamed",
            "self_control.thread_settings_update_queued",
            "self_control.thread_archived",
            "self_control.thread_pin_updated",
            "self_control.thread_seen",
            "self_control.thread_compacted",
            "self_control.thread_interrupted_current",
        ] {
            let Some((_, payload)) = event_kinds.iter().find(|(kind, _)| kind == expected) else {
                panic!("missing audit event {expected}; saw {event_kinds:?}");
            };
            assert!(
                payload["source"]["sourceThreadId"] == "source-thread"
                    && payload["source"]["sourceTurnId"] == "source-turn"
                    && payload["source"]["sourceToolCallId"] == "lifecycle-tool"
                    && payload["source"]["requestedBy"] == "user"
                    && payload["source"]["reason"] == "verify lifecycle provenance",
                "audit event {expected} should preserve source provenance; payload: {payload:?}"
            );
        }
    }

    #[tokio::test]
    async fn self_control_spawn_is_idempotent_and_enforces_depth() {
        let (state, app_server) = test_state().await;
        let project = app_server.seed_project("Kodex".to_string(), "/workspace/kodex".to_string());
        let app = build_router(state);
        let request = json!({
            "projectId": project.id,
            "input": [{"type": "text", "text": "start spawned thread"}],
            "idempotencyKey": "spawn-key-1",
            "maxSelfControlDepth": 2,
            "role": "reviewer",
            "source": {"sourceToolCallId": "tool-spawn"}
        });

        let first = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/thread-spawns")
                    .header("content-type", "application/json")
                    .body(Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let first_body = response_json(first).await;
        assert_eq!(first_body["threadId"], "thread-1");
        assert!(first_body["queuedSubmissionId"].is_string());
        assert!(first_body["clientUserMessageId"].is_string());
        assert!(first_body.get("input").is_none());
        assert!(first_body.get("thread").is_none());
        assert_eq!(first_body["remainingSelfControlDepth"], 1);
        assert_eq!(first_body["idempotentReplay"], false);

        let second = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/thread-spawns")
                    .header("content-type", "application/json")
                    .body(Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        let second_body = response_json(second).await;
        assert_eq!(second_body["threadId"], "thread-1");
        assert_eq!(second_body["idempotentReplay"], true);
        assert_eq!(
            second_body["queuedSubmissionId"],
            first_body["queuedSubmissionId"]
        );
        assert_eq!(
            second_body["clientUserMessageId"],
            first_body["clientUserMessageId"]
        );

        let exhausted = app
            .oneshot(
                Request::post("/v1/self-control/thread-spawns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "projectId": project.id,
                            "input": [{"type": "text", "text": "nope"}],
                            "maxSelfControlDepth": 0
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(exhausted.status(), StatusCode::BAD_REQUEST);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|(method, _)| method == "thread/start")
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|(method, _)| method == "thread/queue/add")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn self_control_automation_run_now_returns_native_admission_without_changing_cadence() {
        let (state, app_server) = test_state().await;
        let start_at = chrono::Utc::now();
        let automation = state
            .store
            .create_automation(NewAutomation {
                name: "Now".to_string(),
                prompt: "run this now".to_string(),
                target_thread_id: "thread-1".to_string(),
                start_at,
                repeat_every_seconds: 60,
                next_run_at: start_at,
                status: crate::store::AutomationStatus::Active,
                paused_reason: None,
                provenance: None,
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::post(format!(
                    "/v1/self-control/automations/{}/run-now",
                    automation.id
                ))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"source": {"sourceToolCallId": "tool-run-now"}}).to_string(),
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["run"]["targetThreadId"], "thread-1");
        assert_eq!(body["run"]["automationId"], automation.id);
        assert_eq!(body["run"]["phase"], "dispatched");
        assert!(body["run"]["scheduledFor"].is_null());
        assert!(body.get("queuedInput").is_none());
        let calls = app_server.requests.lock().unwrap().clone();
        let add = calls
            .iter()
            .find(|(method, _)| method == "thread/queue/add")
            .unwrap();
        assert_eq!(
            add.1,
            json!({"threadId":"thread-1", "clientUserMessageId":body["run"]["id"], "input":[{"type":"text","text":"run this now","text_elements":[]}]})
        );
        assert_eq!(
            calls
                .iter()
                .filter(|(method, _)| method == "thread/queue/add")
                .count(),
            1
        );
        assert!(calls
            .iter()
            .all(|(method, _)| method != "turn/start" && method != "turn/steer"));
        let after = state.store.get_automation(&automation.id).await.unwrap();
        assert_eq!(after.next_run_at, start_at);
        assert!(after.last_native_queue_id.is_none());
        assert_eq!(after.consecutive_failure_count, 0);
        let audits = state.store.replay_events(None, None, None).await.unwrap();
        assert!(audits
            .iter()
            .any(|event| event.payload["source"]["sourceToolCallId"] == "tool-run-now"));
    }

    #[tokio::test]
    async fn self_control_approval_policy_allows_denial_and_gates_approval() {
        let (state, app_server) = test_state().await;
        let deny = crate::approvals::receive_native(
            &state,
            NewApproval {
                request_id: "\"approval-deny\"".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-1".to_string()),
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            },
        )
        .await
        .unwrap();
        let approve = crate::approvals::receive_native(
            &state,
            NewApproval {
                request_id: "\"approval-accept\"".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-2".to_string()),
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            },
        )
        .await
        .unwrap();
        let app = build_router(state);

        let denied = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/self-control/approvals/{}/decision", deny.id))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"decision": {"decision": "decline"}}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::OK);

        let blocked = app
            .clone()
            .oneshot(
                Request::post(format!(
                    "/v1/self-control/approvals/{}/decision",
                    approve.id
                ))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"decision": {"decision": "accept"}}).to_string(),
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(blocked.status(), StatusCode::BAD_REQUEST);

        let accepted = app
            .oneshot(
                Request::post(format!(
                    "/v1/self-control/approvals/{}/decision",
                    approve.id
                ))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "decision": {"decision": "accept"},
                        "requestedBy": "user"
                    })
                    .to_string(),
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::OK);

        let responses = app_server.responses.lock().unwrap();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0].0, "\"approval-deny\"");
        assert_eq!(responses[1].0, "\"approval-accept\"");
    }

    #[tokio::test]
    async fn self_control_events_replay_rejects_conflicting_thread_filters() {
        let (state, _) = test_state().await;
        state
            .store
            .append_event(NewEvent {
                project_id: Some("project-1".to_string()),
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "custom".to_string(),
                codex_method: None,
                payload: json!({"ok": true}),
            })
            .await
            .unwrap();
        let app = build_router(state);

        let replay = app
            .clone()
            .oneshot(
                Request::get("/v1/self-control/events?threadId=thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::OK);
        let body = response_json(replay).await;
        assert_eq!(body["events"][0]["threadId"], "thread-1");

        let invalid = app
            .oneshot(
                Request::get("/v1/self-control/events?threadId=thread-1&excludeThreadId=thread-2")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn thread_start_forwards_initial_composer_settings() {
        let (state, app_server) = test_state().await;
        let project = app_server.seed_project(
            "Kodex".to_string(),
            std::env::current_dir().unwrap().display().to_string(),
        );
        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": {
                "id": "thread-1",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "hello",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            },
            "cwd": "/workspace",
            "model":"native-effective-model", "reasoningEffort":"medium", "serviceTier":null,
            "approvalPolicy":"never", "approvalsReviewer":"user", "sandbox":{"type":"readOnly"}
        }));
        let app = build_router(state.clone());

        let body = json!({
            "projectId": project.id,
            "model": "gpt-5.4",
            "effort": "high",
            "serviceTier": "fast",
            "approvalPolicy": "on-request",
            "approvalsReviewer": "auto_review",
            "sandbox": "workspace-write",
            "payload": {
                "prompt": "hi",
                "effort": "xhigh",
                "reasoningEffort": "xhigh"
            }
        })
        .to_string();
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["thread"]["model"], "native-effective-model");
        assert_eq!(body["thread"]["reasoningEffort"], "medium");
        assert!(body["thread"]["serviceTier"].is_null());
        assert_eq!(body["thread"]["approvalPolicy"], "never");
        assert_eq!(body["thread"]["approvalsReviewer"], "user");
        assert_eq!(body["thread"]["sandbox"]["type"], "readOnly");

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "id": "thread-1",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "hello",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let listed = app
            .oneshot(
                Request::get(format!("/v1/threads?projectId={}", project.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed = response_json(listed).await;
        assert_eq!(listed["threads"][0]["model"], Value::Null);
        assert_eq!(listed["threads"][0]["reasoningEffort"], Value::Null);
        assert_eq!(listed["threads"][0]["serviceTier"], Value::Null);
        assert!(listed["threads"][0]["approvalPolicy"].is_null());
        assert!(listed["threads"][0]["approvalsReviewer"].is_null());
        assert!(listed["threads"][0]["sandbox"].is_null());

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "project/read");
        assert_eq!(requests[0].1["projectId"], project.id);
        let requests = &requests[1..];
        assert_eq!(requests[0].0, "thread/start");
        assert_eq!(requests[0].1["prompt"], "hi");
        assert_eq!(requests[0].1["model"], "gpt-5.4");
        assert!(requests[0].1.get("effort").is_none());
        assert!(requests[0].1.get("reasoningEffort").is_none());
        assert_eq!(requests[0].1["serviceTier"], "fast");
        assert_eq!(requests[0].1["approvalPolicy"], "on-request");
        assert_eq!(requests[0].1["approvalsReviewer"], "auto_review");
        assert_eq!(requests[0].1["sandbox"], "workspace-write");
        assert!(requests[0].1.get("persistExtendedHistory").is_none());
    }

    #[tokio::test]
    async fn thread_settings_update_forwards_native_partial_patch_without_readback() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({}),
            json!({
                "thread": {
                    "id": "thread-1",
                    "cwd": "/workspace",
                    "status": {"type": "idle"},
                    "source": "cli",
                    "preview": "hello",
                    "model": "gpt-5.4-mini",
                    "reasoningEffort": null,
                    "serviceTier": "fast",
                    "approvalPolicy": "on-request",
                    "approvalsReviewer": "auto_review",
                    "sandbox": {"type":"workspaceWrite","networkAccess":false,"writableRoots":[]},
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_601_i64
                }
            }),
        ]);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::patch("/v1/threads/thread-1/settings")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "model": "gpt-5.4-mini",
                            "effort": null,
                            "serviceTier": "fast",
                            "approvalPolicy": "on-request",
                            "approvalsReviewer": "auto_review",
                            "sandboxPolicy": {"type":"workspaceWrite","networkAccess":false,"writableRoots":[]}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(response_json(response).await, json!({}));

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/settings/update");
        assert_eq!(requests[0].1["threadId"], "thread-1");
        assert_eq!(requests[0].1["model"], "gpt-5.4-mini");
        assert!(requests[0].1["effort"].is_null());
        assert_eq!(requests[0].1["serviceTier"], "fast");
        assert_eq!(requests[0].1["approvalPolicy"], "on-request");
        assert_eq!(requests[0].1["approvalsReviewer"], "auto_review");
        assert_eq!(requests[0].1["sandboxPolicy"]["type"], "workspaceWrite");
        assert_eq!(requests.len(), 1);
    }

    #[tokio::test]
    async fn thread_settings_update_rejects_permissions_and_sandbox_conflict() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::patch("/v1/threads/thread-1/settings")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "permissions": "fullAccess",
                            "sandboxPolicy": {"type":"dangerFullAccess"}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(app_server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn permission_profiles_route_paginates_and_resolves_project_cwd() {
        let (state, app_server) = test_state().await;
        let cwd = tempdir().unwrap().path().to_string_lossy().to_string();
        let project = app_server.seed_project("Kodex".to_string(), cwd.clone());
        app_server.queued_responses.lock().unwrap().extend([
            json!({
                "data": [
                    {"id": ":workspace", "description": "Ask before leaving the workspace"}
                ],
                "nextCursor": "next-page"
            }),
            json!({
                "data": [
                    {"id": "full-access", "description": null}
                ],
                "nextCursor": null
            }),
        ]);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get(format!("/v1/permission-profiles?projectId={}", project.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["profiles"][0]["id"], ":workspace");
        assert_eq!(body["profiles"][0]["label"], ":workspace");
        assert_eq!(
            body["profiles"][0]["description"],
            "Ask before leaving the workspace"
        );
        assert_eq!(body["profiles"][1]["id"], "full-access");
        assert_eq!(body["profiles"][1]["label"], "full-access");
        assert!(body["profiles"][1]["description"].is_null());

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "project/read");
        assert_eq!(requests[0].1["projectId"], project.id);
        let requests = &requests[1..];
        assert_eq!(requests[0].0, "permissionProfile/list");
        assert_eq!(requests[0].1["cwd"], cwd);
        assert!(requests[0].1["cursor"].is_null());
        assert_eq!(requests[1].0, "permissionProfile/list");
        assert_eq!(requests[1].1["cursor"], "next-page");
    }

    #[tokio::test]
    async fn create_and_turn_start_forward_native_permissions_profile_ids() {
        let (state, app_server) = test_state().await;
        let cwd = tempdir().unwrap().path().to_string_lossy().to_string();
        let project = app_server.seed_project("Kodex".to_string(), cwd);
        app_server.queued_responses.lock().unwrap().extend([
            json!({
                "thread": {
                    "id": "thread-1",
                    "cwd": "/workspace",
                    "status": {"type": "idle"},
                    "source": "cli",
                    "preview": "hello",
                    "activePermissionProfile": {"id": "auto-review"},
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_600_i64
                },
                "cwd": "/workspace"
            }),
            json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
            json!({"turn": {"id": "turn-1", "status": "inProgress"}}),
        ]);
        let app = build_router(state);

        let create = app
            .clone()
            .oneshot(
                Request::post("/v1/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "projectId": project.id,
                            "permissions": "auto-review",
                            "payload": {"prompt": "hi"}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(create.status(), StatusCode::OK);

        let turn = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "input": [{"type": "text", "text": "next"}],
                            "clientUserMessageId": "permission-choice",
                            "permissions": "read-only",
                            "serviceTier": null
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(turn.status(), StatusCode::OK);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "project/read");
        assert_eq!(requests[0].1["projectId"], project.id);
        let requests = &requests[1..];
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].0, "thread/start");
        assert_eq!(requests[0].1["permissions"], "auto-review");
        assert!(requests[0].1.get("approvalPolicy").is_none());
        assert!(requests[0].1.get("approvalsReviewer").is_none());
        assert!(requests[0].1.get("sandbox").is_none());
        assert_completion_head_request(&requests[1], "thread-1");
        assert_eq!(requests[2].0, "turn/start");
        assert_eq!(requests[2].1["clientUserMessageId"], "permission-choice");
        assert_eq!(requests[2].1["permissions"], "read-only");
        assert!(requests[2].1["serviceTier"].is_null());
        assert!(requests[2].1.get("approvalPolicy").is_none());
        assert!(requests[2].1.get("approvalsReviewer").is_none());
        assert!(requests[2].1.get("sandboxPolicy").is_none());
    }

    #[tokio::test]
    async fn thread_summaries_expose_active_permission_profile() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().push(json!({
            "data": [{
                "id": "thread-1",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "hello",
                "activePermissionProfile": {"id": ":workspace", "extends": "base"},
                "approvalPolicy": "never",
                "approvalsReviewer": "auto_review",
                "sandbox": {"type": "dangerFullAccess"},
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let app = build_router(state);

        let response = app
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(
            body["threads"][0]["activePermissionProfile"]["id"],
            ":workspace"
        );
        assert_eq!(
            body["threads"][0]["activePermissionProfile"]["extends"],
            "base"
        );
    }

    #[tokio::test]
    async fn chat_thread_start_creates_dated_slug_cwd_and_maps_to_app_server() {
        let (mut state, app_server) = test_state().await;
        let home = tempdir().unwrap();
        Arc::make_mut(&mut state.config).projects.home_dir = home.path().join(".");
        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": {
                "id": "chat-thread-1",
                "cwd": "/workspace/chat",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "chat",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            },
            "cwd": "/workspace/chat",
            "model":"gpt-5.4", "reasoningEffort":"high", "serviceTier":"fast",
            "approvalPolicy":"on-request", "approvalsReviewer":"auto_review", "sandbox":{"type":"workspaceWrite"}
        }));
        let app = build_router(state);

        let body = json!({
            "firstMessageText": "Build the Chat Sidebar!",
            "model": "gpt-5.4",
            "effort": "high",
            "serviceTier": "fast",
            "approvalPolicy": "on-request",
            "approvalsReviewer": "auto_review",
            "sandbox": "workspace-write",
            "payload": {"projectId":"must-not-assign"}
        })
        .to_string();
        let response = app
            .oneshot(
                Request::post("/v1/chats/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["thread"]["model"], "gpt-5.4");
        assert_eq!(body["thread"]["reasoningEffort"], "high");
        assert_eq!(body["thread"]["serviceTier"], "fast");
        assert_eq!(body["thread"]["approvalPolicy"], "on-request");
        assert_eq!(body["thread"]["approvalsReviewer"], "auto_review");
        assert_eq!(body["thread"]["sandbox"]["type"], "workspaceWrite");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/start");
        assert_eq!(requests[0].1.get("projectId"), Some(&Value::Null));
        assert_eq!(requests[0].1["model"], "gpt-5.4");
        assert!(requests[0].1.get("effort").is_none());
        assert_eq!(requests[0].1["config"]["model_reasoning_effort"], "high");
        assert_eq!(requests[0].1["serviceTier"], "fast");
        assert_eq!(requests[0].1["approvalPolicy"], "on-request");
        assert_eq!(requests[0].1["approvalsReviewer"], "auto_review");
        assert_eq!(requests[0].1["sandbox"], "workspace-write");
        assert!(requests[0].1.get("persistExtendedHistory").is_none());
        let cwd = requests[0].1["cwd"].as_str().unwrap();
        let today = chrono::Local::now()
            .date_naive()
            .format("%Y-%m-%d")
            .to_string();
        assert!(cwd.ends_with(&format!(
            "Documents{}Codex{}{}{}build-the-chat-sidebar",
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR,
            today,
            std::path::MAIN_SEPARATOR
        )));
        assert!(std::path::Path::new(cwd).is_dir());
    }

    #[tokio::test]
    async fn chat_thread_start_broadcasts_and_replays_thread_upserted_event() {
        let (mut state, app_server) = test_state().await;
        let home = tempdir().unwrap();
        Arc::make_mut(&mut state.config).projects.home_dir = home.path().join(".");
        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": thread_summary("chat-thread-1"),
            "cwd": "/workspace/chat"
        }));
        let mut receiver = state.events.subscribe();
        let app = build_router(state);

        let body = json!({"firstMessageText": "Build the Chat Sidebar!"}).to_string();
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/chats/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let event = recv_event_kind(&mut receiver, "thread.upserted").await;
        assert_eq!(event.project_id.as_deref(), None);
        assert_eq!(event.thread_id.as_deref(), Some("chat-thread-1"));
        assert_eq!(event.payload["scope"], "chat");
        assert_eq!(event.payload["projectId"], Value::Null);
        assert_eq!(event.payload["thread"]["id"], "chat-thread-1");

        let replay = app
            .oneshot(
                Request::get("/v1/events?threadId=chat-thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::OK);
        let replay = response_json(replay).await;
        let replayed = replay["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|event| event["kind"] == "thread.upserted")
            .unwrap();
        assert_eq!(replayed["payload"]["scope"], "chat");
    }

    #[tokio::test]
    async fn chat_thread_list_uses_native_unassigned_membership_outside_scratch_folders() {
        let (mut state, app_server) = test_state().await;
        let home = tempdir().unwrap();
        Arc::make_mut(&mut state.config).projects.home_dir = home.path().to_path_buf();
        let mut thread = thread_summary("unassigned-thread");
        thread["cwd"] = json!("/workspace/existing-project-folder");
        thread["projectId"] = Value::Null;
        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [thread], "nextCursor": null, "backwardsCursor": null
        }));
        let response = build_router(state)
            .oneshot(
                Request::get("/v1/chats/threads")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"].as_array().unwrap().len(), 1);
        assert_eq!(body["threads"][0]["id"], "unassigned-thread");
        assert_eq!(body["threads"][0]["projectId"], Value::Null);
        assert!(!home.path().join("Documents").exists());
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/list");
        assert_eq!(requests[0].1.get("projectId"), Some(&Value::Null));
        assert!(requests[0].1.get("cwd").is_none());
        assert_eq!(requests[0].1["cursor"], Value::Null);
        assert_eq!(requests[0].1["limit"], 100);
        assert_eq!(requests[0].1["sortKey"], "updated_at");
        assert_eq!(requests[0].1["archived"], false);
        assert_eq!(requests[0].1["useStateDbOnly"], true);
    }

    #[tokio::test]
    async fn chat_thread_list_preserves_cursor_and_uses_requested_limit() {
        let (mut state, app_server) = test_state().await;
        let home = tempdir().unwrap();
        Arc::make_mut(&mut state.config).projects.home_dir = home.path().to_path_buf();
        let chat_cwd = home
            .path()
            .join("Documents")
            .join("Codex")
            .join("2026-05-06")
            .join("chat-thread");
        std::fs::create_dir_all(&chat_cwd).unwrap();
        let chat_cwd = std::fs::canonicalize(chat_cwd).unwrap();
        let mut thread = thread_summary("chat-thread");
        thread["cwd"] = json!(chat_cwd.to_string_lossy().to_string());
        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [thread],
            "nextCursor": "next-page",
            "backwardsCursor": null
        }));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/chats/threads?cursor=cursor-1&limit=25")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"].as_array().unwrap().len(), 1);
        assert_eq!(body["nextCursor"], "next-page");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].0, "thread/list");
        assert_eq!(requests[0].1["cursor"], "cursor-1");
        assert_eq!(requests[0].1["limit"], 25);
        assert_eq!(requests[0].1["archived"], false);
        assert_eq!(requests[0].1["useStateDbOnly"], true);
        assert_completion_head_request(&requests[1], "chat-thread");
    }

    #[tokio::test]
    async fn chat_thread_list_filters_archived_threads() {
        let (mut state, app_server) = test_state().await;
        let home = tempdir().unwrap();
        Arc::make_mut(&mut state.config).projects.home_dir = home.path().to_path_buf();
        let chat_cwd = home
            .path()
            .join("Documents")
            .join("Codex")
            .join("2026-05-09")
            .join("chat-thread");
        std::fs::create_dir_all(&chat_cwd).unwrap();
        let chat_cwd = std::fs::canonicalize(chat_cwd).unwrap();
        let mut archived_thread = thread_summary("archived-chat");
        archived_thread["cwd"] = json!(chat_cwd.to_string_lossy().to_string());
        archived_thread["archived"] = json!(true);
        let mut visible_thread = thread_summary("visible-chat");
        visible_thread["cwd"] = json!(chat_cwd.to_string_lossy().to_string());
        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [archived_thread, visible_thread],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/chats/threads")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"].as_array().unwrap().len(), 1);
        assert_eq!(body["threads"][0]["id"], "visible-chat");
    }

    #[tokio::test]
    async fn thread_list_project_filter_forwards_native_membership() {
        let (state, app_server) = test_state().await;
        let cwd = std::env::current_dir().unwrap().display().to_string();
        let project = app_server.seed_project("Kodex".to_string(), cwd.clone());
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get(format!("/v1/threads?projectId={}", project.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/list");
        assert_eq!(requests[0].1["projectId"], project.id);
        assert!(requests[0].1.get("cwd").is_none());
        assert_eq!(requests[0].1["sortKey"], "updated_at");
        assert_eq!(requests[0].1["sortDirection"], "desc");
        assert_eq!(requests[0].1["archived"], false);
        assert_eq!(requests[0].1["useStateDbOnly"], true);
    }

    #[tokio::test]
    async fn sidebar_threads_snapshot_groups_native_projects_chats_and_pins() {
        let (mut state, app_server) = test_state().await;
        let home = tempdir().unwrap();
        Arc::make_mut(&mut state.config).projects.home_dir = home.path().to_path_buf();
        let project_one_cwd = home.path().join("project-one");
        let project_two_cwd = project_one_cwd.clone();
        std::fs::create_dir_all(&project_one_cwd).unwrap();
        std::fs::create_dir_all(&project_two_cwd).unwrap();
        let project_one_cwd = std::fs::canonicalize(project_one_cwd).unwrap();
        let project_two_cwd = std::fs::canonicalize(project_two_cwd).unwrap();
        let project_one = app_server.seed_project(
            "One".to_string(),
            project_one_cwd.to_string_lossy().to_string(),
        );
        let project_two = app_server.seed_project(
            "Two".to_string(),
            project_two_cwd.to_string_lossy().to_string(),
        );
        let completed = state
            .store
            .record_thread_completion("project-one-thread", "project-one-completed")
            .await
            .unwrap();
        state
            .store
            .mark_thread_seen(
                "project-one-thread",
                "project-one-completed",
                completed.read_revision,
            )
            .await
            .unwrap();
        let chat_cwd = home
            .path()
            .join("Documents")
            .join("Codex")
            .join("2026-05-07")
            .join("chat-thread");
        std::fs::create_dir_all(&chat_cwd).unwrap();
        let chat_cwd = std::fs::canonicalize(chat_cwd).unwrap();
        let mut project_one_thread = thread_summary("project-one-thread");
        project_one_thread["cwd"] = json!(project_one_cwd.to_string_lossy().to_string());
        project_one_thread["projectId"] = json!(project_one.id);
        project_one_thread["preview"] = json!({"text": "Project one preview"});
        project_one_thread["status"] = json!({"type": "active"});
        project_one_thread["model"] = json!("gpt-5.4-mini");
        project_one_thread["reasoningEffort"] = json!("high");
        project_one_thread["serviceTier"] = json!("fast");
        project_one_thread["approvalPolicy"] = json!("on-request");
        project_one_thread["approvalsReviewer"] = json!("auto_review");
        project_one_thread["sandbox"] =
            json!({"type":"workspaceWrite","networkAccess":false,"writableRoots":["/workspace"]});
        project_one_thread["gitInfo"] = json!({
            "branch": "feature/sidebar-trim",
            "originUrl": "https://example.test/kodex.git",
            "sha": "abc123",
        });
        let mut project_two_thread = thread_summary("project-two-thread");
        project_two_thread["cwd"] = json!(project_two_cwd.to_string_lossy().to_string());
        project_two_thread["projectId"] = json!(project_two.id);
        let mut chat_thread = thread_summary("chat-thread");
        chat_thread["cwd"] = json!(chat_cwd.to_string_lossy().to_string());
        let listed_projects = [project_one.clone(), project_two.clone()];
        let mut project_responses_by_id = std::collections::HashMap::new();
        for project in &listed_projects {
            if project.id == project_one.id {
                project_responses_by_id.insert(
                    project.id.clone(),
                    json!({"data": [project_one_thread.clone()], "nextCursor": null, "backwardsCursor": null}),
                );
            } else {
                project_responses_by_id.insert(
                    project.id.clone(),
                    json!({"data": [project_two_thread.clone()], "nextCursor": "project-two-next", "backwardsCursor": null}),
                );
            }
        }
        app_server
            .thread_list_responses_by_project_id
            .lock()
            .unwrap()
            .extend(project_responses_by_id);
        let mut queued = Vec::new();
        queued.push(
            json!({"data": [chat_thread], "nextCursor": "chat-next", "backwardsCursor": null}),
        );
        let section = json!({"id":crate::app_server_api::PINNED_THREAD_SECTION_ID,"name":"Pinned","appearance":null});
        let mut section_thread = thread_summary("section-thread");
        section_thread["projectId"] = json!(project_one.id);
        section_thread["section"] = section.clone();
        section_thread["sectionEnteredAt"] = json!(123);
        app_server
            .thread_list_responses_by_section_id
            .lock()
            .unwrap()
            .insert(
                crate::app_server_api::PINNED_THREAD_SECTION_ID.into(),
                json!({"data":[section_thread],"nextCursor":"section-next","backwardsCursor":null}),
            );
        app_server.queued_responses.lock().unwrap().extend(queued);
        let app = build_router(state);

        let response = app
            .clone()
            .oneshot(
                Request::get("/v1/sidebar/threads")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["projects"].as_array().unwrap().len(), 2);
        assert_eq!(
            body["projectThreads"][project_one.id.as_str()]["threads"][0]["id"],
            "project-one-thread"
        );
        assert_eq!(
            body["projectThreads"][project_two.id.as_str()]["threads"][0]["id"],
            "project-two-thread"
        );
        assert_eq!(
            body["projectThreads"][project_two.id.as_str()]["nextCursor"],
            "project-two-next"
        );
        assert!(body["projectThreads"][project_one.id.as_str()]["rawPayload"].is_null());
        assert!(
            body["projectThreads"][project_one.id.as_str()]["threads"][0]["rawPayload"].is_null()
        );
        let project_one_compact = &body["projectThreads"][project_one.id.as_str()]["threads"][0];
        assert_eq!(project_one_compact["projectId"], project_one.id);
        assert_eq!(
            body["projectThreads"][project_two.id.as_str()]["threads"][0]["projectId"],
            project_two.id
        );
        assert_eq!(project_one_compact["status"], "active");
        assert_eq!(
            project_one_compact["preview"],
            json!({"text": "Project one preview"})
        );
        assert_eq!(
            project_one_compact["gitInfo"]["branch"],
            "feature/sidebar-trim"
        );
        assert_eq!(
            project_one_compact["gitInfo"]["originUrl"],
            "https://example.test/kodex.git"
        );
        assert_eq!(project_one_compact["gitInfo"]["sha"], "abc123");
        assert_eq!(project_one_compact["model"], "gpt-5.4-mini");
        assert_eq!(project_one_compact["reasoningEffort"], "high");
        assert_eq!(project_one_compact["serviceTier"], "fast");
        assert_eq!(project_one_compact["approvalPolicy"], "on-request");
        assert_eq!(project_one_compact["approvalsReviewer"], "auto_review");
        assert_eq!(
            project_one_compact["sandbox"],
            json!({
                "type": "workspaceWrite",
                "networkAccess": false,
                "writableRoots": ["/workspace"]
            })
        );
        assert_eq!(
            project_one_compact["seenCompletedTurnId"],
            "project-one-completed"
        );
        assert_eq!(project_one_compact["unreadCompletedAgentTurn"], false);
        assert_eq!(body["chatThreads"]["threads"][0]["id"], "chat-thread");
        assert_eq!(body["chatThreads"]["nextCursor"], "chat-next");
        assert!(body["chatThreads"]["rawPayload"].is_null());
        assert!(body["chatThreads"]["threads"][0]["rawPayload"].is_null());
        let section_page = &body["pinnedThreads"];
        assert_eq!(section_page["threads"][0]["id"], "section-thread");
        assert_eq!(section_page["threads"][0]["pinned"], true);
        assert_eq!(section_page["threads"][0]["projectId"], project_one.id);
        assert_eq!(section_page["nextCursor"], "section-next");
        assert!(section_page["rawPayload"].is_null());
        assert!(section_page["threads"][0]["rawPayload"].is_null());
        assert!(section_page["threads"][0].get("pinnedAt").is_none());

        // The native project-keyed fixture already serves this scoped page;
        // no FIFO reply should be consumed by its separate completion read.
        let scoped_response = app
            .clone()
            .oneshot(
                Request::get(format!(
                    "/v1/threads?projectId={}&limit=100",
                    project_two.id
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(scoped_response.status(), StatusCode::OK);
        let scoped_body = response_json(scoped_response).await;
        assert_eq!(
            body["projectThreads"][project_two.id.as_str()]["threads"][0]["id"],
            scoped_body["threads"][0]["id"]
        );
        assert_eq!(
            body["projectThreads"][project_two.id.as_str()]["nextCursor"],
            scoped_body["nextCursor"]
        );

        let requests = app_server.requests.lock().unwrap();
        assert!(!requests
            .iter()
            .any(|(method, _)| method.starts_with("threadSection/")));
        assert_eq!(requests[0].0, "project/list");
        let mut completion_reads = requests
            .iter()
            .filter(|(method, _)| method == "thread/turns/list")
            .map(|request| {
                let id = request.1["threadId"].as_str().unwrap();
                assert_completion_head_request(request, id);
                id
            })
            .collect::<Vec<_>>();
        completion_reads.sort();
        assert_eq!(
            completion_reads,
            [
                "chat-thread",
                "project-one-thread",
                "project-two-thread",
                "project-two-thread",
                "section-thread"
            ]
        );
        for project in &listed_projects {
            let request = requests
                .iter()
                .find(|(method, params)| {
                    method == "thread/list"
                        && params["projectId"] == project.id
                        && params["limit"] == 10
                })
                .unwrap();
            assert_eq!(request.1["sortKey"], "updated_at");
            assert_eq!(request.1["sortDirection"], "desc");
            assert_eq!(request.1["archived"], false);
            assert_eq!(request.1["useStateDbOnly"], true);
        }
        assert!(requests.iter().any(|(method, params)| {
            method == "thread/list"
                && params["limit"] == 10
                && params["archived"] == false
                && params["useStateDbOnly"] == true
                && params.get("projectId") == Some(&Value::Null)
                && params.get("cwd").is_none()
        }));
        assert!(!requests.iter().any(|(method, _)| method == "thread/read"));
        let section_request = requests
            .iter()
            .find(|(method, params)| {
                method == "thread/list"
                    && params["sectionId"] == crate::app_server_api::PINNED_THREAD_SECTION_ID
            })
            .unwrap();
        assert_eq!(section_request.1["sortKey"], "section_position");
        assert_eq!(section_request.1["sortDirection"], "asc");
        assert_eq!(section_request.1["limit"], 10);
        let scoped_request = requests
            .iter()
            .rev()
            .find(|(method, _)| method == "thread/list")
            .unwrap();
        assert_eq!(scoped_request.1["projectId"], project_two.id);
        assert_eq!(scoped_request.1["limit"], 100);
    }

    #[tokio::test]
    async fn sidebar_threads_fetches_project_groups_concurrently() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(BlockingThreadListAppServer::default());
        let state = AppState::new(Config::default(), store, app_server.clone());
        app_server
            .projects
            .seed_project("One".to_string(), "/workspace/one".to_string());
        app_server
            .projects
            .seed_project("Two".to_string(), "/workspace/two".to_string());
        let app = build_router(state);
        let release = app_server.release.clone();

        let request = tokio::spawn(async move {
            app.oneshot(
                Request::get("/v1/sidebar/threads")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
        });

        timeout(Duration::from_secs(2), async {
            loop {
                if app_server.max_in_flight.load(Ordering::SeqCst) >= 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        release.notify_waiters();

        let response = request.await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(app_server.total_requests.load(Ordering::SeqCst), 2);
        assert_eq!(app_server.max_in_flight.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn thread_list_filters_archived_threads() {
        let (state, app_server) = test_state().await;
        let cwd = std::env::current_dir().unwrap().display().to_string();
        let project = app_server.seed_project("Kodex".to_string(), cwd);
        let mut archived_thread = thread_summary("archived-thread");
        archived_thread["archived"] = json!(true);
        let visible_thread = thread_summary("visible-thread");
        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [archived_thread, visible_thread],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get(format!("/v1/threads?projectId={}", project.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"].as_array().unwrap().len(), 1);
        assert_eq!(body["threads"][0]["id"], "visible-thread");
    }

    #[tokio::test]
    async fn mcp_servers_route_pages_app_server_statuses() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({
                "data": [mcp_server_status("docs", "lookup")],
                "nextCursor": "next-page"
            }),
            json!({
                "data": [mcp_server_status("files", "read")],
                "nextCursor": null
            }),
        ]);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/mcp/servers?detail=toolsAndAuthOnly")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["servers"].as_array().unwrap().len(), 2);
        assert_eq!(body["servers"][0]["name"], "docs");
        assert_eq!(body["servers"][1]["name"], "files");

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests[0],
            (
                "mcpServerStatus/list".to_string(),
                json!({"cursor": null, "detail": "toolsAndAuthOnly", "limit": 100})
            )
        );
        assert_eq!(
            requests[1],
            (
                "mcpServerStatus/list".to_string(),
                json!({"cursor": "next-page", "detail": "toolsAndAuthOnly", "limit": 100})
            )
        );
    }

    #[tokio::test]
    async fn mcp_resource_oauth_and_reload_routes_map_to_app_server() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({
                "contents": [{
                    "uri": "file:///docs/readme.md",
                    "mimeType": "text/markdown",
                    "text": "# Docs"
                }]
            }),
            json!({"authorizationUrl": "https://auth.example.test/login"}),
            json!({}),
        ]);
        let app = build_router(state);

        let resource = app
            .clone()
            .oneshot(
                Request::get(
                    "/v1/mcp/servers/docs/resources/read?uri=file%3A%2F%2F%2Fdocs%2Freadme.md",
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resource.status(), StatusCode::OK);
        let body = response_json(resource).await;
        assert_eq!(body["contents"][0]["text"], "# Docs");

        let oauth = app
            .clone()
            .oneshot(
                Request::post("/v1/mcp/servers/docs/oauth-login")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"scopes": ["read"], "timeoutSecs": 20}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(oauth.status(), StatusCode::OK);
        assert_eq!(
            response_json(oauth).await["authorizationUrl"],
            "https://auth.example.test/login"
        );

        let reload = app
            .oneshot(Request::post("/v1/mcp/reload").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(reload.status(), StatusCode::OK);
        assert_eq!(
            response_json(reload).await,
            json!({"queued":true,"error":null})
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests[0],
            (
                "mcpServer/resource/read".to_string(),
                json!({
                    "server": "docs",
                    "threadId": null,
                    "uri": "file:///docs/readme.md"
                })
            )
        );
        assert_eq!(
            requests[1],
            (
                "mcpServer/oauth/login".to_string(),
                json!({"name": "docs", "scopes": ["read"], "timeoutSecs": 20})
            )
        );
        assert_eq!(
            requests[2],
            ("config/mcpServer/reload".to_string(), Value::Null)
        );
    }

    #[tokio::test]
    async fn mcp_servers_route_reports_app_server_errors() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway("app-server offline".to_string()));
        let app = build_router(state);

        let response = app
            .oneshot(Request::get("/v1/mcp/servers").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = response_json(response).await;
        assert_eq!(body["code"], "bad_gateway");
        assert_eq!(body["message"], "app-server offline");

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "mcpServerStatus/list");
    }

    #[tokio::test]
    async fn mcp_configured_servers_masks_inline_secrets() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().push(json!({
            "config": {
                "mcp_servers": {
                    "docs": {
                        "command": "npx",
                        "args": ["-y", "@docs/mcp"],
                        "env": {"DOCS_TOKEN": "secret-token"},
                        "env_vars": ["SHARED_ENV"],
                        "enabled": false
                    },
                    "remote": {
                        "url": "https://mcp.example.test",
                        "http_headers": {"Authorization": "Bearer secret"},
                        "bearer_token_env_var": "REMOTE_TOKEN"
                    },
                    "broken": "not an object"
                }
            },
            "origins": {}
        }));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/mcp/configured-servers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        let servers = body["servers"].as_array().unwrap();
        assert_eq!(servers.len(), 2);
        assert!(servers.iter().any(|server| server["name"] == "docs"
            && server["enabled"] == false
            && server["hasStoredSecrets"] == true
            && server["transport"]["env"]["DOCS_TOKEN"]["masked"] == true));
        assert!(servers.iter().any(|server| {
            server["name"] == "remote"
                && server["transport"]["httpHeaders"]["Authorization"]["configured"] == true
                && server["transport"]["bearerTokenEnvVar"] == "REMOTE_TOKEN"
        }));
        let response_text = body.to_string();
        assert!(!response_text.contains("secret-token"));
        assert!(!response_text.contains("Bearer secret"));

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests[0],
            (
                "config/read".to_string(),
                json!({"cwd": null, "includeLayers": true})
            )
        );
    }

    #[tokio::test]
    async fn thread_routes_map_read_resume_fork_and_archive() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        assert_ok(
            app.clone()
                .oneshot(
                    Request::get("/v1/threads/thread-1")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/resume")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"target":"latest"}"#))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/fork")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"beforeTurnId":"turn-1"}"#))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/archive")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[0].1["threadId"], "thread-1");
        assert_eq!(requests[0].1["includeTurns"], false);
        assert_eq!(requests[1].0, "thread/turns/list");
        assert_eq!(requests[1].1["threadId"], "thread-1");
        assert_eq!(requests[1].1["itemsView"], "full");
        assert_eq!(requests[2].0, "thread/turns/list");
        assert_eq!(requests[2].1["threadId"], "thread-1");
        assert_eq!(requests[2].1["itemsView"], "notLoaded");
        assert_eq!(requests[3].0, "thread/resume");
        assert_eq!(requests[3].1["threadId"], "thread-1");
        assert!(requests[3].1.get("persistExtendedHistory").is_none());
        assert_eq!(requests[3].1["excludeTurns"], true);
        assert_completion_head_request(&requests[2], "thread-1");
        assert_completion_head_request(&requests[4], "thread-1");
        assert_eq!(requests[5].0, "thread/fork");
        assert_eq!(requests[5].1["threadId"], "thread-1");
        assert_eq!(requests[5].1["beforeTurnId"], "turn-1");
        assert!(requests[5].1.get("persistExtendedHistory").is_none());
        assert_completion_head_request(&requests[6], "thread-1");
        assert_eq!(requests[7].0, "thread/archive");
        assert_eq!(requests[7].1["threadId"], "thread-1");
        assert_eq!(requests.len(), 8);
    }

    #[tokio::test]
    async fn thread_attach_returns_native_canonical_view_despite_stale_gateway_state() {
        for stale_live_view in [ThreadLiveState::Streaming, ThreadLiveState::Syncing] {
            let (state, app_server) = test_state().await;
            thread_view::record_thread_live_state(
                &state.thread_views,
                "thread-1",
                stale_live_view,
                async {
                    Ok(state
                        .store
                        .append_event(NewEvent {
                            project_id: None,
                            thread_id: Some("thread-1".into()),
                            turn_id: None,
                            item_id: None,
                            kind: crate::events_replay::THREAD_VIEW_CURSOR_KIND.into(),
                            codex_method: Some("thread/status/changed".into()),
                            payload: json!({}),
                        })
                        .await?
                        .seq)
                },
            )
            .await
            .unwrap();
            *app_server.next_response.lock().unwrap() = Some(json!({
                "thread": thread_summary("thread-1"),
                "initialTurnsPage": {"data": [], "nextCursor": null, "backwardsCursor": null}
            }));
            let response = build_router(state)
                .oneshot(
                    Request::post("/v1/threads/thread-1/attach")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = response_json(response).await;
            assert!(body.get("disposition").is_none());
            assert_eq!(body["thread"]["id"], "thread-1");
            assert_eq!(body["liveState"], "idle");
            assert_eq!(body["timeline"]["rows"], json!([]));
            assert!(body["timeline"]["activeTurnId"].is_null());
            assert_eq!(body["historyPage"]["hasOlder"], false);
            let requests = app_server.requests.lock().unwrap();
            assert_eq!(requests.len(), 2);
            assert_eq!(
                requests[0],
                (
                    "thread/resume".to_string(),
                    json!({
                        "threadId": "thread-1", "excludeTurns": true,
                        "initialTurnsPage": {"limit": 50, "sortDirection": "desc", "itemsView": "full"}
                    })
                )
            );
            assert_eq!(requests[1].0, "thread/turns/list");
            assert_eq!(requests[1].1["itemsView"], "notLoaded");
        }
    }

    #[tokio::test]
    async fn thread_detail_returns_app_server_snapshot_turns_without_gateway_events() {
        let (state, app_server) = test_state().await;
        state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-stored-cmd".to_string()),
                kind: "thread_view.cursor".to_string(),
                codex_method: Some("thread_view/cursor".to_string()),
                payload: json!({
                    "threadId": "thread-1",
                    "reason": "timeline_changed",
                    "sourceKind": "thread_view.item_upsert_observed",
                    "sourceMethod": "item/completed"
                }),
            })
            .await
            .unwrap();
        let app = build_router(state);
        app_server.queued_responses.lock().unwrap().extend([
            json!({
                "thread": {
                    "id": "thread-1",
                    "cliVersion": "0.130.0",
                    "cwd": "/workspace",
                    "ephemeral": false,
                    "modelProvider": "openai",
                    "preview": "hello",
                    "source": "cli",
                    "status": {"type": "idle"},
                    "turns": [],
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_610_i64
                }
            }),
            json!({
                "data": [{
                    "id": "turn-1",
                    "status": "completed",
                    "startedAt": 1_767_225_600_i64,
                    "completedAt": 1_767_225_610_i64,
                    "items": [
                        {"id": "item-user-1", "type": "userMessage", "content": [{"type": "text", "text": "hello"}]},
                        {"id": "item-reasoning-1", "type": "reasoning", "summary": ["Need to inspect the code."]},
                        {"id": "item-cmd-1", "type": "commandExecution", "command": "rg issue", "commandActions": [], "cwd": "/workspace", "status": "completed", "aggregatedOutput": "match"},
                        {"id": "item-agent-1", "type": "agentMessage", "text": "world"}
                    ]
                }],
                "nextCursor": null,
                "backwardsCursor": "cursor-prev"
            }),
            json!({
                "data": [{
                    "id": "turn-1",
                    "status": "completed",
                    "items": []
                }],
                "nextCursor": null,
                "backwardsCursor": null
            }),
        ]);

        let response = app
            .oneshot(
                Request::get("/v1/threads/thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        let items = serialized_timeline_items(&body["timeline"]);
        assert_eq!(body["thread"]["id"], "thread-1");
        assert_eq!(items[0]["turnId"], "turn-1");
        assert_eq!(items[0]["itemId"], "item-user-1");
        assert_eq!(items[1]["itemType"], "reasoning");
        assert_eq!(items[2]["itemType"], "commandExecution");
        assert!(!body.to_string().contains("item-stored-cmd"));
        assert_eq!(body["thread"]["latestCompletedTurnId"], "turn-1");
        assert_eq!(body["thread"]["readStateKnown"], true);
        assert_eq!(body["thread"]["unreadCompletedAgentTurn"], true);
        assert_eq!(body["historyPage"]["loadedTurnCount"], 1);
        assert_eq!(body["historyPage"]["hasOlder"], false);
        assert_eq!(body["liveState"], "idle");
        assert!(
            !body.to_string().contains("rawPayload"),
            "selected thread snapshots should not serialize raw app-server payloads"
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests[0],
            (
                "thread/read".to_string(),
                json!({"threadId": "thread-1", "includeTurns": false})
            )
        );
        assert_eq!(
            requests[1],
            (
                "thread/turns/list".to_string(),
                json!({
                    "threadId": "thread-1",
                    "cursor": null,
                    "sortDirection": "desc",
                    "itemsView": "full",
                    "limit": 50
                })
            )
        );
        assert_eq!(requests[2].1["itemsView"], "notLoaded");
    }

    #[tokio::test]
    async fn thread_detail_returns_recent_history_window_without_draining_full_pages() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);
        app_server.queued_responses.lock().unwrap().extend([
            json!({
                "thread": {
                    "id": "thread-1",
                    "cliVersion": "0.130.0",
                    "cwd": "/workspace",
                    "ephemeral": false,
                    "modelProvider": "openai",
                    "preview": "hello",
                    "source": "cli",
                    "status": {"type": "idle"},
                    "turns": [],
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_610_i64
                }
            }),
            json!({
                "data": [{
                    "id": "turn-2",
                    "status": "completed",
                    "items": [{"id": "item-agent-2", "type": "agentMessage", "text": "second"}]
                }],
                "nextCursor": "older-cursor",
                "backwardsCursor": "cursor-prev"
            }),
            json!({
                "data": [{
                    "id": "turn-2",
                    "status": "completed",
                    "items": []
                }, {
                    "id": "turn-1",
                    "status": "completed",
                    "items": []
                }],
                "nextCursor": null,
                "backwardsCursor": null
            }),
        ]);

        let response = app
            .oneshot(
                Request::get("/v1/threads/thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        let items = serialized_timeline_items(&body["timeline"]);
        assert_eq!(items[0]["turnId"], "turn-2");
        assert_eq!(body["historyPage"]["olderCursor"], "older-cursor");
        assert_eq!(body["historyPage"]["hasOlder"], true);
        assert_eq!(body["thread"]["latestCompletedTurnId"], "turn-2");
        assert_eq!(body["thread"]["readStateKnown"], true);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[1].0, "thread/turns/list");
        assert_eq!(requests[1].1["cursor"], Value::Null);
        assert_eq!(requests[1].1["sortDirection"], "desc");
        assert_eq!(requests[1].1["limit"], 50);
        assert_eq!(requests[2].1["itemsView"], "notLoaded");
    }

    #[tokio::test]
    async fn thread_timeline_page_prepends_older_history_to_loaded_window() {
        let (state, app_server) = test_state().await;
        let app = build_router(state.clone());
        app_server.queued_responses.lock().unwrap().extend([
            json!({
                "thread": {
                    "id": "thread-1",
                    "cliVersion": "0.130.0",
                    "cwd": "/workspace",
                    "ephemeral": false,
                    "modelProvider": "openai",
                    "preview": "hello",
                    "source": "cli",
                    "status": {"type": "idle"},
                    "turns": [],
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_610_i64
                }
            }),
            json!({
                "data": [{
                    "id": "turn-2",
                    "status": "completed",
                    "items": [{"id": "item-agent-2", "type": "agentMessage", "text": "second"}]
                }],
                "nextCursor": "older-cursor",
                "backwardsCursor": "newer-cursor"
            }),
            json!({
                "data": [{
                    "id": "turn-2",
                    "status": "completed",
                    "items": []
                }, {
                    "id": "turn-1",
                    "status": "completed",
                    "items": []
                }],
                "nextCursor": null,
                "backwardsCursor": null
            }),
            json!({
                "thread": {
                    "id": "thread-1",
                    "cliVersion": "0.130.0",
                    "cwd": "/workspace",
                    "ephemeral": false,
                    "modelProvider": "openai",
                    "preview": "hello",
                    "source": "cli",
                    "status": {"type": "idle"},
                    "turns": [],
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_610_i64
                }
            }),
            json!({
                "data": [{
                    "id": "turn-1",
                    "status": "completed",
                    "items": [{"id": "item-agent-1", "type": "agentMessage", "text": "first"}]
                }],
                "nextCursor": null,
                "backwardsCursor": "newer-cursor-2"
            }),
            json!({
                "data": [{
                    "id": "turn-2",
                    "status": "completed",
                    "items": []
                }, {
                    "id": "turn-1",
                    "status": "completed",
                    "items": []
                }],
                "nextCursor": null,
                "backwardsCursor": null
            }),
        ]);

        let initial = app
            .clone()
            .oneshot(
                Request::get("/v1/threads/thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(initial.status(), StatusCode::OK);
        thread_view::record_item_delta(
            &state.thread_views,
            "thread-1",
            "turn-3",
            "item-agent-3",
            "live tail",
            std::future::ready(Ok(100)),
        )
        .await
        .unwrap();

        let response = app
            .oneshot(
                Request::get("/v1/threads/thread-1/timeline/pages?cursor=older-cursor&limit=25")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        let items = serialized_timeline_items(&body["timeline"]);
        assert_eq!(items[0]["turnId"], "turn-1");
        assert_eq!(items[1]["turnId"], "turn-2");
        assert_eq!(items[2]["turnId"], "turn-3");
        assert_eq!(body["timeline"]["activeTurnId"], "turn-3");
        assert_eq!(body["historyPage"]["loadedTurnCount"], 3);
        assert_eq!(body["historyPage"]["hasOlder"], false);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[4].0, "thread/turns/list");
        assert_eq!(requests[4].1["cursor"], "older-cursor");
        assert_eq!(requests[4].1["sortDirection"], "desc");
        assert_eq!(requests[4].1["itemsView"], "full");
        assert_eq!(requests[4].1["limit"], 25);
    }

    #[tokio::test]
    async fn thread_timeline_page_stale_cursor_resets_to_recent_window() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);
        app_server.queued_responses.lock().unwrap().extend([
            thread_shell_response("thread-1"),
            json!({
                "data": [{
                    "id": "turn-2",
                    "status": {"type": "completed"},
                    "items": [{"id": "item-agent-2", "type": "agentMessage", "text": "second"}]
                }],
                "nextCursor": "older-cursor",
                "backwardsCursor": "newer-cursor"
            }),
            json!({
                "data": [{"id": "turn-2", "status": "completed", "items": [], "itemsView": "notLoaded"}],
                "nextCursor": null,
                "backwardsCursor": null
            }),
            thread_shell_response("thread-1"),
            json!({
                "data": [{
                    "id": "turn-3",
                    "status": {"type": "completed"},
                    "items": [{"id": "item-agent-3", "type": "agentMessage", "text": "third"}]
                }],
                "nextCursor": "older-cursor-2",
                "backwardsCursor": null
            }),
            json!({
                "data": [{"id": "turn-3", "status": "completed", "items": [], "itemsView": "notLoaded"}],
                "nextCursor": null,
                "backwardsCursor": null
            }),
        ]);

        let initial = app
            .clone()
            .oneshot(
                Request::get("/v1/threads/thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(initial.status(), StatusCode::OK);

        let response = app
            .oneshot(
                Request::get("/v1/threads/thread-1/timeline/pages?cursor=stale-cursor&limit=25")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        let items = serialized_timeline_items(&body["timeline"]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["turnId"], "turn-3");
        assert_eq!(body["historyPage"]["olderCursor"], "older-cursor-2");
        assert_eq!(body["historyPage"]["resetWindow"], true);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[4].0, "thread/turns/list");
        assert_eq!(requests[4].1["cursor"], Value::Null);
        assert_ne!(requests[4].1["cursor"], "stale-cursor");
        assert_eq!(requests[4].1["itemsView"], "full");
        assert_eq!(requests[4].1["limit"], 25);
    }

    #[tokio::test]
    async fn thread_detail_returns_in_memory_session_when_turn_history_is_not_materialized() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(NotMaterializedThreadHistoryAppServer::default());
        let state = AppState::new(Config::default(), store.clone(), app_server.clone());
        let pending = store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: None,
                kind: "timeline.pending_user_input".to_string(),
                codex_method: Some("turn/input".to_string()),
                payload: json!({}),
            })
            .await
            .unwrap();
        thread_view::record_pending_user_input(
            &state.thread_views,
            "thread-1",
            "turn-1",
            "fixture-pending",
            &[UserInput::Text {
                text: "Search Google for OpenAI news".to_string(),
                text_elements: Vec::new(),
            }],
            &[],
            (pending.seq, std::future::ready(Ok(pending.seq))),
        )
        .await
        .unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/threads/thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["liveState"], "streaming");
        assert_eq!(body["timeline"]["liveState"], "streaming");
        let items = serialized_timeline_items(&body["timeline"]);
        assert_eq!(items[0]["itemId"], "pending-user-fixture-pending");
        assert_eq!(items[0]["payload"]["clientId"], "fixture-pending");
        assert_eq!(
            items[0]["payload"]["item"]["content"][0]["text"],
            "Search Google for OpenAI news"
        );
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[1].0, "thread/turns/list");
    }

    #[tokio::test]
    async fn thread_detail_revision_is_captured_before_app_server_history_read() {
        let store = Store::in_memory().await.unwrap();
        let initial = store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "gateway.warning".to_string(),
                codex_method: None,
                payload: json!({"phase": "before-read"}),
            })
            .await
            .unwrap();
        let app_server = Arc::new(BlockingThreadReadAppServer::default());
        let state = AppState::new(Config::default(), store, app_server.clone());
        let app = build_router(state.clone());

        let response = tokio::spawn(async move {
            app.oneshot(
                Request::get("/v1/threads/thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
        });
        timeout(
            Duration::from_secs(2),
            app_server.thread_read_started.notified(),
        )
        .await
        .unwrap();
        let newer = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-newer".to_string()),
                item_id: Some("item-newer".to_string()),
                kind: "thread_view.patch".to_string(),
                codex_method: Some("thread_view/patch".to_string()),
                payload: json!({"phase": "after-read-started"}),
            })
            .await
            .unwrap();
        assert!(newer.seq > initial.seq);
        app_server.release_thread_read.notify_one();

        let response = response.await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["timeline"]["viewRevision"], initial.seq);
    }

    #[tokio::test]
    async fn mark_thread_seen_broadcasts_and_replays_canonical_read_state() {
        let (state, app_server) = test_state().await;
        let head = state
            .store
            .record_thread_completion("thread-1", "turn-2")
            .await
            .unwrap();
        let mut receiver = state.events.subscribe();
        let app = build_router(state.clone());

        app_server.queued_responses.lock().unwrap().push(json!({
            "data": [
                {"id": "turn-2", "status": "completed", "items": [], "itemsView": "notLoaded"},
                {"id": "turn-1", "status": "completed", "items": [], "itemsView": "notLoaded"}
            ],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/seen")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"completedTurnId":"turn-2", "readRevision":head.read_revision})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let event = timeout(Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.kind, "thread.read_updated");
        assert_eq!(event.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(event.payload["threadId"], "thread-1");
        assert_eq!(event.payload["seenCompletedTurnId"], "turn-2");
        assert_eq!(event.payload["latestCompletedTurnId"], "turn-2");
        assert!(event.payload["readRevision"].as_i64().unwrap() > head.read_revision);
        assert_eq!(event.payload["readStateKnown"], true);
        assert_eq!(event.payload["unreadCompletedAgentTurn"], json!(false));

        let replayed = state
            .store
            .replay_events(Some(0), None, Some("thread-1".to_string()))
            .await
            .unwrap();
        assert!(replayed.iter().any(|event| {
            event.kind == "thread.read_updated"
                && event.payload["seenCompletedTurnId"] == "turn-2"
                && event.payload["unreadCompletedAgentTurn"] == json!(false)
        }));
    }

    #[tokio::test]
    async fn thread_list_and_detail_preserve_native_pins_and_notification_preferences() {
        let (state, app_server) = test_state().await;
        state
            .store
            .set_thread_notifications_enabled("thread-2", false)
            .await
            .unwrap();
        let section = json!({"id":crate::app_server_api::PINNED_THREAD_SECTION_ID,"name":"Pinned","appearance":null});
        let mut section_thread = thread_summary("thread-1");
        section_thread["section"] = section.clone();
        section_thread["sectionEnteredAt"] = json!(99);
        let app = build_router(state);

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [section_thread.clone(), thread_summary("thread-2")],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let response = app
            .clone()
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"][0]["pinned"], true);
        assert!(body["threads"][0].get("pinnedAt").is_none());
        assert_eq!(body["threads"][1]["pinned"], false);
        assert_eq!(body["threads"][0]["notificationsEnabled"], json!(true));
        assert_eq!(body["threads"][1]["notificationsEnabled"], json!(false));
        assert_eq!(body["rawPayload"]["data"][0]["section"], section);
        assert_eq!(
            body["rawPayload"]["data"][1]["notificationsEnabled"],
            json!(false)
        );

        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": section_thread
        }));
        let response = app
            .oneshot(
                Request::get("/v1/threads/thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["thread"]["pinned"], true);
        assert!(body["thread"].get("pinnedAt").is_none());
        assert_eq!(body["thread"]["notificationsEnabled"], json!(true));
    }

    #[tokio::test]
    async fn thread_notification_settings_route_persists_and_broadcasts() {
        let (state, _) = test_state().await;
        let mut receiver = state.events.subscribe();
        let app = build_router(state.clone());

        let response = app
            .clone()
            .oneshot(
                Request::patch("/v1/threads/thread-1/notifications")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"enabled":false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threadId"], "thread-1");
        assert_eq!(body["notificationsEnabled"], json!(false));
        assert!(body["updatedAt"].is_string());
        assert!(!state
            .store
            .thread_notifications_enabled("thread-1")
            .await
            .unwrap());

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.kind, "thread.notifications_updated");
        assert_eq!(event.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(event.payload["threadId"], "thread-1");
        assert_eq!(event.payload["notificationsEnabled"], json!(false));

        let response = app
            .oneshot(
                Request::patch("/v1/threads/thread-1/notifications")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"enabled":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["notificationsEnabled"], json!(true));
        assert!(state
            .store
            .thread_notifications_enabled("thread-1")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn thread_start_requires_native_project_before_execution() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(
                "app-server error -32602: project not found: missing".to_string(),
            ));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"projectId":"missing","payload":{"prompt":"hi"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            *requests,
            vec![("project/read".to_string(), json!({"projectId":"missing"}))]
        );
    }

    #[tokio::test]
    async fn file_preview_serves_sniffed_images_markdown_pdfs_and_downloads() {
        let (state, app_server) = test_state().await;
        let dir = tempdir().unwrap();
        let images = [
            (
                dir.path().join("preview-png.local"),
                b"\x89PNG\r\n\x1a\npreview image".as_slice(),
                "image/png",
            ),
            (
                dir.path().join("preview-jpeg.local"),
                b"\xff\xd8\xff\xe0preview image".as_slice(),
                "image/jpeg",
            ),
            (
                dir.path().join("preview-gif.local"),
                b"GIF89apreview image".as_slice(),
                "image/gif",
            ),
            (
                dir.path().join("preview-webp.local"),
                b"RIFF0000WEBPpreview image".as_slice(),
                "image/webp",
            ),
            (
                dir.path().join("preview-svg.local"),
                b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>".as_slice(),
                "image/svg+xml",
            ),
        ];
        for (path, bytes, _) in &images {
            std::fs::write(path, bytes).unwrap();
        }
        let markdown = dir.path().join("notes.md");
        std::fs::write(&markdown, "# Notes\n\nhello").unwrap();
        let markdown_long = dir.path().join("notes.markdown");
        std::fs::write(&markdown_long, "## More\n\nworld").unwrap();
        let pdf = dir.path().join("report.pdf");
        std::fs::write(&pdf, b"%PDF-1.7\npreview pdf").unwrap();
        let download = dir.path().join("data.csv");
        std::fs::write(&download, b"alpha,beta\n1,2\n").unwrap();
        let app = build_router(state);

        for (path, bytes, content_type) in &images {
            let response = app
                .clone()
                .oneshot(
                    Request::get(file_preview_url("thread-1", path))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers().get("content-type").unwrap(),
                *content_type
            );
            assert_eq!(response.headers().get("cache-control").unwrap(), "private");
            assert_eq!(
                response.headers().get("content-length").unwrap(),
                bytes.len().to_string().as_str()
            );
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert_eq!(&body[..], *bytes);
        }

        let response = app
            .clone()
            .oneshot(
                Request::get(file_preview_url("thread-1", &markdown))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "text/markdown; charset=utf-8"
        );
        assert_eq!(
            response.headers().get("content-disposition").unwrap(),
            "attachment; filename=\"notes.md\""
        );
        assert_eq!(response.headers().get("cache-control").unwrap(), "private");
        assert_eq!(response_text(response).await, "# Notes\n\nhello");

        let response = app
            .clone()
            .oneshot(
                Request::get(file_preview_url("thread-1", &markdown_long))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "text/markdown; charset=utf-8"
        );

        let response = app
            .clone()
            .oneshot(
                Request::get(file_preview_url("thread-1", &pdf))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "application/pdf"
        );
        assert_eq!(
            response.headers().get("content-disposition").unwrap(),
            "inline; filename=\"report.pdf\""
        );
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], b"%PDF-1.7\npreview pdf");

        let response = app
            .oneshot(
                Request::get(file_preview_url("thread-1", &download))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "application/octet-stream"
        );
        assert_eq!(
            response.headers().get("content-disposition").unwrap(),
            "attachment; filename=\"data.csv\""
        );
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], b"alpha,beta\n1,2\n");

        let requests = app_server.requests.lock().unwrap();
        assert!(requests.iter().all(|(method, _)| method == "thread/read"));
    }

    #[tokio::test]
    async fn file_preview_resolves_relative_paths_from_thread_cwd() {
        let (state, app_server) = test_state().await;
        let dir = tempdir().unwrap();
        let upload = dir
            .path()
            .join(".kodex")
            .join("uploads")
            .join("thread-1")
            .join("file-1")
            .join("notes.md");
        std::fs::create_dir_all(upload.parent().unwrap()).unwrap();
        std::fs::write(&upload, "# Uploaded\n").unwrap();
        let mut thread = thread_read_response("thread-1", 0);
        thread["thread"]["cwd"] = json!(dir.path().display().to_string());
        app_server.queued_responses.lock().unwrap().push(thread);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get(
                    "/v1/threads/thread-1/files/preview?path=.kodex/uploads/thread-1/file-1/notes.md",
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_text(response).await, "# Uploaded\n");
    }

    #[tokio::test]
    async fn skill_icon_preview_serves_supported_images_only() {
        let (state, _app_server) = test_state().await;
        let dir = tempdir().unwrap();
        let icon = dir.path().join("skill-icon.local");
        std::fs::write(&icon, b"\x89PNG\r\n\x1a\npreview image").unwrap();
        let svg_icon = dir.path().join("skill-icon.svg");
        std::fs::write(
            &svg_icon,
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
        )
        .unwrap();
        let markdown = dir.path().join("skill.md");
        std::fs::write(&markdown, "# Skill").unwrap();
        let app = build_router(state);

        let response = app
            .clone()
            .oneshot(
                Request::get(skill_icon_url(&icon))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get("content-type").unwrap(), "image/png");
        assert_eq!(response.headers().get("cache-control").unwrap(), "private");

        let response = app
            .clone()
            .oneshot(
                Request::get(skill_icon_url(&svg_icon))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "image/svg+xml"
        );
        assert_eq!(response.headers().get("cache-control").unwrap(), "private");

        let response = app
            .oneshot(
                Request::get(skill_icon_url(&markdown))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[tokio::test]
    async fn file_preview_rejects_unavailable_and_invalid_preview_targets() {
        let (state, _app_server) = test_state().await;
        let dir = tempdir().unwrap();
        let image = dir.path().join("preview.local");
        std::fs::write(&image, b"\x89PNG\r\n\x1a\npreview image").unwrap();
        let missing = dir.path().join("missing.png");
        let invalid_markdown = dir.path().join("bad.md");
        std::fs::write(&invalid_markdown, b"\xff\xfe\xfd").unwrap();
        let invalid_pdf = dir.path().join("bad.pdf");
        std::fs::write(&invalid_pdf, b"not a pdf").unwrap();
        let app = build_router(state);

        for (thread_id, path, expected_status) in [
            ("thread-missing", image.as_path(), StatusCode::NOT_FOUND),
            ("thread-1", missing.as_path(), StatusCode::NOT_FOUND),
            ("thread-1", dir.path(), StatusCode::NOT_FOUND),
            (
                "thread-1",
                invalid_markdown.as_path(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                "thread-1",
                invalid_pdf.as_path(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::get(file_preview_url(thread_id, path))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected_status, "{path:?}");
        }
    }

    #[tokio::test]
    async fn file_preview_maps_native_missing_thread_error_to_not_found() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(MissingNativeThreadAppServer);
        let state = AppState::new(Config::default(), store, app_server);
        let dir = tempdir().unwrap();
        let image = dir.path().join("preview.local");
        std::fs::write(&image, b"\x89PNG\r\n\x1a\npreview image").unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get(file_preview_url("thread-missing", &image))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn turn_routes_map_start_steer_and_interrupt() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"input":[{"type":"text","text":"hi"}],"clientUserMessageId":"start-message"}"#))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns/turn-1/steer")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{"input":[{"type":"text","text":"continue"}],"clientUserMessageId":"steer-message"}"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/turns/turn-1/interrupt")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].0, "turn/start");
        assert_eq!(
            requests[0].1,
            json!({"threadId": "thread-1", "input": [{"type": "text", "text": "hi"}], "clientUserMessageId": "start-message"})
        );
        assert_eq!(requests[1].0, "turn/steer");
        assert_eq!(
            requests[1].1,
            json!({
                "threadId": "thread-1",
                "expectedTurnId": "turn-1",
                "clientUserMessageId": "steer-message",
                "input": [{"type": "text", "text": "continue"}],
            })
        );
        assert_eq!(requests[2].0, "turn/interrupt");
        assert_eq!(
            requests[2].1,
            json!({"threadId": "thread-1", "turnId": "turn-1"})
        );
    }

    #[tokio::test]
    async fn generated_ui_routes_are_removed_and_legacy_html_is_rejected() {
        let (state, _app_server) = test_state().await;
        let app = build_router(state);

        let old_route = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/threads/thread-1/generated-ui")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "title": "Old generated UI",
                            "html": "<!doctype html><button>Choose</button>"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(old_route.status(), StatusCode::NOT_FOUND);

        let legacy_html = app
            .oneshot(
                Request::post("/v1/self-control/threads/thread-1/app-surface")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "title": "MCP app",
                            "html": "<!doctype html><script>window.parent.postMessage({type:'kodex.generatedUi.submit'}, '*')</script>",
                            "fallbackContent": "Interactive fallback",
                            "grants": {"canSendMessage": true}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(legacy_html.status(), StatusCode::BAD_REQUEST);
        let body = response_json(legacy_html).await;
        assert!(body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("removed legacy generated UI protocol"));
    }

    #[tokio::test]
    async fn app_surface_upsert_read_document_bridge_and_archive() {
        let (state, app_server) = test_state().await;
        let mut events = state.events.subscribe();
        let app = build_router(state.clone());

        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/threads/thread-1/app-surface")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "title": "MCP-style dashboard",
                            "html": "<!doctype html><button id=\"send\">Send</button>",
                            "fallbackContent": "Dashboard fallback",
                            "presentation": "focus",
                            "displayModes": ["inline"],
                            "csp": {
                                "connectDomains": [],
                                "resourceDomains": ["https://cdn.example.test"],
                                "frameDomains": ["https://frame.example.test"],
                                "baseUriDomains": []
                            },
                            "permissions": {
                                "clipboardWrite": {}
                            },
                            "grants": {
                                "tools": [{"name": "lookup", "server": "docs", "tool": "lookup"}],
                                "resources": [{"server": "docs", "uri": "ui://docs/extra"}],
                                "canSendMessage": true,
                                "canUpdateModelContext": true
                            },
                            "provenance": {"source": "route-test"},
                            "source": {
                                "sourceThreadId": "source-thread",
                                "sourceTurnId": "source-turn",
                                "sourceToolCallId": "app-surface-tool",
                                "requestedBy": "agent",
                                "reason": "verify app surface routes"
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        let created = response_json(created).await;
        assert_eq!(created["session"]["provider"], "generated");
        assert_eq!(created["session"]["title"], "MCP-style dashboard");
        assert_eq!(created["session"]["fallbackContent"], "Dashboard fallback");
        assert_eq!(created["session"]["revision"], 1);
        assert_eq!(created["session"]["status"], "active");
        assert_eq!(created["session"]["displayModes"], json!(["inline"]));
        assert_eq!(created["session"]["grants"]["canSendMessage"], true);
        assert_eq!(
            created["session"]["permissions"],
            json!({"clipboardWrite": {}})
        );
        assert!(created["session"]["documentUrl"]
            .as_str()
            .unwrap()
            .starts_with("/v1/app-surfaces/"));
        let session_id = created["session"]["id"].as_str().unwrap().to_string();
        let bridge_token = created["session"]["bridgeToken"]
            .as_str()
            .unwrap()
            .to_string();
        let document_url = created["session"]["documentUrl"]
            .as_str()
            .unwrap()
            .to_string();
        let resource_uri = created["session"]["resourceUri"]
            .as_str()
            .unwrap()
            .to_string();

        let upsert_event = recv_event_kind(&mut events, "app_surface.session_upserted").await;
        assert_eq!(upsert_event.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(upsert_event.payload["id"], session_id);
        assert_eq!(upsert_event.payload["provider"], "generated");
        assert!(upsert_event.payload.get("html").is_none());

        let presentation_event =
            recv_event_kind(&mut events, "app_surface.presentation_requested").await;
        assert_eq!(presentation_event.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(presentation_event.payload["action"], "focus");
        assert_eq!(presentation_event.payload["sessionId"], session_id);
        assert_eq!(presentation_event.payload["title"], "MCP-style dashboard");

        let presentation = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/threads/thread-1/app-surface/presentation")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "action": "open",
                            "source": {
                                "sourceThreadId": "source-thread",
                                "sourceTurnId": "source-turn",
                                "sourceToolCallId": "app-surface-tool",
                                "requestedBy": "agent",
                                "reason": "show app surface without focus"
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(presentation.status(), StatusCode::OK);
        let presentation = response_json(presentation).await;
        assert_eq!(presentation["request"]["action"], "open");
        assert_eq!(presentation["request"]["sessionId"], session_id);

        let read = app
            .clone()
            .oneshot(
                Request::get("/v1/threads/thread-1/app-surface")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::OK);
        assert_eq!(response_json(read).await["session"]["id"], session_id);

        let document = app
            .clone()
            .oneshot(Request::get(&document_url).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(document.status(), StatusCode::OK);
        let csp = document
            .headers()
            .get(CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("connect-src 'none'"));
        assert!(csp.contains("img-src https://cdn.example.test"));
        assert!(csp.contains("frame-src https://frame.example.test"));
        assert!(csp.contains("base-uri 'none'"));
        let document_body = to_bytes(document.into_body(), usize::MAX).await.unwrap();
        assert!(std::str::from_utf8(&document_body)
            .unwrap()
            .contains("id=\"send\""));

        let missing_token = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/app-surfaces/{session_id}/bridge"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "id": "missing-token",
                            "revision": 1,
                            "method": "resources/read",
                            "params": {"uri": resource_uri}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_token.status(), StatusCode::OK);
        let missing_token = response_json(missing_token).await;
        assert_eq!(missing_token["error"]["code"], -32004);

        let bridge_read = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/app-surfaces/{session_id}/bridge"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "id": 1,
                            "bridgeToken": bridge_token.as_str(),
                            "revision": 1,
                            "method": "resources/read",
                            "params": {"uri": resource_uri}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bridge_read.status(), StatusCode::OK);
        let bridge_read = response_json(bridge_read).await;
        assert_eq!(bridge_read["id"], 1);
        assert!(bridge_read["error"].is_null());
        assert_eq!(
            bridge_read["result"]["contents"][0]["mimeType"],
            "text/html;profile=mcp-app"
        );
        assert!(bridge_read["result"]["contents"][0]["text"]
            .as_str()
            .unwrap()
            .contains("id=\"send\""));

        let bridge_initialize = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/app-surfaces/{session_id}/bridge"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "id": "init-1",
                            "bridgeToken": bridge_token.as_str(),
                            "revision": 1,
                            "method": "ui/initialize",
                            "params": {
                                "protocolVersion": "2026-01-26",
                                "appCapabilities": {"displayModes": ["inline"]}
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bridge_initialize.status(), StatusCode::OK);
        let bridge_initialize = response_json(bridge_initialize).await;
        assert_eq!(bridge_initialize["id"], "init-1");
        assert!(bridge_initialize["error"].is_null());
        assert_eq!(bridge_initialize["result"]["protocolVersion"], "2026-01-26");
        assert_eq!(bridge_initialize["result"]["hostInfo"]["name"], "Kodex");
        assert_eq!(
            bridge_initialize["result"]["hostCapabilities"]["serverTools"],
            json!({})
        );
        assert_eq!(
            bridge_initialize["result"]["hostCapabilities"]["serverResources"],
            json!({})
        );
        assert_eq!(
            bridge_initialize["result"]["hostCapabilities"]["sandbox"]["permissions"],
            json!({"clipboardWrite": {}})
        );
        assert_eq!(
            bridge_initialize["result"]["hostContext"]["resourceUri"],
            resource_uri
        );
        assert_eq!(
            bridge_initialize["result"]["hostContext"]["displayMode"],
            "inline"
        );
        assert_eq!(
            bridge_initialize["result"]["hostContext"]["availableDisplayModes"],
            json!(["inline"])
        );
        assert!(bridge_initialize["result"].get("sessionId").is_none());
        assert!(bridge_initialize["result"].get("capabilities").is_none());

        let bridge_size_changed = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/app-surfaces/{session_id}/bridge"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "bridgeToken": bridge_token.as_str(),
                            "revision": 1,
                            "method": "ui/notifications/size-changed",
                            "params": {"width": 360, "height": 420}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bridge_size_changed.status(), StatusCode::OK);
        let bridge_size_changed = response_json(bridge_size_changed).await;
        assert!(bridge_size_changed["id"].is_null());
        assert!(bridge_size_changed["error"].is_null());
        assert_eq!(bridge_size_changed["result"], json!({}));

        let bridge_tool = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/app-surfaces/{session_id}/bridge"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "id": "tool-1",
                            "bridgeToken": bridge_token.as_str(),
                            "revision": 1,
                            "method": "tools/call",
                            "params": {
                                "name": "lookup",
                                "arguments": {"query": "answer"},
                                "_meta": {"source": "iframe"}
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bridge_tool.status(), StatusCode::OK);
        let bridge_tool = response_json(bridge_tool).await;
        assert_eq!(bridge_tool["id"], "tool-1");
        assert!(bridge_tool["error"].is_null());
        assert_eq!(bridge_tool["result"]["approvalRequired"], true);
        let approval_id = bridge_tool["result"]["approvalId"].as_str().unwrap();
        let approval_event = recv_event_kind(&mut events, "approval.changed").await;
        assert!(approval_event.payload.get("runtimeId").is_some());
        let stored_grant = state.store.get_approval(approval_id).await.unwrap();
        assert_eq!(stored_grant.payload["server"], "docs");
        assert_eq!(stored_grant.payload["tool"], "lookup");

        let approved = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/approvals/{approval_id}/decision"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "decision": {"decision": "accept"}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(approved.status(), StatusCode::OK);
        let approved = response_json(approved).await;
        assert_eq!(approved["status"], "resolved");
        assert_eq!(approved["response"], json!({"decision": "accept"}));
        let resolved_event = recv_event_kind(&mut events, "approval.changed").await;
        assert!(resolved_event.seq > approval_event.seq);

        app_server.queued_responses.lock().unwrap().extend([
            json!({
                "content": [{"type": "text", "text": "lookup complete"}],
                "structuredContent": {"answer": 42},
                "isError": false,
                "_meta": {"trace": "tool-call-1"}
            }),
            json!({"turn": {"id": "turn-app-surface", "status": "inProgress"}}),
        ]);

        let bridge_tool = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/app-surfaces/{session_id}/bridge"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "id": "tool-1-retry",
                            "bridgeToken": bridge_token.as_str(),
                            "revision": 1,
                            "method": "tools/call",
                            "params": {
                                "name": "lookup",
                                "arguments": {"query": "answer"},
                                "_meta": {"source": "iframe"},
                                "approvalId": approval_id
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bridge_tool.status(), StatusCode::OK);
        let bridge_tool = response_json(bridge_tool).await;
        assert_eq!(bridge_tool["id"], "tool-1-retry");
        assert!(bridge_tool["error"].is_null());
        assert_eq!(
            bridge_tool["result"]["structuredContent"],
            json!({"answer": 42})
        );
        assert_eq!(bridge_tool["result"]["_meta"]["trace"], "tool-call-1");

        let denied_tool = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/app-surfaces/{session_id}/bridge"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "id": "tool-denied",
                            "bridgeToken": bridge_token.as_str(),
                            "revision": 1,
                            "method": "tools/call",
                            "params": {
                                "name": "delete_everything"
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied_tool.status(), StatusCode::OK);
        let denied_tool = response_json(denied_tool).await;
        assert_eq!(denied_tool["id"], "tool-denied");
        assert!(denied_tool["result"].is_null());
        assert_eq!(denied_tool["error"]["code"], -32000);
        assert!(denied_tool["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not granted"));

        let denied_link = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/app-surfaces/{session_id}/bridge"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "id": "link-denied",
                            "bridgeToken": bridge_token.as_str(),
                            "revision": 1,
                            "method": "ui/open-link",
                            "params": {"url": "https://example.test/doc"}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied_link.status(), StatusCode::OK);
        let denied_link = response_json(denied_link).await;
        assert_eq!(denied_link["id"], "link-denied");
        assert_eq!(denied_link["error"]["code"], -32000);
        assert!(denied_link["error"]["message"]
            .as_str()
            .unwrap()
            .contains("ui/open-link"));

        let updated_context = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/app-surfaces/{session_id}/bridge"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "id": "context-1",
                            "bridgeToken": bridge_token.as_str(),
                            "revision": 1,
                            "method": "ui/update-model-context",
                            "params": {"summary": "Use compact mode"}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(updated_context.status(), StatusCode::OK);
        let updated_context = response_json(updated_context).await;
        assert_eq!(updated_context["id"], "context-1");
        assert!(updated_context["error"].is_null());
        assert_eq!(updated_context["result"]["updated"], true);
        let context_event = recv_event_kind(&mut events, "app_surface.model_context_updated").await;
        assert_eq!(context_event.payload["sessionId"], session_id);
        assert_eq!(
            context_event.payload["context"],
            json!({"summary": "Use compact mode"})
        );

        let bridge_message = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/app-surfaces/{session_id}/bridge"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "id": "send-1",
                            "bridgeToken": bridge_token.as_str(),
                            "revision": 1,
                            "method": "ui/message",
                            "params": {
                                "role": "user",
                                "content": {"type": "text", "text": "Use the dashboard choice"},
                                "_meta": {"choice": "dashboard"}
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bridge_message.status(), StatusCode::OK);
        let bridge_message = response_json(bridge_message).await;
        assert_eq!(bridge_message["id"], "send-1");
        assert!(bridge_message["error"].is_null());
        assert_eq!(
            bridge_message["result"]["input"],
            json!({"payload": {"turn": {"id": "turn-app-surface", "status": "inProgress"}}})
        );

        let bridge_after_message = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/app-surfaces/{session_id}/bridge"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "id": "read-after-message",
                            "bridgeToken": bridge_token.as_str(),
                            "revision": 1,
                            "method": "resources/read",
                            "params": {"uri": resource_uri}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bridge_after_message.status(), StatusCode::OK);
        let bridge_after_message = response_json(bridge_after_message).await;
        assert_eq!(bridge_after_message["id"], "read-after-message");
        assert!(bridge_after_message["error"].is_null());
        assert_eq!(
            bridge_after_message["result"]["contents"][0]["uri"],
            resource_uri
        );

        let active_after_message = app
            .clone()
            .oneshot(
                Request::get("/v1/threads/thread-1/app-surface")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(active_after_message.status(), StatusCode::OK);
        let active_after_message = response_json(active_after_message).await;
        assert_eq!(active_after_message["session"]["status"], "active");
        for retired_field in [
            "submittedMessage",
            "submittedRevision",
            "submittedMetadata",
            "submittedAt",
            "submitAvailable",
        ] {
            assert!(
                active_after_message["session"].get(retired_field).is_none(),
                "retired artifact lifecycle field {retired_field}"
            );
        }

        {
            let requests = app_server.requests.lock().unwrap();
            assert_eq!(
                requests
                    .iter()
                    .map(|(method, _)| method.as_str())
                    .collect::<Vec<_>>(),
                vec![
                    "thread/read",
                    "thread/read",
                    "mcpServer/tool/call",
                    "turn/start"
                ]
            );
            for (_, params) in &requests[..2] {
                assert_eq!(params, &json!({"threadId":"thread-1","includeTurns":false}));
            }
            let requests = &requests[2..];
            assert_eq!(requests[0].0, "mcpServer/tool/call");
            assert_eq!(requests[0].1["server"], "docs");
            assert_eq!(requests[0].1["threadId"], "thread-1");
            assert_eq!(requests[0].1["tool"], "lookup");
            assert_eq!(requests[0].1["arguments"], json!({"query": "answer"}));
            assert_eq!(requests[0].1["_meta"], json!({"source": "iframe"}));
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[1].0, "turn/start");
            let client_id = requests[1].1["clientUserMessageId"].as_str().unwrap();
            assert!(!client_id.is_empty());
            assert_eq!(
                requests[1].1,
                json!({
                    "threadId": "thread-1",
                    "clientUserMessageId": client_id,
                    "input": [{"type": "text", "text": "Use the dashboard choice"}]
                })
            );
        }

        let archived = app
            .clone()
            .oneshot(
                Request::delete("/v1/self-control/threads/thread-1/app-surface")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "source": {
                                "sourceThreadId": "source-thread",
                                "sourceTurnId": "source-turn",
                                "sourceToolCallId": "app-surface-tool",
                                "requestedBy": "agent",
                                "reason": "verify app surface archive"
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(archived.status(), StatusCode::OK);
        assert_eq!(
            response_json(archived).await["session"]["status"],
            "archived"
        );

        let public_read_after_archive = app
            .oneshot(
                Request::get("/v1/threads/thread-1/app-surface")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(public_read_after_archive.status(), StatusCode::OK);
        assert_eq!(
            response_json(public_read_after_archive).await["session"],
            Value::Null
        );

        let audit_events = state
            .store
            .replay_events(None, None, Some("thread-1".to_string()))
            .await
            .unwrap();
        assert!(audit_events
            .iter()
            .any(|event| event.kind == "self_control.app_surface_upserted"));
        assert!(audit_events
            .iter()
            .any(|event| event.kind == "self_control.app_surface_archived"));
        assert!(audit_events.iter().any(|event| {
            event.kind == "app_surface.bridge_call"
                && event.payload["method"] == "ui/message"
                && event.payload["status"] == "ok"
        }));
        assert!(audit_events.iter().any(|event| {
            event.kind == "app_surface.bridge_call"
                && event.payload["method"] == "tools/call"
                && event.payload["status"] == "error"
        }));
    }

    #[tokio::test]
    async fn thread_input_does_not_generate_a_thread_name() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"turn": {"id": "turn-started", "status": "inProgress"}}));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"Implement the requested change"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response_json(response).await,
            json!({"payload": {"turn": {"id": "turn-started", "status": "inProgress"}}})
        );
        tokio::task::yield_now().await;

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            vec!["turn/start"]
        );
    }

    #[tokio::test]
    async fn turn_start_does_not_generate_a_thread_name() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"turnId": "turn-started"}));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"Implement the requested change"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response_json(response).await["payload"]["turnId"],
            "turn-started"
        );
        tokio::task::yield_now().await;
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            vec!["turn/start"]
        );
    }

    #[tokio::test]
    async fn interrupt_current_turn_uses_refreshed_gateway_active_state() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"goal":null}));
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(active_thread_read_response("thread-1", "fresh-turn"));
        app_server.queued_responses.lock().unwrap().push(
            json!({"data":[{"id":"fresh-turn", "status":"inProgress", "items":[]}],
                "nextCursor":null, "backwardsCursor":null}),
        );
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"ok": true}));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/interrupt-current")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "interrupted");
        assert_eq!(body["interruptedTurnId"], "fresh-turn");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/goal/get");
        assert_eq!(requests[1].0, "thread/read");
        assert_eq!(requests[1].1["includeTurns"], false);
        assert_eq!(requests[2].0, "thread/turns/list");
        assert_eq!(requests[2].1["itemsView"], "notLoaded");
        assert_eq!(requests[3].0, "turn/interrupt");
        assert_eq!(
            requests[3].1,
            json!({"threadId": "thread-1", "turnId": "fresh-turn"})
        );
    }

    #[tokio::test]
    async fn interrupt_current_turn_returns_idle_without_interrupting_stale_local_turn() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"goal":null}));
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(thread_read_response("thread-1", 0));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/interrupt-current")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "idle");
        assert_eq!(body["interruptedTurnId"], Value::Null);
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].0, "thread/goal/get");
        assert_eq!(requests[1].0, "thread/read");
    }

    #[tokio::test]
    async fn skills_route_maps_to_app_server_skills_list() {
        let (state, app_server) = test_state().await;
        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "cwd": "/workspace",
                "errors": [],
                "skills": [{
                    "name": "review-fix",
                    "path": "/skills/review-fix/SKILL.md",
                    "description": "Review and fix",
                    "enabled": true,
                    "scope": "user",
                    "shortDescription": "Review loop",
                    "interface": {
                        "displayName": "Review Fix",
                        "shortDescription": "Review loop",
                        "defaultPrompt": null,
                        "brandColor": null,
                        "iconSmall": "./assets/review-fix-small.svg",
                        "iconLarge": "./assets/review-fix.png"
                    }
                }]
            }]
        }));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/skills?cwd=%2Fworkspace")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["cwd"], "/workspace");
        assert_eq!(body["skills"][0]["name"], "review-fix");
        assert_eq!(
            body["skills"][0]["interface"]["iconSmall"],
            "/skills/review-fix/assets/review-fix-small.svg"
        );
        assert_eq!(
            body["skills"][0]["interface"]["iconLarge"],
            "/skills/review-fix/assets/review-fix.png"
        );
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "skills/list");
        assert_eq!(
            requests[0].1,
            json!({"cwds": ["/workspace"], "forceReload": false})
        );
    }

    #[tokio::test]
    async fn app_server_skills_changed_invalidates_gateway_catalog() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            skills_list_response("/workspace", "old-skill", "/skills/old/SKILL.md"),
            skills_list_response("/workspace", "new-skill", "/skills/new/SKILL.md"),
        ]);
        let app = build_router(state.clone());

        let first = app
            .clone()
            .oneshot(
                Request::get("/v1/skills?cwd=%2Fworkspace")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response_json(first).await["skills"][0]["name"], "old-skill");

        ingest_inbound(
            InboundMessage::Notification {
                method: "skills/changed".to_string(),
                params: json!({}),
            },
            &state,
        )
        .await
        .unwrap();

        let second = app
            .oneshot(
                Request::get("/v1/skills?cwd=%2Fworkspace")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response_json(second).await["skills"][0]["name"],
            "new-skill"
        );

        let events = state.store.replay_events(None, None, None).await.unwrap();
        assert!(events.iter().any(|event| event.kind == "skills.changed"));
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].1["forceReload"], false);
        assert_eq!(requests[1].1["forceReload"], true);
    }

    #[tokio::test]
    async fn app_server_skills_changed_delivers_global_sse_event() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());
        let response = app
            .oneshot(
                Request::get("/v1/events")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        ingest_inbound(
            InboundMessage::Notification {
                method: "skills/changed".to_string(),
                params: json!({}),
            },
            &state,
        )
        .await
        .unwrap();

        let mut body = response.into_body();
        let chunk = next_sse_chunk(&mut body).await;
        assert!(chunk.contains("event: skills.changed"));
        assert!(chunk.contains("\"kind\":\"skills.changed\""));
        assert!(chunk.contains("\"threadId\":null"));
    }

    #[tokio::test]
    async fn turn_start_forwards_only_present_composer_settings() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{
                                "input":[{"type":"text","text":"hi"}],
                                "clientUserMessageId":"first-settings",
                                "model":"gpt-5.4",
                                "effort":"high",
                                "serviceTier":"fast",
                                "approvalPolicy":"never",
                                "approvalsReviewer":"user",
                                "sandboxPolicy":{"type":"dangerFullAccess"}
                            }"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{
                                "input":[{"type":"text","text":"changed"}],
                                "clientUserMessageId":"changed-settings",
                                "model":"gpt-5.4-mini",
                                "effort":"medium",
                                "approvalPolicy":"on-request",
                                "approvalsReviewer":"auto_review",
                                "sandboxPolicy":{"type":"workspaceWrite","networkAccess":false,"writableRoots":[]}
                            }"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "id": "thread-1",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "hello",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let listed = app
            .clone()
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed = response_json(listed).await;
        assert!(listed["threads"][0]["model"].is_null());
        assert!(listed["threads"][0]["reasoningEffort"].is_null());
        assert!(listed["threads"][0]["serviceTier"].is_null());
        assert!(listed["threads"][0]["approvalPolicy"].is_null());
        assert!(listed["threads"][0]["approvalsReviewer"].is_null());
        assert!(listed["threads"][0]["sandbox"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["model"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["reasoningEffort"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["serviceTier"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["approvalPolicy"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["approvalsReviewer"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["sandbox"].is_null());
        assert!(listed["rawPayload"]["data"][0]["model"].is_null());
        assert!(listed["rawPayload"]["data"][0]["reasoningEffort"].is_null());
        assert!(listed["rawPayload"]["data"][0]["sandbox"].is_null());

        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{"input":[{"type":"text","text":"default"}],"clientUserMessageId":"default-settings"}"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "id": "thread-1",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "hello",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let listed = app
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed = response_json(listed).await;
        assert!(listed["threads"][0]["model"].is_null());
        assert!(listed["threads"][0]["reasoningEffort"].is_null());
        assert!(listed["threads"][0]["serviceTier"].is_null());
        assert!(listed["threads"][0]["approvalPolicy"].is_null());
        assert!(listed["threads"][0]["approvalsReviewer"].is_null());
        assert!(listed["threads"][0]["sandbox"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["model"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["reasoningEffort"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["serviceTier"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["approvalPolicy"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["approvalsReviewer"].is_null());
        assert!(listed["threads"][0]["rawPayload"]["sandbox"].is_null());
        assert!(listed["rawPayload"]["data"][0]["model"].is_null());
        assert!(listed["rawPayload"]["data"][0]["reasoningEffort"].is_null());
        assert!(listed["rawPayload"]["data"][0]["serviceTier"].is_null());
        assert!(listed["rawPayload"]["data"][0]["approvalPolicy"].is_null());
        assert!(listed["rawPayload"]["data"][0]["approvalsReviewer"].is_null());
        assert!(listed["rawPayload"]["data"][0]["sandbox"].is_null());

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests[0].1,
            json!({
                "threadId": "thread-1",
                "input": [{"type": "text", "text": "hi"}],
                "clientUserMessageId": "first-settings",
                "model": "gpt-5.4",
                "effort": "high",
                "serviceTier": "fast",
                "approvalPolicy": "never",
                "approvalsReviewer": "user",
                "sandboxPolicy": {"type": "dangerFullAccess"}
            })
        );
        assert_eq!(
            requests[1].1,
            json!({
                "threadId": "thread-1",
                "input": [{"type": "text", "text": "changed"}],
                "clientUserMessageId": "changed-settings",
                "model": "gpt-5.4-mini",
                "effort": "medium",
                "approvalPolicy": "on-request",
                "approvalsReviewer": "auto_review",
                "sandboxPolicy": {"type":"workspaceWrite","networkAccess":false,"writableRoots":[]}
            })
        );
        assert_eq!(requests[2].0, "thread/list");
        assert_eq!(
            requests[4].1,
            json!({"threadId": "thread-1", "input": [{"type": "text", "text": "default"}], "clientUserMessageId": "default-settings"})
        );
        assert_completion_head_request(&requests[3], "thread-1");
        assert_eq!(requests[5].0, "thread/list");
        assert_completion_head_request(&requests[6], "thread-1");
        assert_eq!(requests.len(), 7);
    }

    #[tokio::test]
    async fn rejected_turn_start_does_not_persist_local_settings_overlay() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        let rejected = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{
                            "input":[{"type":"text","text":"hi"}],
                            "model":"gpt-5.4",
                            "sandboxPolicy":{"type":"unsupported"}
                        }"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(!rejected.status().is_success());

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "id": "thread-1",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "hello",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let listed = app
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed = response_json(listed).await;
        assert!(listed["threads"][0]["model"].is_null());
        assert!(listed["threads"][0]["sandbox"].is_null());

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].0, "thread/list");
        assert_completion_head_request(&requests[1], "thread-1");
    }

    #[tokio::test]
    async fn turn_routes_forward_typed_image_inputs_and_reject_invalid_input() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{"input":[{"type":"text","text":"inspect this"},{"type":"localImage","path":"/tmp/kodex-upload.png"}],"clientUserMessageId":"local-image-message"}"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/threads/thread-1/turns/turn-1/steer")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            r#"{"input":[{"type":"image","url":"https://example.test/image.png"}],"clientUserMessageId":"remote-image-message"}"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap(),
        );

        let invalid = app
            .oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"video","url":"bad"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(!invalid.status().is_success());

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].1,
            json!({
                "threadId": "thread-1",
                "clientUserMessageId": "local-image-message",
                "input": [
                    {"type": "text", "text": "inspect this"},
                    {"type": "localImage", "path": "/tmp/kodex-upload.png"}
                ],
            })
        );
        assert_eq!(
            requests[1].1,
            json!({
                "threadId": "thread-1",
                "expectedTurnId": "turn-1",
                "clientUserMessageId": "remote-image-message",
                "input": [{"type": "image", "url": "https://example.test/image.png"}],
            })
        );
    }

    #[tokio::test]
    async fn thread_input_resumes_and_retries_when_turn_start_reports_missing_thread() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::NativeRpc(crate::app_server::JsonRpcError {
                code: -32600,
                message: "thread not found: thread-1".into(),
                data: Some(json!({"diagnostic": "loaded thread unavailable"})),
            }));
        app_server.queued_responses.lock().unwrap().extend([
            json!({
                "thread": thread_summary("thread-1"),
                "cwd": "/workspace",
                "model": "gpt-5.4",
                "modelProvider": "openai"
            }),
            json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
            json!({"turn": {"id": "turn-started", "status": "inProgress"}}),
        ]);
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"hello"}],"clientUserMessageId":"resume-message"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(
            body,
            json!({"payload": {"turn": {"id": "turn-started", "status": "inProgress"}}})
        );
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0].0, "turn/start");
        assert_eq!(
            requests[0].1,
            json!({
                "threadId": "thread-1",
                "input": [{"type": "text", "text": "hello"}],
                "clientUserMessageId": "resume-message"
            })
        );
        assert_eq!(requests[1].0, "thread/resume");
        assert_eq!(requests[1].1["threadId"], "thread-1");
        assert!(requests[1].1.get("persistExtendedHistory").is_none());
        assert_eq!(requests[1].1["excludeTurns"], true);
        assert_completion_head_request(&requests[2], "thread-1");
        assert_eq!(requests[3].0, "turn/start");
        assert_eq!(requests[3].1, requests[0].1);
    }

    #[tokio::test]
    async fn automation_routes_validate_persist_and_broadcast_state() {
        let (state, app_server) = test_state().await;
        let app = build_router(state.clone());

        let invalid = app
            .clone()
            .oneshot(
                Request::post("/v1/automations")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{
                            "name":" ",
                            "prompt":"check",
                            "targetThreadId":"thread-1",
                            "schedule":{
                                "startAt":"2026-05-07T09:00:00Z",
                                "repeatEvery":{"value":29,"unit":"seconds"}
                            }
                        }"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

        let mut receiver = state.events.subscribe();
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/automations")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{
                            "name":"Status",
                            "prompt":"Summarize status",
                            "targetThreadId":"thread-1",
                            "schedule":{
                                "startAt":"2026-05-07T09:00:00Z",
                                "repeatEvery":{"value":30,"unit":"seconds"}
                            }
                        }"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        let created_body = response_json(created).await;
        let automation_id = created_body["automation"]["id"].as_str().unwrap();
        assert_eq!(created_body["automation"]["name"], "Status");
        assert_eq!(
            created_body["automation"]["schedule"]["repeatEvery"]["value"],
            30
        );

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.kind, automations::AUTOMATION_UPSERT_EVENT);
        assert_eq!(event.payload["id"], automation_id);
        assert_eq!(event.payload["schedule"]["repeatEvery"]["value"], 30);
        assert!(event.payload.get("repeatEverySeconds").is_none());

        let listed = app
            .clone()
            .oneshot(
                Request::get("/v1/automations?threadId=thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed_body = response_json(listed).await;
        assert_eq!(listed_body["automations"].as_array().unwrap().len(), 1);

        let paused = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/automations/{automation_id}/pause"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(paused.status(), StatusCode::OK);
        let paused_body = response_json(paused).await;
        assert_eq!(paused_body["automation"]["status"], "paused");

        let deleted = app
            .oneshot(
                Request::delete(format!("/v1/automations/{automation_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ok(deleted);

        let requests = app_server.requests.lock().unwrap();
        assert!(requests.iter().any(|(method, _)| method == "thread/read"));
    }

    #[tokio::test]
    async fn self_control_automation_defaults_paused_and_persists_provenance() {
        let (state, app_server) = test_state().await;
        let mut receiver = state.events.subscribe();
        let app = build_router(state.clone());

        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/automations")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{
                            "name":"Self check",
                            "prompt":"Summarize status",
                            "targetThreadId":"thread-1",
                            "schedule":{
                                "startAt":"2026-05-07T09:00:00Z",
                                "repeatEvery":{"value":30,"unit":"seconds"}
                            },
                            "source":{
                                "sourceThreadId":"origin-thread",
                                "sourceToolCallId":"tool-1",
                                "requestedBy":"agent",
                                "reason":"test"
                            }
                        }"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(created.status(), StatusCode::OK);
        let body = response_json(created).await;
        let automation_id = body["automation"]["id"].as_str().unwrap();
        assert_eq!(body["automation"]["status"], "paused");
        assert_eq!(body["pausedByDefault"], true);
        assert_eq!(
            body["automation"]["provenance"]["sourceToolCallId"],
            "tool-1"
        );

        let stored = state.store.get_automation(automation_id).await.unwrap();
        assert_eq!(stored.status, crate::store::AutomationStatus::Paused);
        assert_eq!(
            stored
                .provenance
                .as_ref()
                .and_then(|value| value["sourceThreadId"].as_str()),
            Some("origin-thread")
        );
        let event = timeout(Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.kind, automations::AUTOMATION_UPSERT_EVENT);
        assert_eq!(event.payload["id"], automation_id);

        let updated = app
            .clone()
            .oneshot(
                Request::patch(format!("/v1/self-control/automations/{automation_id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"name": "Self check updated"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(updated.status(), StatusCode::OK);
        let updated = response_json(updated).await;
        assert_eq!(updated["automation"]["name"], "Self check updated");
        assert_eq!(
            updated["automation"]["provenance"]["sourceToolCallId"],
            "tool-1"
        );

        let resumed = app
            .clone()
            .oneshot(
                Request::post(format!(
                    "/v1/self-control/automations/{automation_id}/resume"
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resumed.status(), StatusCode::OK);
        assert_eq!(
            response_json(resumed).await["automation"]["status"],
            "active"
        );

        let paused = app
            .clone()
            .oneshot(
                Request::post(format!(
                    "/v1/self-control/automations/{automation_id}/pause"
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(paused.status(), StatusCode::OK);
        assert_eq!(
            response_json(paused).await["automation"]["status"],
            "paused"
        );

        let enabled = app
            .oneshot(
                Request::post("/v1/self-control/automations")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "name": "Enabled self check",
                            "prompt": "Summarize status",
                            "targetThreadId": "thread-1",
                            "enabled": true,
                            "schedule": {
                                "startAt": "2026-05-07T10:00:00Z",
                                "repeatEvery": {"value": 30, "unit": "seconds"}
                            },
                            "source": {"sourceToolCallId": "tool-enabled"}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(enabled.status(), StatusCode::OK);
        let enabled = response_json(enabled).await;
        assert_eq!(enabled["automation"]["status"], "active");
        assert_eq!(enabled["pausedByDefault"], false);

        let requests = app_server.requests.lock().unwrap();
        assert!(requests.iter().any(|(method, _)| method == "thread/read"));
    }

    #[tokio::test]
    async fn due_automation_admits_native_queue_with_run_identity_and_no_execution_overrides() {
        let (state, app_server) = test_state().await;
        let start_at = chrono::Utc.with_ymd_and_hms(2026, 5, 7, 9, 0, 0).unwrap();
        let automation = state
            .store
            .create_automation(crate::store::NewAutomation {
                name: "Status".to_string(),
                prompt: "Summarize status".to_string(),
                target_thread_id: "thread-1".to_string(),
                start_at,
                repeat_every_seconds: 30,
                next_run_at: start_at,
                status: crate::store::AutomationStatus::Active,
                paused_reason: None,
                provenance: Some(json!({
                    "sourceType": "kodex_control",
                    "sourceToolCallId": "tool-scheduler"
                })),
            })
            .await
            .unwrap();
        let mut receiver = state.events.subscribe();

        let processed = automations::process_due_automations(&state, start_at)
            .await
            .unwrap();
        assert_eq!(processed, 1);

        let runs = state
            .store
            .list_automation_runs(&automation.id)
            .await
            .unwrap();
        assert_eq!(runs.len(), 1);
        let run = &runs[0];
        assert_eq!(run.target_thread_id, "thread-1");
        assert_eq!(run.scheduled_for, Some(start_at));
        assert_eq!(run.phase, crate::store::AutomationRunPhase::Dispatched);
        assert_eq!(run.turn_id.as_deref(), Some("native-queue-turn"));
        let calls = app_server.requests.lock().unwrap().clone();
        assert_eq!(
            calls
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            vec![
                "thread/read",
                "thread/read",
                "thread/queue/add",
                "thread/turns/list",
                "thread/queue/start",
            ]
        );
        let add = &calls[2].1;
        assert_eq!(
            add,
            &json!({
                "threadId":"thread-1", "clientUserMessageId":run.id,
                "input":[{"type":"text","text":"Summarize status","text_elements":[]}],
            })
        );
        assert_eq!(
            calls[4].1,
            json!({"threadId":"thread-1","queuedSubmissionId":run.native_queue_id})
        );
        let event = recv_event_kind(&mut receiver, automations::AUTOMATION_RUN_UPDATED_EVENT).await;
        assert_eq!(event.payload, json!({"automationId":automation.id}));
        let updated = state.store.get_automation(&automation.id).await.unwrap();
        assert_eq!(updated.last_native_queue_id, run.native_queue_id);
        assert_eq!(
            updated.next_run_at,
            start_at + chrono::Duration::seconds(30)
        );
        assert_eq!(updated.consecutive_failure_count, 0);
        automations::recover_automations_after_restart(&state)
            .await
            .unwrap();
        let automation = state.store.get_automation(&automation.id).await.unwrap();
        assert_eq!(
            automation.provenance.as_ref().unwrap()["sourceToolCallId"],
            "tool-scheduler"
        );
    }

    #[tokio::test]
    async fn due_automation_marks_failure_when_target_thread_cannot_resume() {
        let app_server = Arc::new(UnresumableThreadAppServer::default());
        let state = AppState::new(
            Config::default(),
            Store::in_memory().await.unwrap(),
            app_server.clone(),
        );
        let start_at = chrono::Utc.with_ymd_and_hms(2026, 5, 7, 9, 0, 0).unwrap();
        let automation = state
            .store
            .create_automation(crate::store::NewAutomation {
                name: "Status".to_string(),
                prompt: "Summarize status".to_string(),
                target_thread_id: "thread-1".to_string(),
                start_at,
                repeat_every_seconds: 30,
                next_run_at: start_at,
                status: crate::store::AutomationStatus::Active,
                paused_reason: None,
                provenance: None,
            })
            .await
            .unwrap();
        let mut receiver = state.events.subscribe();

        let processed = automations::process_due_automations(&state, start_at)
            .await
            .unwrap();
        assert_eq!(processed, 1);

        let automation_event = timeout(Duration::from_secs(2), async {
            loop {
                let event = receiver.recv().await.unwrap();
                if event.kind == automations::AUTOMATION_UPSERT_EVENT
                    && event.payload["consecutiveFailureCount"] == 1
                {
                    break event;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(automation_event.payload["id"], automation.id);
        assert_eq!(automation_event.payload["consecutiveFailureCount"], 1);
        assert!(automation_event.payload["lastError"]
            .as_str()
            .unwrap()
            .contains("Target thread is not resumable"));

        let automation = state.store.get_automation(&automation.id).await.unwrap();
        assert_eq!(automation.consecutive_failure_count, 1);
        assert!(automation.last_native_queue_id.is_none());
        assert!(automation
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("Target thread is not resumable"));

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[0].1["includeTurns"], false);
        assert_eq!(
            requests[1],
            (
                "thread/resume".into(),
                json!({"threadId":"thread-1","excludeTurns":true})
            )
        );
    }

    #[tokio::test]
    async fn due_automation_waits_when_app_server_is_unready() {
        let (state, app_server) = test_state().await;
        app_server.ready.store(false, Ordering::SeqCst);
        let start_at = chrono::Utc.with_ymd_and_hms(2026, 5, 7, 9, 0, 0).unwrap();
        let automation = state
            .store
            .create_automation(crate::store::NewAutomation {
                name: "Status".to_string(),
                prompt: "Summarize status".to_string(),
                target_thread_id: "thread-1".to_string(),
                start_at,
                repeat_every_seconds: 30,
                next_run_at: start_at,
                status: crate::store::AutomationStatus::Active,
                paused_reason: None,
                provenance: None,
            })
            .await
            .unwrap();

        let processed = automations::process_due_automations(&state, start_at)
            .await
            .unwrap();
        assert_eq!(processed, 0);
        let automation = state.store.get_automation(&automation.id).await.unwrap();
        assert_eq!(automation.next_run_at, start_at);
        assert_eq!(automation.consecutive_failure_count, 0);
        assert!(app_server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn image_upload_accepts_images_and_rejects_non_images() {
        let (mut state, _) = test_state().await;
        let dir = tempdir().unwrap();
        Arc::make_mut(&mut state.config).uploads.dir = dir.path().join("uploads");
        let app = build_router(state);

        let accepted = app
            .clone()
            .oneshot(
                Request::post("/v1/uploads/images")
                    .header(
                        "content-type",
                        "multipart/form-data; boundary=kodexboundary",
                    )
                    .body(Body::from(multipart_body(
                        "image.png",
                        "image/png",
                        VALID_1X1_PNG,
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::OK);
        let accepted = response_json(accepted).await;
        assert_eq!(accepted["images"].as_array().unwrap().len(), 1);
        let image_path = accepted["images"][0]["path"].as_str().unwrap();
        assert!(image_path.ends_with(".png"));
        assert!(std::path::Path::new(image_path).exists());

        let rejected = app
            .oneshot(
                Request::post("/v1/uploads/images")
                    .header(
                        "content-type",
                        "multipart/form-data; boundary=kodexboundary",
                    )
                    .body(Body::from(multipart_body(
                        "note.txt",
                        "text/plain",
                        b"hello",
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn file_upload_writes_to_thread_cwd_and_rejects_images() {
        let (state, app_server) = test_state().await;
        let dir = tempdir().unwrap();
        let cwd = dir.path().to_path_buf();
        let mut thread = thread_read_response("thread-1", 0);
        thread["thread"]["cwd"] = json!(cwd.display().to_string());
        let mut image_thread = thread_read_response("thread-1", 0);
        image_thread["thread"]["cwd"] = json!(cwd.display().to_string());
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .extend([thread, image_thread]);
        let app = build_router(state);

        let accepted = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/uploads/files")
                    .header(
                        "content-type",
                        "multipart/form-data; boundary=kodexboundary",
                    )
                    .body(Body::from(multipart_body_with_field(
                        "files",
                        "../notes.md",
                        "text/markdown",
                        b"# notes",
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::OK);
        let accepted = response_json(accepted).await;
        let files = accepted["files"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["fileName"], "notes.md");
        assert_eq!(files[0]["extension"], "md");
        let relative_path = files[0]["relativePath"].as_str().unwrap();
        assert!(relative_path.starts_with(".kodex/uploads/thread-1/"));
        assert!(relative_path.ends_with("/notes.md"));
        let absolute_path = files[0]["absolutePath"].as_str().unwrap();
        assert!(std::path::Path::new(absolute_path).exists());
        let canonical_cwd = std::fs::canonicalize(&cwd).unwrap();
        assert!(std::path::Path::new(absolute_path)
            .starts_with(canonical_cwd.join(".kodex/uploads/thread-1")));

        let rejected = app
            .oneshot(
                Request::post("/v1/threads/thread-1/uploads/files")
                    .header(
                        "content-type",
                        "multipart/form-data; boundary=kodexboundary",
                    )
                    .body(Body::from(multipart_body_with_field(
                        "files",
                        "image.png",
                        "image/png",
                        VALID_1X1_PNG,
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn file_upload_rejects_symlinked_upload_directory() {
        let (state, app_server) = test_state().await;
        let dir = tempdir().unwrap();
        let cwd = dir.path().join("workspace");
        let escaped = dir.path().join("escaped");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&escaped).unwrap();
        std::os::unix::fs::symlink(&escaped, cwd.join(".kodex")).unwrap();

        let mut thread = thread_read_response("thread-1", 0);
        thread["thread"]["cwd"] = json!(cwd.display().to_string());
        app_server.queued_responses.lock().unwrap().push(thread);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/uploads/files")
                    .header(
                        "content-type",
                        "multipart/form-data; boundary=kodexboundary",
                    )
                    .body(Body::from(multipart_body_with_field(
                        "files",
                        "notes.md",
                        "text/markdown",
                        b"# notes",
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(!escaped.join("uploads").exists());
    }

    #[tokio::test]
    async fn image_upload_rejects_corrupt_pngs() {
        let (mut state, _) = test_state().await;
        let dir = tempdir().unwrap();
        Arc::make_mut(&mut state.config).uploads.dir = dir.path().join("uploads");
        let app = build_router(state);
        let mut corrupt_png = VALID_1X1_PNG.to_vec();
        corrupt_png[53] = 0xbf;
        corrupt_png[55] = 0xdb;

        let response = app
            .oneshot(
                Request::post("/v1/uploads/images")
                    .header(
                        "content-type",
                        "multipart/form-data; boundary=kodexboundary",
                    )
                    .body(Body::from(multipart_body(
                        "corrupt.png",
                        "image/png",
                        &corrupt_png,
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn image_upload_rejects_oversized_images() {
        let (mut state, _) = test_state().await;
        let dir = tempdir().unwrap();
        Arc::make_mut(&mut state.config).uploads.dir = dir.path().join("uploads");
        let app = build_router(state);
        let oversized = vec![b'x'; 25 * 1024 * 1024 + 1];

        let response = app
            .oneshot(
                Request::post("/v1/uploads/images")
                    .header(
                        "content-type",
                        "multipart/form-data; boundary=kodexboundary",
                    )
                    .body(Body::from(multipart_body(
                        "large.png",
                        "image/png",
                        &oversized,
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn turn_and_item_notifications_persist_cursor_metadata_without_raw_payloads() {
        let (state, _) = test_state().await;
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/agentMessage/delta".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "delta": "hello"
                }),
            },
            &state,
        )
        .await
        .unwrap();
        ingest_inbound(
            InboundMessage::Notification {
                method: "turn/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turn": {"id": "turn-2"}
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let first_broadcast = receiver.recv().await.unwrap();
        assert_eq!(
            first_broadcast.kind,
            thread_view::THREAD_VIEW_PATCH_EVENT_KIND
        );
        let persisted = state.store.replay_events(None, None, None).await.unwrap();
        assert!(persisted
            .iter()
            .all(|event| event.kind != "codex.notification"));
        let delta_cursor = persisted
            .iter()
            .find(|event| event.payload["sourceMethod"] == "item/agentMessage/delta")
            .unwrap();
        assert_eq!(delta_cursor.kind, "thread_view.cursor");
        assert_eq!(delta_cursor.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(delta_cursor.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(delta_cursor.item_id.as_deref(), Some("item-1"));
        assert!(delta_cursor.payload.get("delta").is_none());

        let completed_cursor = persisted
            .iter()
            .find(|event| event.payload["sourceKind"] == "thread_view.turn_completed")
            .unwrap();
        assert_eq!(completed_cursor.kind, "thread_view.cursor");
        assert_eq!(completed_cursor.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(completed_cursor.turn_id.as_deref(), Some("turn-2"));
    }

    #[tokio::test]
    async fn app_server_overload_maps_to_retryable_error_response() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(RetryableAppServer);
        let state = AppState::new(Config::default(), store, app_server);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"hi"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let body = response_json(response).await;
        assert_eq!(body["code"], "app_server_retryable");
        assert_eq!(body["retryable"], true);
    }

    #[tokio::test]
    async fn approval_broker_creates_pending_approvals_for_supported_methods() {
        let (state, _) = test_state().await;
        for method in [
            "item/commandExecution/requestApproval",
            "item/fileChange/requestApproval",
            "item/permissions/requestApproval",
            "mcpServer/elicitation/request",
            "item/tool/requestUserInput",
        ] {
            ingest_inbound(
                InboundMessage::ServerRequest {
                    request_id: format!("\"{method}\""),
                    method: method.to_string(),
                    params: json!({
                        "threadId": "thread-1",
                        "turnId": "turn-1",
                        "itemId": "item-1"
                    }),
                },
                &state,
            )
            .await
            .unwrap();
        }

        let approvals = crate::approvals::list_approvals(
            &state,
            Some("pending".to_string()),
            Some("thread-1".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(approvals.approvals.len(), 5);

        let events = state.store.replay_events(None, None, None).await.unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "approval.changed")
                .count(),
            5
        );
        assert!(state
            .store
            .list_approvals(None, None)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn unsupported_server_request_emits_warning_without_approval() {
        let (state, _) = test_state().await;
        ingest_inbound(
            InboundMessage::ServerRequest {
                request_id: "\"unsupported\"".to_string(),
                method: "unknown/request".to_string(),
                params: json!({"threadId": "thread-1"}),
            },
            &state,
        )
        .await
        .unwrap();

        assert!(state
            .store
            .list_approvals(None, None)
            .await
            .unwrap()
            .is_empty());
        let events = state.store.replay_events(None, None, None).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "gateway.warning");
    }

    #[tokio::test]
    async fn approval_decision_sends_one_response_and_waits_for_native_resolution() {
        let (state, app_server) = test_state().await;
        let approval = crate::approvals::receive_native(
            &state,
            NewApproval {
                request_id: "\"approval-1\"".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-1".to_string()),
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            },
        )
        .await
        .unwrap();
        let app = build_router(state.clone());

        let response = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/approvals/{}/decision", approval.id))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"decision":{"decision":"accept"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(app_server.responses.lock().unwrap().len(), 1);

        let duplicate = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/approvals/{}/decision", approval.id))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"decision":{"decision":"accept"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);
        assert_eq!(app_server.responses.lock().unwrap().len(), 1);

        let unknown = app
            .oneshot(
                Request::post("/v1/approvals/missing/decision")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"decision":{"decision":"accept"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

        assert_eq!(
            crate::approvals::get_approval(&state, &approval.id)
                .await
                .unwrap()
                .status,
            "responding"
        );
        ingest_inbound(
            InboundMessage::Notification {
                method: "serverRequest/resolved".to_string(),
                params: json!({"threadId":"thread-1", "requestId":"approval-1"}),
            },
            &state,
        )
        .await
        .unwrap();
        assert_eq!(
            crate::approvals::get_approval(&state, &approval.id)
                .await
                .unwrap()
                .status,
            "resolved"
        );
    }

    #[tokio::test]
    async fn concurrent_approval_decisions_only_send_one_upstream_response() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(BlockingRespondAppServer::default());
        app_server.ready.store(true, Ordering::SeqCst);
        let state = AppState::new(Config::default(), store, app_server.clone());
        let approval = crate::approvals::receive_native(
            &state,
            NewApproval {
                request_id: "\"approval-1\"".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-1".to_string()),
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            },
        )
        .await
        .unwrap();
        let app = build_router(state);
        let path = format!("/v1/approvals/{}/decision", approval.id);

        let first = tokio::spawn({
            let app = app.clone();
            let path = path.clone();
            async move {
                app.oneshot(
                    Request::post(path)
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"decision":{"decision":"accept"}}"#))
                        .unwrap(),
                )
                .await
                .unwrap()
            }
        });

        timeout(
            Duration::from_secs(2),
            app_server.respond_started.notified(),
        )
        .await
        .unwrap();

        let duplicate = app
            .oneshot(
                Request::post(path)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"decision":{"decision":"accept"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);
        assert_eq!(app_server.responses.lock().unwrap().len(), 1);

        app_server.release_response.notify_one();
        let first = first.await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(app_server.responses.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn approval_decision_validates_payload_before_responding() {
        let (state, app_server) = test_state().await;
        let approval = crate::approvals::receive_native(
            &state,
            NewApproval {
                request_id: "\"approval-1\"".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            },
        )
        .await
        .unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post(format!("/v1/approvals/{}/decision", approval.id))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"decision":{"decision":"bogus"}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(app_server.responses.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn account_and_model_routes_map_to_app_server_methods() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        assert_ok(
            app.clone()
                .oneshot(
                    Request::get("/v1/account?refreshToken=true")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/account/login")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/account/login/login-1/cancel")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post("/v1/account/logout")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.clone()
                .oneshot(
                    Request::get("/v1/account/rate-limits")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        );
        assert_ok(
            app.oneshot(
                Request::get("/v1/models?includeHidden=true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "account/read");
        assert_eq!(requests[0].1, json!({"refreshToken": true}));
        assert_eq!(requests[1].0, "account/login/start");
        assert_eq!(requests[1].1, json!({"type": "chatgptDeviceCode"}));
        assert_eq!(requests[2].0, "account/login/cancel");
        assert_eq!(requests[2].1, json!({"loginId": "login-1"}));
        assert_eq!(requests[3].0, "account/logout");
        assert_eq!(requests[3].1, Value::Null);
        assert_eq!(requests[4].0, "account/rateLimits/read");
        assert_eq!(requests[4].1, Value::Null);
        assert_eq!(requests[5].0, "model/list");
        assert_eq!(requests[5].1, json!({"includeHidden": true}));
    }

    #[tokio::test]
    async fn frontend_critical_routes_return_product_shaped_contracts() {
        let (state, app_server) = test_state().await;
        let cwd = std::env::current_dir().unwrap().display().to_string();
        let app = build_router(state);

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "id": "thread-1",
                "cliVersion": "0.130.0",
                "name": "Build gateway",
                "cwd": cwd,
                "ephemeral": false,
                "modelProvider": "openai",
                "preview": "hello",
                "source": "cli",
                "status": {"type": "idle"},
                "turns": [],
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_660_i64
            }],
            "nextCursor": "next-1",
            "backwardsCursor": null
        }));
        let threads = app
            .clone()
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(threads.status(), StatusCode::OK);
        let threads = response_json(threads).await;
        assert_eq!(threads["threads"][0]["id"], "thread-1");
        assert_eq!(threads["threads"][0]["name"], "Build gateway");
        assert_eq!(threads["threads"][0]["status"], "idle");
        assert_eq!(threads["threads"][0]["createdAt"], 1_767_225_600_i64);
        assert_eq!(threads["threads"][0]["updatedAt"], 1_767_225_660_i64);
        assert!(threads.get("payload").is_none());
        assert!(threads.get("rawPayload").is_some());

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [
                {
                    "id": "visible",
                    "model": "gpt-5.4",
                    "displayName": "GPT-5.4",
                    "description": "Everyday coding",
                    "hidden": false,
                    "isDefault": true,
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": [
                        {"reasoningEffort": "medium", "description": "Balanced"}
                    ],
                    "inputModalities": ["text", "image"]
                },
                {
                    "id": "hidden",
                    "model": "hidden-model",
                    "displayName": "Hidden",
                    "description": "Hidden",
                    "hidden": true,
                    "isDefault": false,
                    "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": []
                }
            ],
            "nextCursor": null
        }));
        let models = app
            .clone()
            .oneshot(Request::get("/v1/models").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(models.status(), StatusCode::OK);
        let models = response_json(models).await;
        assert_eq!(models["models"].as_array().unwrap().len(), 1);
        assert_eq!(models["models"][0]["id"], "visible");
        assert!(models.get("payload").is_none());

        *app_server.next_response.lock().unwrap() = Some(json!({
            "requiresOpenaiAuth": false,
            "account": {"type": "chatgpt", "email": "dev@example.test", "planType": "pro"}
        }));
        let account = app
            .clone()
            .oneshot(Request::get("/v1/account").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(account.status(), StatusCode::OK);
        let account = response_json(account).await;
        assert_eq!(account["requiresOpenaiAuth"], false);
        assert_eq!(account["account"]["email"], "dev@example.test");

        *app_server.next_response.lock().unwrap() = Some(json!({
            "rateLimits": {
                "limitId": "codex",
                "limitName": "Codex",
                "primary": {"usedPercent": 15, "resetsAt": 1770000000, "windowDurationMins": 300},
                "secondary": null,
                "credits": {"hasCredits": true, "unlimited": false, "balance": "10"},
                "planType": "pro",
                "rateLimitReachedType": null
            },
            "rateLimitsByLimitId": null
        }));
        let rate_limits = app
            .clone()
            .oneshot(
                Request::get("/v1/account/rate-limits")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rate_limits.status(), StatusCode::OK);
        let rate_limits = response_json(rate_limits).await;
        assert_eq!(rate_limits["rateLimits"]["limitId"], "codex");
        assert_eq!(rate_limits["rateLimits"]["primary"]["usedPercent"], 15);

        *app_server.next_response.lock().unwrap() = Some(json!({
            "type": "chatgptDeviceCode",
            "loginId": "login-1",
            "verificationUrl": "https://example.test/device",
            "userCode": "CODE-1234"
        }));
        let login = app
            .oneshot(
                Request::post("/v1/account/login")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(login.status(), StatusCode::OK);
        let login = response_json(login).await;
        assert_eq!(login["loginType"], "chatgptDeviceCode");
        assert_eq!(login["loginId"], "login-1");
        assert_eq!(login["verificationUrl"], "https://example.test/device");
        assert_eq!(login["userCode"], "CODE-1234");
    }

    #[tokio::test]
    async fn product_shaped_response_drift_returns_bad_gateway() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);
        *app_server.next_response.lock().unwrap() = Some(json!({"data": [{"name": "missing id"}]}));

        let response = app
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(response_json(response).await["code"], "bad_gateway");
    }

    #[tokio::test]
    async fn account_notifications_flow_through_event_stream() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());
        let mut live_clients = Vec::new();
        for _ in 0..2 {
            let response = app
                .clone()
                .oneshot(
                    Request::get("/v1/events?includeGlobal=true&threadIds=thread-1")
                        .header("accept", "text/event-stream")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            live_clients.push(response.into_body());
        }
        for (method, params) in [
            (
                "account/login/completed",
                json!({"loginId": "login-1", "success": false, "error": "device auth timed out after 15 minutes"}),
            ),
            (
                "account/updated",
                json!({"authMode": "chatgpt", "planType": "plus"}),
            ),
            ("account/rateLimits/updated", json!({"rateLimits": null})),
        ] {
            ingest_inbound(
                InboundMessage::Notification {
                    method: method.to_string(),
                    params,
                },
                &state,
            )
            .await
            .unwrap();
        }
        let response = app
            .oneshot(
                Request::get("/v1/events?includeGlobal=true&threadIds=thread-1&cursor=0")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        live_clients.push(response.into_body());
        for mut body in live_clients {
            for kind in [
                "account.login_completed",
                "account.updated",
                "account.rate_limits_updated",
            ] {
                let chunk = next_sse_chunk(&mut body).await;
                assert!(chunk.contains(&format!("event: {kind}")), "{chunk}");
                if kind == "account.login_completed" {
                    assert!(chunk.contains("login-1"));
                    assert!(chunk.contains("device auth timed out after 15 minutes"));
                }
            }
        }
    }

    #[tokio::test]
    async fn frontend_static_serving_returns_index_and_api_routes_win() {
        let (mut state, _) = test_state().await;
        let dist = tempdir().unwrap();
        std::fs::write(
            dist.path().join("index.html"),
            "<!doctype html><title>Kodex UI</title><main>Kodex UI</main>",
        )
        .unwrap();
        state.config = Arc::new(Config {
            frontend: crate::config::FrontendConfig {
                dist_dir: Some(dist.path().to_path_buf()),
            },
            ..Config::default()
        });
        let app = build_router(state);

        let root = app
            .clone()
            .oneshot(Request::get("/").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(root.status(), StatusCode::OK);
        assert_eq!(
            root.headers()
                .get(CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("no-cache")
        );
        assert!(response_text(root).await.contains("Kodex UI"));

        let fallback = app
            .clone()
            .oneshot(
                Request::get("/threads/thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(fallback.status(), StatusCode::OK);
        assert_eq!(
            fallback
                .headers()
                .get(CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("no-cache")
        );
        assert!(response_text(fallback).await.contains("Kodex UI"));

        let health = app
            .clone()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        assert!(health.headers().get(CACHE_CONTROL).is_none());
        assert_eq!(response_json(health).await["status"], "ok");

        let events = app
            .oneshot(
                Request::get("/v1/events")
                    .header(ACCEPT_ENCODING, "gzip")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(events.status(), StatusCode::OK);
        assert!(events.headers().get(CACHE_CONTROL).is_none());
        assert_ne!(
            events
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("text/html")
        );
        assert!(events.headers().get(CONTENT_ENCODING).is_none());
    }

    #[tokio::test]
    async fn frontend_static_serving_uses_vite_asset_cache_headers() {
        let (mut state, _) = test_state().await;
        let dist = tempdir().unwrap();
        let assets = dist.path().join("assets");
        std::fs::create_dir(&assets).unwrap();
        std::fs::write(
            dist.path().join("index.html"),
            "<!doctype html><title>Kodex UI</title>",
        )
        .unwrap();
        std::fs::write(dist.path().join("manifest.webmanifest"), "{}").unwrap();
        std::fs::write(dist.path().join("service-worker.js"), "self.skipWaiting();").unwrap();
        std::fs::write(
            assets.join("index-BG6bYKqW.js"),
            "console.log('hashed static asset loaded for compression validation');",
        )
        .unwrap();
        std::fs::write(
            assets.join("index-DLWtEkjL.js"),
            "console.log('all-letter hash');",
        )
        .unwrap();
        std::fs::write(assets.join("component.css"), ".component {}").unwrap();
        std::fs::write(assets.join("logo.svg"), "<svg></svg>").unwrap();
        state.config = Arc::new(Config {
            frontend: crate::config::FrontendConfig {
                dist_dir: Some(dist.path().to_path_buf()),
            },
            ..Config::default()
        });
        let app = build_router(state);

        let hashed_asset = app
            .clone()
            .oneshot(
                Request::get("/assets/index-BG6bYKqW.js")
                    .header(ACCEPT_ENCODING, "gzip")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(hashed_asset.status(), StatusCode::OK);
        assert_eq!(
            hashed_asset
                .headers()
                .get(CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("public, max-age=31536000, immutable")
        );
        assert_eq!(
            hashed_asset
                .headers()
                .get(CONTENT_ENCODING)
                .and_then(|value| value.to_str().ok()),
            Some("gzip")
        );

        let all_letter_hash_asset = app
            .clone()
            .oneshot(
                Request::get("/assets/index-DLWtEkjL.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(all_letter_hash_asset.status(), StatusCode::OK);
        assert_eq!(
            all_letter_hash_asset
                .headers()
                .get(CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("public, max-age=31536000, immutable")
        );

        let unhashed_asset = app
            .clone()
            .oneshot(
                Request::get("/assets/logo.svg")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unhashed_asset.status(), StatusCode::OK);
        assert_eq!(
            unhashed_asset
                .headers()
                .get(CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("no-cache")
        );

        let long_unhashed_asset = app
            .clone()
            .oneshot(
                Request::get("/assets/component.css")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(long_unhashed_asset.status(), StatusCode::OK);
        assert_eq!(
            long_unhashed_asset
                .headers()
                .get(CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("no-cache")
        );

        let manifest = app
            .clone()
            .oneshot(
                Request::get("/manifest.webmanifest")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(manifest.status(), StatusCode::OK);
        assert_eq!(
            manifest
                .headers()
                .get(CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("no-cache")
        );

        let service_worker = app
            .oneshot(
                Request::get("/service-worker.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(service_worker.status(), StatusCode::OK);
        assert_eq!(
            service_worker
                .headers()
                .get(CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("no-cache")
        );
    }

    #[tokio::test]
    async fn missing_frontend_build_keeps_api_only_development_working() {
        let (mut state, _) = test_state().await;
        let dist = tempdir().unwrap();
        state.config = Arc::new(Config {
            frontend: crate::config::FrontendConfig {
                dist_dir: Some(dist.path().join("missing")),
            },
            ..Config::default()
        });
        let app = build_router(state);

        let health = app
            .clone()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);

        let fallback = app
            .oneshot(Request::get("/not-an-api").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(fallback.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn event_replay_excludes_timeline_history_and_keeps_operational_events() {
        let (state, _) = test_state().await;
        state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "thread_view.cursor".to_string(),
                codex_method: Some("thread_view/cursor".to_string()),
                payload: json!({
                    "threadId": "t1",
                    "reason": "timeline_changed",
                    "sourceKind": "thread_view.item_delta_observed",
                    "sourceMethod": "item/agentMessage/delta"
                }),
            })
            .await
            .unwrap();
        let approval = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "approval.changed".to_string(),
                codex_method: Some("apply_patch".to_string()),
                payload: json!({"threadId": "t1", "status": "pending"}),
            })
            .await
            .unwrap();
        let warning = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "gateway.warning".to_string(),
                codex_method: None,
                payload: json!({"threadId": "t1", "message": "careful"}),
            })
            .await
            .unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=t1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        let events = body["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["seq"], approval.seq);
        assert_eq!(events[0]["kind"], "approval.changed");
        assert_eq!(events[1]["seq"], warning.seq);
        assert_eq!(events[1]["kind"], "gateway.warning");
    }

    #[tokio::test]
    async fn event_replay_and_sse_include_mcp_lifecycle_events() {
        let (state, _) = test_state().await;
        let config_changed = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: None,
                turn_id: None,
                item_id: None,
                kind: "config.changed".to_string(),
                codex_method: None,
                payload: json!({"operation": "add", "server": "docs"}),
            })
            .await
            .unwrap();
        let startup = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: None,
                turn_id: None,
                item_id: None,
                kind: "mcp.server_status_updated".to_string(),
                codex_method: Some("mcpServer/startupStatus/updated".to_string()),
                payload: json!({"name": "docs", "status": "ready"}),
            })
            .await
            .unwrap();
        let oauth = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: None,
                turn_id: None,
                item_id: None,
                kind: "mcp.oauth_login_completed".to_string(),
                codex_method: Some("mcpServer/oauthLogin/completed".to_string()),
                payload: json!({"name": "docs", "success": true}),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let response = app
            .clone()
            .oneshot(
                Request::get("/v1/events?cursor=0")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        let events = body["events"].as_array().unwrap();
        assert!(events.iter().any(|event| {
            event["seq"] == config_changed.seq && event["kind"] == "config.changed"
        }));
        assert!(events.iter().any(|event| {
            event["seq"] == startup.seq && event["kind"] == "mcp.server_status_updated"
        }));
        assert!(events.iter().any(|event| {
            event["seq"] == oauth.seq && event["kind"] == "mcp.oauth_login_completed"
        }));

        let response = app
            .oneshot(
                Request::get("/v1/events")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let live = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: None,
                turn_id: None,
                item_id: None,
                kind: "config.changed".to_string(),
                codex_method: None,
                payload: json!({"operation": "replace", "server": "docs"}),
            })
            .await
            .unwrap();
        state.events.send(startup).unwrap();
        state.events.send(live.clone()).unwrap();

        let mut body = response.into_body();
        let chunk = next_sse_chunk(&mut body).await;
        assert!(chunk.contains(&format!("id: {}", live.seq)));
        assert!(chunk.contains("config.changed"));
        assert!(chunk.contains("\"operation\":\"replace\""));
    }

    #[tokio::test]
    async fn debug_event_replay_returns_raw_persisted_events() {
        let (state, _) = test_state().await;
        state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "thread_view.cursor".to_string(),
                codex_method: Some("thread_view/cursor".to_string()),
                payload: json!({
                    "threadId": "t1",
                    "reason": "timeline_changed",
                    "sourceKind": "thread_view.item_delta_observed",
                    "sourceMethod": "item/agentMessage/delta"
                }),
            })
            .await
            .unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/debug/events?threadId=t1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["events"].as_array().unwrap().len(), 1);
        assert_eq!(body["events"][0]["kind"], "thread_view.cursor");
    }

    #[tokio::test]
    async fn sse_replays_all_persisted_pages_before_live_events() {
        let (state, _) = test_state().await;
        for index in 0..501 {
            state
                .store
                .append_event(NewEvent {
                    project_id: Some("p1".to_string()),
                    thread_id: Some("t1".to_string()),
                    turn_id: None,
                    item_id: None,
                    kind: "gateway.warning".to_string(),
                    codex_method: None,
                    payload: json!({
                        "phase": "replay",
                        "index": index,
                    }),
                })
                .await
                .unwrap();
            if index == 250 {
                state
                    .store
                    .append_event(NewEvent {
                        project_id: Some("p2".to_string()),
                        thread_id: Some("t1".to_string()),
                        turn_id: None,
                        item_id: None,
                        kind: "gateway.warning".to_string(),
                        codex_method: None,
                        payload: json!({
                            "phase": "filtered",
                            "index": index,
                        }),
                    })
                    .await
                    .unwrap();
            }
        }
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?cursor=0&projectId=p1&threadId=t1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let live = state
            .store
            .append_event(NewEvent {
                project_id: Some("p1".to_string()),
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "thread_view.patch".to_string(),
                codex_method: Some("thread_view/patch".to_string()),
                payload: json!({"threadId": "t1", "phase": "live"}),
            })
            .await
            .unwrap();
        state.events.send(live.clone()).unwrap();

        let mut body = response.into_body();
        for index in 0..500 {
            let chunk = next_sse_chunk(&mut body).await;
            assert!(chunk.contains("\"phase\":\"replay\""));
            assert!(chunk.contains(&format!("\"index\":{index}")));
            assert!(!chunk.contains("\"phase\":\"filtered\""));
            assert!(!chunk.contains("\"phase\":\"live\""));
        }

        let beyond_first_page = next_sse_chunk(&mut body).await;
        assert!(beyond_first_page.contains("\"phase\":\"replay\""));
        assert!(beyond_first_page.contains("\"index\":500"));
        assert!(!beyond_first_page.contains("\"phase\":\"live\""));

        let live_chunk = next_sse_chunk(&mut body).await;
        assert!(live_chunk.contains(&format!("id: {}", live.seq)));
        assert!(live_chunk.contains("\"phase\":\"live\""));
    }

    #[tokio::test]
    async fn sse_without_cursor_starts_after_existing_operational_events() {
        let (state, _) = test_state().await;
        let replay = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "gateway.warning".to_string(),
                codex_method: None,
                payload: json!({"threadId": "t1", "phase": "replay"}),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get(format!("/v1/events?threadId=t1&cursor={}", replay.seq))
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let live = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "gateway.warning".to_string(),
                codex_method: None,
                payload: json!({"threadId": "t1", "phase": "live"}),
            })
            .await
            .unwrap();
        state.events.send(replay).unwrap();
        state.events.send(live.clone()).unwrap();

        let mut body = response.into_body();
        let first = next_sse_chunk(&mut body).await;
        assert!(first.contains(&format!("id: {}", live.seq)));
        assert!(first.contains("\"phase\":\"live\""));
        assert!(!first.contains("\"phase\":\"replay\""));
    }

    #[tokio::test]
    async fn sse_replays_and_streams_thread_read_updates() {
        let (state, _) = test_state().await;
        let replay = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "thread.read_updated".to_string(),
                codex_method: None,
                payload: json!({
                    "threadId": "thread-1",
                    "seenCompletedTurnId": "turn-1",
                    "latestCompletedTurnId": "turn-1",
                    "readRevision": 1,
                    "readStateKnown": true,
                    "updatedAt": "2026-10-05T00:00:00Z",
                    "unreadCompletedAgentTurn": false
                }),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=thread-1&cursor=0")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let live = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "thread.read_updated".to_string(),
                codex_method: None,
                payload: json!({
                    "threadId": "thread-1",
                    "seenCompletedTurnId": "turn-1",
                    "latestCompletedTurnId": "turn-2",
                    "readRevision": 2,
                    "readStateKnown": true,
                    "updatedAt": "2026-10-05T00:00:01Z",
                    "unreadCompletedAgentTurn": true
                }),
            })
            .await
            .unwrap();
        state.events.send(live.clone()).unwrap();

        let mut body = response.into_body();
        let replay_chunk = next_sse_chunk(&mut body).await;
        assert!(replay_chunk.contains(&format!("id: {}", replay.seq)));
        assert!(replay_chunk.contains("thread.read_updated"));
        assert!(replay_chunk.contains("\"unreadCompletedAgentTurn\":false"));

        let live_chunk = next_sse_chunk(&mut body).await;
        assert!(live_chunk.contains(&format!("id: {}", live.seq)));
        assert!(live_chunk.contains("thread.read_updated"));
        assert!(live_chunk.contains("\"unreadCompletedAgentTurn\":true"));
    }

    #[tokio::test]
    async fn sse_replays_and_streams_global_subagent_refills_to_unrelated_thread_subscription() {
        let (state, _) = test_state().await;
        let replay = crate::subagents::native_change_event(
            &state,
            "thread/closed",
            &json!({"threadId":"child"}),
        )
        .await
        .unwrap()
        .unwrap();
        let app = build_router(state.clone());
        let response = app
            .oneshot(
                Request::get("/v1/events?threadIds=unrelated&includeGlobal=true&cursor=0")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let live = crate::subagents::native_change_event(
            &state,
            "thread/deleted",
            &json!({"threadId":"other-child"}),
        )
        .await
        .unwrap()
        .unwrap();
        state.events.send(live.clone()).unwrap();
        let mut body = response.into_body();
        for event in [replay, live] {
            let chunk = next_sse_chunk(&mut body).await;
            assert!(chunk.contains(&format!("id: {}", event.seq)));
            assert!(chunk.contains(crate::subagents::THREAD_SUBAGENTS_CHANGED_EVENT));
            assert!(chunk.contains(&serde_json::to_string(&event.payload).unwrap()));
            assert!(!chunk.contains("subagentId"));
        }
    }

    #[tokio::test]
    async fn sse_skips_persisted_timeline_replay_before_live_events() {
        let (state, _) = test_state().await;
        let replay = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: crate::events::ACCOUNT_RATE_LIMITS_UPDATED_EVENT.to_string(),
                codex_method: Some("turn/completed".to_string()),
                payload: json!({"threadId": "t1", "phase": "replay"}),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get(format!("/v1/events?threadId=t1&cursor={}", replay.seq))
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let mut body = response.into_body();

        let live = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "thread_view.patch".to_string(),
                codex_method: Some("thread_view/patch".to_string()),
                payload: json!({"threadId": "t1", "phase": "live"}),
            })
            .await
            .unwrap();
        state.events.send(replay.clone()).unwrap();
        state.events.send(live.clone()).unwrap();

        let first = next_sse_chunk(&mut body).await;
        assert!(first.contains(&format!("id: {}", live.seq)));
        assert!(first.contains("\"phase\":\"live\""));
        assert!(!first.contains("\"phase\":\"replay\""));
    }

    #[tokio::test]
    async fn sse_refetches_selected_thread_instead_of_replaying_a_stale_projection_patch() {
        let (state, _) = test_state().await;
        let projection = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-1".to_string()),
                kind: "thread_view.patch".to_string(),
                codex_method: Some("thread_view/patch".to_string()),
                payload: json!({
                    "scope": "turn",
                    "viewRevision": 1,
                    "threadId": "t1",
                    "activeTurnId": "turn-1",
                    "liveState": "streaming",
                    "pendingApprovalRequests": [],
                    "pendingUserInputRequests": [],
                    "affectedTurnIds": ["turn-1"],
                    "rows": [{
                        "id": "row-item-1",
                        "kind": "assistant_message",
                        "displayOrder": 1,
                        "status": "running",
                        "turnId": "turn-1",
                        "item": {
                            "id": "projection-turn-1-item-1",
                            "threadId": "t1",
                            "turnId": "turn-1",
                            "itemId": "item-1",
                            "itemType": "agentMessage",
                            "status": "running",
                            "displayOrder": 1,
                            "codexMethod": "item/agentMessage/delta",
                            "payload": {
                                "source": "gatewayStream",
                                "turnId": "turn-1",
                                "itemId": "item-1",
                                "item": {"text": "hello"},
                                "itemSnapshot": {
                                    "id": "item-1",
                                    "itemType": "agentMessage",
                                    "rawPayload": {"id": "item-1", "type": "agentMessage", "text": "hello"}
                                }
                            }
                        },
                        "items": [],
                        "fileChanges": [],
                        "collapsedRows": []
                    }],
                    "turns": [
                        {
                            "id": "turn-1",
                            "status": "running",
                            "startedAt": 1,
                            "completedAt": null
                        }
                    ],
                    "items": [],
                    "debugText": "hello"
                }),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?cursor=0&threadId=t1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let live = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "gateway.warning".to_string(),
                codex_method: None,
                payload: json!({"threadId": "t1", "phase": "live"}),
            })
            .await
            .unwrap();
        state.events.send(live).unwrap();

        let mut body = response.into_body();
        let first = next_sse_chunk(&mut body).await;
        assert!(first.contains(&format!("id: {}", projection.seq)));
        assert!(first.contains("thread_view.refresh_required"));
        assert!(!first.contains("thread_view.patch"));
        assert!(!first.contains("\"hello\""));
        assert!(!first.contains("\"phase\":\"live\""));
    }

    #[tokio::test]
    async fn sse_allows_live_selected_thread_view_item_deltas_without_replay() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=thread-1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/agentMessage/delta".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "delta": "hello"
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let mut body = response.into_body();
        let first = next_sse_chunk(&mut body).await;
        assert!(first.contains("thread_view.patch"));
        assert!(first.contains("\"scope\":\"full_snapshot\""));
        assert!(first.contains("\"text\":\"hello\""));

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/agentMessage/delta".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "delta": " world"
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let second = next_sse_chunk(&mut body).await;
        assert!(second.contains("thread_view.item_delta"));
        assert!(second.contains("\"delta\":\" world\""));
        assert!(second.contains("\"itemId\":\"item-1\""));
        assert!(!second.contains("\"scope\":\"turn\""));
        assert!(!second.contains("\"rows\""));

        let replayed = state
            .store
            .replay_events(None, None, Some("thread-1".to_string()))
            .await
            .unwrap();
        assert!(replayed
            .iter()
            .all(|event| event.kind != "timeline.item_delta"));
        assert!(replayed
            .iter()
            .all(|event| event.kind != "thread_view.item_delta"));
        assert!(replayed
            .iter()
            .all(|event| event.kind != "thread_view.refresh_required"));
    }

    #[tokio::test]
    async fn sse_global_stream_does_not_deliver_thread_view_item_deltas() {
        let (state, _) = test_state().await;
        thread_view::record_item_delta(
            &state.thread_views,
            "thread-1",
            "turn-1",
            "item-1",
            "hello",
            std::future::ready(Ok(1)),
        )
        .await
        .unwrap();
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/agentMessage/delta".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "delta": " world"
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let mut body = response.into_body();
        let delivered = timeout(Duration::from_millis(50), next_sse_chunk(&mut body)).await;
        assert!(
            delivered.is_err(),
            "global SSE stream should not receive thread_view.item_delta"
        );
    }

    #[tokio::test]
    async fn sse_global_stream_compacts_non_selected_thread_view_patches() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?excludeThreadId=thread-1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/updated".to_string(),
                params: json!({
                    "threadId": "thread-2",
                    "turnId": "turn-2",
                    "item": {
                        "id": "call-1",
                        "type": "commandExecution",
                        "command": "cat large-output.txt",
                        "output": "large output that belongs only on the selected thread stream"
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let mut body = response.into_body();
        let first = next_sse_chunk(&mut body).await;
        assert!(first.contains("thread_view.patch"));
        assert!(first.contains("\"threadId\":\"thread-2\""));
        assert!(first.contains("\"scope\":\"lifecycle\""));
        assert!(first.contains("\"activeTurnId\":\"turn-2\""));
        assert!(first.contains("\"liveState\":\"streaming\""));
        assert!(!first.contains("\"rows\""));
        assert!(!first.contains("\"affectedTurnIds\""));
        assert!(!first.contains("large output that belongs only on the selected thread stream"));
    }

    #[tokio::test]
    async fn sse_selected_thread_stream_keeps_thread_view_patch_rows() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=thread-2&includeCommandOutputs=true")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/updated".to_string(),
                params: json!({
                    "threadId": "thread-2",
                    "turnId": "turn-2",
                    "item": {
                        "id": "call-1",
                        "type": "commandExecution",
                        "command": "cat selected-output.txt",
                        "output": "selected thread output stays on the selected stream"
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let mut body = response.into_body();
        let first = next_sse_chunk(&mut body).await;
        assert!(first.contains("thread_view.patch"));
        assert!(first.contains("\"threadId\":\"thread-2\""));
        assert!(first.contains("\"rows\""));
        assert!(first.contains("selected thread output stays on the selected stream"));
        assert!(!first.contains("\"scope\":\"lifecycle\""));
    }

    #[tokio::test]
    async fn sse_global_stream_excludes_selected_thread_when_requested() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?excludeThreadId=thread-1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let excluded = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: None,
                kind: "thread_view.patch".to_string(),
                codex_method: Some("thread_view/patch".to_string()),
                payload: json!({"threadId": "thread-1", "phase": "excluded"}),
            })
            .await
            .unwrap();
        let delivered = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-2".to_string()),
                turn_id: Some("turn-2".to_string()),
                item_id: None,
                kind: "thread_view.patch".to_string(),
                codex_method: Some("thread_view/patch".to_string()),
                payload: json!({"threadId": "thread-2", "phase": "delivered"}),
            })
            .await
            .unwrap();
        state.events.send(excluded).unwrap();
        state.events.send(delivered.clone()).unwrap();

        let mut body = response.into_body();
        let first = next_sse_chunk(&mut body).await;
        assert!(first.contains(&format!("id: {}", delivered.seq)));
        assert!(first.contains("\"phase\":\"delivered\""));
        assert!(!first.contains("\"phase\":\"excluded\""));
    }

    #[tokio::test]
    async fn sse_delivers_selected_thread_notifications_updates() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=thread-1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let event = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "thread.notifications_updated".to_string(),
                codex_method: None,
                payload: json!({
                    "threadId": "thread-1",
                    "notificationsEnabled": false,
                    "updatedAt": "2026-05-27T00:00:00Z"
                }),
            })
            .await
            .unwrap();
        state.events.send(event.clone()).unwrap();

        let mut body = response.into_body();
        let first = next_sse_chunk(&mut body).await;
        assert!(first.contains(&format!("id: {}", event.seq)));
        assert!(first.contains("thread.notifications_updated"));
        assert!(first.contains("\"notificationsEnabled\":false"));
    }

    #[tokio::test]
    async fn sse_delivers_selected_thread_gateway_errors() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=thread-1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let event = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("error-1".to_string()),
                kind: "gateway.error".to_string(),
                codex_method: None,
                payload: json!({"message": "selected error routed"}),
            })
            .await
            .unwrap();
        state.events.send(event.clone()).unwrap();

        let mut body = response.into_body();
        let first = next_sse_chunk(&mut body).await;
        assert!(first.contains(&format!("id: {}", event.seq)));
        assert!(first.contains("gateway.error"));
        assert!(first.contains("selected error routed"));
    }

    #[tokio::test]
    async fn sse_rejects_thread_and_exclude_thread_together() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=thread-1&excludeThreadId=thread-1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn sse_replay_recovers_skipped_selected_thread_cursor_events_with_refresh_required() {
        let (state, _) = test_state().await;
        ingest_inbound(
            InboundMessage::Notification {
                method: "item/agentMessage/delta".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "delta": "missed prefix"
                }),
            },
            &state,
        )
        .await
        .unwrap();
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?cursor=0&threadId=thread-1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let mut body = response.into_body();
        let first = next_sse_chunk(&mut body).await;
        assert!(first.contains("thread_view.refresh_required"));
        assert!(first.contains("\"reason\":\"missed_cursor\""));
        assert!(!first.contains("timeline.item_delta"));
        assert!(!first.contains("missed prefix"));
    }

    #[tokio::test]
    async fn sse_replay_converts_legacy_unscoped_thread_view_patch_to_refresh_required() {
        let (state, _) = test_state().await;
        let legacy_projection = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: None,
                kind: "thread_view.patch".to_string(),
                codex_method: Some("thread_view/patch".to_string()),
                payload: json!({
                    "viewRevision": 1,
                    "threadId": "t1",
                    "activeTurnId": "turn-1",
                    "liveState": "streaming",
                    "pendingApprovalRequests": [],
                    "pendingUserInputRequests": [],
                    "turns": [],
                    "items": [],
                    "legacyText": "stale projection should not replay"
                }),
            })
            .await
            .unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/events?cursor=0&threadId=t1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let mut body = response.into_body();
        let first = next_sse_chunk(&mut body).await;
        assert!(first.contains(&format!("id: {}", legacy_projection.seq)));
        assert!(first.contains("thread_view.refresh_required"));
        assert!(first.contains("\"reason\":\"missed_cursor\""));
        assert!(!first.contains("thread_view.patch"));
        assert!(!first.contains("stale projection should not replay"));
    }

    #[tokio::test]
    async fn sse_delivers_native_thread_name_updates_to_each_client() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());
        let mut clients = Vec::new();
        for _ in 0..2 {
            let response = app
                .clone()
                .oneshot(
                    Request::get("/v1/events?threadId=t1")
                        .header("accept", "text/event-stream")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            clients.push(response.into_body());
        }

        ingest_inbound(
            InboundMessage::Notification {
                method: "thread/name/updated".to_string(),
                params: json!({"threadId": "t1", "threadName": "Manual name"}),
            },
            &state,
        )
        .await
        .unwrap();
        let named_event = state
            .store
            .replay_events(None, None, Some("t1".into()))
            .await
            .unwrap()
            .into_iter()
            .find(|event| event.codex_method.as_deref() == Some("thread/name/updated"))
            .unwrap();
        let seq = named_event.seq;

        for body in &mut clients {
            let chunk = next_sse_chunk(body).await;
            assert!(chunk.contains(&format!("id: {seq}")));
            assert!(chunk.contains("thread/name/updated"));
            assert!(chunk.contains("Manual name"));
        }
    }

    #[tokio::test]
    async fn sse_allows_live_thread_token_usage_notifications() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=t1")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let token_usage = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: None,
                kind: "timeline.thread_metadata".to_string(),
                codex_method: Some("thread/tokenUsage/updated".to_string()),
                payload: json!({
                    "threadId": "t1",
                    "turnId": "turn-1",
                    "tokenUsage": {
                        "last": {"totalTokens": 20_000},
                        "total": {"totalTokens": 20_000},
                        "modelContextWindow": 28_000
                    }
                }),
            })
            .await
            .unwrap();
        state.events.send(token_usage.clone()).unwrap();

        let mut body = response.into_body();
        let chunk = next_sse_chunk(&mut body).await;
        assert!(chunk.contains(&format!("id: {}", token_usage.seq)));
        assert!(chunk.contains("thread/tokenUsage/updated"));
        assert!(chunk.contains("modelContextWindow"));
    }

    #[tokio::test]
    async fn sse_allows_live_account_rate_limit_notifications() {
        let (state, _) = test_state().await;
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events")
                    .header("accept", "text/event-stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let rate_limits = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: None,
                turn_id: None,
                item_id: None,
                kind: crate::events::ACCOUNT_RATE_LIMITS_UPDATED_EVENT.to_string(),
                codex_method: Some("account/rateLimits/updated".to_string()),
                payload: json!({
                    "rateLimits": {
                        "limitId": "codex",
                        "primary": {
                            "usedPercent": 12,
                            "resetsAt": 1_777_750_400_i64,
                            "windowDurationMins": 300
                        },
                        "secondary": {
                            "usedPercent": 25,
                            "resetsAt": 1_778_355_200_i64,
                            "windowDurationMins": 10_080
                        }
                    }
                }),
            })
            .await
            .unwrap();
        state.events.send(rate_limits.clone()).unwrap();

        let mut body = response.into_body();
        let chunk = next_sse_chunk(&mut body).await;
        assert!(chunk.contains(&format!("id: {}", rate_limits.seq)));
        assert!(chunk.contains("account/rateLimits/updated"));
        assert!(chunk.contains("\"usedPercent\":12"));
    }

    struct RecordingPushSender {
        outcome: PushDeliveryOutcome,
        payloads: StdMutex<Vec<NotificationPayload>>,
    }

    impl RecordingPushSender {
        fn new(outcome: PushDeliveryOutcome) -> Self {
            Self {
                outcome,
                payloads: StdMutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl PushSender for RecordingPushSender {
        async fn send(
            &self,
            _subscription: &PushSubscription,
            payload: &NotificationPayload,
        ) -> PushDeliveryOutcome {
            self.payloads.lock().unwrap().push(payload.clone());
            self.outcome.clone()
        }
    }

    struct SelectivePushSender {
        stale_endpoint: String,
        payloads: StdMutex<Vec<NotificationPayload>>,
    }

    #[async_trait]
    impl PushSender for SelectivePushSender {
        async fn send(
            &self,
            subscription: &PushSubscription,
            payload: &NotificationPayload,
        ) -> PushDeliveryOutcome {
            self.payloads.lock().unwrap().push(payload.clone());
            if subscription.endpoint == self.stale_endpoint {
                PushDeliveryOutcome::StaleEndpoint
            } else {
                PushDeliveryOutcome::Sent
            }
        }
    }

    struct FlakyEndpointPushSender {
        flaky_endpoint: String,
        attempts_by_endpoint: StdMutex<HashMap<String, usize>>,
    }

    #[async_trait]
    impl PushSender for FlakyEndpointPushSender {
        async fn send(
            &self,
            subscription: &PushSubscription,
            _payload: &NotificationPayload,
        ) -> PushDeliveryOutcome {
            let mut attempts_by_endpoint = self.attempts_by_endpoint.lock().unwrap();
            let attempts = attempts_by_endpoint
                .entry(subscription.endpoint.clone())
                .or_insert(0);
            *attempts += 1;
            if subscription.endpoint == self.flaky_endpoint && *attempts == 1 {
                PushDeliveryOutcome::TemporaryFailure
            } else {
                PushDeliveryOutcome::Sent
            }
        }
    }

    fn thread_read_response(thread_id: &str, completed_turns: usize) -> Value {
        let turns = (0..completed_turns)
            .map(|index| {
                json!({
                    "id": format!("turn-{index}"),
                    "status": {"type": "completed"},
                    "items": []
                })
            })
            .collect::<Vec<_>>();
        json!({
            "thread": {
                "id": thread_id,
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "source": "cli",
                "status": {"type": "idle"},
                "turns": turns,
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }
        })
    }

    fn active_thread_read_response(thread_id: &str, turn_id: &str) -> Value {
        json!({
            "thread": {
                "id": thread_id,
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "source": "cli",
                "status": {"type": "active", "activeFlags": []},
                "turns": [{
                    "id": turn_id,
                    "status": {"type": "running"},
                    "items": []
                }],
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }
        })
    }

    async fn recv_event_kind(
        receiver: &mut tokio::sync::broadcast::Receiver<EventEnvelope>,
        expected_kind: &str,
    ) -> EventEnvelope {
        timeout(Duration::from_secs(2), async {
            loop {
                let event = receiver.recv().await.unwrap();
                if event.kind == expected_kind {
                    return event;
                }
            }
        })
        .await
        .unwrap()
    }

    fn assert_completion_head_request(request: &(String, Value), thread_id: &str) {
        assert_eq!(
            request,
            &(
                "thread/turns/list".into(),
                json!({
                    "threadId":thread_id, "cursor":null, "sortDirection":"desc", "itemsView":"notLoaded", "limit":8
                })
            )
        );
    }

    #[derive(Default)]
    struct BlockingThreadListAppServer {
        projects: RecordingAppServer,
        in_flight: AtomicUsize,
        max_in_flight: AtomicUsize,
        total_requests: AtomicUsize,
        release: Arc<Notify>,
    }

    #[async_trait]
    impl AppServer for BlockingThreadListAppServer {
        fn is_ready(&self) -> bool {
            true
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
            if method.starts_with("project/") {
                return self.projects.request(method, params).await;
            }
            if method != "thread/list" || !params["projectId"].is_string() {
                return Ok(match method {
                    "thread/read" => json!({"thread": thread_summary("thread-1")}),
                    "thread/list" => {
                        json!({"data": [], "nextCursor": null, "backwardsCursor": null})
                    }
                    _ => json!({}),
                });
            }

            self.total_requests.fetch_add(1, Ordering::SeqCst);
            let in_flight = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_in_flight.fetch_max(in_flight, Ordering::SeqCst);
            self.release.notified().await;
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            Ok(json!({"data": [], "nextCursor": null, "backwardsCursor": null}))
        }

        async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct UnresumableThreadAppServer {
        requests: StdMutex<Vec<(String, Value)>>,
    }

    #[async_trait]
    impl AppServer for UnresumableThreadAppServer {
        fn is_ready(&self) -> bool {
            true
        }
        fn readiness_error(&self) -> Option<String> {
            None
        }
        async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
            self.requests
                .lock()
                .unwrap()
                .push((method.into(), params.clone()));
            match method {
                "thread/read" => {
                    let mut thread = thread_summary(params["threadId"].as_str().unwrap());
                    thread["status"] = json!({"type":"notLoaded"});
                    Ok(json!({"thread":thread}))
                }
                "thread/resume" => {
                    Err(ApiError::BadGateway("native resume rejected target".into()))
                }
                _ => Err(ApiError::BadGateway(format!(
                    "unexpected activation RPC {method}"
                ))),
            }
        }
        async fn respond(&self, _: &str, _: Value) -> ApiResult<()> {
            Err(ApiError::BadGateway("unexpected approval response".into()))
        }
    }

    async fn mark_thread_session_active(state: &AppState, thread_id: &str, turn_id: &str) {
        thread_view::record_item_delta(
            &state.thread_views,
            thread_id,
            turn_id,
            "agent-active",
            "working",
            std::future::ready(Ok(1)),
        )
        .await
        .unwrap();
    }

    fn notification_thread_summary_response(
        thread_id: &str,
        name: &str,
        source: Value,
        thread_source: Option<&str>,
    ) -> Value {
        let mut response = thread_read_response(thread_id, 0);
        response["thread"]["name"] = json!(name);
        response["thread"]["source"] = source;
        if let Some(thread_source) = thread_source {
            response["thread"]["threadSource"] = json!(thread_source);
        }
        response
    }

    async fn response_json(response: axum::response::Response) -> Value {
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn serialized_timeline_items(timeline: &Value) -> Vec<&Value> {
        let mut items = Vec::new();
        if let Some(rows) = timeline.get("rows").and_then(Value::as_array) {
            collect_serialized_row_items(rows, &mut items);
        }
        items
    }

    fn collect_serialized_row_items<'a>(rows: &'a [Value], items: &mut Vec<&'a Value>) {
        for row in rows {
            if let Some(item) = row.get("item").filter(|item| !item.is_null()) {
                items.push(item);
            }
            if let Some(row_items) = row.get("items").and_then(Value::as_array) {
                items.extend(row_items);
            }
            if let Some(collapsed_rows) = row.get("collapsedRows").and_then(Value::as_array) {
                collect_serialized_row_items(collapsed_rows, items);
            }
        }
    }

    fn plugin_read_response(
        installed: bool,
        marketplace_path: &std::path::Path,
        plugin_root: Option<&std::path::Path>,
    ) -> Value {
        let generative_ui_skill_path = plugin_root
            .map(|root| root.join("skills/generative-ui/SKILL.md"))
            .unwrap_or_else(|| "/tmp/generative-ui/SKILL.md".into());
        json!({
            "plugin": {
                "summary": {
                    "id": "kodex-local:kodex-control",
                    "name": "kodex-control",
                    "installed": installed,
                    "enabled": installed,
                    "installPolicy": "available",
                    "authPolicy": "onInstall",
                    "source": {"source": "local", "path": "./plugins/kodex-control"},
                    "interface": {
                        "displayName": "Kodex Control",
                        "shortDescription": "Guarded Kodex self-management tools",
                        "capabilities": ["Interactive", "Write"]
                    }
                },
                "marketplaceName": "kodex-local",
                "marketplacePath": marketplace_path.display().to_string(),
                "skills": [
                    {
                        "name": "generative-ui",
                        "path": generative_ui_skill_path.display().to_string(),
                        "description": "Open interactive generated app-surface panes.",
                        "enabled": true,
                        "scope": "plugin"
                    }
                ],
                "mcpServers": ["kodex-control"],
                "apps": [],
                "description": null
            }
        })
    }

    fn mcp_server_status(name: &str, tool_name: &str) -> Value {
        json!({
            "name": name,
            "authStatus": "unsupported",
            "tools": {
                tool_name: {
                    "name": tool_name,
                    "description": "Lookup docs",
                    "inputSchema": {"type": "object", "properties": {}}
                }
            },
            "resources": [{
                "name": "docs",
                "title": "Docs",
                "uri": "file:///docs",
                "mimeType": "text/plain"
            }],
            "resourceTemplates": [{
                "name": "doc-template",
                "title": "Doc Template",
                "uriTemplate": "file:///docs/{id}",
                "mimeType": "text/plain"
            }]
        })
    }

    fn thread_summary(id: &str) -> Value {
        json!({
            "id": id,
            "cliVersion": "0.130.0",
            "cwd": "/workspace",
            "ephemeral": false,
            "modelProvider": "openai",
            "preview": "hello",
            "source": "cli",
            "status": {"type": "idle"},
            "turns": [],
            "createdAt": 1_767_225_600_i64,
            "updatedAt": 1_767_225_600_i64
        })
    }

    fn thread_summary_with_cwd(id: &str, cwd: &str) -> Value {
        let mut thread = thread_summary(id);
        thread["cwd"] = json!(cwd);
        thread
    }

    fn thread_shell_response(id: &str) -> Value {
        json!({
            "thread": thread_summary(id)
        })
    }

    fn skills_list_response(cwd: &str, name: &str, path: &str) -> Value {
        json!({
            "data": [{
                "cwd": cwd,
                "errors": [],
                "skills": [{
                    "name": name,
                    "path": path,
                    "description": format!("{name} description"),
                    "enabled": true,
                    "scope": "user",
                    "shortDescription": null,
                    "interface": null
                }]
            }]
        })
    }

    const VALID_1X1_PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5,
        0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc,
        0xff, 0x1f, 0x00, 0x03, 0x03, 0x02, 0x00, 0xef, 0xa2, 0xa7, 0x5b, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    fn multipart_body(file_name: &str, content_type: &str, bytes: &[u8]) -> Vec<u8> {
        multipart_body_with_field("images", file_name, content_type, bytes)
    }

    fn multipart_body_with_field(
        field_name: &str,
        file_name: &str,
        content_type: &str,
        bytes: &[u8],
    ) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(b"--kodexboundary\r\n");
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"{field_name}\"; filename=\"{file_name}\"\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n--kodexboundary--\r\n");
        body
    }

    fn file_preview_url(thread_id: &str, path: &std::path::Path) -> String {
        format!(
            "/v1/threads/{thread_id}/files/preview?path={}",
            path.display()
        )
    }

    fn skill_icon_url(path: &std::path::Path) -> String {
        format!("/v1/skills/icon?path={}", path.display())
    }

    async fn response_text(response: axum::response::Response) -> String {
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(body.to_vec()).unwrap()
    }

    fn assert_ok(response: axum::response::Response) {
        assert_eq!(response.status(), StatusCode::OK);
    }

    async fn next_sse_chunk(body: &mut Body) -> String {
        let frame = timeout(Duration::from_secs(2), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let data = frame.into_data().unwrap();
        String::from_utf8(data.to_vec()).unwrap()
    }

    struct RetryableAppServer;

    struct MissingNativeThreadAppServer;

    #[derive(Default)]
    struct NotMaterializedThreadHistoryAppServer {
        requests: StdMutex<Vec<(String, Value)>>,
    }

    #[derive(Default)]
    struct BlockingThreadReadAppServer {
        thread_read_started: Notify,
        release_thread_read: Notify,
    }

    #[derive(Default)]
    struct BlockingRespondAppServer {
        ready: std::sync::atomic::AtomicBool,
        responses: StdMutex<Vec<(String, Value)>>,
        respond_started: Notify,
        release_response: Notify,
    }

    #[async_trait]
    impl AppServer for RetryableAppServer {
        fn is_ready(&self) -> bool {
            true
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, _method: &str, _params: Value) -> ApiResult<Value> {
            Err(ApiError::Retryable("server overloaded".to_string()))
        }

        async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
            Ok(())
        }
    }

    #[async_trait]
    impl AppServer for MissingNativeThreadAppServer {
        fn is_ready(&self) -> bool {
            true
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, _method: &str, _params: Value) -> ApiResult<Value> {
            Err(ApiError::NativeRpc(crate::app_server::JsonRpcError {
                code: -32600,
                message: "thread not loaded: thread-missing".into(),
                data: None,
            }))
        }

        async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
            Ok(())
        }
    }

    #[async_trait]
    impl AppServer for NotMaterializedThreadHistoryAppServer {
        fn is_ready(&self) -> bool {
            true
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, method: &str, params: Value) -> ApiResult<Value> {
            self.requests
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            if method == "thread/turns/list" {
                return Err(ApiError::NativeRpc(crate::app_server::JsonRpcError {
                    code: -32600,
                    message: "thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message".into(),
                    data: None,
                }));
            }
            Ok(json!({
                "thread": {
                    "id": "thread-1",
                    "cliVersion": "0.130.0",
                    "cwd": "/workspace",
                    "ephemeral": false,
                    "modelProvider": "openai",
                    "preview": "pending",
                    "source": "cli",
                    "status": {"type": "active"},
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_600_i64
                }
            }))
        }

        async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
            Ok(())
        }
    }

    #[async_trait]
    impl AppServer for BlockingThreadReadAppServer {
        fn is_ready(&self) -> bool {
            true
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, method: &str, _params: Value) -> ApiResult<Value> {
            if method == "thread/read" {
                self.thread_read_started.notify_one();
                self.release_thread_read.notified().await;
                return Ok(thread_read_response("thread-1", 0));
            }
            if method == "thread/turns/list" {
                return Ok(json!({
                    "data": [],
                    "nextCursor": null,
                    "backwardsCursor": null
                }));
            }
            Ok(json!({}))
        }

        async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
            Ok(())
        }
    }

    #[async_trait]
    impl AppServer for BlockingRespondAppServer {
        fn is_ready(&self) -> bool {
            self.ready.load(Ordering::SeqCst)
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, method: &str, _params: Value) -> ApiResult<Value> {
            Ok(json!({"ok": true, "method": method}))
        }

        async fn respond(&self, request_id: &str, result: Value) -> ApiResult<()> {
            self.responses
                .lock()
                .unwrap()
                .push((request_id.to_string(), result));
            self.respond_started.notify_one();
            self.release_response.notified().await;
            Ok(())
        }
    }
}
