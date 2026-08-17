# Notification Reliability Plan

## Context

- Kodex currently supports Web Push for unread agent messages, but local use shows notifications can stop reaching registered recipients until notifications are disabled and re-enabled.
- Comparison with a production reference implementation points to two reliability gaps:
  - Kodex treats a `localStorage` subscription id as the browser's enabled state in `apps/web/src/notifications/pushSubscriptions.ts`, while the reference reconciles the browser's current `PushSubscription.endpoint` with backend state.
  - Kodex sends push notifications inline from `apps/gateway/src/notifications.rs` and only logs failures, while the reference stores delivery rows, retries transient failures, and revokes subscriptions only for explicit terminal push-service statuses.
- This plan keeps the MVP deployment assumption unchanged: the gateway is local or trusted-VPN only, and Web Push still requires a secure browser context for non-localhost devices.

## Current State

- `apps/gateway/src/routes/notifications.rs` exposes:
  - `GET /v1/notifications/status`
  - `POST /v1/notifications/subscriptions`
  - `DELETE /v1/notifications/subscriptions/{subscriptionId}`
- `apps/gateway/src/store.rs` stores `push_subscriptions` keyed by endpoint with `enabled`, `created_at`, and `updated_at`, but has no endpoint-keyed current-device status lookup route and no delivery-attempt table.
- `apps/web/src/api/client.ts` serializes browser push subscriptions through generated OpenAPI types, but deletion is id-keyed and the frontend only keeps the gateway id in `localStorage`.
- `apps/web/src/notifications/pushSubscriptions.ts` reports enabled state from `localStorage["kodex.pushSubscriptionId"]`; it does not check `registration.pushManager.getSubscription()` or confirm the endpoint is still enabled on the gateway.
- `apps/web/src/PreferencesModal.tsx` disables the Enable button when `browserPushNotificationsEnabled()` returns true, which can trap the UI in "Enabled" when the gateway has disabled the stale server row.
- `apps/gateway/src/events.rs` appends `notification.planned` when a turn becomes terminal and spawns a delayed in-process recheck. If the gateway exits before the spawn runs, there is no durable delivery job to resume.
- `apps/gateway/src/notifications.rs` disables subscriptions on `PushDeliveryOutcome::PermanentFailure`; the concrete `permanent_delivery_error` set includes broad client-side construction errors such as `BadRequest`.
- Existing coverage lives in:
  - `apps/gateway/src/routes/mod.rs` for notification status, subscription upsert/delete, unread-agent-message delivery planning, and permanent/temporary failure behavior.
  - `apps/gateway/src/store.rs` for push subscription upsert and disabled filtering.
  - `apps/web/src/notifications/pushSubscriptions.test.ts` and `apps/web/src/PreferencesModal.test.tsx` for frontend enable/disable behavior.
- `AGENTS.md` requires public DTOs to generate OpenAPI, frontend API types to come from generated artifacts, gateway ownership for shared state, two-tab test shapes for shared state, and `$agent-browser` validation for browser-observable UI changes.

## Decisions

- Treat the browser's current `PushSubscription.endpoint` plus gateway active status as the source of truth for current-device notification state. Do not use `localStorage` as durable truth.
- Keep subscription identity endpoint-keyed in browser workflows. Gateway ids may remain in API responses for diagnostics, but the current device should enable, disable, and reconcile by browser endpoint.
- Add durable delivery attempts so push failures and retries are inspectable after the fact and so delayed notification work can survive gateway restarts.
- Retry non-terminal delivery failures. Disable a subscription only for explicit stale endpoint responses such as 404 or 410, or the closest status equivalents exposed by the Rust Web Push crate.
- Add a local diagnostic test-notification route so a registered recipient can be tested without waiting for an agent turn to complete.
- Keep push payloads minimal and privacy-preserving: notification kind, thread id when applicable, title/body preview already allowed by the current implementation, route, and badge count. Do not add full transcript data.

## Milestones

### 1. Current-Device Subscription Reconciliation

- Scope: `apps/gateway/src/routes/notifications.rs`, `apps/gateway/src/store.rs`, `apps/gateway/src/api.rs`, `apps/gateway/src/routes/mod.rs`, `apps/web/src/api/client.ts`, generated OpenAPI, and `apps/web/src/notifications/pushSubscriptions.ts`.
- Work:
  - Add a store lookup such as `get_push_subscription_status_by_endpoint(endpoint)` that returns whether the endpoint exists and is enabled.
  - Add `GET /v1/notifications/subscription/current?endpoint=...` returning `configured`, `subscribed`, and optionally the matching subscription metadata.
  - Add endpoint-keyed disable support, either `DELETE /v1/notifications/subscription/current` with an endpoint body or a query-param equivalent that fits the existing axum route patterns.
  - Keep the existing id-keyed delete route during migration so older clients can still disable rows.
  - Regenerate OpenAPI and update `apps/web/src/api/client.ts` wrappers with generated types.
  - Replace `browserPushNotificationsEnabled()` with an async state loader that:
    - checks browser support and `Notification.permission`,
    - gets the current service worker registration,
    - reads `registration.pushManager.getSubscription()`,
    - asks the gateway whether that endpoint is active,
    - returns `supported`, `configured`, `permission`, `hasBrowserSubscription`, and `subscribed`.
  - On enable, always upsert the actual current browser subscription endpoint and clear any legacy localStorage id.
  - On disable, revoke the current browser endpoint on the gateway, then unsubscribe the browser subscription; do not depend on a stored gateway id.
- Exit criteria:
  - Gateway route tests cover endpoint status for missing, enabled, disabled, and unconfigured states.
  - Store tests cover endpoint lookup after upsert, disable, and re-upsert.
  - Frontend tests prove stale localStorage alone does not show Enabled and does not disable the Enable button.
  - Frontend tests prove browser subscription present plus gateway disabled reports not subscribed and an Enable action re-upserts the same endpoint.
  - `cargo fmt`, focused `cargo test` notification/store tests, and focused `cd apps/web && npm test -- pushSubscriptions PreferencesModal` pass.

### 2. Durable Push Delivery Attempts And Retry Policy

- Scope: `apps/gateway/src/store.rs`, `apps/gateway/src/notifications.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/api.rs`, and focused backend tests in `apps/gateway/src/routes/mod.rs` or a new notification test module.
- Work:
  - Add a SQLite table for push notification delivery work, for example `notification_deliveries`, with `id`, `kind`, `thread_id`, `turn_id`, `payload_json` or enough source data to recompute payload, `status`, `attempt_count`, `available_at`, `processing_started_at`, `sent_at`, `last_error`, `created_at`, and `updated_at`.
  - On terminal turn notification planning in `apps/gateway/src/events.rs`, create a durable pending delivery job instead of relying only on a detached `tokio::spawn`.
  - Add a gateway worker in `NotificationService` or adjacent module that claims due delivery jobs, performs the existing delayed recheck, computes payload from `thread_read`, fans out to currently enabled subscriptions, and records sent/failed/retry state.
  - Preserve the existing `notification.planned` event if it is still useful for UI/debug visibility, but make delivery correctness depend on the durable job.
  - Retry temporary failures with bounded attempts and a short backoff. Keep subscriptions enabled for retryable errors.
  - Disable subscriptions only when the push service says the endpoint is stale. Map Web Push crate errors conservatively; do not classify payload construction/configuration errors as stale endpoint failures.
  - Log delivery outcomes with subscription id, endpoint host, delivery id, attempt count, and stale/temporary classification, without logging secrets.
- Exit criteria:
  - Store tests cover delivery job creation, claiming, retry scheduling, stale processing recovery, and retention/cleanup if cleanup is added.
  - Backend tests prove a planned notification survives by existing as a pending delivery row before worker execution.
  - Backend tests prove temporary failures retry and do not disable subscriptions.
  - Backend tests prove stale endpoint responses disable only the affected subscription and mark the delivery failed or partially failed as appropriate.
  - Backend tests prove a gateway restart between planning and worker execution would not lose the pending delivery row.
  - `cargo fmt` and focused `cargo test` coverage pass.

### 3. Diagnostic Test Notification

- Scope: `apps/gateway/src/routes/notifications.rs`, `apps/gateway/src/notifications.rs`, `apps/gateway/src/api.rs`, `apps/web/src/api/client.ts`, `apps/web/src/PreferencesModal.tsx`, `apps/web/src/PreferencesModal.test.tsx`, and generated OpenAPI.
- Work:
  - Add `POST /v1/notifications/test` to enqueue or immediately create a durable test notification delivery for all active subscriptions.
  - Return a response with push configuration state, active subscription count, delivery ids or attempted count, and a clear no-active-subscription state.
  - Render a small Test button in Preferences > Notifications when current-device notification state is subscribed.
  - Show success/failure feedback using existing Mantine alert patterns in `PreferencesModal.tsx`.
  - Keep the test payload generic, for example title `Kodex test notification`, body `Push notifications are working.`, route `/`, and a stable test notification kind.
- Exit criteria:
  - Gateway route tests cover configured/unconfigured, no active subscriptions, and active subscription enqueue behavior.
  - Frontend tests cover Test button visibility and mutation feedback.
  - Generated OpenAPI and `apps/web/src/api/generated/schema.ts` include the new route and DTOs.
  - `$agent-browser` validates the Preferences notification panel shows accurate state and exposes the Test action without console errors.

### 4. Frontend Service Worker And Multi-Client State Validation

- Scope: `apps/web/src/sw.ts`, `apps/web/src/sw.test.ts`, `apps/web/src/pwa/registerServiceWorker.ts`, `apps/web/src/notifications/pushSubscriptions.ts`, `apps/web/src/PreferencesModal.tsx`, and related tests.
- Work:
  - Ensure service worker registration returns the registration that owns the active push subscription. If a waiting service worker update exists, keep notification subscription lookup stable across update prompts.
  - Add service-worker tests for test notification payloads and unread-agent-message payloads.
  - Ensure notification click routing remains origin-bound and handles test notification route `/`.
  - Remove or migrate the legacy `kodex.pushSubscriptionId` localStorage key. Keep a one-time cleanup path so existing browsers are not stuck in stale enabled state.
  - Add a two-tab test shape around Preferences notification state if practical with current Vitest harness: one client disables/re-enables and the other converges after refetch instead of trusting local browser storage.
- Exit criteria:
  - `apps/web/src/notifications/pushSubscriptions.test.ts`, `apps/web/src/PreferencesModal.test.tsx`, and `apps/web/src/sw.test.ts` cover the new state model.
  - `cd apps/web && npm test` passes.
  - `cd apps/web && npm run build` passes.
  - `$agent-browser` validates desktop fine-pointer Preferences behavior and a narrow viewport shape. For native push delivery, document any manual browser/device check that cannot be automated.

### 5. Documentation, Local Migration, And Rollout

- Scope: `README.md`, `plans/index.md`, `AGENTS.md` only if workflow constraints change, local SQLite migration behavior in `apps/gateway/src/store.rs`, and generated artifacts.
- Work:
  - Document the current-device reconciliation behavior and the test notification flow in `README.md`.
  - Keep local/VPN-only and HTTPS requirements explicit.
  - Add a migration note for existing local `push_subscriptions` rows: existing enabled rows remain enabled, but browsers will reconcile by endpoint on next Preferences open or enable action.
  - Update `plans/index.md` as this plan moves from Proposed to Active to Complete.
  - Regenerate `apps/web/src/api/generated/schema.ts` after backend DTO changes.
- Exit criteria:
  - `README.md` covers setup and debugging for "registered but not receiving" notifications.
  - `plans/index.md` status is current.
  - OpenAPI and frontend generated types are committed with the implementation.
  - Final implementation verification includes `cargo test`, `cd apps/web && npm test`, `cd apps/web && npm run build`, and `$agent-browser` validation.

## Verification

- Backend:
  - `cargo fmt`
  - Focused tests first, then `cargo test` before marking implementation complete.
  - Inspect `GET /openapi.json` after route/DTO changes.
- Frontend:
  - `cd apps/web && npm run generate:api` with a gateway running after OpenAPI changes.
  - `cd apps/web && npm test`
  - `cd apps/web && npm run build`
- Browser:
  - `$agent-browser` checks Preferences > Notifications state, stale localStorage cleanup behavior, Test button rendering, console cleanliness, and responsive layout.
  - Manual native push smoke on at least one real recipient class available locally, preferably Chrome/FCM and Safari or installed iOS/iPadOS PWA if testing Apple Web Push behavior.
- Operational:
  - Query `~/.kodex/gateway.db` during manual testing to verify active subscriptions, durable delivery rows, attempts, and failure classifications match observed behavior.
  - Confirm no push endpoint auth secret or VAPID private key is logged or exposed through response DTOs.

## Risks And Open Questions

- The Rust `web_push` crate error variants may not expose HTTP status directly for every push service. Implementation should classify stale endpoint failures conservatively and add tests around the adapter boundary.
- Durable delivery jobs introduce a background worker. Keep it small, bounded, and in-process for this local gateway; do not add a general queue framework unless notification delivery needs it.
- Apple Web Push and FCM can behave differently around endpoint rotation. The endpoint reconciliation path should be validated against both when possible.
- A test notification can prove push plumbing, but native OS notification settings can still suppress display after the push service accepts delivery. The diagnostic response and delivery rows should make that distinction visible.
