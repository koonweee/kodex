pub mod account;
pub mod approvals;
pub mod automations;
pub mod capabilities;
pub mod composer_settings;
pub mod events;
pub mod file_preview;
pub mod health;
pub mod kodex_control_plugin;
pub mod mcp;
pub mod models;
pub mod notifications;
pub mod permission_profiles;
pub mod project_previews;
pub mod projects;
pub mod self_control;
pub mod skills;
pub mod thread_presence;
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
            header::{ACCEPT_ENCODING, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_TYPE},
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
        app_server_api::{ThreadLiveState, TimelineSkillMention, UserInput},
        automations,
        config::Config,
        error::{ApiError, ApiResult},
        events::ingest_inbound,
        notifications::{
            process_due_deliveries, NotificationKind, NotificationPayload, PushDeliveryOutcome,
            PushSender,
        },
        queue,
        store::{
            NewApproval, NewAutomation, NewEvent, NewNotificationDelivery, NewPushSubscription,
            NotificationDeliveryStatus, PushSubscription, Store, ThreadLocalSettingsOverlay,
            ThreadRuntimeState, ThreadRuntimeStatus,
        },
        thread_view,
        title_generation::{ThreadTitleGenerator, ThreadTitleRequest, TitleGenerationService},
    };

    async fn test_state() -> (AppState, Arc<RecordingAppServer>) {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(RecordingAppServer::default());
        app_server.ready.store(true, Ordering::SeqCst);
        (
            AppState::new(Config::default(), store, app_server.clone())
                .with_title_generation_service(
                    crate::title_generation::TitleGenerationService::disabled(),
                ),
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
            thread_read_response("thread-1", 1),
            thread_read_response_with_agent_message(
                "thread-1",
                "Octopus Heart Facts With An Overly Long Thread Title That Should Not Fill The Banner",
                "Tool output should stay hidden.",
                "Yes, octopuses actually have three hearts.\n\nThey use two for their gills.",
            ),
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
        assert_eq!(payloads[0].badge_count, 1);

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
        state
            .store
            .mark_thread_seen_completed_agent_turns("thread-1", 1)
            .await
            .unwrap();
        app_server.queued_responses.lock().unwrap().extend([
            thread_read_response("thread-1", 1),
            thread_read_response("thread-1", 1),
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
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(thread_read_response("thread-1", 1));

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
        app_server.queued_responses.lock().unwrap().extend([
            thread_read_response("thread-1", 1),
            thread_read_response("thread-1", 1),
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
        assert!(sender.payloads.lock().unwrap().is_empty());
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
            thread_read_response("thread-1", 1),
            thread_read_response("thread-1", 1),
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
            app_server.queued_responses.lock().unwrap().extend([
                thread_read_response("thread-subagent", 1),
                thread_read_response_with_agent_message_source(
                    "thread-subagent",
                    "Subagent",
                    "Tool output should stay hidden.",
                    "Subagent final answer.",
                    source,
                    thread_source,
                ),
                json!({"data": [], "nextCursor": null, "backwardsCursor": null}),
            ]);

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
                    badge_count: 1,
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
                    badge_count: 1,
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
        assert_eq!(body["skills"][0], "kodex-proxy-evaluation");
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
        assert_eq!(body["status"]["skills"][0], "kodex-proxy-evaluation");
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
        assert_eq!(body["capabilities"]["projectPreviewApply"], true);
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
        assert_eq!(capabilities_body["appServer"]["schemaVersion"], "0.135.0");
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
            "/v1/projects/{projectId}/previews",
            "/v1/projects/{projectId}/preview-services",
            "/v1/projects/{projectId}/preview-services/{serviceId}",
            "/v1/projects/{projectId}/previews/{previewId}",
            "/v1/projects/{projectId}/previews/{previewId}/routes",
            "/v1/projects/{projectId}/previews/{previewId}/routes/{routeId}",
            "/v1/project-previews/reload",
            "/v1/threads",
            "/v1/sidebar/threads",
            "/v1/chats/threads",
            "/v1/threads/pinned",
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
            "/v1/threads/{threadId}/queued-inputs/{queueId}/retry",
            "/v1/threads/{threadId}/queued-inputs/{queueId}/steer",
            "/v1/threads/{threadId}/files/preview",
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
            "/v1/mcp/servers/{server}/replace",
            "/v1/mcp/servers/{server}/resources/read",
            "/v1/mcp/servers/{server}/oauth-login",
            "/v1/mcp/reload",
            "/v1/self-control/status",
            "/v1/self-control/projects",
            "/v1/self-control/projects/{projectId}",
            "/v1/self-control/projects/{projectId}/previews",
            "/v1/self-control/project-previews/apply",
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
        assert!(
            openapi["components"]["schemas"]["QueuedInputStatus"]["enum"]
                .as_array()
                .is_some_and(|values| values.iter().any(|value| value == "pendingCommit"))
        );
        assert_eq!(
            openapi["paths"]["/v1/threads/{threadId}/queued-inputs/{queueId}/steer"]["post"]
                ["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/QueuedInputResponse"
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
            "Codex app-server is incompatible: rejected required persistExtendedHistory field"
                .to_string(),
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
            "Codex app-server is incompatible: rejected required persistExtendedHistory field"
        );
    }

    #[tokio::test]
    async fn project_create_resolves_relative_cwd_from_home() {
        let (mut state, _) = test_state().await;
        let home = tempdir().unwrap();
        Arc::make_mut(&mut state.config).projects.home_dir = home.path().join(".");
        let cwd = tempfile::Builder::new()
            .prefix("kodex-project-")
            .tempdir_in(home.path())
            .unwrap();
        let relative_cwd = cwd
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap()
            .to_string();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"cwd": relative_cwd}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let project = response_json(response).await;
        assert_eq!(
            project["cwd"],
            std::fs::canonicalize(cwd.path())
                .unwrap()
                .to_string_lossy()
                .to_string()
        );
        assert_eq!(project["name"], relative_cwd);
    }

    #[tokio::test]
    async fn project_create_can_create_missing_relative_directory_under_home() {
        let (mut state, _) = test_state().await;
        let home = tempdir().unwrap();
        Arc::make_mut(&mut state.config).projects.home_dir = home.path().to_path_buf();
        let parent = tempfile::Builder::new()
            .prefix("kodex-project-")
            .tempdir_in(home.path())
            .unwrap();
        let relative_cwd = format!(
            "{}/missing-child",
            parent
                .path()
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap()
        );
        let expected_cwd = parent.path().join("missing-child");
        let app = build_router(state);

        let missing = app
            .clone()
            .oneshot(
                Request::post("/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"cwd": relative_cwd}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::BAD_REQUEST);
        assert!(!expected_cwd.exists());

        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/projects")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"cwd": relative_cwd, "createDirectory": true}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::CREATED);
        assert!(expected_cwd.is_dir());
    }

    #[tokio::test]
    async fn project_routes_create_list_get_and_reject_missing_cwd() {
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
                    .body(Body::from(json!({"name": "Kodex", "cwd": cwd}).to_string()))
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
    async fn project_preview_routes_persist_validate_and_report_gateway_status() {
        let (mut state, _) = test_state().await;
        Arc::make_mut(&mut state.config).previews.caddy_binary =
            "__missing_kodex_test_caddy__".to_string();
        state.previews = crate::previews::PreviewManager::new(state.config.clone());
        let cwd = std::env::current_dir().unwrap().display().to_string();
        let project = state
            .store
            .create_project("Kodex".to_string(), cwd)
            .await
            .unwrap();
        let app = build_router(state);

        let frontend = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/projects/{}/preview-services", project.id))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"name": "Frontend", "localPort": 3000}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(frontend.status(), StatusCode::CREATED);
        let frontend = response_json(frontend).await;
        assert_eq!(frontend["service"]["name"], "Frontend");
        assert_eq!(frontend["service"]["status"]["reachability"], "unreachable");
        assert_eq!(frontend["subsystem"]["state"], "disabled");
        let frontend_id = frontend["service"]["id"].as_str().unwrap().to_string();

        let backend = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/projects/{}/preview-services", project.id))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"name": "Backend", "localPort": 4000, "healthPath": "/health"})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(backend.status(), StatusCode::CREATED);
        let backend = response_json(backend).await;
        let backend_id = backend["service"]["id"].as_str().unwrap().to_string();

        let preview = app
            .clone()
            .oneshot(
                Request::post(format!("/v1/projects/{}/previews", project.id))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"name": "App", "rootServiceId": frontend_id}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(preview.status(), StatusCode::CREATED);
        let preview = response_json(preview).await;
        assert_eq!(preview["publicPort"], 13000);
        assert_eq!(preview["status"]["state"], "degraded");
        let preview_id = preview["id"].as_str().unwrap().to_string();

        let route = app
            .clone()
            .oneshot(
                Request::post(format!(
                    "/v1/projects/{}/previews/{preview_id}/routes",
                    project.id
                ))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"pathPattern": "/api/*", "serviceId": backend_id, "stripPrefix": true})
                        .to_string(),
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(route.status(), StatusCode::CREATED);
        let route = response_json(route).await;
        assert_eq!(route["route"]["pathPattern"], "/api/*");

        let invalid_route = app
            .clone()
            .oneshot(
                Request::post(format!(
                    "/v1/projects/{}/previews/{preview_id}/routes",
                    project.id
                ))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"pathPattern": "/", "serviceId": backend_id}).to_string(),
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid_route.status(), StatusCode::BAD_REQUEST);

        let referenced_delete = app
            .clone()
            .oneshot(
                Request::delete(format!(
                    "/v1/projects/{}/preview-services/{frontend_id}",
                    project.id
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(referenced_delete.status(), StatusCode::BAD_REQUEST);

        let referenced_port_edit = app
            .clone()
            .oneshot(
                Request::patch(format!(
                    "/v1/projects/{}/preview-services/{frontend_id}",
                    project.id
                ))
                .header("content-type", "application/json")
                .body(Body::from(json!({"localPort": 3001}).to_string()))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(referenced_port_edit.status(), StatusCode::BAD_REQUEST);

        let disabled = app
            .clone()
            .oneshot(
                Request::patch(format!("/v1/projects/{}/previews/{preview_id}", project.id))
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"enabled": false}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(disabled.status(), StatusCode::OK);
        let disabled = response_json(disabled).await;
        assert_eq!(disabled["enabled"], false);
        assert_eq!(disabled["status"]["state"], "disabled");

        let listed = app
            .clone()
            .oneshot(
                Request::get(format!("/v1/projects/{}/previews", project.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed = response_json(listed).await;
        assert_eq!(listed["services"].as_array().unwrap().len(), 2);
        assert_eq!(listed["previews"][0]["routes"].as_array().unwrap().len(), 1);

        let reload = app
            .oneshot(
                Request::post("/v1/project-previews/reload")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reload.status(), StatusCode::OK);
        assert_eq!(response_json(reload).await["state"], "disabled");
    }

    #[tokio::test]
    async fn self_control_preview_apply_dry_run_create_and_second_apply_is_unchanged() {
        let (mut state, _) = test_state().await;
        Arc::make_mut(&mut state.config).previews.caddy_binary =
            "__missing_kodex_test_caddy__".to_string();
        state.previews = crate::previews::PreviewManager::new(state.config.clone());
        let cwd = std::env::current_dir().unwrap().display().to_string();
        let project = state
            .store
            .create_project("Kodex".to_string(), cwd)
            .await
            .unwrap();
        let app = build_router(state.clone());
        let desired = json!({
            "projectId": project.id,
            "dryRun": true,
            "services": [
                {"name": "frontend", "localPort": 4000},
                {"name": "backend", "localPort": 3000, "healthPath": "/health"}
            ],
            "previews": [{
                "name": "app",
                "publicPort": 13000,
                "rootServiceName": "frontend",
                "routes": [{
                    "pathPattern": "/api/*",
                    "serviceName": "backend",
                    "stripPrefix": true
                }]
            }]
        });

        let dry_run = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(desired.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(dry_run.status(), StatusCode::OK);
        let dry_run = response_json(dry_run).await;
        assert_eq!(dry_run["dryRun"], true);
        assert_eq!(dry_run["previews"]["services"].as_array().unwrap().len(), 0);
        assert!(dry_run["diff"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| change["action"] == "created"));

        let mut desired_apply = desired.clone();
        desired_apply["dryRun"] = Value::Bool(false);
        let apply = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(desired_apply.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(apply.status(), StatusCode::OK);
        let apply = response_json(apply).await;
        assert_eq!(apply["previews"]["services"].as_array().unwrap().len(), 2);
        assert_eq!(
            apply["previews"]["previews"][0]["routes"][0]["stripPrefix"],
            true
        );

        let second = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(desired_apply.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        let second = response_json(second).await;
        assert!(second["diff"]
            .as_array()
            .unwrap()
            .iter()
            .all(|change| change["action"] == "unchanged"));
        assert_eq!(second["previews"]["subsystem"]["state"], "disabled");

        let create_project_dir = tempdir().unwrap();
        let project_count_before = state.store.list_projects().await.unwrap().len();
        let dry_run_create = json!({
            "projectCwd": create_project_dir.path().display().to_string(),
            "projectName": "Dry Run Project",
            "createProject": true,
            "dryRun": true,
            "services": [{"name": "new-web", "localPort": 4300}],
            "previews": [{
                "name": "new-workspace",
                "publicPort": 13001,
                "rootServiceName": "new-web"
            }]
        });
        let dry_run = app
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(dry_run_create.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(dry_run.status(), StatusCode::OK);
        let dry_run = response_json(dry_run).await;
        assert_eq!(dry_run["dryRun"], true);
        assert_eq!(dry_run["project"]["id"], "dry-run:project");
        assert_eq!(
            state.store.list_projects().await.unwrap().len(),
            project_count_before
        );
    }

    #[tokio::test]
    async fn self_control_preview_apply_reconciles_by_ports_and_rejects_invalid_routes() {
        let (mut state, _) = test_state().await;
        Arc::make_mut(&mut state.config).previews.caddy_binary =
            "__missing_kodex_test_caddy__".to_string();
        state.previews = crate::previews::PreviewManager::new(state.config.clone());
        let project = state
            .store
            .create_project(
                "Kodex".to_string(),
                std::env::current_dir().unwrap().display().to_string(),
            )
            .await
            .unwrap();
        let app = build_router(state.clone());
        let initial = json!({
            "projectId": project.id,
            "services": [
                {"name": "frontend", "localPort": 4000},
                {"name": "backend", "localPort": 3000, "healthPath": "/health"}
            ],
            "previews": [{
                "name": "app",
                "publicPort": 13000,
                "rootServiceName": "frontend",
                "routes": [{
                    "pathPattern": "/api/*",
                    "serviceName": "backend"
                }]
            }]
        });
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(initial.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);

        let renamed = json!({
            "projectId": project.id,
            "services": [
                {"name": "web", "localPort": 4000},
                {"name": "api", "localPort": 3000, "healthPath": "/ready"}
            ],
            "previews": [{
                "name": "workspace",
                "publicPort": 13000,
                "rootServiceName": "web",
                "routes": [{
                    "pathPattern": "/api/*",
                    "serviceName": "api"
                }]
            }]
        });
        let reconciled = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(renamed.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reconciled.status(), StatusCode::OK);
        let reconciled = response_json(reconciled).await;
        assert_eq!(
            reconciled["previews"]["services"].as_array().unwrap().len(),
            2
        );
        assert_eq!(
            reconciled["previews"]["previews"].as_array().unwrap().len(),
            1
        );
        assert!(reconciled["diff"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| change["resource"] == "service"
                && change["name"] == "web"
                && change["action"] == "updated"));
        assert!(reconciled["diff"]
            .as_array()
            .unwrap()
            .iter()
            .any(|change| change["resource"] == "preview"
                && change["name"] == "workspace"
                && change["action"] == "updated"));

        let moved_ports = json!({
            "projectId": project.id,
            "services": [
                {"name": "web", "localPort": 5173},
                {"name": "api", "localPort": 3001, "healthPath": "/ready"}
            ],
            "previews": [{
                "name": "workspace",
                "publicPort": 13000,
                "rootServiceName": "web",
                "routes": [{
                    "pathPattern": "/api/*",
                    "serviceName": "api"
                }]
            }]
        });
        let moved = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(moved_ports.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(moved.status(), StatusCode::OK);
        let moved = response_json(moved).await;
        let services = moved["previews"]["services"].as_array().unwrap();
        assert!(services
            .iter()
            .any(|service| { service["name"] == "web" && service["localPort"] == 5173 }));
        assert!(services
            .iter()
            .any(|service| { service["name"] == "api" && service["localPort"] == 3001 }));
        let root_service_id = moved["previews"]["previews"][0]["rootServiceId"]
            .as_str()
            .unwrap();
        let route_service_id = moved["previews"]["previews"][0]["routes"][0]["serviceId"]
            .as_str()
            .unwrap();
        let root_port = services
            .iter()
            .find(|service| service["id"] == root_service_id)
            .unwrap()["localPort"]
            .as_i64()
            .unwrap();
        let route_port = services
            .iter()
            .find(|service| service["id"] == route_service_id)
            .unwrap()["localPort"]
            .as_i64()
            .unwrap();
        assert_eq!(root_port, 5173);
        assert_eq!(route_port, 3001);

        let reuse_old_replaced_port = json!({
            "projectId": project.id,
            "services": [
                {"name": "legacy-web", "localPort": 4000},
                {"name": "web", "localPort": 5173},
                {"name": "api", "localPort": 3001, "healthPath": "/ready"}
            ],
            "previews": [{
                "name": "workspace",
                "publicPort": 13000,
                "rootServiceName": "web",
                "routes": [{
                    "pathPattern": "/api/*",
                    "serviceName": "api"
                }]
            }]
        });
        let reused_old_port = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(reuse_old_replaced_port.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reused_old_port.status(), StatusCode::OK);
        let reused_old_port = response_json(reused_old_port).await;
        let services = reused_old_port["previews"]["services"].as_array().unwrap();
        assert!(services
            .iter()
            .any(|service| { service["name"] == "legacy-web" && service["localPort"] == 4000 }));
        let root_service_id = reused_old_port["previews"]["previews"][0]["rootServiceId"]
            .as_str()
            .unwrap();
        let root_port = services
            .iter()
            .find(|service| service["id"] == root_service_id)
            .unwrap()["localPort"]
            .as_i64()
            .unwrap();
        assert_eq!(root_port, 5173);

        let add_aux = json!({
            "projectId": project.id,
            "services": [{"name": "aux", "localPort": 4100}]
        });
        let added_aux = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(add_aux.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(added_aux.status(), StatusCode::OK);

        let reuse_freed_port = json!({
            "projectId": project.id,
            "services": [
                {"name": "aux", "localPort": 4101},
                {"name": "reuse", "localPort": 4100}
            ]
        });
        let reused = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(reuse_freed_port.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reused.status(), StatusCode::OK);
        let reused = response_json(reused).await;
        let services = reused["previews"]["services"].as_array().unwrap();
        assert!(services
            .iter()
            .any(|service| { service["name"] == "aux" && service["localPort"] == 4101 }));
        assert!(services
            .iter()
            .any(|service| { service["name"] == "reuse" && service["localPort"] == 4100 }));

        let service_collision_count_before = state
            .store
            .list_project_preview_services(&project.id)
            .await
            .unwrap()
            .len();
        let ambiguous_service = json!({
            "projectId": project.id,
            "services": [{"name": "web", "localPort": 4000}]
        });
        let invalid = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(ambiguous_service.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let services_after_collision = state
            .store
            .list_project_preview_services(&project.id)
            .await
            .unwrap();
        assert_eq!(
            services_after_collision.len(),
            service_collision_count_before
        );
        assert!(services_after_collision
            .iter()
            .any(|service| service.name == "web" && service.local_port == 5173));
        assert!(services_after_collision
            .iter()
            .any(|service| service.name == "legacy-web" && service.local_port == 4000));

        let add_sidecar_preview = json!({
            "projectId": project.id,
            "previews": [{
                "name": "sidecar",
                "publicPort": 13002,
                "rootServiceName": "web"
            }]
        });
        let added_sidecar = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(add_sidecar_preview.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(added_sidecar.status(), StatusCode::OK);
        let preview_collision_count_before = state
            .store
            .list_project_previews(&project.id)
            .await
            .unwrap()
            .len();
        let ambiguous_preview = json!({
            "projectId": project.id,
            "previews": [{
                "name": "workspace",
                "publicPort": 13002,
                "rootServiceName": "web"
            }]
        });
        let invalid = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(ambiguous_preview.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let previews_after_collision = state
            .store
            .list_project_previews(&project.id)
            .await
            .unwrap();
        assert_eq!(
            previews_after_collision.len(),
            preview_collision_count_before
        );
        assert!(previews_after_collision
            .iter()
            .any(|preview| preview.name == "workspace" && preview.public_port == 13000));
        assert!(previews_after_collision
            .iter()
            .any(|preview| preview.name == "sidecar" && preview.public_port == 13002));

        let invalid_reference = json!({
            "projectId": project.id,
            "services": [{"name": "will-not-persist", "localPort": 4200}],
            "previews": [{
                "name": "workspace",
                "publicPort": 13000,
                "rootServiceName": "web",
                "routes": [{"pathPattern": "/missing/*", "serviceName": "missing-service"}]
            }]
        });
        let invalid = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(invalid_reference.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let after_invalid = app
            .clone()
            .oneshot(
                Request::get(format!("/v1/projects/{}/previews", project.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(after_invalid.status(), StatusCode::OK);
        let after_invalid = response_json(after_invalid).await;
        assert!(!after_invalid["services"]
            .as_array()
            .unwrap()
            .iter()
            .any(|service| service["name"] == "will-not-persist"));

        let create_project_dir = tempdir().unwrap();
        let project_count_before = state.store.list_projects().await.unwrap().len();
        let invalid_create_project = json!({
            "projectCwd": create_project_dir.path().display().to_string(),
            "createProject": true,
            "services": [{"name": "new-web", "localPort": 4300}],
            "previews": [{
                "name": "new-workspace",
                "publicPort": 13001,
                "rootServiceName": "new-web",
                "routes": [{"pathPattern": "/missing/*", "serviceName": "missing-service"}]
            }]
        });
        let invalid = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(invalid_create_project.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            state.store.list_projects().await.unwrap().len(),
            project_count_before
        );

        let padded_refs_dir = tempdir().unwrap();
        let padded_refs = json!({
            "projectCwd": padded_refs_dir.path().display().to_string(),
            "projectName": "Padded refs",
            "createProject": true,
            "services": [
                {"name": "new-web", "localPort": 4300},
                {"name": "new-api", "localPort": 4301}
            ],
            "previews": [{
                "name": "new-workspace",
                "publicPort": 13001,
                "rootServiceName": " new-web ",
                "routes": [{"pathPattern": "/api/*", "serviceName": " new-api "}]
            }]
        });
        let padded = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(padded_refs.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(padded.status(), StatusCode::OK);
        let padded = response_json(padded).await;
        let root_service_id = padded["previews"]["previews"][0]["rootServiceId"]
            .as_str()
            .unwrap();
        let route_service_id = padded["previews"]["previews"][0]["routes"][0]["serviceId"]
            .as_str()
            .unwrap();
        let services = padded["previews"]["services"].as_array().unwrap();
        assert_eq!(
            services
                .iter()
                .find(|service| service["id"] == root_service_id)
                .unwrap()["name"],
            "new-web"
        );
        assert_eq!(
            services
                .iter()
                .find(|service| service["id"] == route_service_id)
                .unwrap()["name"],
            "new-api"
        );
        let project_count_before = state.store.list_projects().await.unwrap().len();

        let port_conflict_dir = tempdir().unwrap();
        let invalid_port_conflict = json!({
            "projectCwd": port_conflict_dir.path().display().to_string(),
            "createProject": true,
            "services": [{"name": "conflict-web", "localPort": 4400}],
            "previews": [{
                "name": "conflict-workspace",
                "publicPort": 13000,
                "rootServiceName": "conflict-web"
            }]
        });
        let invalid = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(invalid_port_conflict.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            state.store.list_projects().await.unwrap().len(),
            project_count_before
        );

        let invalid_route = json!({
            "projectId": project.id,
            "services": [{"name": "web", "localPort": 5173}],
            "previews": [{
                "name": "workspace",
                "publicPort": 13000,
                "rootServiceName": "web",
                "routes": [{"pathPattern": "api/*", "serviceName": "web"}]
            }]
        });
        let invalid = app
            .oneshot(
                Request::post("/v1/self-control/project-previews/apply")
                    .header("content-type", "application/json")
                    .body(Body::from(invalid_route.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn thread_start_maps_to_app_server() {
        let (state, app_server) = test_state().await;
        let project = state
            .store
            .create_project(
                "Kodex".to_string(),
                std::env::current_dir().unwrap().display().to_string(),
            )
            .await
            .unwrap();
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
        assert_eq!(requests[0].0, "thread/start");
        assert!(requests[0].1.get("cwd").is_some());
        assert_eq!(requests[0].1["persistExtendedHistory"], true);
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
        assert_eq!(body["thread"]["updatedAt"], 1_767_225_700_i64);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].0, "thread/name/set");
        assert_eq!(requests[0].1["threadId"], "thread-1");
        assert_eq!(requests[0].1["name"], "Renamed thread");
        assert_eq!(requests[1].0, "thread/read");
        assert_eq!(requests[1].1["threadId"], "thread-1");
        assert_eq!(requests[1].1["includeTurns"], false);
    }

    #[tokio::test]
    async fn thread_start_broadcasts_and_replays_thread_upserted_event() {
        let (state, app_server) = test_state().await;
        let project = state
            .store
            .create_project(
                "Kodex".to_string(),
                std::env::current_dir().unwrap().display().to_string(),
            )
            .await
            .unwrap();
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

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.kind, "thread.upserted");
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
        assert_eq!(replay["events"][0]["kind"], "thread.upserted");
        assert_eq!(
            replay["events"][0]["payload"]["thread"]["id"],
            "project-thread-1"
        );
    }

    #[tokio::test]
    async fn self_control_thread_create_and_input_use_gateway_state_and_source_labels() {
        let (state, app_server) = test_state().await;
        let project = state
            .store
            .create_project("Kodex".to_string(), "/workspace/kodex".to_string())
            .await
            .unwrap();
        let mut receiver = state.events.subscribe();
        let app = build_router(state.clone());

        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/threads")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "projectId": project.id,
                            "model": "gpt-5.4",
                            "payload": {"source": "self-control-test"},
                            "source": {"sourceToolCallId": "tool-create"}
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

        let started = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "input": [{"type": "text", "text": "start now"}],
                            "source": {"sourceToolCallId": "tool-start"},
                            "model": "gpt-5.4"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(started.status(), StatusCode::OK);
        let started = response_json(started).await;
        assert_eq!(started["action"], "started");
        assert_eq!(started["turn"]["payload"]["method"], "turn/start");

        let mut saw_started_audit = false;
        for _ in 0..4 {
            let event = timeout(Duration::from_secs(2), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            if event.kind == "self_control.thread_input" {
                assert_eq!(event.payload["action"], "started");
                assert_eq!(event.payload["source"]["sourceToolCallId"], "tool-start");
                saw_started_audit = true;
                break;
            }
        }
        assert!(saw_started_audit);

        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Syncing,
                active_turn_id: Some("turn-active".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        mark_thread_session_active(&state, "thread-1", "turn-active").await;
        let queued = app
            .oneshot(
                Request::post("/v1/self-control/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "input": [{"type": "text", "text": "follow up"}],
                            "source": {"sourceToolCallId": "tool-input"},
                            "model": "gpt-5.4"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(queued.status(), StatusCode::OK);
        let queued = response_json(queued).await;
        assert_eq!(queued["action"], "queued");
        assert_eq!(queued["queuedInput"]["sourceType"], "kodex_control");
        assert_eq!(queued["queuedInput"]["sourceId"], "tool-input");
        assert_eq!(queued["queuedInput"]["input"][0]["text"], "follow up");

        let requests = app_server.requests.lock().unwrap();
        assert!(requests.iter().any(|(method, _)| method == "thread/start"));
        assert!(requests.iter().any(|(method, _)| method == "turn/start"));
        assert!(requests.iter().all(|(method, _)| method != "turn/steer"));
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
    async fn self_control_thread_input_starts_when_thread_is_not_materialized_yet() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(
                "app-server error -32600: thread thread-1 is not materialized yet; includeTurns is unavailable before first user message".to_string(),
            ));
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"turnId": "turn-started"}));
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::post("/v1/self-control/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "input": [{"type": "text", "text": "start now"}],
                            "source": {"sourceToolCallId": "tool-start"}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["action"], "started");
        assert!(body["queuedInput"].is_null());
        assert_eq!(body["turn"]["payload"]["turnId"], "turn-started");
        let queued = state.store.list_queued_inputs("thread-1").await.unwrap();
        assert!(queued.is_empty());
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[1].0, "turn/start");
        assert_eq!(requests[1].1["input"][0]["text"], "start now");
    }

    #[tokio::test]
    async fn self_control_thread_input_rejects_permissions_and_sandbox_conflict_before_queue() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Syncing,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        mark_thread_session_active(&state, "thread-1", "turn-active").await;
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::post("/v1/self-control/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "input": [{"type": "text", "text": "invalid"}],
                            "permissions": "full-access",
                            "sandboxPolicy": {"type": "dangerFullAccess"}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(state
            .store
            .list_queued_inputs("thread-1")
            .await
            .unwrap()
            .is_empty());
        assert!(app_server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn self_control_source_type_must_be_kodex_control() {
        let (state, _) = test_state().await;
        let project = state
            .store
            .create_project("Kodex".to_string(), "/workspace/kodex".to_string())
            .await
            .unwrap();
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
        let project = state
            .store
            .create_project("Kodex".to_string(), "/workspace/kodex".to_string())
            .await
            .unwrap();
        app_server
            .thread_list_responses_by_cwd
            .lock()
            .unwrap()
            .insert(
                "/workspace/kodex".to_string(),
                json!({
                    "data": [thread_summary_with_cwd("thread-project", "/workspace/kodex")],
                    "nextCursor": null,
                    "backwardsCursor": null
                }),
            );
        state
            .store
            .create_queued_input(
                "thread-project",
                vec![UserInput::Text {
                    text: "queued".to_string(),
                    text_elements: Vec::new(),
                }],
                Default::default(),
            )
            .await
            .unwrap();
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
        let (state, _) = test_state().await;
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
            ("POST", "pin", source.clone()),
            ("DELETE", "pin", source.clone()),
            (
                "POST",
                "seen",
                json!({"seenCompletedAgentTurnSeq": 3, "source": source_value.clone()}),
            ),
            ("POST", "compact", source.clone()),
            ("POST", "interrupt-current", source.clone()),
        ] {
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
                StatusCode::OK,
                "{method} /{path} should succeed"
            );
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
            "self_control.thread_settings_updated",
            "self_control.thread_archived",
            "self_control.thread_pinned",
            "self_control.thread_unpinned",
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
        let project = state
            .store
            .create_project("Kodex".to_string(), "/workspace/kodex".to_string())
            .await
            .unwrap();
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
        assert_eq!(first_body["input"]["action"], "started");
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

        let exhausted = app
            .oneshot(
                Request::post("/v1/self-control/thread-spawns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "projectId": first_body["thread"]["thread"]["id"],
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
    }

    #[tokio::test]
    async fn self_control_spawn_retry_reuses_created_thread_after_input_failure() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(SpawnInputFailingAppServer::default());
        let state = AppState::new(Config::default(), store, app_server.clone())
            .with_title_generation_service(TitleGenerationService::disabled());
        let project = state
            .store
            .create_project("Kodex".to_string(), "/workspace/kodex".to_string())
            .await
            .unwrap();
        let app = build_router(state.clone());
        let request = json!({
            "projectId": project.id,
            "input": [{"type": "text", "text": "start spawned thread"}],
            "idempotencyKey": "spawn-key-partial",
            "maxSelfControlDepth": 2
        });

        let failed = app
            .clone()
            .oneshot(
                Request::post("/v1/self-control/thread-spawns")
                    .header("content-type", "application/json")
                    .body(Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(failed.status(), StatusCode::BAD_GATEWAY);
        let events = state.store.replay_events(None, None, None).await.unwrap();
        assert!(events
            .iter()
            .any(|event| event.kind == "self_control.thread_spawn_created"));
        assert!(!events
            .iter()
            .any(|event| event.kind == "self_control.thread_spawned"));

        let retried = app
            .oneshot(
                Request::post("/v1/self-control/thread-spawns")
                    .header("content-type", "application/json")
                    .body(Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(retried.status(), StatusCode::OK);
        let body = response_json(retried).await;
        assert_eq!(body["threadId"], "thread-spawned");
        assert_eq!(body["input"]["action"], "started");
        assert_eq!(body["idempotentReplay"], true);

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
                .filter(|(method, _)| method == "thread/read")
                .count(),
            2
        );
        assert_eq!(
            requests
                .iter()
                .filter(|(method, _)| method == "turn/start")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn self_control_automation_run_now_queues_source_labeled_input() {
        let (state, _) = test_state().await;
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
        assert_eq!(body["queuedInput"]["sourceType"], "automation");
        assert_eq!(body["queuedInput"]["sourceId"], "tool-run-now");
        assert_eq!(body["queuedInput"]["input"][0]["text"], "run this now");
    }

    #[tokio::test]
    async fn self_control_approval_policy_allows_denial_and_gates_approval() {
        let (state, app_server) = test_state().await;
        let deny = state
            .store
            .insert_approval(NewApproval {
                request_id: "approval-deny".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-1".to_string()),
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            })
            .await
            .unwrap();
        let approve = state
            .store
            .insert_approval(NewApproval {
                request_id: "approval-accept".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-2".to_string()),
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            })
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
        assert_eq!(responses[0].0, "approval-deny");
        assert_eq!(responses[1].0, "approval-accept");
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
        let project = state
            .store
            .create_project(
                "Kodex".to_string(),
                std::env::current_dir().unwrap().display().to_string(),
            )
            .await
            .unwrap();
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
            "cwd": "/workspace"
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
        assert_eq!(body["thread"]["model"], "gpt-5.4");
        assert_eq!(body["thread"]["reasoningEffort"], "high");
        assert_eq!(body["thread"]["serviceTier"], "fast");
        assert_eq!(body["thread"]["approvalPolicy"], "on-request");
        assert_eq!(body["thread"]["approvalsReviewer"], "auto_review");
        assert_eq!(body["thread"]["sandbox"], "workspace-write");

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
        assert_eq!(listed["threads"][0]["approvalPolicy"], "on-request");
        assert_eq!(listed["threads"][0]["approvalsReviewer"], "auto_review");
        assert_eq!(listed["threads"][0]["sandbox"], "workspace-write");

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/start");
        assert_eq!(requests[0].1["prompt"], "hi");
        assert_eq!(requests[0].1["model"], "gpt-5.4");
        assert!(requests[0].1.get("effort").is_none());
        assert!(requests[0].1.get("reasoningEffort").is_none());
        assert_eq!(requests[0].1["serviceTier"], "fast");
        assert_eq!(requests[0].1["approvalPolicy"], "on-request");
        assert_eq!(requests[0].1["approvalsReviewer"], "auto_review");
        assert_eq!(requests[0].1["sandbox"], "workspace-write");
        assert_eq!(requests[0].1["persistExtendedHistory"], true);
    }

    #[tokio::test]
    async fn thread_settings_update_forwards_native_partial_patch_and_returns_refreshed_thread() {
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

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["thread"]["model"], "gpt-5.4-mini");
        assert!(body["thread"]["reasoningEffort"].is_null());
        assert_eq!(body["thread"]["serviceTier"], "fast");
        assert_eq!(body["thread"]["approvalPolicy"], "on-request");
        assert_eq!(body["thread"]["approvalsReviewer"], "auto_review");
        assert_eq!(body["thread"]["sandbox"]["type"], "workspaceWrite");

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/settings/update");
        assert_eq!(requests[0].1["threadId"], "thread-1");
        assert_eq!(requests[0].1["model"], "gpt-5.4-mini");
        assert!(requests[0].1["effort"].is_null());
        assert_eq!(requests[0].1["serviceTier"], "fast");
        assert_eq!(requests[0].1["approvalPolicy"], "on-request");
        assert_eq!(requests[0].1["approvalsReviewer"], "auto_review");
        assert_eq!(requests[0].1["sandboxPolicy"]["type"], "workspaceWrite");
        assert_eq!(requests[1].0, "thread/read");
        assert_eq!(requests[1].1["threadId"], "thread-1");
        assert_eq!(requests[1].1["includeTurns"], false);
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
    async fn thread_settings_update_preserves_permissions_when_refreshed_thread_omits_profile() {
        let (state, app_server) = test_state().await;
        state
            .store
            .save_thread_local_settings_overlay(
                "thread-1",
                &ThreadLocalSettingsOverlay {
                    approval_policy: Some("on-request".to_string()),
                    approvals_reviewer: Some("auto_review".to_string()),
                    permissions: Some("old-profile".to_string()),
                    sandbox: Some(json!({"type": "dangerFullAccess"})),
                    ..ThreadLocalSettingsOverlay::default()
                },
            )
            .await
            .unwrap();
        app_server.queued_responses.lock().unwrap().extend([
            json!({}),
            json!({
                "thread": {
                    "id": "thread-1",
                    "cwd": "/workspace",
                    "status": {"type": "idle"},
                    "source": "cli",
                    "preview": "hello",
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_601_i64
                }
            }),
            json!({}),
            json!({
                "thread": {
                    "id": "thread-1",
                    "cwd": "/workspace",
                    "status": {"type": "idle"},
                    "source": "cli",
                    "preview": "hello",
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_602_i64
                }
            }),
        ]);
        let app = build_router(state.clone());

        let select = app
            .clone()
            .oneshot(
                Request::patch("/v1/threads/thread-1/settings")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"permissions": "auto-review"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(select.status(), StatusCode::OK);
        let body = response_json(select).await;
        assert_eq!(
            body["thread"]["activePermissionProfile"]["id"],
            "auto-review"
        );
        let events = state.store.replay_events(None, None, None).await.unwrap();
        assert_eq!(
            events[0].payload["thread"]["activePermissionProfile"]["id"],
            "auto-review"
        );
        let stored = state
            .store
            .thread_local_settings_overlays(&["thread-1".to_string()])
            .await
            .unwrap();
        assert_eq!(
            stored["thread-1"].permissions.as_deref(),
            Some("auto-review")
        );
        assert!(stored["thread-1"].approval_policy.is_none());
        assert!(stored["thread-1"].approvals_reviewer.is_none());
        assert!(stored["thread-1"].sandbox.is_none());

        let clear = app
            .oneshot(
                Request::patch("/v1/threads/thread-1/settings")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"permissions": null}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(clear.status(), StatusCode::OK);
        let body = response_json(clear).await;
        assert!(body["thread"]["activePermissionProfile"].is_null());
        let events = state.store.replay_events(None, None, None).await.unwrap();
        assert!(events[1].payload["thread"]["activePermissionProfile"].is_null());

        let stored = state
            .store
            .thread_local_settings_overlays(&["thread-1".to_string()])
            .await
            .unwrap();
        assert!(stored["thread-1"].permissions.is_none());
        assert!(stored["thread-1"].sandbox.is_none());

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/settings/update");
        assert_eq!(requests[0].1["permissions"], "auto-review");
        assert_eq!(requests[1].0, "thread/read");
        assert_eq!(requests[2].0, "thread/settings/update");
        assert!(requests[2].1["permissions"].is_null());
        assert_eq!(requests[3].0, "thread/read");
    }

    #[tokio::test]
    async fn permission_profiles_route_paginates_and_resolves_project_cwd() {
        let (state, app_server) = test_state().await;
        let cwd = tempdir().unwrap().path().to_string_lossy().to_string();
        let project = state
            .store
            .create_project("Kodex".to_string(), cwd.clone())
            .await
            .unwrap();
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
        let project = state
            .store
            .create_project("Kodex".to_string(), cwd)
            .await
            .unwrap();
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
            json!({
                "thread": {
                    "id": "thread-1",
                    "cwd": "/workspace",
                    "status": {"type": "idle"},
                    "source": "cli",
                    "turns": [],
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_600_i64
                }
            }),
            json!({"turnId": "turn-1"}),
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
                            "permissions": "read-only"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(turn.status(), StatusCode::OK);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/start");
        assert_eq!(requests[0].1["permissions"], "auto-review");
        assert!(requests[0].1.get("approvalPolicy").is_none());
        assert!(requests[0].1.get("approvalsReviewer").is_none());
        assert!(requests[0].1.get("sandbox").is_none());
        assert_eq!(requests[2].0, "turn/start");
        assert_eq!(requests[2].1["permissions"], "read-only");
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
    async fn thread_settings_updated_notification_applies_gateway_owned_overlays() {
        let (state, app_server) = test_state().await;
        let pin = state.store.pin_thread("thread-1").await.unwrap();
        state
            .store
            .set_thread_notifications_enabled("thread-1", false)
            .await
            .unwrap();
        state
            .store
            .save_thread_local_settings_overlay(
                "thread-1",
                &ThreadLocalSettingsOverlay {
                    approval_policy: Some("on-request".to_string()),
                    approvals_reviewer: Some("auto_review".to_string()),
                    ..ThreadLocalSettingsOverlay::default()
                },
            )
            .await
            .unwrap();
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"thread": thread_summary("thread-1")}));
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "thread/settings/updated".to_string(),
                params: json!({"threadId": "thread-1"}),
            },
            &state,
        )
        .await
        .unwrap();

        let event = timeout(Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.kind, "timeline.thread_metadata");
        assert_eq!(
            event.codex_method.as_deref(),
            Some("thread/settings/updated")
        );
        assert_eq!(event.payload["thread"]["pinnedAt"], json!(pin.pinned_at));
        assert_eq!(
            event.payload["thread"]["notificationsEnabled"],
            json!(false)
        );
        assert!(event.payload["thread"]["model"].is_null());
        assert!(event.payload["thread"]["reasoningEffort"].is_null());
        assert_eq!(
            event.payload["thread"]["approvalPolicy"],
            json!("on-request")
        );
        assert_eq!(
            event.payload["thread"]["approvalsReviewer"],
            json!("auto_review")
        );
    }

    #[tokio::test]
    async fn thread_settings_updated_notification_clears_active_permission_profile() {
        let (state, app_server) = test_state().await;
        state
            .store
            .save_thread_local_settings_overlay(
                "thread-1",
                &ThreadLocalSettingsOverlay {
                    permissions: Some("stale-profile".to_string()),
                    ..ThreadLocalSettingsOverlay::default()
                },
            )
            .await
            .unwrap();
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"thread": thread_summary("thread-1")}));
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "thread/settings/updated".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "threadSettings": {
                        "activePermissionProfile": null
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let event = timeout(Duration::from_secs(1), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.kind, "timeline.thread_metadata");
        assert!(event.payload["thread"]["activePermissionProfile"].is_null());
        assert!(event.payload["thread"]["rawPayload"]
            .get("activePermissionProfile")
            .is_none());

        let stored = state
            .store
            .thread_local_settings_overlays(&["thread-1".to_string()])
            .await
            .unwrap();
        assert!(stored["thread-1"].permissions.is_none());
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
            "cwd": "/workspace/chat"
        }));
        let app = build_router(state);

        let body = json!({
            "firstMessageText": "Build the Chat Sidebar!",
            "model": "gpt-5.4",
            "effort": "high",
            "serviceTier": "fast",
            "approvalPolicy": "on-request",
            "approvalsReviewer": "auto_review",
            "sandbox": "workspace-write"
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
        assert_eq!(body["thread"]["sandbox"], "workspace-write");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/start");
        assert!(requests[0].1.get("projectId").is_none());
        assert_eq!(requests[0].1["model"], "gpt-5.4");
        assert!(requests[0].1.get("effort").is_none());
        assert_eq!(requests[0].1["serviceTier"], "fast");
        assert_eq!(requests[0].1["approvalPolicy"], "on-request");
        assert_eq!(requests[0].1["approvalsReviewer"], "auto_review");
        assert_eq!(requests[0].1["sandbox"], "workspace-write");
        assert_eq!(requests[0].1["persistExtendedHistory"], true);
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

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.kind, "thread.upserted");
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
        assert_eq!(replay["events"][0]["kind"], "thread.upserted");
        assert_eq!(replay["events"][0]["payload"]["scope"], "chat");
    }

    #[tokio::test]
    async fn chat_thread_list_filters_threads_under_chat_root() {
        let (mut state, app_server) = test_state().await;
        let home = tempdir().unwrap();
        Arc::make_mut(&mut state.config).projects.home_dir = home.path().to_path_buf();
        let chat_cwd = home
            .path()
            .join("Documents")
            .join("Codex")
            .join("2026-05-05")
            .join("chat-thread");
        std::fs::create_dir_all(&chat_cwd).unwrap();
        let chat_cwd = std::fs::canonicalize(chat_cwd).unwrap();
        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [
                {
                    "id": "chat-thread",
                    "cwd": chat_cwd,
                    "status": {"type": "idle"},
                    "source": "local",
                    "preview": "chat",
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_700_i64
                },
                {
                    "id": "project-thread",
                    "cwd": "/workspace/project",
                    "status": {"type": "idle"},
                    "source": "local",
                    "preview": "project",
                    "createdAt": 1_767_225_600_i64,
                    "updatedAt": 1_767_225_700_i64
                }
            ],
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
        assert_eq!(body["threads"][0]["id"], "chat-thread");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/list");
        assert!(requests[0].1["cwd"]
            .as_array()
            .unwrap()
            .contains(&Value::String(chat_cwd.to_string_lossy().to_string())));
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
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "thread/list");
        assert_eq!(requests[0].1["cursor"], "cursor-1");
        assert_eq!(requests[0].1["limit"], 25);
        assert_eq!(requests[0].1["archived"], false);
        assert_eq!(requests[0].1["useStateDbOnly"], true);
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
    async fn thread_list_project_filter_maps_to_cwd() {
        let (state, app_server) = test_state().await;
        let cwd = std::env::current_dir().unwrap().display().to_string();
        let project = state
            .store
            .create_project("Kodex".to_string(), cwd.clone())
            .await
            .unwrap();
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
        assert_eq!(requests[0].1["cwd"], cwd);
        assert_eq!(requests[0].1["sortKey"], "updated_at");
        assert_eq!(requests[0].1["sortDirection"], "desc");
        assert_eq!(requests[0].1["archived"], false);
        assert_eq!(requests[0].1["useStateDbOnly"], true);
    }

    #[tokio::test]
    async fn sidebar_threads_snapshot_groups_project_chat_and_pinned_threads() {
        let (mut state, app_server) = test_state().await;
        let home = tempdir().unwrap();
        Arc::make_mut(&mut state.config).projects.home_dir = home.path().to_path_buf();
        let project_one_cwd = home.path().join("project-one");
        let project_two_cwd = home.path().join("project-two");
        std::fs::create_dir_all(&project_one_cwd).unwrap();
        std::fs::create_dir_all(&project_two_cwd).unwrap();
        let project_one_cwd = std::fs::canonicalize(project_one_cwd).unwrap();
        let project_two_cwd = std::fs::canonicalize(project_two_cwd).unwrap();
        let project_one = state
            .store
            .create_project(
                "One".to_string(),
                project_one_cwd.to_string_lossy().to_string(),
            )
            .await
            .unwrap();
        let project_two = state
            .store
            .create_project(
                "Two".to_string(),
                project_two_cwd.to_string_lossy().to_string(),
            )
            .await
            .unwrap();
        let pinned_thread = state.store.pin_thread("pinned-thread").await.unwrap();
        state
            .store
            .save_thread_local_settings_overlay(
                "project-one-thread",
                &ThreadLocalSettingsOverlay {
                    approval_policy: Some("on-request".to_string()),
                    approvals_reviewer: Some("auto_review".to_string()),
                    permissions: None,
                    sandbox: Some(json!({
                        "type": "workspaceWrite",
                        "networkAccess": false,
                        "writableRoots": ["/workspace"]
                    })),
                },
            )
            .await
            .unwrap();
        state
            .store
            .mark_thread_seen_completed_agent_turns("project-one-thread", 3)
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
        project_one_thread["preview"] = json!({"text": "Project one preview"});
        project_one_thread["status"] = json!({"type": "active"});
        project_one_thread["model"] = json!("gpt-5.4-mini");
        project_one_thread["reasoningEffort"] = json!("high");
        project_one_thread["serviceTier"] = json!("fast");
        project_one_thread["gitInfo"] = json!({
            "branch": "feature/sidebar-trim",
            "originUrl": "https://example.test/kodex.git",
            "sha": "abc123",
        });
        let mut project_two_thread = thread_summary("project-two-thread");
        project_two_thread["cwd"] = json!(project_two_cwd.to_string_lossy().to_string());
        let mut chat_thread = thread_summary("chat-thread");
        chat_thread["cwd"] = json!(chat_cwd.to_string_lossy().to_string());
        let listed_projects = state.store.list_projects().await.unwrap();
        let mut project_responses_by_cwd = std::collections::HashMap::new();
        for project in &listed_projects {
            if project.id == project_one.id {
                project_responses_by_cwd.insert(
                    project.cwd.clone(),
                    json!({"data": [project_one_thread.clone()], "nextCursor": null, "backwardsCursor": null}),
                );
            } else {
                project_responses_by_cwd.insert(
                    project.cwd.clone(),
                    json!({"data": [project_two_thread.clone()], "nextCursor": "project-two-next", "backwardsCursor": null}),
                );
            }
        }
        app_server
            .thread_list_responses_by_cwd
            .lock()
            .unwrap()
            .extend(project_responses_by_cwd);
        let mut queued = Vec::new();
        queued.push(
            json!({"data": [chat_thread], "nextCursor": "chat-next", "backwardsCursor": null}),
        );
        queued.push(json!({"thread": thread_summary("pinned-thread")}));
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
        assert_eq!(project_one_compact["seenCompletedAgentTurnSeq"], 3);
        assert_eq!(project_one_compact["unreadCompletedAgentTurn"], false);
        assert_eq!(body["chatThreads"]["threads"][0]["id"], "chat-thread");
        assert_eq!(body["chatThreads"]["nextCursor"], "chat-next");
        assert!(body["chatThreads"]["rawPayload"].is_null());
        assert!(body["chatThreads"]["threads"][0]["rawPayload"].is_null());
        assert_eq!(body["pinnedThreads"]["threads"][0]["id"], "pinned-thread");
        assert_eq!(
            body["pinnedThreads"]["threads"][0]["pinnedAt"],
            json!(pinned_thread.pinned_at)
        );
        assert!(body["pinnedThreads"]["rawPayload"].is_null());
        assert!(body["pinnedThreads"]["threads"][0]["rawPayload"].is_null());

        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"data": [project_two_thread], "nextCursor": "project-two-next", "backwardsCursor": null}));
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
        assert_eq!(requests.len(), 5);
        for project in &listed_projects {
            let request = requests
                .iter()
                .find(|(method, params)| {
                    method == "thread/list" && params["cwd"] == project.cwd && params["limit"] == 10
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
                && params["cwd"]
                    .as_array()
                    .unwrap()
                    .contains(&Value::String(chat_cwd.to_string_lossy().to_string()))
        }));
        assert!(requests.iter().any(|(method, params)| {
            method == "thread/read"
                && *params == json!({"threadId": "pinned-thread", "includeTurns": false})
        }));
        assert_eq!(requests[4].0, "thread/list");
        assert_eq!(requests[4].1["cwd"], project_two.cwd);
        assert_eq!(requests[4].1["limit"], 100);
    }

    #[tokio::test]
    async fn sidebar_threads_fetches_project_groups_concurrently() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(BlockingThreadListAppServer::default());
        let state = AppState::new(Config::default(), store, app_server.clone());
        state
            .store
            .create_project("One".to_string(), "/workspace/one".to_string())
            .await
            .unwrap();
        state
            .store
            .create_project("Two".to_string(), "/workspace/two".to_string())
            .await
            .unwrap();
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
        let project = state
            .store
            .create_project("Kodex".to_string(), cwd)
            .await
            .unwrap();
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
    async fn composer_settings_reads_project_config_and_persists_execution_defaults() {
        let (state, app_server) = test_state().await;
        let cwd = std::env::current_dir().unwrap().display().to_string();
        let project = state
            .store
            .create_project("Kodex".to_string(), cwd.clone())
            .await
            .unwrap();
        *app_server.next_response.lock().unwrap() = Some(json!({
            "config": {
                "model": "gpt-5.4",
                "model_reasoning_effort": "high",
                "service_tier": "fast",
                "default_permissions": ":workspace",
                "approval_policy": "on-request",
                "approvals_reviewer": "auto_review",
                "sandbox_mode": "workspace-write"
            },
            "origins": {}
        }));
        let app = build_router(state.clone());

        let read = app
            .clone()
            .oneshot(
                Request::get(format!("/v1/composer-settings?projectId={}", project.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::OK);
        let body = response_json(read).await;
        assert_eq!(body["model"], "gpt-5.4");
        assert_eq!(body["effort"], "high");
        assert_eq!(body["serviceTier"], "fast");
        assert_eq!(body["permissionProfileId"], ":workspace");
        assert_eq!(body["approvalPolicy"], "on-request");
        assert_eq!(body["approvalsReviewer"], "auto_review");
        assert_eq!(body["permissionsPreset"], "autoReview");

        let write = app
            .oneshot(
                Request::patch("/v1/composer-settings")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "model": "gpt-5.4",
                            "effort": "medium",
                            "serviceTier": null,
                            "permissionProfileId": ":read-only",
                            "approvalPolicy": "on-request",
                            "approvalsReviewer": "user"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(write.status(), StatusCode::OK);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests[0],
            (
                "config/read".to_string(),
                json!({"cwd": cwd, "includeLayers": false})
            )
        );
        assert_eq!(requests[1].0, "config/batchWrite");
        assert_eq!(
            requests[1].1,
            json!({
                "edits": [
                    {"keyPath": "model", "mergeStrategy": "replace", "value": "gpt-5.4"},
                    {"keyPath": "model_reasoning_effort", "mergeStrategy": "replace", "value": "medium"},
                    {"keyPath": "service_tier", "mergeStrategy": "replace", "value": null},
                    {"keyPath": "default_permissions", "mergeStrategy": "replace", "value": ":read-only"},
                    {"keyPath": "approval_policy", "mergeStrategy": "replace", "value": "on-request"},
                    {"keyPath": "approvals_reviewer", "mergeStrategy": "replace", "value": "user"}
                ],
                "reloadUserConfig": true
            })
        );
        let events = state.store.replay_events(None, None, None).await.unwrap();
        assert!(events.iter().any(|event| {
            event.kind == "skills.changed" && event.payload["source"] == "config-write"
        }));
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
        assert_eq!(response_json(reload).await["reloaded"], true);

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
    async fn mcp_config_mutations_write_reload_and_emit_event() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({"config": {"mcp_servers": {}}, "origins": {}}),
            json!({}),
            json!({}),
            json!({}),
            json!({}),
            json!({}),
            json!({}),
        ]);
        let app = build_router(state.clone());

        let add = app
            .clone()
            .oneshot(
                Request::post("/v1/mcp/servers")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "name": "docs",
                            "transport": {
                                "type": "stdio",
                                "command": "npx",
                                "args": ["-y", "@docs/mcp"],
                                "env": {"DOCS_TOKEN": "secret-token"},
                                "envVars": ["SHARED_ENV"]
                            },
                            "enabled": true
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(add.status(), StatusCode::OK);
        let add = response_json(add).await;
        assert_eq!(add["configuredServer"]["name"], "docs");
        assert_eq!(
            add["configuredServer"]["transport"]["env"]["DOCS_TOKEN"]["masked"],
            true
        );
        assert!(!add.to_string().contains("secret-token"));

        let toggle = app
            .clone()
            .oneshot(
                Request::patch("/v1/mcp/servers/docs/enabled")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"enabled": false}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(toggle.status(), StatusCode::OK);

        let remove = app
            .oneshot(
                Request::delete("/v1/mcp/servers/docs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(remove.status(), StatusCode::OK);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests[0],
            (
                "config/read".to_string(),
                json!({"cwd": null, "includeLayers": true})
            )
        );
        assert_eq!(requests[1].0, "config/batchWrite");
        assert_eq!(
            requests[1].1,
            json!({
                "edits": [{
                    "keyPath": "mcp_servers.docs",
                    "mergeStrategy": "replace",
                    "value": {
                        "command": "npx",
                        "args": ["-y", "@docs/mcp"],
                        "env": {"DOCS_TOKEN": "secret-token"},
                        "env_vars": ["SHARED_ENV"],
                        "enabled": true
                    }
                }],
                "reloadUserConfig": true
            })
        );
        assert_eq!(
            requests[2],
            ("config/mcpServer/reload".to_string(), Value::Null)
        );
        assert_eq!(
            requests[3].1,
            json!({
                "edits": [{
                    "keyPath": "mcp_servers.docs.enabled",
                    "mergeStrategy": "replace",
                    "value": false
                }],
                "reloadUserConfig": true
            })
        );
        assert_eq!(
            requests[4],
            ("config/mcpServer/reload".to_string(), Value::Null)
        );
        assert_eq!(
            requests[5].1,
            json!({
                "edits": [{
                    "keyPath": "mcp_servers.docs",
                    "mergeStrategy": "replace",
                    "value": null
                }],
                "reloadUserConfig": true
            })
        );
        assert_eq!(
            requests[6],
            ("config/mcpServer/reload".to_string(), Value::Null)
        );

        let events = state.store.replay_events(None, None, None).await.unwrap();
        let config_events = events
            .iter()
            .filter(|event| event.kind == "mcp.config_changed")
            .collect::<Vec<_>>();
        assert_eq!(config_events.len(), 3);
        assert_eq!(config_events[0].payload["operation"], "add");
        assert_eq!(config_events[1].payload["operation"], "toggle");
        assert_eq!(config_events[2].payload["operation"], "remove");
    }

    #[tokio::test]
    async fn mcp_replace_preserves_replaces_and_clears_stored_secrets() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({
                "config": {
                    "mcp_servers": {
                        "docs": {
                            "url": "https://old.example.test",
                            "http_headers": {
                                "Authorization": "Bearer old",
                                "X-Keep": "keep-secret",
                                "X-Remove": "remove-secret"
                            },
                            "scopes": ["old-scope"],
                            "enabled_tools": ["old-tool"],
                            "startup_timeout_sec": 5,
                            "tool_timeout_sec": 20
                        }
                    }
                },
                "origins": {}
            }),
            json!({}),
            json!({}),
        ]);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/mcp/servers/docs/replace")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "name": "docs",
                            "transport": {
                                "type": "streamableHttp",
                                "url": "https://new.example.test",
                                "httpHeaders": {"Authorization": "Bearer new"},
                                "clearHttpHeaders": ["X-Remove"],
                                "envHttpHeaders": {"X-Env": "DOCS_TOKEN"}
                            },
                            "enabled": true,
                            "required": true
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(
            body["configuredServer"]["transport"]["httpHeaders"]["Authorization"]["masked"],
            true
        );
        assert_eq!(
            body["configuredServer"]["transport"]["httpHeaders"]["X-Keep"]["masked"],
            true
        );
        assert!(body["configuredServer"]["transport"]["httpHeaders"]
            .get("X-Remove")
            .is_none());
        let response_text = body.to_string();
        assert!(!response_text.contains("Bearer new"));
        assert!(!response_text.contains("keep-secret"));

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "config/read");
        assert_eq!(
            requests[1].1,
            json!({
                "edits": [{
                    "keyPath": "mcp_servers.docs",
                    "mergeStrategy": "replace",
                    "value": {
                        "url": "https://new.example.test",
                        "http_headers": {
                            "Authorization": "Bearer new",
                            "X-Keep": "keep-secret"
                        },
                        "env_http_headers": {"X-Env": "DOCS_TOKEN"},
                        "enabled": true,
                        "required": true,
                        "startup_timeout_sec": 5,
                        "tool_timeout_sec": 20,
                        "scopes": ["old-scope"],
                        "enabled_tools": ["old-tool"]
                    }
                }],
                "reloadUserConfig": true
            })
        );
        assert_eq!(
            requests[2],
            ("config/mcpServer/reload".to_string(), Value::Null)
        );
    }

    #[tokio::test]
    async fn mcp_add_rejects_existing_configured_server_name() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().push(json!({
            "config": {
                "mcp_servers": {
                    "docs": {"command": "npx"}
                }
            },
            "origins": {}
        }));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/mcp/servers")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "name": "docs",
                            "transport": {"type": "stdio", "command": "npx"}
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = response_json(response).await;
        assert_eq!(body["code"], "bad_request");
        assert!(body["message"].as_str().unwrap().contains("already exists"));

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "config/read");
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
                        .body(Body::from(r#"{"fromItemId":"item-1"}"#))
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
        assert_eq!(requests[3].1["persistExtendedHistory"], true);
        assert_eq!(requests[3].1["excludeTurns"], true);
        assert_eq!(requests[4].0, "thread/fork");
        assert_eq!(requests[4].1["threadId"], "thread-1");
        assert_eq!(requests[4].1["persistExtendedHistory"], true);
        assert_eq!(requests[5].0, "thread/archive");
        assert_eq!(requests[5].1["threadId"], "thread-1");
    }

    #[tokio::test]
    async fn thread_attach_resumes_when_gateway_thread_view_is_stale_live() {
        let (state, app_server) = test_state().await;
        thread_view::record_thread_live_state(
            &state.thread_views,
            "thread-1",
            ThreadLiveState::Streaming,
            1,
        )
        .await
        .unwrap();
        app_server.queued_responses.lock().unwrap().extend([
            json!({"data": [], "nextCursor": null}),
            json!({
                "thread": thread_summary("thread-1"),
                "cwd": "/workspace",
                "model": "gpt-5.4",
                "modelProvider": "openai"
            }),
        ]);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/attach")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "resumed");
        assert_eq!(body["thread"]["id"], "thread-1");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/loaded/list");
        assert_eq!(requests[1].0, "thread/resume");
    }

    #[tokio::test]
    async fn thread_attach_resumes_despite_stale_idle_runtime() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Idle,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        app_server.queued_responses.lock().unwrap().extend([
            json!({"data": [], "nextCursor": null}),
            json!({
                "thread": thread_summary("thread-1"),
                "cwd": "/workspace",
                "model": "gpt-5.4",
                "modelProvider": "openai"
            }),
        ]);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/attach")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "resumed");
        assert_eq!(body["thread"]["id"], "thread-1");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].0, "thread/loaded/list");
        assert_eq!(requests[1].0, "thread/resume");
        assert_eq!(requests[1].1["threadId"], "thread-1");
        assert_eq!(requests[1].1["persistExtendedHistory"], true);
        assert_eq!(requests[1].1["excludeTurns"], true);
    }

    #[tokio::test]
    async fn thread_attach_noops_when_app_server_session_is_loaded() {
        let (state, app_server) = test_state().await;
        *app_server.next_response.lock().unwrap() =
            Some(json!({"data": ["thread-1"], "nextCursor": null}));
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/attach")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "alreadyLoaded");
        assert!(body["thread"].is_null());
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "thread/loaded/list");
    }

    #[tokio::test]
    async fn thread_attach_resumes_unknown_thread() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/attach")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "resumed");
        assert_eq!(body["thread"]["id"], "thread-1");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].0, "thread/loaded/list");
        assert_eq!(requests[1].0, "thread/resume");
        assert_eq!(requests[1].1["threadId"], "thread-1");
        assert_eq!(requests[1].1["persistExtendedHistory"], true);
        assert_eq!(requests[1].1["excludeTurns"], true);
    }

    #[tokio::test]
    async fn thread_subagents_returns_loaded_descendants_in_created_order() {
        let (state, app_server) = test_state().await;
        *app_server.queued_responses.lock().unwrap() = vec![
            json!({
                "data": [
                    "thread-parent",
                    "thread-bad",
                    "thread-child-b",
                    "thread-child-a",
                    "thread-grandchild",
                    "thread-unrelated",
                    "thread-child-0"
                ],
                "nextCursor": null
            }),
            json!({}),
            json!({"thread": subagent_thread_summary(
                "thread-child-b",
                "thread-parent",
                30,
                300,
                "Builder",
                "worker",
                "idle"
            )}),
            json!({"thread": subagent_thread_summary(
                "thread-child-a",
                "thread-parent",
                10,
                100,
                "Scout",
                "explorer",
                "active"
            )}),
            json!({"thread": subagent_thread_summary(
                "thread-grandchild",
                "thread-child-a",
                20,
                200,
                "Verifier",
                "reviewer",
                "idle"
            )}),
            json!({"thread": subagent_thread_summary(
                "thread-unrelated",
                "thread-other-parent",
                5,
                500,
                "Other",
                "worker",
                "idle"
            )}),
            json!({"thread": subagent_thread_summary(
                "thread-child-0",
                "thread-parent",
                10,
                150,
                "Planner",
                "planner",
                "idle"
            )}),
        ];
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/threads/thread-parent/subagents")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;

        assert_eq!(
            body["subagents"],
            json!([
                {
                    "id": "thread-child-0",
                    "parentThreadId": "thread-parent",
                    "agentNickname": "Planner",
                    "agentRole": "planner",
                    "status": "idle",
                    "liveState": "idle",
                    "updatedAt": 150
                },
                {
                    "id": "thread-child-a",
                    "parentThreadId": "thread-parent",
                    "agentNickname": "Scout",
                    "agentRole": "explorer",
                    "status": "active",
                    "liveState": "streaming",
                    "updatedAt": 100
                },
                {
                    "id": "thread-grandchild",
                    "parentThreadId": "thread-child-a",
                    "agentNickname": "Verifier",
                    "agentRole": "reviewer",
                    "status": "idle",
                    "liveState": "idle",
                    "updatedAt": 200
                },
                {
                    "id": "thread-child-b",
                    "parentThreadId": "thread-parent",
                    "agentNickname": "Builder",
                    "agentRole": "worker",
                    "status": "idle",
                    "liveState": "idle",
                    "updatedAt": 300
                }
            ])
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/loaded/list");
        assert_eq!(requests[0].1, json!({"cursor": null, "limit": null}));
        assert_eq!(requests.len(), 7);
        assert!(requests[1..].iter().all(|(method, params)| {
            method == "thread/read" && params["includeTurns"] == false
        }));
    }

    #[tokio::test]
    async fn thread_subagents_uses_repaired_projection_on_repeated_request() {
        let (state, app_server) = test_state().await;
        *app_server.queued_responses.lock().unwrap() = vec![
            json!({
                "data": ["thread-parent", "thread-child-a"],
                "nextCursor": null
            }),
            json!({"thread": subagent_thread_summary(
                "thread-child-a",
                "thread-parent",
                10,
                100,
                "Scout",
                "explorer",
                "active"
            )}),
        ];
        let app = build_router(state);

        let first = app
            .clone()
            .oneshot(
                Request::get("/v1/threads/thread-parent/subagents")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(
            response_json(first).await["subagents"][0]["id"],
            "thread-child-a"
        );
        app_server.requests.lock().unwrap().clear();

        let second = app
            .oneshot(
                Request::get("/v1/threads/thread-parent/subagents")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(
            response_json(second).await["subagents"][0]["id"],
            "thread-child-a"
        );
        assert!(app_server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn thread_subagents_repairs_again_after_subagent_hook_uncertainty() {
        let (state, app_server) = test_state().await;
        *app_server.queued_responses.lock().unwrap() = vec![json!({
            "data": ["thread-parent"],
            "nextCursor": null
        })];
        let app = build_router(state.clone());

        let empty = app
            .clone()
            .oneshot(
                Request::get("/v1/threads/thread-parent/subagents")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(empty.status(), StatusCode::OK);
        assert_eq!(response_json(empty).await["subagents"], json!([]));
        app_server.requests.lock().unwrap().clear();

        ingest_inbound(
            InboundMessage::Notification {
                method: "hook/started".to_string(),
                params: json!({
                    "threadId": "thread-parent",
                    "run": {"id": "hook-1", "eventName": "subagentStart"}
                }),
            },
            &state,
        )
        .await
        .unwrap();
        *app_server.queued_responses.lock().unwrap() = vec![
            json!({
                "data": ["thread-parent", "thread-child-a"],
                "nextCursor": null
            }),
            json!({"thread": subagent_thread_summary(
                "thread-child-a",
                "thread-parent",
                10,
                100,
                "Scout",
                "explorer",
                "active"
            )}),
        ];

        let repaired = app
            .oneshot(
                Request::get("/v1/threads/thread-parent/subagents")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(repaired.status(), StatusCode::OK);
        assert_eq!(
            response_json(repaired).await["subagents"][0]["id"],
            "thread-child-a"
        );
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/loaded/list");
        assert_eq!(requests[1].0, "thread/read");
    }

    #[tokio::test]
    async fn thread_subagents_returns_empty_list_without_loaded_descendants() {
        let (state, app_server) = test_state().await;
        *app_server.queued_responses.lock().unwrap() = vec![json!({
            "data": ["thread-parent"],
            "nextCursor": null
        })];
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/threads/thread-parent/subagents")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["subagents"], json!([]));
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "thread/loaded/list");
    }

    #[tokio::test]
    async fn thread_subagents_errors_when_all_loaded_thread_reads_fail() {
        let (state, app_server) = test_state().await;
        *app_server.queued_responses.lock().unwrap() = vec![
            json!({
                "data": ["thread-parent", "thread-child-a", "thread-child-b"],
                "nextCursor": null
            }),
            json!({}),
            json!({}),
        ];
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::get("/v1/threads/thread-parent/subagents")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = response_json(response).await;
        assert_eq!(body["code"], "bad_gateway");
        assert_eq!(
            body["message"],
            "failed to read any loaded thread during subagent discovery"
        );
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].0, "thread/loaded/list");
    }

    #[tokio::test]
    async fn fork_thread_copies_gateway_owned_local_settings_overlay() {
        let (state, app_server) = test_state().await;
        state
            .store
            .save_thread_local_settings_overlay(
                "thread-1",
                &ThreadLocalSettingsOverlay {
                    approval_policy: Some("on-request".to_string()),
                    approvals_reviewer: Some("auto_review".to_string()),
                    permissions: Some("auto-review".to_string()),
                    sandbox: Some(json!({"type": "workspaceWrite", "networkAccess": false, "writableRoots": []})),
                },
            )
            .await
            .unwrap();
        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": {
                "id": "thread-fork",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "hello",
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            },
            "cwd": "/workspace"
        }));
        let app = build_router(state);

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/fork")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"fromItemId":"item-1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["thread"]["id"], "thread-fork");
        assert!(body["thread"]["model"].is_null());
        assert!(body["thread"]["reasoningEffort"].is_null());
        assert!(body["thread"]["serviceTier"].is_null());
        assert_eq!(body["thread"]["approvalPolicy"], "on-request");
        assert_eq!(body["thread"]["approvalsReviewer"], "auto_review");
        assert_eq!(
            body["thread"]["sandbox"],
            json!({"type": "workspaceWrite", "networkAccess": false, "writableRoots": []})
        );

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [{
                "id": "thread-fork",
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
        assert_eq!(listed["threads"][0]["approvalPolicy"], "on-request");
        assert_eq!(listed["threads"][0]["approvalsReviewer"], "auto_review");
        assert_eq!(
            listed["threads"][0]["sandbox"],
            json!({"type": "workspaceWrite", "networkAccess": false, "writableRoots": []})
        );
    }

    #[tokio::test]
    async fn stored_local_settings_do_not_fill_app_server_model_or_reasoning_fields() {
        let (state, app_server) = test_state().await;
        state
            .store
            .save_thread_local_settings_overlay(
                "thread-1",
                &ThreadLocalSettingsOverlay {
                    approval_policy: Some("on-request".to_string()),
                    approvals_reviewer: Some("auto_review".to_string()),
                    permissions: None,
                    sandbox: None,
                },
            )
            .await
            .unwrap();
        app_server.queued_responses.lock().unwrap().push(json!({
            "data": [{
                "id": "thread-1",
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "status": {"type": "idle"},
                "source": "cli",
                "preview": "hello",
                "model": "app-server-model",
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
        assert_eq!(body["threads"][0]["model"], "app-server-model");
        assert!(body["threads"][0]["reasoningEffort"].is_null());
        assert!(body["threads"][0]["serviceTier"].is_null());
        assert_eq!(body["threads"][0]["approvalPolicy"], "on-request");
        assert_eq!(body["threads"][0]["approvalsReviewer"], "auto_review");
        assert_eq!(
            body["threads"][0]["rawPayload"]["model"],
            "app-server-model"
        );
        assert!(body["threads"][0]["rawPayload"]
            .get("reasoningEffort")
            .is_none());
    }

    #[tokio::test]
    async fn existing_thread_input_options_do_not_overwrite_local_settings_overlay() {
        let (state, _) = test_state().await;
        state
            .store
            .save_thread_local_settings_overlay(
                "thread-1",
                &ThreadLocalSettingsOverlay {
                    approval_policy: Some("on-request".to_string()),
                    approvals_reviewer: Some("auto_review".to_string()),
                    permissions: None,
                    sandbox: Some(json!({"type": "workspaceWrite", "networkAccess": false, "writableRoots": []})),
                },
            )
            .await
            .unwrap();
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Starting,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: Some(0),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{
                            "input":[{"type":"text","text":"queued from stale tab"}],
                            "model":"stale-model",
                            "effort":"low",
                            "serviceTier":null,
                            "approvalPolicy":"never",
                            "approvalsReviewer":"human",
                            "sandboxPolicy":{"type":"readOnly"}
                        }"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let settings = state
            .store
            .thread_local_settings_overlays(&["thread-1".to_string()])
            .await
            .unwrap();
        let settings = settings.get("thread-1").unwrap();
        assert_eq!(settings.approval_policy.as_deref(), Some("on-request"));
        assert_eq!(settings.approvals_reviewer.as_deref(), Some("auto_review"));
        assert_eq!(
            settings.sandbox,
            Some(json!({"type": "workspaceWrite", "networkAccess": false, "writableRoots": []}))
        );
        let queued = state.store.list_queued_inputs("thread-1").await.unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].options.model.as_deref(), Some("stale-model"));
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
                    "status": {"type": "completed"},
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
                    "status": {"type": "completed"},
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
        assert_eq!(body["thread"]["lastCompletedAgentTurnSeq"], 1);
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
                    "status": {"type": "completed"},
                    "items": [{"id": "item-agent-2", "type": "agentMessage", "text": "second"}]
                }],
                "nextCursor": "older-cursor",
                "backwardsCursor": "cursor-prev"
            }),
            json!({
                "data": [{
                    "id": "turn-2",
                    "status": {"type": "completed"},
                    "items": []
                }, {
                    "id": "turn-1",
                    "status": {"type": "completed"},
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
        assert_eq!(body["thread"]["lastCompletedAgentTurnSeq"], 2);

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
                    "status": {"type": "completed"},
                    "items": [{"id": "item-agent-2", "type": "agentMessage", "text": "second"}]
                }],
                "nextCursor": "older-cursor",
                "backwardsCursor": "newer-cursor"
            }),
            json!({
                "data": [{
                    "id": "turn-2",
                    "status": {"type": "completed"},
                    "items": []
                }, {
                    "id": "turn-1",
                    "status": {"type": "completed"},
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
                    "status": {"type": "completed"},
                    "items": [{"id": "item-agent-1", "type": "agentMessage", "text": "first"}]
                }],
                "nextCursor": null,
                "backwardsCursor": "newer-cursor-2"
            }),
            json!({
                "data": [{
                    "id": "turn-2",
                    "status": {"type": "completed"},
                    "items": []
                }, {
                    "id": "turn-1",
                    "status": {"type": "completed"},
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
            100,
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
                "data": [{"id": "turn-2", "status": {"type": "completed"}}],
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
                "data": [{"id": "turn-3", "status": {"type": "completed"}}],
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
    async fn thread_detail_retries_transient_rollout_load_error() {
        let (state, app_server) = test_state().await;
        app_server.queued_errors.lock().unwrap().push(ApiError::BadGateway(
            "app-server error -32603: failed to load rollout `/Users/example/.codex/sessions/2026/05/07/rollout-2026-05-07T16-08-24-019e042c-2a66-73c1-8b68-94e5be3f51af.jsonl`".to_string(),
        ));
        app_server.queued_responses.lock().unwrap().push(json!({
            "thread": {
                "id": "thread-1",
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "preview": "hi",
                "source": "cli",
                "status": {"type": "idle"},
                "turns": [],
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_610_i64
            }
        }));
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
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
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
                "thread/read".to_string(),
                json!({"threadId": "thread-1", "includeTurns": false})
            )
        );
        assert_eq!(requests[2].0, "thread/turns/list");
        assert_eq!(requests[2].1["itemsView"], "full");
        assert_eq!(requests[3].1["itemsView"], "notLoaded");
    }

    #[tokio::test]
    async fn thread_detail_retries_empty_rollout_read_error() {
        let (state, app_server) = test_state().await;
        app_server.queued_errors.lock().unwrap().push(ApiError::BadGateway(
            "app-server error -32603: failed to read thread: thread-store internal error: failed to read thread /Users/example/.codex/sessions/2026/05/20/rollout-2026-05-20T22-32-32-019e4905-6c37-7662-987f-6032cc5f8793.jsonl: rollout at /Users/example/.codex/sessions/2026/05/20/rollout-2026-05-20T22-32-32-019e4905-6c37-7662-987f-6032cc5f8793.jsonl is empty".to_string(),
        ));
        app_server.queued_responses.lock().unwrap().push(json!({
            "thread": {
                "id": "thread-1",
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "preview": "hi",
                "source": "cli",
                "status": {"type": "idle"},
                "turns": [],
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_610_i64
            }
        }));
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
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
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
                "thread/read".to_string(),
                json!({"threadId": "thread-1", "includeTurns": false})
            )
        );
        assert_eq!(requests[2].0, "thread/turns/list");
        assert_eq!(requests[3].1["itemsView"], "notLoaded");
    }

    #[tokio::test]
    async fn thread_detail_retries_transient_thread_history_load_error() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(
                "app-server error -32603: FAILED TO LOAD THREAD HISTORY".to_string(),
            ));
        app_server.queued_responses.lock().unwrap().push(json!({
            "thread": {
                "id": "thread-1",
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "preview": "hi",
                "source": "cli",
                "status": {"type": "idle"},
                "turns": [],
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_610_i64
            }
        }));
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
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
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
                "thread/read".to_string(),
                json!({"threadId": "thread-1", "includeTurns": false})
            )
        );
        assert_eq!(requests[2].0, "thread/turns/list");
        assert_eq!(requests[2].1["itemsView"], "full");
        assert_eq!(requests[3].1["itemsView"], "notLoaded");
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
            &[UserInput::Text {
                text: "Search Google for OpenAI news".to_string(),
                text_elements: Vec::new(),
            }],
            pending.seq,
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
        assert_eq!(items[0]["itemId"], "pending-user-1");
        assert_eq!(
            items[0]["payload"]["item"]["content"][0]["text"],
            "Search Google for OpenAI news"
        );
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[1].0, "thread/turns/list");
    }

    #[tokio::test]
    async fn thread_detail_revalidates_persisted_skill_mentions_against_catalog() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_timeline_skill_mentions(
                "thread-1",
                "item-user-1",
                &[TimelineSkillMention {
                    start: 4,
                    end: 18,
                    name: "agent-browser".to_string(),
                    path: "/skills/agent-browser/SKILL.md".to_string(),
                    display_name: Some("Agent Browser".to_string()),
                    scope: Some("user".to_string()),
                    short_description: Some("Open sites".to_string()),
                    brand_color: Some("#23a55a".to_string()),
                    icon_small_url: Some("/v1/skills/icon?path=%2Fstale.png".to_string()),
                }],
            )
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
                    "preview": "Use $agent-browser",
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
                    "status": {"type": "completed"},
                    "startedAt": 1_767_225_600_i64,
                    "completedAt": 1_767_225_610_i64,
                    "items": [
                        {"id": "item-user-1", "type": "userMessage", "content": [{"type": "text", "text": "Use $agent-browser"}]}
                    ]
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
        assert_eq!(
            items[0]["payload"]["itemSnapshot"]["skillMentions"],
            json!([{
                "start": 4,
                "end": 18,
                "name": "agent-browser",
                "path": "/skills/agent-browser/SKILL.md"
            }])
        );
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
    async fn thread_detail_derives_skill_mentions_from_historical_user_text() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({
                "thread": {
                    "id": "thread-1",
                    "cliVersion": "0.130.0",
                    "cwd": "/workspace",
                    "ephemeral": false,
                    "modelProvider": "openai",
                    "preview": "Use $browser-use:browser",
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
                        "status": {"type": "completed"},
                        "startedAt": 1_767_225_600_i64,
                        "completedAt": 1_767_225_610_i64,
                        "items": [
                            {"id": "item-user-1", "type": "userMessage", "content": [{"type": "text", "text": "Use $browser-use:browser"}]}
                        ]
                    }],
                "nextCursor": null,
                "backwardsCursor": null
            }),
            json!({
                "data": [{
                    "id": "turn-1",
                    "status": {"type": "completed"}
                }],
                "nextCursor": null,
                "backwardsCursor": null
            }),
            skills_list_response_with_interface(
                "/workspace",
                "browser-use:browser",
                "/skills/browser-use/browser/SKILL.md",
            ),
        ]);
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
        let items = serialized_timeline_items(&body["timeline"]);
        assert_eq!(
            items[0]["payload"]["itemSnapshot"]["skillMentions"],
            json!([{
                "start": 4,
                "end": 24,
                "name": "browser-use:browser",
                "path": "/skills/browser-use/browser/SKILL.md",
                "displayName": "Review Fix",
                "scope": "user",
                "shortDescription": "Review loop",
                "brandColor": "#23a55a",
                "iconSmallUrl": "/v1/skills/icon?path=%2Fskills%2Freview-fix%2Ficon.png"
            }])
        );
    }

    #[tokio::test]
    async fn thread_list_derives_unread_completed_agent_turns_from_persisted_read_state() {
        let (state, app_server) = test_state().await;
        state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("legacy-turn".to_string()),
                item_id: None,
                kind: "thread_view.cursor".to_string(),
                codex_method: Some("thread_view/cursor".to_string()),
                payload: json!({
                    "threadId": "thread-1",
                    "turnId": "legacy-turn",
                    "reason": "agent_turn_completed",
                    "sourceKind": "thread_view.turn_completed",
                    "sourceMethod": "turn/completed"
                }),
            })
            .await
            .unwrap();
        let app = build_router(state);

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [
                thread_summary("thread-1"),
                thread_summary("thread-2")
            ],
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
        assert_eq!(body["threads"][0]["lastCompletedAgentTurnSeq"], Value::Null);
        assert_eq!(body["threads"][0]["seenCompletedAgentTurnSeq"], json!(0));
        assert_eq!(body["threads"][0]["unreadCompletedAgentTurn"], json!(false));
        assert_eq!(body["threads"][1]["lastCompletedAgentTurnSeq"], Value::Null);
        assert_eq!(body["threads"][1]["unreadCompletedAgentTurn"], json!(false));

        let mut list_thread_with_cursor_like_marker = thread_summary("thread-1");
        list_thread_with_cursor_like_marker["lastCompletedAgentTurnSeq"] = json!(129381);
        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [
                list_thread_with_cursor_like_marker
            ],
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
        assert_eq!(body["threads"][0]["lastCompletedAgentTurnSeq"], Value::Null);
        assert_eq!(body["threads"][0]["unreadCompletedAgentTurn"], json!(false));

        app_server.queued_responses.lock().unwrap().push(json!({
            "data": [
                {"id": "turn-1", "status": {"type": "completed"}}
            ],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/seen")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["seenCompletedAgentTurnSeq"], json!(1));

        app_server.queued_responses.lock().unwrap().push(json!({
            "data": [
                {"id": "turn-1", "status": {"type": "completed"}}
            ],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/seen")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["seenCompletedAgentTurnSeq"], json!(1));
        let requests = app_server.requests.lock().unwrap();
        assert!(requests
            .iter()
            .any(|(method, params)| method == "thread/turns/list"
                && params["itemsView"] == "notLoaded"));
        assert!(requests
            .iter()
            .all(|(method, params)| method != "thread/read" || params["includeTurns"] == false));
        drop(requests);

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/seen")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"seenCompletedAgentTurnSeq":0}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["seenCompletedAgentTurnSeq"], json!(1));

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [thread_summary("thread-1")],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let response = app
            .oneshot(Request::get("/v1/threads").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"][0]["seenCompletedAgentTurnSeq"], json!(1));
        assert_eq!(body["threads"][0]["unreadCompletedAgentTurn"], json!(false));
        assert_eq!(body["threads"][0]["lastCompletedAgentTurnSeq"], Value::Null);
    }

    #[tokio::test]
    async fn explicit_thread_seen_marker_does_not_wait_for_app_server_readback() {
        let (state, app_server) = test_state().await;
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/seen")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"seenCompletedAgentTurnSeq":2}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["seenCompletedAgentTurnSeq"], json!(2));
        assert!(app_server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn mark_thread_seen_broadcasts_and_replays_canonical_read_state() {
        let (state, app_server) = test_state().await;
        let mut receiver = state.events.subscribe();
        let app = build_router(state.clone());

        app_server.queued_responses.lock().unwrap().push(json!({
            "data": [
                {"id": "turn-1", "status": {"type": "completed"}},
                {"id": "turn-2", "status": {"type": "completed"}}
            ],
            "nextCursor": null,
            "backwardsCursor": null
        }));
        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/seen")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
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
        assert_eq!(event.payload["seenCompletedAgentTurnSeq"], json!(2));
        assert_eq!(event.payload["lastCompletedAgentTurnSeq"], json!(2));
        assert_eq!(event.payload["unreadCompletedAgentTurn"], json!(false));

        let replayed = state
            .store
            .replay_events(Some(0), None, Some("thread-1".to_string()))
            .await
            .unwrap();
        assert!(replayed.iter().any(|event| {
            event.kind == "thread.read_updated"
                && event.payload["seenCompletedAgentTurnSeq"] == json!(2)
                && event.payload["unreadCompletedAgentTurn"] == json!(false)
        }));
    }

    #[tokio::test]
    async fn thread_list_and_detail_overlay_gateway_owned_pin_state() {
        let (state, app_server) = test_state().await;
        let pin = state.store.pin_thread("thread-1").await.unwrap();
        state
            .store
            .set_thread_notifications_enabled("thread-2", false)
            .await
            .unwrap();
        let app = build_router(state);

        *app_server.next_response.lock().unwrap() = Some(json!({
            "data": [thread_summary("thread-1"), thread_summary("thread-2")],
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
        assert_eq!(body["threads"][0]["pinnedAt"], json!(pin.pinned_at));
        assert_eq!(body["threads"][1]["pinnedAt"], Value::Null);
        assert_eq!(body["threads"][0]["notificationsEnabled"], json!(true));
        assert_eq!(body["threads"][1]["notificationsEnabled"], json!(false));
        assert_eq!(
            body["rawPayload"]["data"][0]["pinnedAt"],
            json!(pin.pinned_at)
        );
        assert_eq!(
            body["rawPayload"]["data"][1]["notificationsEnabled"],
            json!(false)
        );

        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": thread_summary("thread-1")
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
        assert_eq!(body["thread"]["pinnedAt"], json!(pin.pinned_at));
        assert_eq!(body["thread"]["notificationsEnabled"], json!(true));
    }

    #[tokio::test]
    async fn pin_routes_persist_broadcast_and_list_pinned_threads() {
        let (state, app_server) = test_state().await;
        let mut receiver = state.events.subscribe();
        let app = build_router(state);

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/pin")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threadId"], "thread-1");
        assert!(body["pinnedAt"].is_string());
        let pinned_at = body["pinnedAt"].clone();

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.kind, "thread.pin_updated");
        assert_eq!(event.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(event.payload["threadId"], "thread-1");
        assert_eq!(event.payload["pinnedAt"], pinned_at);

        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": thread_summary("thread-1")
        }));
        let response = app
            .clone()
            .oneshot(
                Request::get("/v1/threads/pinned")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"].as_array().unwrap().len(), 1);
        assert_eq!(body["threads"][0]["id"], "thread-1");
        assert_eq!(body["threads"][0]["pinnedAt"], pinned_at);
        {
            let requests = app_server.requests.lock().unwrap();
            assert_eq!(requests.last().unwrap().0, "thread/read");
            assert_eq!(
                requests.last().unwrap().1,
                json!({"threadId": "thread-1", "includeTurns": false})
            );
        }

        let mut archived_thread = thread_summary("thread-1");
        archived_thread["archived"] = json!(true);
        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": archived_thread
        }));
        let response = app
            .clone()
            .oneshot(
                Request::get("/v1/threads/pinned")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threads"].as_array().unwrap().len(), 0);

        let response = app
            .oneshot(
                Request::delete("/v1/threads/thread-1/pin")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["threadId"], "thread-1");
        assert_eq!(body["pinnedAt"], Value::Null);

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.kind, "thread.pin_updated");
        assert_eq!(event.payload["pinnedAt"], Value::Null);
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
    async fn archive_missing_rollout_thread_clears_stale_pin() {
        let store = Store::in_memory().await.unwrap();
        store.pin_thread("thread-missing").await.unwrap();
        let app_server = Arc::new(MissingRolloutAppServer);
        let state = AppState::new(Config::default(), store.clone(), app_server);
        let mut receiver = state.events.subscribe();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-missing/archive")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["payload"]["threadId"], "thread-missing");
        assert_eq!(body["payload"]["stale"], true);
        assert!(store.get_thread_pin("thread-missing").await.is_err());
        let event = receiver.recv().await.unwrap();
        assert_eq!(event.kind, "thread.pin_updated");
        assert_eq!(event.thread_id.as_deref(), Some("thread-missing"));
        assert_eq!(event.payload["pinnedAt"], Value::Null);
    }

    #[tokio::test]
    async fn thread_start_requires_stored_project_before_app_server_call() {
        let (state, app_server) = test_state().await;
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
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(app_server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn file_preview_serves_sniffed_images_and_markdown() {
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

        let requests = app_server.requests.lock().unwrap();
        assert!(requests.iter().all(|(method, _)| method == "thread/read"));
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
    async fn file_preview_rejects_unknown_unavailable_and_unsupported_targets() {
        let (state, _app_server) = test_state().await;
        let dir = tempdir().unwrap();
        let image = dir.path().join("preview.local");
        std::fs::write(&image, b"\x89PNG\r\n\x1a\npreview image").unwrap();
        let missing = dir.path().join("missing.png");
        let unsupported = dir.path().join("notes.txt");
        std::fs::write(&unsupported, "plain text").unwrap();
        let invalid_markdown = dir.path().join("bad.md");
        std::fs::write(&invalid_markdown, b"\xff\xfe\xfd").unwrap();
        let app = build_router(state);

        for (thread_id, path, expected_status) in [
            ("thread-missing", image.as_path(), StatusCode::NOT_FOUND),
            ("thread-1", missing.as_path(), StatusCode::NOT_FOUND),
            ("thread-1", dir.path(), StatusCode::NOT_FOUND),
            (
                "thread-1",
                unsupported.as_path(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            (
                "thread-1",
                invalid_markdown.as_path(),
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
    async fn file_preview_maps_rollout_missing_thread_app_server_error_to_not_found() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(MissingRolloutAppServer);
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
                        .body(Body::from(r#"{"input":[{"type":"text","text":"hi"}]}"#))
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
                            r#"{"input":[{"type":"text","text":"continue"}]}"#,
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
        assert_eq!(requests[0].0, "turn/start");
        assert_eq!(
            requests[0].1,
            json!({"threadId": "thread-1", "input": [{"type": "text", "text": "hi"}]})
        );
        assert_eq!(requests[1].0, "turn/steer");
        assert_eq!(
            requests[1].1,
            json!({
                "threadId": "thread-1",
                "expectedTurnId": "turn-1",
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
    async fn thread_input_sets_model_generated_name_after_started_turn() {
        let (state, app_server) = test_state().await;
        let title_generator = Arc::new(RecordingTitleGenerator::new(Some("Implement Naming")));
        let state = state.with_title_generation_service(TitleGenerationService::with_generator(
            title_generator.clone(),
        ));
        app_server.queued_responses.lock().unwrap().extend([
            thread_read_response("thread-1", 0),
            json!({"turnId": "turn-started"}),
            thread_read_response("thread-1", 1),
            thread_read_response("thread-1", 1),
        ]);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"Create model generated thread naming"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_json(response).await["disposition"], "started");
        wait_for_app_server_method(&app_server, "thread/name/set").await;

        let title_requests = title_generator.requests.lock().unwrap();
        assert_eq!(title_requests.len(), 1);
        assert_eq!(
            title_requests[0].user_request,
            "Create model generated thread naming"
        );
        drop(title_requests);

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[1].0, "turn/start");
        assert!(requests
            .iter()
            .any(|(method, params)| method == "thread/read"
                && params == &json!({"threadId": "thread-1", "includeTurns": true})));
        assert!(requests
            .iter()
            .any(|(method, params)| method == "thread/name/set"
                && params == &json!({"threadId": "thread-1", "name": "Implement Naming"})));
    }

    #[tokio::test]
    async fn turn_start_sets_model_generated_name_after_started_turn() {
        let (state, app_server) = test_state().await;
        let title_generator = Arc::new(RecordingTitleGenerator::new(Some("Direct Turn Title")));
        let state = state
            .with_title_generation_service(TitleGenerationService::with_generator(title_generator));
        app_server.queued_responses.lock().unwrap().extend([
            json!({"turnId": "turn-started"}),
            thread_read_response("thread-1", 1),
            thread_read_response("thread-1", 1),
        ]);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"Name direct turns"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        wait_for_app_server_method(&app_server, "thread/name/set").await;
        let requests = app_server.requests.lock().unwrap();
        assert!(requests
            .iter()
            .any(|(method, params)| method == "thread/name/set"
                && params == &json!({"threadId": "thread-1", "name": "Direct Turn Title"})));
    }

    #[tokio::test]
    async fn model_generated_name_skips_already_named_thread() {
        let (state, app_server) = test_state().await;
        let title_generator = Arc::new(RecordingTitleGenerator::new(Some("Should Not Apply")));
        let state = state.with_title_generation_service(TitleGenerationService::with_generator(
            title_generator.clone(),
        ));
        app_server.queued_responses.lock().unwrap().extend([
            json!({"turnId": "turn-started"}),
            named_thread_read_response("thread-1", "User Name", 1),
        ]);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"do not rename"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        wait_for_app_server_request_count(&app_server, "thread/read", 1).await;
        assert_eq!(title_generator.requests.lock().unwrap().len(), 0);
        let requests = app_server.requests.lock().unwrap();
        assert!(requests
            .iter()
            .all(|(method, _)| method != "thread/name/set"));
    }

    #[tokio::test]
    async fn model_generated_name_skips_threads_after_first_turn() {
        let (state, app_server) = test_state().await;
        let title_generator = Arc::new(RecordingTitleGenerator::new(Some("Should Not Apply")));
        let state = state.with_title_generation_service(TitleGenerationService::with_generator(
            title_generator.clone(),
        ));
        app_server.queued_responses.lock().unwrap().extend([
            json!({"turnId": "turn-started"}),
            thread_read_response("thread-1", 2),
        ]);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"second turn"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        wait_for_app_server_request_count(&app_server, "thread/read", 1).await;
        assert_eq!(title_generator.requests.lock().unwrap().len(), 0);
        let requests = app_server.requests.lock().unwrap();
        assert!(requests
            .iter()
            .all(|(method, _)| method != "thread/name/set"));
    }

    #[tokio::test]
    async fn active_steered_thread_input_does_not_generate_thread_name() {
        let (state, app_server) = test_state().await;
        let title_generator = Arc::new(RecordingTitleGenerator::new(Some("Should Not Run")));
        let state = state.with_title_generation_service(TitleGenerationService::with_generator(
            title_generator.clone(),
        ));
        app_server.queued_responses.lock().unwrap().extend([
            active_thread_read_response("thread-1", "turn-active"),
            json!({"turnId": "turn-active"}),
        ]);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"queue me"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_json(response).await["disposition"], "steered");
        assert_eq!(title_generator.requests.lock().unwrap().len(), 0);
        let requests = app_server.requests.lock().unwrap();
        assert!(requests
            .iter()
            .all(|(method, _)| method != "thread/name/set"));
    }

    #[tokio::test]
    async fn interrupt_current_turn_uses_refreshed_gateway_active_state() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(active_thread_read_response("thread-1", "fresh-turn"));
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
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[1].0, "turn/interrupt");
        assert_eq!(
            requests[1].1,
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
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "thread/read");
    }

    #[tokio::test]
    async fn compact_thread_starts_app_server_compaction_and_marks_syncing() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(thread_read_response("thread-1", 0));
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"started": true}));
        let mut events = state.events.subscribe();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/compact")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "started");
        assert_eq!(body["rawPayload"], json!({"started": true}));
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[1].0, "thread/compact/start");
        assert_eq!(requests[1].1, json!({"threadId": "thread-1"}));

        let event = timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.kind, "thread_view.patch");
        assert_eq!(event.codex_method.as_deref(), Some("thread_view/patch"));
        assert_eq!(event.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(event.payload["liveState"], "syncing");
    }

    #[tokio::test]
    async fn compact_thread_rejects_gateway_busy_runtime_without_app_server_call() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Syncing,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/compact")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = response_json(response).await;
        assert_eq!(body["code"], "conflict");
        assert!(body["message"]
            .as_str()
            .unwrap()
            .contains("task is in progress"));
        assert!(app_server.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn thread_input_queues_while_compaction_syncing_without_draining() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Syncing,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: Some(10),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"wait behind compaction"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "queued");
        assert_eq!(
            body["queuedInput"]["input"][0]["text"],
            "wait behind compaction"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(app_server.requests.lock().unwrap().is_empty());
        let runtime = state
            .store
            .get_thread_runtime_state("thread-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(runtime.status, ThreadRuntimeStatus::Syncing);
        assert_eq!(runtime.active_turn_id, None);
    }

    #[tokio::test]
    async fn turn_start_retries_transient_rollout_load_error() {
        let (state, app_server) = test_state().await;
        app_server.queued_errors.lock().unwrap().push(ApiError::BadGateway(
            "app-server error -32603: failed to load rollout `/Users/example/.codex/sessions/2026/05/07/rollout-2026-05-07T13-41-03-019e042c-2a66-73c1-8b68-94e5be3f51af.jsonl`".to_string(),
        ));
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"ok": true}));
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

        assert_eq!(response.status(), StatusCode::OK);
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|(method, params)| {
            method == "turn/start"
                && *params
                    == json!({"threadId": "thread-1", "input": [{"type": "text", "text": "hi"}]})
        }));
    }

    #[tokio::test]
    async fn turn_start_retries_transient_thread_history_load_error() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(
                "app-server error -32603: FAILED TO LOAD THREAD HISTORY".to_string(),
            ));
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"ok": true}));
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

        assert_eq!(response.status(), StatusCode::OK);
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|(method, params)| {
            method == "turn/start"
                && *params
                    == json!({"threadId": "thread-1", "input": [{"type": "text", "text": "hi"}]})
        }));
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
    async fn turn_start_resolves_skill_mentions_against_thread_cwd() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({"thread": thread_summary("thread-1")}),
            skills_list_response("/workspace", "review-fix", "/skills/review-fix/SKILL.md"),
        ]);
        let app = build_router(state);

        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"Run $review-fix"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[0].1["includeTurns"], false);
        assert_eq!(requests[1].0, "skills/list");
        assert_eq!(requests[1].1["cwds"], json!(["/workspace"]));
        assert_eq!(requests[2].0, "turn/start");
        assert_eq!(
            requests[2].1["input"],
            json!([
                {"type": "text", "text": "Run $review-fix"},
                {"type": "skill", "name": "review-fix", "path": "/skills/review-fix/SKILL.md"}
            ])
        );
    }

    #[tokio::test]
    async fn turn_start_retries_transient_rollout_load_error_while_resolving_thread_cwd() {
        let (state, app_server) = test_state().await;
        app_server.queued_errors.lock().unwrap().push(ApiError::BadGateway(
            "app-server error -32603: failed to load rollout `/Users/example/.codex/sessions/2026/05/07/rollout-2026-05-07T16-08-24-019e042c-2a66-73c1-8b68-94e5be3f51af.jsonl`".to_string(),
        ));
        app_server.queued_responses.lock().unwrap().extend([
            json!({"thread": thread_summary("thread-1")}),
            skills_list_response("/workspace", "review-fix", "/skills/review-fix/SKILL.md"),
            json!({"ok": true}),
        ]);
        let app = build_router(state);

        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"Run $review-fix"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[0].1["includeTurns"], false);
        assert_eq!(requests[1].0, "thread/read");
        assert_eq!(requests[1].1["includeTurns"], false);
        assert_eq!(requests[2].0, "skills/list");
        assert_eq!(requests[3].0, "turn/start");
    }

    #[tokio::test]
    async fn turn_start_retries_transient_thread_history_load_error_while_resolving_thread_cwd() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(
                "app-server error -32603: FAILED TO LOAD THREAD HISTORY".to_string(),
            ));
        app_server.queued_responses.lock().unwrap().extend([
            json!({"thread": thread_summary("thread-1")}),
            skills_list_response("/workspace", "review-fix", "/skills/review-fix/SKILL.md"),
            json!({"ok": true}),
        ]);
        let app = build_router(state);

        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"Run $review-fix"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[0].1["includeTurns"], false);
        assert_eq!(requests[1].0, "thread/read");
        assert_eq!(requests[1].1["includeTurns"], false);
        assert_eq!(requests[2].0, "skills/list");
        assert_eq!(requests[3].0, "turn/start");
    }

    #[tokio::test]
    async fn selected_skill_input_is_rewritten_from_gateway_catalog() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({"thread": thread_summary("thread-1")}),
            skills_list_response(
                "/workspace",
                "canonical-review",
                "/skills/review-fix/SKILL.md",
            ),
        ]);
        let app = build_router(state);

        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"Run selected skill"},{"type":"skill","name":"client-stale-name","path":"/skills/review-fix/SKILL.md"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[0].1["includeTurns"], false);
        assert_eq!(requests[2].0, "turn/start");
        assert_eq!(
            requests[2].1["input"],
            json!([
                {"type": "text", "text": "Run selected skill"},
                {"type": "skill", "name": "canonical-review", "path": "/skills/review-fix/SKILL.md"}
            ])
        );
    }

    #[tokio::test]
    async fn turn_start_records_structured_skill_mentions_until_user_item_materializes() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({"thread": thread_summary("thread-1")}),
            skills_list_response("/workspace", "review-fix", "/skills/review-fix/SKILL.md"),
        ]);
        let app = build_router(state.clone());

        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"Run $review-fix","text_elements":[{"byteRange":{"start":4,"end":15}}]},{"type":"skill","name":"review-fix","path":"/skills/review-fix/SKILL.md"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let mentions = state
            .store
            .commit_pending_timeline_skill_mentions("thread-1", "item-user-1", "Run $review-fix")
            .await
            .unwrap()
            .expect("structured skill mention should be pending until item materializes");
        assert_eq!(mentions[0].name, "review-fix");
        assert_eq!(mentions[0].path, "/skills/review-fix/SKILL.md");
    }

    #[tokio::test]
    async fn turn_start_enriches_pending_skill_mentions_from_catalog_metadata() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({"thread": thread_summary("thread-1")}),
            skills_list_response_with_interface(
                "/workspace",
                "review-fix",
                "/skills/review-fix/SKILL.md",
            ),
        ]);
        let app = build_router(state.clone());

        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r##"{"input":[{"type":"text","text":"Run $review-fix","text_elements":[{"byteRange":{"start":4,"end":15}}]},{"type":"skill","name":"review-fix","path":"/skills/review-fix/SKILL.md"}]}"##,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let mentions = state
            .store
            .commit_pending_timeline_skill_mentions("thread-1", "item-user-1", "Run $review-fix")
            .await
            .unwrap()
            .expect("structured skill mention should be pending until item materializes");
        assert_eq!(mentions[0].display_name.as_deref(), Some("Review Fix"));
        assert_eq!(mentions[0].scope.as_deref(), Some("user"));
        assert_eq!(
            mentions[0].short_description.as_deref(),
            Some("Review loop")
        );
        assert_eq!(mentions[0].brand_color.as_deref(), Some("#23a55a"));
        assert_eq!(
            mentions[0].icon_small_url.as_deref(),
            Some("/v1/skills/icon?path=%2Fskills%2Freview-fix%2Ficon.png")
        );
    }

    #[tokio::test]
    async fn turn_steer_records_structured_skill_mentions_until_user_item_materializes() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({"thread": thread_summary("thread-1")}),
            skills_list_response_with_interface(
                "/workspace",
                "agent-browser",
                "/skills/agent-browser/SKILL.md",
            ),
        ]);
        let app = build_router(state.clone());

        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/turns/turn-1/steer")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r##"{"input":[{"type":"text","text":"Use $agent-browser","text_elements":[{"byteRange":{"start":4,"end":18}}]},{"type":"skill","name":"agent-browser","path":"/skills/agent-browser/SKILL.md"}]}"##,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        let mentions = state
            .store
            .commit_pending_timeline_skill_mentions("thread-1", "item-user-1", "Use $agent-browser")
            .await
            .unwrap()
            .expect("structured steer skill mention should be pending until item materializes");
        assert_eq!(mentions[0].name, "agent-browser");
        assert_eq!(mentions[0].display_name.as_deref(), Some("Review Fix"));
        assert_eq!(mentions[0].brand_color.as_deref(), Some("#23a55a"));

        let projection = state.thread_views.patch_for_thread("thread-1").await;
        assert_eq!(projection.items.len(), 1);
        assert_eq!(projection.items[0].turn_id, "turn-1");
        assert!(projection.items[0].item_id.starts_with("pending-user-"));
        assert_eq!(projection.items[0].item_type, "userMessage");
        assert_eq!(
            projection.items[0].payload.item.content.as_ref().unwrap()[0]["text"],
            "Use $agent-browser"
        );

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[2].0, "turn/steer");
        assert_eq!(
            requests[2].1["input"],
            json!([
                {"type": "text", "text": "Use $agent-browser", "text_elements": [{"byteRange": {"start": 4, "end": 18}, "placeholder": null}]},
                {"type": "skill", "name": "agent-browser", "path": "/skills/agent-browser/SKILL.md"}
            ])
        );
    }

    #[tokio::test]
    async fn stale_selected_skill_returns_clear_error_after_force_reload() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({"thread": thread_summary("thread-1")}),
            skills_list_response("/workspace", "review-fix", "/skills/new/SKILL.md"),
            skills_list_response("/workspace", "review-fix", "/skills/new/SKILL.md"),
        ]);
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/turns")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"Run $review-fix"},{"type":"skill","name":"review-fix","path":"/skills/old/SKILL.md"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = response_json(response).await;
        assert!(body["message"]
            .as_str()
            .unwrap()
            .contains("Skill \"review-fix\" is no longer available"));
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[1].1["forceReload"], false);
        assert_eq!(requests[2].1["forceReload"], true);
        assert!(requests.iter().all(|(method, _)| method != "turn/start"));
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
                            r#"{"input":[{"type":"text","text":"default"}]}"#,
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
                "model": "gpt-5.4-mini",
                "effort": "medium",
                "approvalPolicy": "on-request",
                "approvalsReviewer": "auto_review",
                "sandboxPolicy": {"type":"workspaceWrite","networkAccess":false,"writableRoots":[]}
            })
        );
        assert_eq!(requests[2].0, "thread/list");
        assert_eq!(
            requests[3].1,
            json!({"threadId": "thread-1", "input": [{"type": "text", "text": "default"}]})
        );
        assert_eq!(requests[4].0, "thread/list");
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
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "thread/list");
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
                            r#"{"input":[{"type":"text","text":"inspect this"},{"type":"localImage","path":"/tmp/kodex-upload.png"}]}"#,
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
                            r#"{"input":[{"type":"image","url":"https://example.test/image.png"}]}"#,
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
                "input": [{"type": "image", "url": "https://example.test/image.png"}],
            })
        );
    }

    #[tokio::test]
    async fn thread_input_starts_when_gateway_session_is_idle() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({"thread": thread_summary("thread-1")}),
            json!({"turnId": "turn-started"}),
        ]);
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"hello"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "started");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[1].0, "turn/start");
    }

    #[tokio::test]
    async fn thread_input_readbacks_idle_runtime_state_before_start() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Idle,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: Some(10),
            })
            .await
            .unwrap();
        app_server.queued_responses.lock().unwrap().extend([
            json!({"thread": thread_summary("thread-1"), "turns": []}),
            json!({"turnId": "turn-started"}),
        ]);
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"hello"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "started");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[1].0, "turn/start");
    }

    #[tokio::test]
    async fn thread_input_resumes_and_retries_when_turn_start_reports_missing_thread() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Idle,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: Some(10),
            })
            .await
            .unwrap();
        app_server.queued_errors.lock().unwrap().extend([
            ApiError::BadGateway(
                "app-server error -32600: thread is not materialized yet before first user message"
                    .to_string(),
            ),
            ApiError::BadGateway("app-server error -32600: thread not found: thread-1".to_string()),
        ]);
        app_server.queued_responses.lock().unwrap().extend([
            json!({
                "thread": thread_summary("thread-1"),
                "cwd": "/workspace",
                "model": "gpt-5.4",
                "modelProvider": "openai"
            }),
            json!({"turnId": "turn-started"}),
        ]);
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"hello"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "started");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[1].0, "turn/start");
        assert_eq!(requests[2].0, "thread/resume");
        assert_eq!(requests[2].1["threadId"], "thread-1");
        assert_eq!(requests[2].1["persistExtendedHistory"], true);
        assert_eq!(requests[2].1["excludeTurns"], true);
        assert_eq!(requests[3].0, "turn/start");
    }

    #[tokio::test]
    async fn thread_input_queues_after_runtime_starting_without_readback() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Starting,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: Some(10),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let second = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"second"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        let second = response_json(second).await;
        assert_eq!(second["disposition"], "queued");
        assert_eq!(second["queuedInput"]["input"][0]["text"], "second");

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|(method, _)| method == "turn/start")
                .count(),
            0
        );
        assert!(requests.iter().all(|(method, _)| method != "thread/read"));
    }

    #[tokio::test]
    async fn thread_input_queues_while_queue_drainer_has_claimed_runtime() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Draining,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: Some(10),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"wait behind drain"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "queued");
        assert_eq!(body["queuedInput"]["input"][0]["text"], "wait behind drain");
        let requests = app_server.requests.lock().unwrap();
        assert!(requests.is_empty());
    }

    #[tokio::test]
    async fn concurrent_thread_input_reserves_starting_before_turn_start() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(BlockingTurnStartAppServer::default());
        let state = AppState::new(Config::default(), store, app_server.clone());
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Idle,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: Some(10),
            })
            .await
            .unwrap();
        let app = build_router(state);

        let first_app = app.clone();
        let first = tokio::spawn(async move {
            first_app
                .oneshot(
                    Request::post("/v1/threads/thread-1/input")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"input":[{"type":"text","text":"first"}]}"#))
                        .unwrap(),
                )
                .await
                .unwrap()
        });

        timeout(Duration::from_secs(2), async {
            loop {
                if app_server.turn_start_requests.load(Ordering::SeqCst) == 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();

        let second = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"second"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        let second = response_json(second).await;
        assert_eq!(second["disposition"], "queued");
        assert_eq!(second["queuedInput"]["input"][0]["text"], "second");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(app_server.turn_start_requests.load(Ordering::SeqCst), 1);
        assert_eq!(app_server.thread_read_requests.load(Ordering::SeqCst), 1);

        app_server.release.notify_waiters();
        let first = first.await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(response_json(first).await["disposition"], "started");
    }

    #[tokio::test]
    async fn queued_input_drains_after_concurrent_turn_start_failure() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(FailingThenSucceedingTurnStartAppServer::default());
        let state = AppState::new(Config::default(), store, app_server.clone());
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Idle,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: Some(10),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let first_app = app.clone();
        let first = tokio::spawn(async move {
            first_app
                .oneshot(
                    Request::post("/v1/threads/thread-1/input")
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"input":[{"type":"text","text":"first"}]}"#))
                        .unwrap(),
                )
                .await
                .unwrap()
        });

        timeout(Duration::from_secs(2), async {
            loop {
                if app_server.turn_start_requests.load(Ordering::SeqCst) == 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();

        let second = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"second"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(response_json(second).await["disposition"], "queued");

        app_server.release_first.notify_waiters();
        let first = first.await.unwrap();
        assert_eq!(first.status(), StatusCode::BAD_GATEWAY);

        timeout(Duration::from_secs(2), async {
            loop {
                if app_server.turn_start_requests.load(Ordering::SeqCst) == 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(app_server.thread_read_requests.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn thread_input_starts_when_thread_is_not_materialized_yet() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(
                "app-server error -32600: thread thread-1 is not materialized yet; includeTurns is unavailable before first user message".to_string(),
            ));
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"turnId": "turn-started"}));
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"hello"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "started");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[1].0, "turn/start");
    }

    #[tokio::test]
    async fn thread_input_steers_when_app_server_has_active_turn() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            active_thread_read_response("thread-1", "turn-active"),
            json!({"turnId": "turn-active"}),
        ]);
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"steer"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "steered");
        assert!(body["queuedInput"].is_null());
        assert_eq!(body["rawPayload"]["turnId"], "turn-active");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[1].0, "turn/steer");
        assert_eq!(requests[1].1["expectedTurnId"], "turn-active");
        assert_eq!(requests[1].1["input"][0]["text"], "steer");
        assert!(requests.iter().all(|(method, _)| method != "turn/start"));
        let queued = state.store.list_queued_inputs("thread-1").await.unwrap();
        assert!(queued.is_empty());
        let events = state
            .store
            .replay_events(None, None, Some("thread-1".to_string()))
            .await
            .unwrap();
        assert!(events
            .iter()
            .all(|event| event.kind != queue::QUEUE_UPSERT_EVENT));
    }

    #[tokio::test]
    async fn thread_input_steers_when_gateway_session_has_active_turn() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"turnId": "turn-active"}));
        thread_view::record_item_delta(
            &state.thread_views,
            "thread-1",
            "turn-active",
            "agent-1",
            "working",
            1,
        )
        .await
        .unwrap();
        let app = build_router(state.clone());

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"steer"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "steered");
        assert!(body["queuedInput"].is_null());
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "turn/steer");
        assert_eq!(requests[0].1["expectedTurnId"], "turn-active");
        assert!(requests.iter().all(|(method, _)| method != "turn/start"));
        let queued = state.store.list_queued_inputs("thread-1").await.unwrap();
        assert!(queued.is_empty());
        let events = state
            .store
            .replay_events(None, None, Some("thread-1".to_string()))
            .await
            .unwrap();
        assert!(events
            .iter()
            .all(|event| event.kind != queue::QUEUE_UPSERT_EVENT));
    }

    #[tokio::test]
    async fn thread_input_clears_stale_active_runtime_state_and_starts() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Active,
                active_turn_id: Some("turn-active".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: Some(10),
            })
            .await
            .unwrap();
        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(
                "app-server error -32602: no active turn".to_string(),
            ));
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"turnId": "turn-started"}));
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"queue"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "started");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "turn/steer");
        assert_eq!(requests[0].1["expectedTurnId"], "turn-active");
        assert_eq!(requests[1].0, "turn/start");
    }

    #[tokio::test]
    async fn thread_input_steers_resolved_skill_input_when_active() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({"thread": thread_summary("thread-1")}),
            skills_list_response(
                "/workspace",
                "canonical-review",
                "/skills/review-fix/SKILL.md",
            ),
            active_thread_read_response("thread-1", "turn-active"),
            json!({"turnId": "turn-active"}),
        ]);
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"Run selected skill"},{"type":"skill","name":"client-stale-name","path":"/skills/review-fix/SKILL.md"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "steered");
        assert!(body["queuedInput"].is_null());
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[0].1["includeTurns"], false);
        assert_eq!(requests[1].0, "skills/list");
        assert_eq!(requests[2].0, "thread/read");
        assert_eq!(requests[3].0, "turn/steer");
        assert_eq!(
            requests[3].1["input"],
            json!([
                {"type": "text", "text": "Run selected skill"},
                {"type": "skill", "name": "canonical-review", "path": "/skills/review-fix/SKILL.md"}
            ])
        );
        assert!(requests.iter().all(|(method, _)| method != "turn/start"));
    }

    #[tokio::test]
    async fn thread_input_clears_stale_active_turn_and_starts() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(
                "app-server error -32602: no active turn".to_string(),
            ));
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"turnId": "turn-started"}));
        thread_view::record_item_delta(
            &state.thread_views,
            "thread-1",
            "turn-stale",
            "agent-1",
            "working",
            1,
        )
        .await
        .unwrap();
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"new turn"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "started");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "turn/steer");
        assert_eq!(requests[0].1["expectedTurnId"], "turn-stale");
        assert_eq!(requests[1].0, "turn/start");
    }

    #[tokio::test]
    async fn thread_input_retries_expected_turn_mismatch_once() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Active,
                active_turn_id: Some("turn-stale".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: Some(10),
            })
            .await
            .unwrap();
        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(
                r#"app-server error -32602: expectedTurnId mismatch; data: {"actualTurnId":"turn-active"}"#
                    .to_string(),
            ));
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(json!({"turnId": "turn-active"}));
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"retry steer"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "steered");
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "turn/steer");
        assert_eq!(requests[0].1["expectedTurnId"], "turn-stale");
        assert_eq!(requests[1].0, "turn/steer");
        assert_eq!(requests[1].1["expectedTurnId"], "turn-active");
    }

    #[tokio::test]
    async fn thread_input_surfaces_second_expected_turn_mismatch() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Active,
                active_turn_id: Some("turn-stale".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: Some(10),
            })
            .await
            .unwrap();
        app_server.queued_errors.lock().unwrap().extend([
            ApiError::BadGateway(
                r#"app-server error -32602: expectedTurnId mismatch; data: {"actualTurnId":"turn-active"}"#
                    .to_string(),
            ),
            ApiError::BadGateway(
                r#"app-server error -32602: expectedTurnId mismatch; data: {"actualTurnId":"turn-newer"}"#
                    .to_string(),
            ),
        ]);
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"retry steer"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|(method, _)| method == "turn/steer")
                .count(),
            2
        );
        assert!(state
            .store
            .list_queued_inputs("thread-1")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn thread_input_queues_rejected_steer_when_active_turn_is_non_steerable() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Active,
                active_turn_id: Some("turn-active".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: Some(10),
            })
            .await
            .unwrap();
        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(
                "app-server error -32602: ActiveTurnNotSteerable".to_string(),
            ));
        let app = build_router(state.clone());

        let response = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"queue rejected"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["disposition"], "queued");
        assert_eq!(body["queuedInput"]["priority"], "rejectedSteer");
        assert_eq!(body["queuedInput"]["status"], "queued");
        assert_eq!(body["queuedInput"]["input"][0]["text"], "queue rejected");
        let queue_id = body["queuedInput"]["id"].as_str().unwrap().to_string();
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "turn/steer");
        assert!(requests.iter().all(|(method, _)| method != "turn/start"));

        let listed = app
            .oneshot(
                Request::get("/v1/threads/thread-1/queued-inputs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed = response_json(listed).await;
        assert_eq!(listed["queuedInputs"][0]["id"], queue_id);
        assert_eq!(listed["queuedInputs"][0]["priority"], "rejectedSteer");

        let replayed = state
            .store
            .replay_events(None, None, Some("thread-1".to_string()))
            .await
            .unwrap();
        assert!(replayed.iter().any(|event| {
            event.kind == queue::QUEUE_UPSERT_EVENT
                && event.payload["id"] == queue_id
                && event.payload["priority"] == "rejectedSteer"
        }));
    }

    #[tokio::test]
    async fn queued_input_routes_persist_broadcast_and_replay_operational_events() {
        let (state, _app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Active,
                active_turn_id: Some("turn-1".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        let app = build_router(state);

        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"next"}],"model":"gpt-5.4"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        let created = response_json(created).await;
        let queue_id = created["queuedInput"]["id"].as_str().unwrap().to_string();
        assert_eq!(created["queuedInput"]["status"], "queued");
        assert_eq!(created["queuedInput"]["options"]["model"], "gpt-5.4");

        let listed = app
            .clone()
            .oneshot(
                Request::get("/v1/threads/thread-1/queued-inputs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let listed = response_json(listed).await;
        assert_eq!(listed["queuedInputs"].as_array().unwrap().len(), 1);
        assert_eq!(listed["queuedInputs"][0]["id"], queue_id);

        let replay = app
            .clone()
            .oneshot(
                Request::get("/v1/events?threadId=thread-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let replay = response_json(replay).await;
        assert_eq!(replay["events"][0]["kind"], "turn_queue.item_upsert");

        let deleted = app
            .oneshot(
                Request::delete(format!("/v1/threads/thread-1/queued-inputs/{queue_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn queued_input_drains_one_row_when_thread_is_idle() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({"thread": thread_summary("thread-1")}),
            json!({"turnId": "turn-drain-1"}),
        ]);
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Idle,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"drain me"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        timeout(Duration::from_secs(2), async {
            loop {
                if app_server
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(method, _)| method == "turn/start")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|(method, _)| method == "turn/start")
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .find(|(method, _)| method == "turn/start")
                .unwrap()
                .1,
            json!({
                "threadId": "thread-1",
                "input": [{"type": "text", "text": "drain me"}]
            })
        );
        drop(requests);

        timeout(Duration::from_secs(2), async {
            loop {
                if state
                    .thread_views
                    .patch_for_thread("thread-1")
                    .await
                    .items
                    .len()
                    == 1
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let projection = state.thread_views.patch_for_thread("thread-1").await;
        assert_eq!(projection.items.len(), 1);
        assert_eq!(projection.items[0].turn_id, "turn-drain-1");
        assert!(projection.items[0].item_id.starts_with("pending-user-"));
        assert_eq!(projection.items[0].item_type, "userMessage");
        assert_eq!(projection.items[0].status, "running");
        assert_eq!(
            projection.items[0].payload.item.content.as_ref().unwrap()[0]["text"],
            "drain me"
        );
    }

    #[tokio::test]
    async fn queued_skill_input_resolves_and_drains_against_target_thread_cwd() {
        let (state, app_server) = test_state().await;
        app_server.queued_responses.lock().unwrap().extend([
            json!({"thread": thread_summary_with_cwd("thread-1", "/target")}),
            skills_list_response(
                "/target",
                "review-fix",
                "/target/.codex/skills/review-fix/SKILL.md",
            ),
            json!({"thread": thread_summary_with_cwd("thread-1", "/target")}),
            json!({"thread": thread_summary_with_cwd("thread-1", "/target")}),
        ]);
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Idle,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        let app = build_router(state);

        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"queued $review-fix"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap(),
        );

        timeout(Duration::from_secs(2), async {
            loop {
                if app_server
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(method, _)| method == "turn/start")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let requests = app_server.requests.lock().unwrap();
        let skills_list = requests
            .iter()
            .find(|(method, _)| method == "skills/list")
            .unwrap();
        assert_eq!(skills_list.1["cwds"], json!(["/target"]));
        let turn_start = requests
            .iter()
            .find(|(method, _)| method == "turn/start")
            .unwrap();
        assert_eq!(
            turn_start.1["input"],
            json!([
                {"type": "text", "text": "queued $review-fix"},
                {"type": "skill", "name": "review-fix", "path": "/target/.codex/skills/review-fix/SKILL.md"}
            ])
        );
    }

    #[tokio::test]
    async fn queued_input_drainer_claims_only_one_row_per_idle_transition() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Idle,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        let app = build_router(state);

        for text in ["first", "second"] {
            assert_ok(
                app.clone()
                    .oneshot(
                        Request::post("/v1/threads/thread-1/queued-inputs")
                            .header("content-type", "application/json")
                            .body(Body::from(format!(
                                r#"{{"input":[{{"type":"text","text":"{text}"}}]}}"#
                            )))
                            .unwrap(),
                    )
                    .await
                    .unwrap(),
            );
        }

        timeout(Duration::from_secs(2), async {
            loop {
                let count = app_server
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(method, _)| method == "turn/start")
                    .count();
                if count == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::task::yield_now().await;
        assert_eq!(
            app_server
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(method, _)| method == "turn/start")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn active_thread_status_blocks_stale_idle_queue_drain() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Idle,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        ingest_inbound(
            InboundMessage::Notification {
                method: "thread/status".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "status": {"type": "active", "activeFlags": []}
                }),
            },
            &state,
        )
        .await
        .unwrap();
        let app = build_router(state.clone());

        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"hold"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap(),
        );
        tokio::task::yield_now().await;

        assert!(app_server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|(method, _)| method != "turn/start"));
        let runtime = state
            .store
            .get_thread_runtime_state("thread-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(runtime.status, ThreadRuntimeStatus::Active);
    }

    #[tokio::test]
    async fn app_server_active_thread_blocks_stale_idle_queue_drain() {
        let (state, app_server) = test_state().await;
        app_server
            .queued_responses
            .lock()
            .unwrap()
            .push(active_thread_read_response("thread-1", "turn-active"));
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Idle,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        assert_ok(
            app.oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"input":[{"type":"text","text":"hold"}]}"#))
                    .unwrap(),
            )
            .await
            .unwrap(),
        );
        timeout(Duration::from_secs(2), async {
            loop {
                if state
                    .thread_views
                    .active_turn_id("thread-1")
                    .await
                    .as_deref()
                    == Some("turn-active")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let requests = app_server.requests.lock().unwrap();
        assert!(requests.iter().any(|(method, _)| method == "thread/read"));
        assert!(requests.iter().all(|(method, _)| method != "turn/start"));
    }

    #[tokio::test]
    async fn queue_recovery_broadcasts_failed_rows_after_restart() {
        let (state, _) = test_state().await;
        let queued = state
            .store
            .create_queued_input(
                "thread-1",
                vec![crate::app_server_api::UserInput::Text {
                    text: "recover me".to_string(),
                    text_elements: vec![],
                }],
                crate::app_server_api::TurnStartOptions::default(),
            )
            .await
            .unwrap();
        state
            .store
            .claim_next_queued_input("thread-1")
            .await
            .unwrap()
            .unwrap();
        let mut receiver = state.events.subscribe();

        queue::recover_queued_inputs(&state).await.unwrap();

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.kind, queue::QUEUE_UPSERT_EVENT);
        assert_eq!(event.payload["id"], queued.id);
        assert_eq!(event.payload["status"], "failed");
        assert!(event.payload["lastError"]
            .as_str()
            .unwrap()
            .contains("Gateway restarted"));
    }

    #[tokio::test]
    async fn queue_recovery_schedules_existing_queued_rows_for_drain() {
        let (state, app_server) = test_state().await;
        state
            .store
            .create_queued_input(
                "thread-1",
                vec![crate::app_server_api::UserInput::Text {
                    text: "queued before restart".to_string(),
                    text_elements: vec![],
                }],
                crate::app_server_api::TurnStartOptions::default(),
            )
            .await
            .unwrap();

        queue::recover_queued_inputs(&state).await.unwrap();

        timeout(Duration::from_secs(2), async {
            loop {
                if app_server
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(method, _)| method == "turn/start")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let requests = app_server.requests.lock().unwrap();
        assert!(requests.iter().any(|(method, _)| method == "thread/read"));
        assert!(requests.iter().any(|(method, _)| method == "turn/start"));
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
    async fn due_automation_queues_source_labeled_input_with_local_execution_overrides() {
        let (state, app_server) = test_state().await;
        state
            .store
            .save_thread_local_settings_overlay(
                "thread-1",
                &ThreadLocalSettingsOverlay {
                    approval_policy: Some("on-request".to_string()),
                    approvals_reviewer: Some("auto_review".to_string()),
                    permissions: None,
                    sandbox: Some(json!({"type": "workspaceWrite"})),
                },
            )
            .await
            .unwrap();
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

        let queue_event = timeout(Duration::from_secs(2), async {
            loop {
                let event = receiver.recv().await.unwrap();
                if event.kind == queue::QUEUE_UPSERT_EVENT {
                    break event;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(queue_event.payload["sourceType"], "automation");
        assert!(queue_event.payload["sourceId"].as_str().is_some());

        timeout(Duration::from_secs(2), async {
            loop {
                if app_server
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(method, _)| method == "turn/start")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let requests = app_server.requests.lock().unwrap();
        let turn_start = requests
            .iter()
            .find(|(method, _)| method == "turn/start")
            .unwrap();
        assert_eq!(turn_start.1["threadId"], "thread-1");
        assert_eq!(turn_start.1["input"][0]["text"], "Summarize status");
        assert!(turn_start.1.get("model").is_none());
        assert!(turn_start.1.get("effort").is_none());
        assert!(turn_start.1.get("serviceTier").is_none());
        assert_eq!(turn_start.1["approvalPolicy"], "on-request");
        assert_eq!(turn_start.1["approvalsReviewer"], "auto_review");
        assert_eq!(
            turn_start.1["sandboxPolicy"],
            json!({"type": "workspaceWrite"})
        );
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
        let (state, app_server) = test_state().await;
        app_server
            .queued_errors
            .lock()
            .unwrap()
            .push(ApiError::BadGateway(
                "app-server error -32600: thread not found: thread-1".to_string(),
            ));
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
                if event.kind == automations::AUTOMATION_UPSERT_EVENT {
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
        assert!(automation.last_queued_input_id.is_none());
        assert!(automation
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("Target thread is not resumable"));
        assert!(state
            .store
            .list_queued_inputs("thread-1")
            .await
            .unwrap()
            .is_empty());

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "thread/resume");
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
    async fn queue_reconciliation_does_not_overwrite_draining_claim() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Draining,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        queue::reconcile_thread_runtime_from_app_server(&state, "thread-1")
            .await
            .unwrap();

        let runtime = state
            .store
            .get_thread_runtime_state("thread-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(runtime.status, ThreadRuntimeStatus::Draining);
        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "thread/read");
    }

    #[tokio::test]
    async fn queued_steer_reconciles_active_runtime_without_turn_id() {
        let (state, app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Active,
                active_turn_id: None,
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        *app_server.next_response.lock().unwrap() = Some(json!({
            "thread": {
                "id": "thread-1",
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "preview": "hello",
                "source": "cli",
                "status": {"type": "active", "activeFlags": []},
                "turns": [{
                    "id": "turn-active",
                    "status": {"type": "running"},
                    "startedAt": 1_767_225_600_i64,
                    "items": []
                }],
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_610_i64
            }
        }));
        let app = build_router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"steer me"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        let created = response_json(created).await;
        let queue_id = created["queuedInput"]["id"].as_str().unwrap();
        timeout(Duration::from_secs(2), async {
            loop {
                if state
                    .thread_views
                    .active_turn_id("thread-1")
                    .await
                    .as_deref()
                    == Some("turn-active")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let mut receiver = state.events.subscribe();
        let steered = app
            .clone()
            .oneshot(
                Request::post(format!(
                    "/v1/threads/thread-1/queued-inputs/{queue_id}/steer"
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(steered.status(), StatusCode::OK);
        let steered = response_json(steered).await;
        assert_eq!(steered["queuedInput"]["id"], queue_id);
        assert_eq!(steered["queuedInput"]["status"], "pendingCommit");
        assert_eq!(steered["queuedInput"]["acceptedTurnId"], "turn-active");

        let requests = app_server.requests.lock().unwrap();
        assert_eq!(requests[0].0, "thread/read");
        assert_eq!(requests[1].0, "turn/steer");
        assert_eq!(requests[1].1["expectedTurnId"], "turn-active");

        timeout(Duration::from_secs(2), async {
            let mut saw_steering = false;
            let mut saw_pending_commit = false;
            loop {
                let event = receiver.recv().await.unwrap();
                if event.kind == queue::QUEUE_DELETE_EVENT && event.payload["id"] == queue_id {
                    panic!("successful steer acceptance must not broadcast queue delete");
                }
                if event.kind == queue::QUEUE_UPSERT_EVENT && event.payload["id"] == queue_id {
                    match event.payload["status"].as_str() {
                        Some("steering") => saw_steering = true,
                        Some("pendingCommit") => {
                            assert!(saw_steering);
                            saw_pending_commit = true;
                        }
                        _ => {}
                    }
                }
                if saw_pending_commit {
                    break;
                }
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn committed_user_message_deletes_matching_pending_steer() {
        let (state, _app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Active,
                active_turn_id: Some("turn-1".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        mark_thread_session_active(&state, "thread-1", "turn-1").await;
        let app = build_router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"after tool"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created = response_json(created).await;
        let queue_id = created["queuedInput"]["id"].as_str().unwrap().to_string();
        let mut receiver = state.events.subscribe();

        let steered = app
            .clone()
            .oneshot(
                Request::post(format!(
                    "/v1/threads/thread-1/queued-inputs/{queue_id}/steer"
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response_json(steered).await["queuedInput"]["status"],
            "pendingCommit"
        );

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-user-1",
                    "item": {
                        "id": "item-user-1",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "after tool"}]
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        timeout(Duration::from_secs(2), async {
            loop {
                let event = receiver.recv().await.unwrap();
                if event.kind == queue::QUEUE_DELETE_EVENT && event.payload["id"] == queue_id {
                    break;
                }
            }
        })
        .await
        .unwrap();
        let listed = app
            .oneshot(
                Request::get("/v1/threads/thread-1/queued-inputs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response_json(listed).await["queuedInputs"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn accepted_steer_cannot_be_deleted_by_stale_client() {
        let (state, _app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Active,
                active_turn_id: Some("turn-1".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        mark_thread_session_active(&state, "thread-1", "turn-1").await;
        let app = build_router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"after tool"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created = response_json(created).await;
        let queue_id = created["queuedInput"]["id"].as_str().unwrap().to_string();
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post(format!(
                        "/v1/threads/thread-1/queued-inputs/{queue_id}/steer"
                    ))
                    .body(Body::empty())
                    .unwrap(),
                )
                .await
                .unwrap(),
        );

        let deleted = app
            .clone()
            .oneshot(
                Request::delete(format!("/v1/threads/thread-1/queued-inputs/{queue_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::BAD_REQUEST);
        let listed = app
            .oneshot(
                Request::get("/v1/threads/thread-1/queued-inputs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let listed = response_json(listed).await;
        assert_eq!(listed["queuedInputs"][0]["id"], queue_id);
        assert_eq!(listed["queuedInputs"][0]["status"], "pendingCommit");
    }

    #[tokio::test]
    async fn in_flight_steer_cannot_be_deleted_by_stale_client() {
        let (state, _app_server) = test_state().await;
        let queued_input = state
            .store
            .create_queued_input(
                "thread-1",
                vec![crate::app_server_api::UserInput::Text {
                    text: "after tool".to_string(),
                    text_elements: vec![],
                }],
                crate::app_server_api::TurnStartOptions::default(),
            )
            .await
            .unwrap();
        state
            .store
            .claim_queued_input_for_steering("thread-1", &queued_input.id)
            .await
            .unwrap();
        state
            .store
            .delete_queued_input("thread-1", &queued_input.id)
            .await
            .unwrap_err();
        let app = build_router(state.clone());

        let deleted = app
            .oneshot(
                Request::delete(format!(
                    "/v1/threads/thread-1/queued-inputs/{}",
                    queued_input.id
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::BAD_REQUEST);
        let queued_input = state
            .store
            .get_queued_input("thread-1", &queued_input.id)
            .await
            .unwrap();
        assert_eq!(
            queued_input.status,
            crate::store::QueuedInputStatus::Steering
        );
    }

    #[tokio::test]
    async fn committed_user_message_broadcasts_before_pending_steer_delete() {
        let (state, _app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Active,
                active_turn_id: Some("turn-1".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        mark_thread_session_active(&state, "thread-1", "turn-1").await;
        let app = build_router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"after tool"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created = response_json(created).await;
        let queue_id = created["queuedInput"]["id"].as_str().unwrap().to_string();
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post(format!(
                        "/v1/threads/thread-1/queued-inputs/{queue_id}/steer"
                    ))
                    .body(Body::empty())
                    .unwrap(),
                )
                .await
                .unwrap(),
        );
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-user-1",
                    "item": {
                        "id": "item-user-1",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "after tool"}]
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();

        let (timeline_event, delete_event) = timeout(Duration::from_secs(2), async {
            let mut timeline_event = None;
            let mut delete_event = None;
            loop {
                let event = receiver.recv().await.unwrap();
                if event.kind == thread_view::THREAD_VIEW_PATCH_EVENT_KIND
                    && event.payload["rows"].as_array().is_some_and(|rows| {
                        rows.iter()
                            .any(|row| row["item"]["itemId"] == "item-user-1")
                    })
                {
                    timeline_event = Some(event);
                } else if event.kind == queue::QUEUE_DELETE_EVENT && event.payload["id"] == queue_id
                {
                    assert!(
                        timeline_event.is_some(),
                        "queue delete was broadcast before its committed timeline item"
                    );
                    delete_event = Some(event);
                }
                if let (Some(timeline_event), Some(delete_event)) = (&timeline_event, &delete_event)
                {
                    break (timeline_event.clone(), delete_event.clone());
                }
            }
        })
        .await
        .unwrap();
        assert!(
            timeline_event.seq < delete_event.seq,
            "timeline event should be broadcast before the queue delete that depends on it"
        );
    }

    #[tokio::test]
    async fn idle_thread_status_requeues_unmatched_pending_steer() {
        let (state, _app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Active,
                active_turn_id: Some("turn-1".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        mark_thread_session_active(&state, "thread-1", "turn-1").await;
        let app = build_router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"after tool"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created = response_json(created).await;
        let queue_id = created["queuedInput"]["id"].as_str().unwrap().to_string();
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post(format!(
                        "/v1/threads/thread-1/queued-inputs/{queue_id}/steer"
                    ))
                    .body(Body::empty())
                    .unwrap(),
                )
                .await
                .unwrap(),
        );
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "thread/status".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "status": {"type": "idle"}
                }),
            },
            &state,
        )
        .await
        .unwrap();

        timeout(Duration::from_secs(2), async {
            let mut saw_thread_status = false;
            loop {
                let event = receiver.recv().await.unwrap();
                if event.kind == thread_view::THREAD_VIEW_PATCH_EVENT_KIND
                    && event.payload["liveState"] == "idle"
                {
                    saw_thread_status = true;
                }
                if event.kind == queue::QUEUE_UPSERT_EVENT && event.payload["id"] == queue_id {
                    assert!(
                        saw_thread_status,
                        "thread status should broadcast before requeued pending steer"
                    );
                    assert_eq!(event.payload["status"], "queued");
                    assert_eq!(event.payload["priority"], "rejectedSteer");
                    break;
                }
            }
        })
        .await
        .unwrap();
        let listed = app
            .oneshot(
                Request::get("/v1/threads/thread-1/queued-inputs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let listed = response_json(listed).await;
        assert_eq!(listed["queuedInputs"][0]["id"], queue_id);
        assert_eq!(listed["queuedInputs"][0]["status"], "queued");
        assert_eq!(listed["queuedInputs"][0]["priority"], "rejectedSteer");
    }

    #[tokio::test]
    async fn completed_turn_broadcasts_before_pending_steer_requeue_and_drain() {
        let (state, _app_server) = test_state().await;
        state
            .store
            .upsert_thread_runtime_state(ThreadRuntimeState {
                thread_id: "thread-1".to_string(),
                status: ThreadRuntimeStatus::Active,
                active_turn_id: Some("turn-1".to_string()),
                updated_at: chrono::Utc::now(),
                last_event_seq: None,
            })
            .await
            .unwrap();
        mark_thread_session_active(&state, "thread-1", "turn-1").await;
        let app = build_router(state.clone());
        let created = app
            .clone()
            .oneshot(
                Request::post("/v1/threads/thread-1/queued-inputs")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"input":[{"type":"text","text":"after tool"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let created = response_json(created).await;
        let queue_id = created["queuedInput"]["id"].as_str().unwrap().to_string();
        assert_ok(
            app.clone()
                .oneshot(
                    Request::post(format!(
                        "/v1/threads/thread-1/queued-inputs/{queue_id}/steer"
                    ))
                    .body(Body::empty())
                    .unwrap(),
                )
                .await
                .unwrap(),
        );
        let mut receiver = state.events.subscribe();

        ingest_inbound(
            InboundMessage::Notification {
                method: "turn/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
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

        timeout(Duration::from_secs(2), async {
            let mut saw_turn_upsert = false;
            loop {
                let event = receiver.recv().await.unwrap();
                if event.kind == thread_view::THREAD_VIEW_PATCH_EVENT_KIND
                    && event.payload["liveState"] == "idle"
                {
                    saw_turn_upsert = true;
                }
                if event.kind == queue::QUEUE_UPSERT_EVENT && event.payload["id"] == queue_id {
                    assert!(
                        saw_turn_upsert,
                        "turn completion should broadcast before requeued pending steer"
                    );
                    assert_eq!(event.payload["status"], "queued");
                    assert_eq!(event.payload["priority"], "rejectedSteer");
                    break;
                }
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn committed_user_message_matches_only_front_pending_steer() {
        let (state, _app_server) = test_state().await;
        let first = state
            .store
            .create_queued_input(
                "thread-1",
                vec![crate::app_server_api::UserInput::Text {
                    text: "first".to_string(),
                    text_elements: vec![],
                }],
                crate::app_server_api::TurnStartOptions::default(),
            )
            .await
            .unwrap();
        let second = state
            .store
            .create_queued_input(
                "thread-1",
                vec![crate::app_server_api::UserInput::Text {
                    text: "second".to_string(),
                    text_elements: vec![],
                }],
                crate::app_server_api::TurnStartOptions::default(),
            )
            .await
            .unwrap();
        for row in [&first, &second] {
            state
                .store
                .claim_queued_input_for_steering("thread-1", &row.id)
                .await
                .unwrap();
            state
                .store
                .mark_queued_input_pending_commit("thread-1", &row.id, "turn-1", None, None)
                .await
                .unwrap();
        }

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-user-second",
                    "item": {
                        "id": "item-user-second",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "second"}]
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();
        let listed = state.store.list_queued_inputs("thread-1").await.unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, first.id);
        assert_eq!(listed[1].id, second.id);

        ingest_inbound(
            InboundMessage::Notification {
                method: "item/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-user-first",
                    "item": {
                        "id": "item-user-first",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "first"}]
                    }
                }),
            },
            &state,
        )
        .await
        .unwrap();
        let listed = state.store.list_queued_inputs("thread-1").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, second.id);
        assert_eq!(
            listed[0].status,
            crate::store::QueuedInputStatus::PendingCommit
        );
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

        let approvals = state
            .store
            .list_approvals(Some("pending".to_string()), Some("thread-1".to_string()))
            .await
            .unwrap();
        assert_eq!(approvals.len(), 5);

        let events = state.store.replay_events(None, None, None).await.unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "codex.server_request")
                .count(),
            5
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "approval.created")
                .count(),
            5
        );
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
        assert_eq!(events[0].kind, "codex.server_request");
        assert_eq!(events[1].kind, "gateway.warning");
    }

    #[tokio::test]
    async fn approval_decision_sends_one_response_and_emits_resolved_event() {
        let (state, app_server) = test_state().await;
        let approval = state
            .store
            .insert_approval(NewApproval {
                request_id: "\"approval-1\"".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-1".to_string()),
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            })
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

        let resolved_events = state
            .store
            .replay_events(None, None, Some("thread-1".to_string()))
            .await
            .unwrap()
            .into_iter()
            .filter(|event| event.kind == "approval.resolved")
            .collect::<Vec<_>>();
        assert_eq!(resolved_events.len(), 1);
    }

    #[tokio::test]
    async fn concurrent_approval_decisions_only_send_one_upstream_response() {
        let store = Store::in_memory().await.unwrap();
        let app_server = Arc::new(BlockingRespondAppServer::default());
        app_server.ready.store(true, Ordering::SeqCst);
        let state = AppState::new(Config::default(), store, app_server.clone());
        let approval = state
            .store
            .insert_approval(NewApproval {
                request_id: "\"approval-1\"".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: Some("turn-1".to_string()),
                item_id: Some("item-1".to_string()),
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            })
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
        let approval = state
            .store
            .insert_approval(NewApproval {
                request_id: "\"approval-1\"".to_string(),
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: None,
                method: "item/commandExecution/requestApproval".to_string(),
                payload: json!({"threadId": "thread-1"}),
            })
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
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{}"#))
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
        assert_eq!(requests[1].1, json!({"type": "chatgpt"}));
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
            "type": "chatgpt",
            "loginId": "login-1",
            "authUrl": "https://example.test/login"
        }));
        let login = app
            .oneshot(
                Request::post("/v1/account/login")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(login.status(), StatusCode::OK);
        let login = response_json(login).await;
        assert_eq!(login["loginType"], "chatgpt");
        assert_eq!(login["loginId"], "login-1");
        assert_eq!(login["authUrl"], "https://example.test/login");
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
        for method in [
            "account/login/completed",
            "account/updated",
            "account/rateLimits/updated",
        ] {
            ingest_inbound(
                InboundMessage::Notification {
                    method: method.to_string(),
                    params: json!({"accountId": "acct-1"}),
                },
                &state,
            )
            .await
            .unwrap();
        }

        let methods = state
            .store
            .replay_events(None, None, None)
            .await
            .unwrap()
            .into_iter()
            .map(|event| event.codex_method.unwrap())
            .collect::<Vec<_>>();
        assert_eq!(methods, vec!["account/rateLimits/updated"]);
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
                kind: "approval.created".to_string(),
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
        assert_eq!(events[0]["kind"], "approval.created");
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
                kind: "mcp.config_changed".to_string(),
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
            event["seq"] == config_changed.seq && event["kind"] == "mcp.config_changed"
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
                kind: "mcp.config_changed".to_string(),
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
        assert!(chunk.contains("mcp.config_changed"));
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
                    "seenCompletedAgentTurnSeq": 1,
                    "lastCompletedAgentTurnSeq": 1,
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
                    "seenCompletedAgentTurnSeq": 1,
                    "lastCompletedAgentTurnSeq": 2,
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
    async fn sse_replays_and_streams_parent_scoped_subagent_events() {
        let (state, _) = test_state().await;
        let replay = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("thread-parent".to_string()),
                turn_id: None,
                item_id: None,
                kind: crate::subagents::THREAD_SUBAGENT_STARTED_EVENT.to_string(),
                codex_method: Some("thread/subagent".to_string()),
                payload: json!({
                    "parentThreadId": "thread-parent",
                    "subagentId": "subagent-1",
                    "subagent": {
                        "id": "subagent-1",
                        "parentThreadId": "thread-parent",
                        "agentNickname": "Scout",
                        "agentRole": "explorer",
                        "status": "active",
                        "liveState": "streaming",
                        "updatedAt": 100
                    }
                }),
            })
            .await
            .unwrap();
        let app = build_router(state.clone());

        let response = app
            .oneshot(
                Request::get("/v1/events?threadId=thread-parent&cursor=0")
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
                thread_id: Some("thread-parent".to_string()),
                turn_id: None,
                item_id: None,
                kind: crate::subagents::THREAD_SUBAGENT_STOPPED_EVENT.to_string(),
                codex_method: Some("thread/subagent".to_string()),
                payload: json!({
                    "parentThreadId": "thread-parent",
                    "subagentId": "subagent-1",
                    "subagent": null
                }),
            })
            .await
            .unwrap();
        state.events.send(live.clone()).unwrap();

        let mut body = response.into_body();
        let replay_chunk = next_sse_chunk(&mut body).await;
        assert!(replay_chunk.contains(&format!("id: {}", replay.seq)));
        assert!(replay_chunk.contains(crate::subagents::THREAD_SUBAGENT_STARTED_EVENT));
        assert!(replay_chunk.contains("\"subagentId\":\"subagent-1\""));

        let live_chunk = next_sse_chunk(&mut body).await;
        assert!(live_chunk.contains(&format!("id: {}", live.seq)));
        assert!(live_chunk.contains(crate::subagents::THREAD_SUBAGENT_STOPPED_EVENT));
        assert!(live_chunk.contains("\"subagent\":null"));
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
    async fn sse_replays_selected_thread_projection_patches_after_cursor() {
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
        assert!(first.contains("thread_view.patch"));
        assert!(first.contains("\"hello\""));
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
            1,
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
                Request::get("/v1/events?threadId=thread-2")
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
    async fn sse_allows_live_thread_title_notifications() {
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

        let title = state
            .store
            .append_event(NewEvent {
                project_id: None,
                thread_id: Some("t1".to_string()),
                turn_id: None,
                item_id: None,
                kind: "timeline.thread_metadata".to_string(),
                codex_method: Some("thread/name/updated".to_string()),
                payload: json!({"threadId": "t1", "threadName": "New title"}),
            })
            .await
            .unwrap();
        state.events.send(title.clone()).unwrap();

        let mut body = response.into_body();
        let chunk = next_sse_chunk(&mut body).await;
        assert!(chunk.contains(&format!("id: {}", title.seq)));
        assert!(chunk.contains("thread/name/updated"));
        assert!(chunk.contains("New title"));
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

    fn named_thread_read_response(thread_id: &str, name: &str, completed_turns: usize) -> Value {
        let mut response = thread_read_response(thread_id, completed_turns);
        response["thread"]["name"] = json!(name);
        response
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

    async fn wait_for_app_server_method(app_server: &RecordingAppServer, expected_method: &str) {
        wait_for_app_server_request_count(app_server, expected_method, 1).await;
    }

    async fn wait_for_app_server_request_count(
        app_server: &RecordingAppServer,
        expected_method: &str,
        expected_count: usize,
    ) {
        timeout(Duration::from_secs(2), async {
            loop {
                if app_server
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(method, _)| method == expected_method)
                    .count()
                    >= expected_count
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    struct RecordingTitleGenerator {
        title: Option<String>,
        requests: StdMutex<Vec<ThreadTitleRequest>>,
    }

    impl RecordingTitleGenerator {
        fn new(title: Option<&str>) -> Self {
            Self {
                title: title.map(str::to_string),
                requests: StdMutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl ThreadTitleGenerator for RecordingTitleGenerator {
        async fn generate_title(&self, request: ThreadTitleRequest) -> ApiResult<Option<String>> {
            self.requests.lock().unwrap().push(request);
            Ok(self.title.clone())
        }
    }

    #[derive(Default)]
    struct BlockingThreadListAppServer {
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
            if method != "thread/list" || !params["cwd"].is_string() {
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
    struct BlockingTurnStartAppServer {
        turn_start_requests: AtomicUsize,
        thread_read_requests: AtomicUsize,
        release: Notify,
    }

    #[async_trait]
    impl AppServer for BlockingTurnStartAppServer {
        fn is_ready(&self) -> bool {
            true
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, method: &str, _params: Value) -> ApiResult<Value> {
            match method {
                "turn/start" => {
                    self.turn_start_requests.fetch_add(1, Ordering::SeqCst);
                    self.release.notified().await;
                    Ok(json!({"turnId": "turn-started"}))
                }
                "thread/read" => {
                    self.thread_read_requests.fetch_add(1, Ordering::SeqCst);
                    Ok(thread_read_response("thread-1", 0))
                }
                "thread/list" => {
                    Ok(json!({"data": [], "nextCursor": null, "backwardsCursor": null}))
                }
                _ => Ok(json!({})),
            }
        }

        async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct FailingThenSucceedingTurnStartAppServer {
        turn_start_requests: AtomicUsize,
        thread_read_requests: AtomicUsize,
        release_first: Notify,
    }

    #[async_trait]
    impl AppServer for FailingThenSucceedingTurnStartAppServer {
        fn is_ready(&self) -> bool {
            true
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, method: &str, _params: Value) -> ApiResult<Value> {
            match method {
                "turn/start" => {
                    let request_index = self.turn_start_requests.fetch_add(1, Ordering::SeqCst);
                    if request_index == 0 {
                        self.release_first.notified().await;
                        Err(ApiError::BadGateway("turn start failed".to_string()))
                    } else {
                        Ok(json!({"turnId": "turn-started-after-failure"}))
                    }
                }
                "thread/read" => {
                    self.thread_read_requests.fetch_add(1, Ordering::SeqCst);
                    Ok(thread_read_response("thread-1", 0))
                }
                "thread/list" => {
                    Ok(json!({"data": [], "nextCursor": null, "backwardsCursor": null}))
                }
                _ => Ok(json!({})),
            }
        }

        async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct SpawnInputFailingAppServer {
        requests: StdMutex<Vec<(String, Value)>>,
        thread_read_requests: AtomicUsize,
    }

    #[async_trait]
    impl AppServer for SpawnInputFailingAppServer {
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
            match method {
                "thread/start" => Ok(json!({
                    "thread": thread_summary("thread-spawned"),
                    "cwd": "/workspace/kodex"
                })),
                "thread/read" => {
                    let request_index = self.thread_read_requests.fetch_add(1, Ordering::SeqCst);
                    if request_index == 0 {
                        Err(ApiError::BadGateway("thread read failed".to_string()))
                    } else {
                        Ok(thread_read_response("thread-spawned", 0))
                    }
                }
                "turn/start" => Ok(json!({"turnId": "turn-started"})),
                "thread/list" => {
                    Ok(json!({"data": [], "nextCursor": null, "backwardsCursor": null}))
                }
                _ => Ok(json!({})),
            }
        }

        async fn respond(&self, _request_id: &str, _result: Value) -> ApiResult<()> {
            Ok(())
        }
    }

    async fn mark_thread_session_active(state: &AppState, thread_id: &str, turn_id: &str) {
        thread_view::record_item_delta(
            &state.thread_views,
            thread_id,
            turn_id,
            "agent-active",
            "working",
            1,
        )
        .await
        .unwrap();
    }

    fn thread_read_response_with_agent_message(
        thread_id: &str,
        name: &str,
        tool_output: &str,
        agent_text: &str,
    ) -> Value {
        thread_read_response_with_agent_message_source(
            thread_id,
            name,
            tool_output,
            agent_text,
            json!("cli"),
            None,
        )
    }

    fn thread_read_response_with_agent_message_source(
        thread_id: &str,
        name: &str,
        tool_output: &str,
        agent_text: &str,
        source: Value,
        thread_source: Option<&str>,
    ) -> Value {
        let mut response = json!({
            "thread": {
                "id": thread_id,
                "name": name,
                "cliVersion": "0.130.0",
                "cwd": "/workspace",
                "ephemeral": false,
                "modelProvider": "openai",
                "source": source,
                "status": {"type": "idle"},
                "turns": [{
                    "id": "turn-0",
                    "status": {"type": "completed"},
                    "items": [
                        {"id": "item-user-1", "type": "userMessage", "content": [{"type": "text", "text": "Question"}]},
                        {"id": "item-tool-1", "type": "commandExecution", "aggregatedOutput": tool_output},
                        {"id": "item-agent-1", "type": "agentMessage", "phase": "final_answer", "text": agent_text}
                    ]
                }],
                "createdAt": 1_767_225_600_i64,
                "updatedAt": 1_767_225_600_i64
            }
        });
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
        let skill_path = plugin_root
            .map(|root| root.join("skills/kodex-proxy-evaluation/SKILL.md"))
            .unwrap_or_else(|| "/tmp/kodex-proxy-evaluation/SKILL.md".into());
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
                "skills": [{
                    "name": "kodex-proxy-evaluation",
                    "path": skill_path.display().to_string(),
                    "description": "Evaluate repository preview proxy compatibility.",
                    "enabled": true,
                    "scope": "plugin"
                }],
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

    fn subagent_thread_summary(
        id: &str,
        parent_thread_id: &str,
        created_at: i64,
        updated_at: i64,
        nickname: &str,
        role: &str,
        status: &str,
    ) -> Value {
        let mut thread = thread_summary(id);
        thread["source"] = json!({
            "subAgent": {
                "thread_spawn": {
                    "parent_thread_id": parent_thread_id,
                    "depth": 1,
                    "agent_nickname": nickname,
                    "agent_role": role
                }
            }
        });
        thread["agentNickname"] = json!(nickname);
        thread["agentRole"] = json!(role);
        thread["status"] = json!({"type": status});
        thread["createdAt"] = json!(created_at);
        thread["updatedAt"] = json!(updated_at);
        thread
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

    fn skills_list_response_with_interface(cwd: &str, name: &str, path: &str) -> Value {
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
                    "shortDescription": "Fallback short",
                    "interface": {
                        "displayName": "Review Fix",
                        "shortDescription": "Review loop",
                        "brandColor": "#23a55a",
                        "defaultPrompt": null,
                        "iconSmall": "/skills/review-fix/icon.png",
                        "iconLarge": null
                    }
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
        let mut body = Vec::new();
        body.extend_from_slice(b"--kodexboundary\r\n");
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"images\"; filename=\"{file_name}\"\r\n"
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

    struct MissingRolloutAppServer;

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
    impl AppServer for MissingRolloutAppServer {
        fn is_ready(&self) -> bool {
            true
        }

        fn readiness_error(&self) -> Option<String> {
            None
        }

        async fn request(&self, _method: &str, _params: Value) -> ApiResult<Value> {
            Err(ApiError::BadGateway(
                "app-server error -32602: no rollout found for thread id thread-missing"
                    .to_string(),
            ))
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
                return Err(ApiError::BadGateway(
                    "app-server error -32600: thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message".to_string(),
                ));
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
