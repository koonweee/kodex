# Thread Foreground Presence Notification Suppression Plan

## Context

- Goal: suppress unread-agent-message push notifications when any web/PWA client is actively viewing the target thread.
- The signal must be gateway-owned because multi-tab and future multi-client correctness cannot depend on one React tree's local state.
- Scope for this plan is web/PWA client reporting only. The gateway API should be reusable by future native clients, but SwiftUI/iOS reporting is not part of this plan.
- Notification delivery already runs through a durable delayed recheck in `apps/gateway/src/notifications.rs`, so suppression can happen at delivery time rather than at terminal-turn event ingestion time.

## Current State

- `apps/web/src/App.tsx` owns `selectedThreadId` and `selectedThreadIdRef`, and selected-thread snapshots call `markCompletedAgentTurnSeen` when a thread is opened.
- `apps/web/src/timeline/useSelectedThreadTimeline.ts` opens a selected-thread SSE stream with `threadId`, but this only proves the thread is selected in that tab. It does not prove the page is foreground-visible.
- `apps/web/src/events/useGlobalLiveStream.ts` excludes the selected thread from the global stream with `excludeThreadId`, again based on selection rather than visibility.
- `apps/web/src/threads/useThreadReadState.ts` marks completed selected-thread agent turns as seen without checking `document.visibilityState`.
- `apps/gateway/src/events.rs` enqueues unread-agent-message notification deliveries when a terminal turn is observed.
- `apps/gateway/src/notifications.rs` resolves pending unread-agent-message deliveries through `notification_payload_for_delivery` and `unread_agent_message_payload_if_still_unread`, after checking per-thread notification settings and source suppression.
- `apps/gateway/src/routes/notifications.rs` owns existing notification management routes, but foreground thread presence is a thread-view lifecycle concern and should not be stored as a durable notification setting.
- `apps/gateway/src/api.rs` owns `AppState`, OpenAPI registration, and route merging. Public DTOs must be Rust DTOs that generate `/openapi.json`, and web types must come from `apps/web/src/api/generated/schema.ts`.
- Web/PWA backgrounding is not currently observed in the web source; there are no `visibilitychange` or `document.visibilityState` hooks.

## Milestones

### 1. Gateway Foreground Presence Contract

- Scope: `apps/gateway/src/api.rs`, `apps/gateway/src/routes/mod.rs`, a new focused gateway module such as `apps/gateway/src/thread_presence.rs`, and a route module such as `apps/gateway/src/routes/thread_presence.rs`.
- Work:
  - Add an in-memory, gateway-owned foreground presence registry to `AppState`, keyed by `clientId`.
  - Track `{ clientId, threadId, visible, lastSeenAt }` with monotonic cleanup semantics and a short TTL. Use a heartbeat interval around 5 seconds and a TTL around 15 seconds unless implementation testing shows a need to tune.
  - Expose a public route such as `POST /v1/threads/{threadId}/view-presence` with a request body containing `clientId` and `visible`.
  - Return a small response such as `{ threadId, foregroundViewerCount, viewed }` so tests and future clients can verify the gateway interpretation.
  - Register the route and DTOs in `ApiDoc` so `/openapi.json` includes the contract.
  - Keep this state ephemeral and local to the gateway process; do not create SQLite tables or durable events for presence.
- Exit criteria:
  - Focused gateway tests cover visible heartbeat, hidden clear, TTL expiry, client switching threads, and multiple clients viewing the same thread.
  - `cargo fmt` passes for edited Rust files.

### 2. Notification Suppression At Delivery Recheck

- Scope: `apps/gateway/src/notifications.rs`, `apps/gateway/src/routes/mod.rs` tests, and any focused helper tests for the new presence module.
- Work:
  - Check the presence registry inside `unread_agent_message_payload_if_still_unread` after per-thread notification settings and source suppression, before building the push payload.
  - If `thread_id` has at least one unexpired foreground viewer, return `Ok(None)` and mark the pending notification delivery as sent/no-op through the existing `process_delivery` path.
  - Add tracing with a stable reason such as `foreground_viewer_present` for local diagnostics.
  - Do not suppress `NotificationKind::Test`; test notifications should continue to send regardless of presence.
  - Preserve the existing durable delivery behavior for disabled settings, subagent/source suppression, temporary push failures, and stale endpoint handling.
- Exit criteria:
  - Gateway tests prove an unread-agent-message delivery is skipped when a foreground viewer heartbeat is active.
  - Gateway tests prove the same delivery sends after the presence TTL expires.
  - Existing notification tests around disabled thread settings, subagents, temporary failures, stale endpoints, and test notifications still pass.

### 3. Web/PWA Presence Hook

- Scope: `apps/web/src/api/client.ts`, generated schema in `apps/web/src/api/generated/schema.ts`, a new hook such as `apps/web/src/threads/useThreadViewPresence.ts`, and `apps/web/src/App.tsx`.
- Work:
  - Regenerate frontend OpenAPI types after the gateway route is added, then add a typed API helper for the presence POST route.
  - Generate a stable per-tab/per-PWA-window `clientId` in `sessionStorage`, with a runtime fallback when storage is unavailable.
  - Add a hook that reports presence only when a thread is selected and `document.visibilityState === "visible"`.
  - On visible selected-thread state, send an immediate heartbeat and repeat on a short interval.
  - On thread change, unmount, or `visibilitychange` to hidden, send a best-effort `visible: false` for the previous thread.
  - Use `navigator.sendBeacon` with a JSON `Blob` for `pagehide`/cleanup when available, with fetch fallback for normal transitions.
  - Wire the hook from `App.tsx` with `selectedMainPane === "thread"` and the current `selectedThreadId`; do not put the heartbeat logic directly in `App.tsx`.
- Exit criteria:
  - Focused frontend tests cover heartbeat while visible, no heartbeat while hidden, clear-on-hidden, clear-on-thread-change, and storage fallback for `clientId`.
  - Tests use fake timers and mocked `document.visibilityState`/`visibilitychange` rather than relying on real browser background behavior.
  - `cd apps/web && npm test -- --run <focused tests>` passes.

### 4. Contract, Multi-Client, And Browser Validation

- Scope: generated API artifacts, frontend tests, gateway tests, and browser-observable validation.
- Work:
  - Regenerate `apps/web/src/api/generated/schema.ts` from a running gateway and update `apps/web/src/api/client.ts` type exports/helpers without hand-written duplicate DTOs.
  - Add or update tests that model two web clients: one visible on the target thread suppresses notification delivery, then hiding or TTL expiry allows delivery.
  - Confirm the feature does not change read receipts. A visible heartbeat suppresses push delivery; `markThreadSeen` remains the read-state API.
  - Use `$agent-browser` validation on the local web app to confirm that selecting a thread starts presence, changing threads clears the old presence, and simulated hidden state stops foreground reporting without visible UI regressions.
- Exit criteria:
  - `cargo test` or a focused gateway subset that includes notification and presence tests passes.
  - `cd apps/web && npm test` or the closest focused frontend test subset passes.
  - `cd apps/web && npm run build` passes after generated API updates.
  - Browser validation records the selected-thread and hidden-state behavior.

## Verification

- Backend:
  - `cargo fmt`
  - Focused gateway tests for `thread_presence` and unread-agent-message notification suppression.
  - Broader `cargo test` before marking the plan complete.
- Frontend:
  - Regenerate OpenAPI types with the gateway running, then `cd apps/web && npm run generate:api`.
  - Focused Vitest coverage for the presence hook and any API helper.
  - `cd apps/web && npm run build`.
- Browser:
  - Start the gateway and Vite dev server.
  - Use `$agent-browser` to select a thread, observe presence requests, switch threads, and simulate or trigger visibility changes.
  - Validate no new visible UI is introduced unless explicitly added later.

## Risks And Open Questions

- Presence TTL creates an intentional grace window. If a PWA is backgrounded and JavaScript is frozen before cleanup, notifications can be suppressed until TTL expiry. Keep the TTL short enough that this is acceptable.
- Gateway restart drops all presence, so notifications may send immediately after restart even if a browser is still open. This is acceptable for ephemeral local/VPN-only gateway state.
- `sendBeacon` may not include normal fetch headers and can fail silently. The gateway route should accept a plain JSON body without requiring custom headers, and the client should rely on TTL for cleanup authority.
- This plan intentionally does not add native iOS reporting. If APNS delivery becomes active, add SwiftUI `scenePhase`-based reporting to the same gateway endpoint in a separate plan or milestone.
- Suppression is for push notifications only. Read/unread state remains gateway-owned through `thread.read_updated` and `/v1/threads/{threadId}/seen`.
