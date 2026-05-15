# PWA Notifications Plan

## Context

- Add PWA support to `apps/web` without changing frameworks. Kodex already uses React, Vite, and Mantine, so the PWA layer should be `vite-plugin-pwa` plus a custom Workbox service worker.
- Keep notification behavior minimal for the first implementation: notify when a thread has an unread completed agent turn, and keep the app badge in sync with unread thread attention.
- Do not add iOS-specific install guidance or a dedicated iOS onboarding flow. iOS compatibility still matters for manifest metadata, service-worker behavior, Web Push, and Badging API fallbacks.
- Centralize notification decisions so future notification types, such as approval requests or automation failures, can be added without threading one-off Notification API calls through `App.tsx`.

## Current State

- `apps/web/package.json` uses Vite, React, Vitest, and Playwright; there is no PWA plugin, manifest, service worker registration, or notification module.
- `apps/web/index.html` already references favicon, `icon-192.png`, `icon-256.png`, `apple-touch-icon.png`, and `kodex-badge.png` in `apps/web/public`.
- Gateway-owned unread state already exists:
  - `apps/gateway/src/store.rs` creates `thread_reads` with `seen_completed_agent_turn_seq`.
  - `apps/gateway/src/routes/threads.rs` exposes `POST /v1/threads/{thread_id}/seen`.
  - `apps/gateway/src/app_server_api.rs` exposes `ThreadSummary.lastCompletedAgentTurnSeq`, `seenCompletedAgentTurnSeq`, and `unreadCompletedAgentTurn`.
  - `apps/web/src/threads/useThreadReadState.ts` updates selected and background thread unread state from `timeline.turn_upsert` events.
  - `apps/web/src/threads/WorkspaceSidebar.tsx` renders the unread completed agent turn indicator.
- `apps/web/src/App.tsx` owns the global SSE stream, selected thread timeline, thread cache updates, and the current `applyCompletedAgentTurnEvent` call site.
- `apps/web/src/events/stream.ts` centralizes gateway SSE event type registration and reconnect behavior.
- `apps/gateway/src/events.rs` normalizes app-server notifications into `timeline.turn_upsert`, `timeline.item_upsert`, `timeline.thread_status`, and related events.
- `apps/gateway/src/static_assets.rs` serves the built frontend through `ServeDir` with `index.html` fallback when `KODEX_FRONTEND_DIST` is configured.
- `AGENTS.md` requires gateway-owned state for multi-client correctness, generated OpenAPI as the API contract, generated frontend API types, two-tab coverage for shared thread state, and `$agent-browser` validation for browser-observable frontend changes.

## Decisions

- Treat `ThreadSummary.unreadCompletedAgentTurn` as the v1 canonical signal for "thread has unread agent message" notifications. Do not add a second browser-local unread model.
- Badge count is the number of unique known threads with `unreadCompletedAgentTurn === true`, deduped across project, chat, pinned, and selected-thread caches.
- Browser notifications are opt-in and generic. The UI may add a minimal Notifications preference row because browser permission and push subscription both require user action, but it must not add iOS-specific install copy.
- Foreground behavior is client-owned projection: app badge updates immediately from Query cache and SSE state.
- Background behavior is gateway-owned delivery: the service worker displays Web Push notifications, and the gateway rechecks unread state after a short delay before sending a push.
- Notification payloads stay minimal: kind, thread id, thread title when available, route, and badge count. Do not include full agent message text in push payloads for v1.

## Milestones

### 1. PWA Shell And Service Worker

- Scope: `apps/web/package.json`, `apps/web/package-lock.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, new files under `apps/web/src/pwa` or `apps/web/src/notifications`, and `apps/web/src/sw.ts`.
- Work:
  - Add `vite-plugin-pwa` and Workbox dependencies.
  - Configure `VitePWA` in `apps/web/vite.config.ts` with `injectManifest` so `src/sw.ts` can own `push`, `notificationclick`, and badge handling.
  - Add a web app manifest with stable `id`, `name`, `short_name`, `start_url`, `scope`, `display: "standalone"`, colors, and existing icons from `apps/web/public`.
  - Add or generate any missing PWA icon sizes needed for installability, preferring existing Kodex assets where possible.
  - Register the service worker from a small `apps/web/src/pwa/registerServiceWorker.ts` module called by `apps/web/src/main.tsx`.
  - Keep static app-shell caching conservative: cache built static assets and avoid caching `/v1/*`, `/openapi.json`, SSE, or file preview responses.
- Exit criteria:
  - `cd apps/web && npm test` covers service-worker registration helpers and manifest-adjacent capability detection where practical.
  - `cd apps/web && npm run build` emits a manifest and service worker without type errors.
  - `$agent-browser` validates the built or dev app has a registered service worker and a valid manifest, with no console errors.

### 2. Frontend Notification Center And App Badge

- Scope: new `apps/web/src/notifications/*`, `apps/web/src/App.tsx`, `apps/web/src/threads/useThreadReadState.ts`, `apps/web/src/threads/cache.ts`, `apps/web/src/PreferencesModal.tsx`, `apps/web/src/PreferencesModal.test.tsx`, and focused app/timeline tests.
- Work:
  - Add pure notification decision helpers, for example:
    - `notificationTypes.ts` for `KodexNotificationKind`, `NotificationIntent`, and `NotificationState`.
    - `unreadAgentMessages.ts` for deriving unread-agent-message intents and unread badge counts from `ThreadSummary[]`.
    - `browserBadge.ts` for safe wrappers around `navigator.setAppBadge()` and `navigator.clearAppBadge()`.
    - `browserNotifications.ts` for safe wrappers around `Notification.permission`, `Notification.requestPermission()`, and foreground notification display.
  - Add a `useKodexNotifications` hook that accepts known thread snapshots, selected thread id, and terminal turn events, then delegates all browser notification and badge effects through the notification module.
  - Refactor `App.tsx` so global SSE still updates thread/read state first, then passes a normalized notification signal to the notification center.
  - Update app badge whenever deduped unread count changes. Clear the badge when the count returns to zero or when the browser lacks Badging API support.
  - Add a minimal generic Notifications preference row if needed for permission and subscription controls. Do not add iOS-specific install instructions or banners.
  - Keep selected-thread behavior quiet: a terminal event for the currently selected thread should be marked seen and should not create a foreground notification or lasting badge.
- Exit criteria:
  - Focused Vitest coverage proves badge counts dedupe project/chat/pinned cache entries.
  - Existing unread tests in `apps/web/src/App.mvp.timeline.test.tsx` continue to pass.
  - New tests prove selected-thread terminal events clear or avoid badge state, while background-thread terminal events set badge state.
  - Browser API wrappers are tested with missing APIs so unsupported desktop browsers, non-installed iOS Safari, and jsdom degrade silently.
  - `$agent-browser` validates foreground badge/permission UI behavior where browser support allows inspection, with a manual fallback note when the local browser does not expose Badging API state.

### 3. Gateway Web Push Subscription API

- Scope: `apps/gateway/src/store.rs`, new `apps/gateway/src/routes/notifications.rs`, `apps/gateway/src/routes/mod.rs`, `apps/gateway/src/api.rs`, `apps/gateway/src/config.rs`, `apps/web/src/api/client.ts`, and generated `apps/web/src/api/generated/schema.ts`.
- Work:
  - Add a `push_subscriptions` table with endpoint, public key, auth secret, optional user-agent label, enabled state, created timestamp, and updated timestamp.
  - Add gateway DTOs and OpenAPI routes:
    - `GET /v1/notifications/status` returns capability/configuration state and VAPID public key when available.
    - `POST /v1/notifications/subscriptions` upserts the current browser subscription.
    - `DELETE /v1/notifications/subscriptions/{subscriptionId}` or endpoint-keyed equivalent disables/removes a subscription.
  - Add a small gateway notification service module responsible for subscription lookup, VAPID configuration, delivery attempts, stale subscription cleanup, and delivery error logging.
  - Choose the Rust Web Push dependency during implementation based on current crate health, then keep the integration behind the gateway notification service so it can be swapped.
  - Regenerate OpenAPI and frontend API types after route DTOs are implemented.
- Exit criteria:
  - Gateway route tests cover subscription create/update/delete/status and generated OpenAPI inclusion.
  - Store tests cover idempotent endpoint upsert and stale subscription cleanup.
  - `cargo fmt` and focused gateway tests pass.
  - `cd apps/web && npm run generate:api` updates `apps/web/src/api/generated/schema.ts` from a running gateway.

### 4. Background Unread Agent Message Delivery

- Scope: `apps/gateway/src/events.rs`, notification service module, `apps/web/src/sw.ts`, `apps/web/src/notifications/*`, and focused backend/frontend tests.
- Work:
  - Hook gateway notification planning into the normalized `timeline.turn_upsert` terminal path in `apps/gateway/src/events.rs`.
  - Schedule a short delayed recheck before sending push. On recheck, read canonical thread state and `thread_reads`; skip delivery if the completed turn has already been marked seen.
  - Compute a deduped unread badge count from gateway-owned thread summaries where practical. If the count cannot be computed because app-server is unavailable, send the specific unread-thread notification and set a conservative badge count of at least `1`.
  - Send only v1 `unreadAgentMessage` push payloads with thread id, display title, route, and badge count.
  - In `apps/web/src/sw.ts`, handle `push` by showing a minimal notification and setting the app badge when supported.
  - In `notificationclick`, focus an existing Kodex client when possible and navigate to `/threads/{threadId}`; otherwise open that route.
  - Add foreground and service-worker message paths so future notification kinds can reuse the same payload schema.
- Exit criteria:
  - Gateway tests prove terminal background events schedule delivery, selected/already-seen rechecks skip delivery, and stale push subscriptions are disabled on permanent push failures.
  - Service-worker tests or build-time type checks cover payload parsing and click route construction.
  - Frontend integration tests prove foreground app state and push payload schema use the same notification kind/type definitions.
  - Two mounted app clients converge on unread and badge state when one client opens/marks the thread seen.

### 5. Documentation And Validation

- Scope: `README.md`, `plans/index.md`, and any implementation notes needed near configuration.
- Work:
  - Document the local/VPN-only PWA assumption and HTTPS requirement for device Web Push without implying public exposure safety.
  - Document the notification setup command/configuration once VAPID key management is implemented.
  - Keep `plans/index.md` status current as implementation starts and completes.
  - Add a small manual QA checklist covering desktop browser, narrow viewport, and installed iOS/iPadOS PWA behavior without adding in-app iOS guidance.
- Exit criteria:
  - `README.md` reflects any new setup or runtime configuration.
  - `plans/index.md` reflects the implementation status.
  - Full relevant verification passes: `cargo test`, `cd apps/web && npm test`, `cd apps/web && npm run build`, and focused `$agent-browser` validation.

## Verification

- Backend:
  - `cargo fmt`
  - `cargo test`
  - Focused route/store tests for notification subscription and delivery planning.
  - OpenAPI check via `GET /openapi.json` after new DTOs/routes are added.
- Frontend:
  - `cd apps/web && npm test`
  - `cd apps/web && npm run build`
  - `cd apps/web && npm run generate:api` after gateway route changes.
  - Focused Vitest coverage for notification decisions, browser wrappers, badge count derivation, and selected-thread suppression.
- Browser:
  - `$agent-browser` checks manifest/service-worker registration, foreground badge behavior where available, route focus/navigation after notification click where practical, and console cleanliness.
  - Manual installed-PWA smoke on iOS/iPadOS 16.4+ or newer: install from Safari, enable notifications through the generic notification control, trigger a background unread agent message, verify native notification and app badge, then open the thread and verify badge clears.

## Risks And Open Questions

- Exact Web Push crate choice should be checked during implementation because Rust push crate maintenance can change. Keep the dependency behind a small gateway service.
- Existing `lastCompletedAgentTurnSeq` is a completed-turn count, not a durable app-server turn id. The first implementation should avoid using browser-observed SSE order as durable state and should re-read gateway/app-server state before background push delivery.
- Gateway-wide unread count may require listing project and chat thread summaries, which can be expensive. Start with correctness over optimization; add caching only if tests or local use show it is needed.
- Browser support varies. Badging and notifications must degrade silently when unavailable, denied, or not installed as a PWA.
- Push subscriptions are local-gateway state in the MVP security model. Do not imply this makes Kodex safe to expose publicly.
