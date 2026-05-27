# Per-Thread Notifications Plan

## Status

Complete.

## Context

Change notification delivery from an unread/read-state gate to an explicit per-thread user preference. Normal threads should notify by default, users should be able to disable notifications from the selected thread's existing three-dot menu, and the foreground `new Notification(...)` fallback should be removed.

Settled decisions:

- Normal threads default to notifications enabled.
- `thread_reads.seen_completed_agent_turn_seq` and `ThreadSummary.unreadCompletedAgentTurn` must no longer suppress Web Push delivery.
- Existing subagent and memory-consolidation suppression in `apps/gateway/src/notifications.rs` remains authoritative; the per-thread toggle does not override it.
- Remove the frontend foreground notification fallback. Browser notification display should come from service-worker Web Push only.
- Recommended implementation assumption: when notifications are enabled for a normal thread, the service worker should show Web Push even if that same device already has a Kodex window open on the thread. This keeps the per-thread setting as the user-visible gate and removes hidden selected-thread suppression paths.

Relevant code seams:

- `apps/gateway/src/events.rs` appends `notification.planned` and schedules `NotificationService::schedule_unread_agent_message_recheck` when a turn first becomes terminal.
- `apps/gateway/src/notifications.rs` currently rereads the thread, applies read state, and skips delivery when `unread_completed_agent_turn` is false.
- `apps/gateway/src/store.rs` owns SQLite tables and gateway-owned thread state such as `thread_reads`, `thread_pins`, and `push_subscriptions`.
- `apps/gateway/src/routes/threads.rs` owns thread routes, `ThreadSummary` overlays, selected-thread commands, and SSE broadcast helpers.
- `apps/gateway/src/api.rs` is the OpenAPI source of truth for new gateway DTOs and routes.
- `apps/web/src/threads/ThreadPanel.tsx` owns the selected-thread header and existing three-dot menu.
- `apps/web/src/notifications/useKodexNotifications.ts` owns the current foreground fallback and app badge update.
- `apps/web/src/sw.ts` owns service-worker push display and currently suppresses display when a same-origin client already shows the thread.

## Current State

- Backend Web Push configuration is global. `GET /v1/notifications/status` reports VAPID readiness, and `POST /v1/notifications/subscriptions` stores browser subscriptions in `push_subscriptions`.
- The only notification kind is `unreadAgentMessage`.
- A terminal turn creates a `notification.planned` event in `apps/gateway/src/events.rs`, then the gateway waits `KODEX_NOTIFICATIONS_RECHECK_DELAY_MS` before delivery.
- The delayed delivery path calls `thread/read`, overlays read state from `thread_reads`, and skips push if the thread is no longer unread.
- The browser marks selected threads seen automatically in `apps/web/src/threads/useThreadReadState.ts`, which can clear unread state before the delayed push recheck.
- The service worker ignores unknown payloads and skips display when `pushNotificationThreadVisible(...)` sees the same thread open on the same device.
- The frontend foreground fallback in `useKodexNotifications` calls `showForegroundNotification(...)` only when browser push is not locally enabled and the completed turn is for a non-selected loaded thread.
- `AGENTS.md` requires gateway-owned shared state, generated OpenAPI/frontend types, and same-user multi-client convergence for thread/session state changes.

## Milestones

### 1. Gateway-Owned Thread Notification Preference

Scope: `apps/gateway/src/store.rs`, `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/api.rs`, focused gateway tests.

Work:

- Add a SQLite table in `Store::migrate`:
  - `thread_notification_settings(thread_id text primary key, notifications_enabled integer not null default 1, updated_at text not null)`.
- Add store DTO/helpers for:
  - reading one thread's effective setting, defaulting missing rows to enabled;
  - reading settings for a batch of thread IDs;
  - upserting a thread's enabled/disabled state.
- Add `notifications_enabled: bool` to `ThreadSummary` and `SidebarThreadSummary`, with gateway overlays defaulting to true for missing settings.
- Extend `apply_thread_summary_state(...)` so thread list, selected-thread, pinned-thread, rename, create, resume, fork, and attach responses all include the setting.
- Keep raw response synchronization consistent by ensuring `ThreadSummary.raw_payload` includes the overlaid `notificationsEnabled` value before `sync_thread_list_raw_payload(...)` and `sync_raw_response_thread(...)`.
- Add route DTOs:
  - `ThreadNotificationSettingsUpdateRequest { enabled: bool }`
  - `ThreadNotificationSettingsResponse { threadId, notificationsEnabled, updatedAt }`
  - `ThreadNotificationSettingsUpdate` for SSE payloads.
- Add `PATCH /v1/threads/{threadId}/notifications` to `apps/gateway/src/routes/threads.rs`.
- Broadcast a `thread.notifications_updated` gateway event after successful upsert.
- Add route and DTO registration to `apps/gateway/src/api.rs`.

Exit criteria:

- Store tests prove missing setting defaults to enabled, explicit false persists, explicit true re-enables, and batch reads default missing rows.
- Route tests prove the PATCH route upserts state, returns camelCase DTOs, and emits `thread.notifications_updated`.
- Thread list/detail/sidebar tests prove summaries include `notificationsEnabled: true` by default and `false` after an override.
- `cargo fmt` and focused gateway tests pass.

### 2. Notification Delivery Uses Preference, Not Read State

Scope: `apps/gateway/src/notifications.rs`, `apps/gateway/src/events.rs` if payload metadata needs adjustment, focused gateway notification tests.

Work:

- In `deliver_unread_agent_message_if_still_unread`, read the effective per-thread notification setting before delivery.
- If `notifications_enabled` is false, skip delivery without consulting read state.
- Keep `suppress_unread_agent_message_notification(...)` for subagent and memory-consolidation threads.
- Keep the delayed recheck so the gateway can read a fresh thread snapshot for title/body, but remove the gate that exits when `snapshot.thread.unread_completed_agent_turn` is false.
- Avoid calling `apply_completed_agent_turn_read_state(...)` in the delivery decision path unless still needed for badge count derivation.
- Keep `unread_badge_count(...)` as a best-effort badge count for now; preserve the existing `max(1)` fallback so a notification still has a nonzero badge even when all read state is cleared.
- Add debug-level logging that distinguishes `disabled_by_thread_setting`, `suppressed_by_thread_source`, and `delivered` so future delivery debugging is not blind.

Exit criteria:

- Gateway test proves a planned notification still delivers when `thread_reads` already marks the completed turn seen.
- Gateway test proves an explicit disabled thread setting suppresses delivery.
- Gateway test proves subagent and memory-consolidation suppression still wins even when the thread setting is enabled.
- Gateway test proves permanent push failures still disable stale subscriptions and temporary failures remain enabled.

### 3. Frontend API, Cache, And SSE Convergence

Scope: generated OpenAPI artifacts, `apps/web/src/api/client.ts`, `apps/web/src/threads/events.ts`, `apps/web/src/threads/cache.ts`, `apps/web/src/App.tsx`, focused frontend tests.

Work:

- Regenerate `apps/web/src/api/generated/schema.ts` after the backend route and DTOs exist.
- Export typed aliases and add `setThreadNotificationsEnabled(threadId, enabled)` in `apps/web/src/api/client.ts`.
- Add `threadNotificationsUpdateFromEvent(event)` in `apps/web/src/threads/events.ts` for `thread.notifications_updated`.
- Add or reuse cache helpers to patch `notificationsEnabled` across selected thread state, route-selected thread state, project thread lists, chat threads, pinned threads, and Query cache snapshots.
- Add a React Query mutation in `App.tsx` and a stable callback passed to `ThreadPanel`.
- Apply the canonical mutation response locally and still process the SSE event for same-user two-tab convergence.
- Preserve the default-true behavior when older cached/generated test fixtures omit `notificationsEnabled` during transition.

Exit criteria:

- Frontend event tests parse `thread.notifications_updated` payloads and ignore malformed events.
- Cache tests prove a notification-setting update patches project, chat, pinned, selected, and sidebar snapshots without dropping unrelated thread fields.
- App-level two-tab-shaped test proves one client toggling the setting converges in another client through SSE/cache update without reload.
- `cd apps/web && npm test -- threads/events.test.ts threads/cache.test.ts App.mvp.shell.test.tsx` or the focused touched-test equivalent passes.

### 4. Thread Menu Toggle

Scope: `apps/web/src/threads/ThreadPanel.tsx`, `apps/web/src/ui/CheckboxMenuItem.tsx` usage, app shell or component tests, browser validation.

Work:

- Add a checkbox item to the selected thread's existing three-dot menu in `ThreadPanel.tsx`.
- Label: `Notify for this thread`.
- Checked state: `selectedThread.notificationsEnabled !== false`.
- On click, call `onSetThreadNotificationsEnabled(selectedThread.id, nextEnabled)`.
- Use the existing `CheckboxMenuItem` primitive for accessible checked menu behavior and visual consistency.
- Keep the toggle in the main selected-thread menu only; do not add controls to `SubagentThreadViewer`.
- Surface mutation failures through the existing `reportError` path in `App.tsx`; do not add a new modal or toast surface for this plan.

Exit criteria:

- Test proves the menu item is checked by default for a thread without an explicit setting.
- Test proves clicking the item calls the new API with `enabled: false` and updates the menu state.
- Test proves clicking again calls the API with `enabled: true`.
- Test proves the menu reflects an SSE update from another tab.
- `$agent-browser` validates the three-dot menu toggle on desktop and narrow/mobile widths, including that labels fit and the menu is usable with touch/coarse pointer.

### 5. Remove Foreground Notification Fallback And Same-Device Push Suppression

Scope: `apps/web/src/notifications/useKodexNotifications.ts`, `browserNotifications.ts`, `unreadAgentMessages.ts`, `notificationTypes.ts`, `pushVisibility.ts`, `sw.ts`, `App.tsx`, related tests.

Work:

- Remove the foreground `showForegroundNotification(...)` path from `useKodexNotifications`.
- Refactor or rename `useKodexNotifications` so its remaining responsibility is app badge synchronization from known unread state, or inline that behavior in a smaller badge-focused hook.
- Keep `notificationPermission()` and `requestKodexNotificationPermission()` if they are still used by `PreferencesModal`, but delete `showForegroundNotification` and `NotificationIntent` if no longer referenced.
- Delete or simplify `unreadAgentMessageIntent(...)` if it only served foreground notifications; keep unread badge count helpers if still useful.
- Remove `browserPushNotificationsEnabled()` checks from notification-event handling if they only existed to suppress foreground fallback.
- In `apps/web/src/sw.ts`, remove the `pushNotificationThreadVisible(...)` skip so the service worker displays valid Web Push payloads regardless of same-device open-thread visibility.
- Delete `pushVisibility.ts` and its tests if nothing else uses them.
- Update tests by removing foreground-notification expectations and adding service-worker behavior coverage for same-thread-open clients if the existing test harness supports it.

Exit criteria:

- `rg "showForegroundNotification|NotificationIntent|pushNotificationThreadVisible"` finds no production references.
- Frontend tests prove badge updates still work without foreground notification creation.
- Service-worker tests or focused unit coverage prove valid `unreadAgentMessage` payloads are not suppressed due to visible clients.
- `cd apps/web && npm test` touched suites and `cd apps/web && npm run build` pass.

### 6. Documentation, Generated Artifacts, And Validation

Scope: `README.md` if behavior/config docs need an update, `plans/index.md`, generated OpenAPI/frontend schema, browser validation.

Work:

- Regenerate OpenAPI and frontend schema after backend DTO changes:
  - start a gateway;
  - `cd apps/web && npm run generate:api`.
- Update `README.md` only if the public notification behavior/setup text changes beyond existing VAPID setup.
- Keep `plans/index.md` status current when implementation starts and completes.
- Run focused backend/frontend tests after each milestone, then broader verification before completion.
- Use `$agent-browser` for the observable menu toggle and service-worker/browser behavior where practical.

Exit criteria:

- `cargo fmt` passes.
- Focused `cargo test` targets for store, thread routes, and notifications pass.
- `cd apps/web && npm test` touched suites pass.
- `cd apps/web && npm run build` passes.
- Generated `apps/web/src/api/generated/schema.ts` is committed with the backend DTO changes.
- `$agent-browser` validation covers the thread menu toggle on desktop and narrow/mobile shapes.

## Verification

- Backend:
  - `cargo fmt`
  - Focused `cargo test` for `store`, `routes::threads`, and notification delivery tests.
  - `cargo test` before marking complete if runtime cost is acceptable.
  - `/openapi.json` inspection after route/DTO changes.
- Frontend:
  - `cd apps/web && npm run generate:api` with a gateway running after backend route changes.
  - `cd apps/web && npm test -- threads/events.test.ts threads/cache.test.ts App.mvp.shell.test.tsx notifications/useKodexNotifications.test.tsx notifications/browserNotifications.test.ts notifications/pushVisibility.test.ts`
  - Adjust the exact touched test list as files are deleted or renamed.
  - `cd apps/web && npm run build`.
- Browser:
  - `$agent-browser` opens the local app, selects a thread, opens the three-dot menu, verifies the `Notify for this thread` checkbox state, toggles it, and confirms the UI remains usable at desktop and narrow/mobile widths.
  - Manual or automated service-worker smoke verifies a valid Web Push payload displays even when a client is open on the thread.

## Risks And Open Questions

- The plan assumes per-thread enabled means "show Web Push for normal threads" even when a same-device client is already open on that thread. If this proves too noisy, restore same-device suppression as a separate explicit decision, not as a hidden read-state proxy.
- Badge count remains based on unread thread state, while delivery no longer does. This can produce a notification with badge `1` for a thread another tab already marked read. That is acceptable for the first pass because the notification itself is the user-requested signal; revisit badge semantics only if the mismatch is confusing.
- Existing fixtures may omit `notificationsEnabled`; frontend normalization and tests should treat missing as true during the transition.
- Public API changes require generated OpenAPI and frontend types. Do not hand-write duplicate TypeScript DTOs.
- This remains local/trusted-VPN notification infrastructure. Do not imply the gateway is safe to expose publicly.
