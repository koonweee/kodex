# Thread Rename Plan

## Status

Complete.

## Context

Add a main-thread rename action to the web client. The action should live in the open thread's three-dot menu and call the Codex app-server thread name API through the Kodex gateway.

Relevant app-server behavior is established:

- Official app-server docs list `thread/name/set` as setting or updating a thread's user-facing name for a loaded thread or persisted rollout, and emitting `thread/name/updated`.
- Checked-in app-server schema at `apps/gateway/app-server-schema/0.128.0/json/v2/ThreadSetNameParams.json` requires `{ "threadId": string, "name": string }`.
- Checked-in app-server schema at `apps/gateway/app-server-schema/0.128.0/json/v2/ThreadNameUpdatedNotification.json` emits `{ "threadId": string, "threadName": string | null }`.
- Upstream Codex TUI exposes this as `/rename`, trims leading/trailing whitespace, rejects empty names, calls `thread_set_name`, and updates local state from `ThreadNameUpdated`.

Settled product decisions:

- Scope is the main selected thread only.
- Do not add a composer `/rename` command in this plan.
- Reject empty or whitespace-only names.
- Enforce trim/reject validation in both frontend and gateway.
- Keep the rename modal open with inline errors on failure.
- After a successful request, update the current tab from the canonical gateway response while still processing SSE for cross-tab convergence.
- Accept app-server canonical `updatedAt` behavior and existing sidebar sorting.
- When no custom `thread.name` exists, leave the input empty and show the current display title as placeholder context.

## Current State

- `apps/gateway/src/app_server_api.rs` wraps app-server thread operations such as `thread/list`, `thread/read`, `thread/start`, `thread/resume`, `thread/fork`, and `thread/archive`, but does not yet expose `thread/name/set`.
- `apps/gateway/src/routes/threads.rs` owns thread routes under `/v1/threads`, including archive, pin/unpin, resume, fork, list, and selected-thread detail. It applies local gateway overlays through `apply_thread_*_state`.
- `apps/gateway/src/api.rs` is the generated OpenAPI source of truth and must include any new route DTOs and path registration.
- `apps/gateway/src/events.rs` currently treats thread name updates as live thread metadata only for older-looking method spellings: `thread/nameupdated` and `thread/name_updated`. The current schema/docs spelling is `thread/name/updated`.
- `apps/web/src/events/stream.ts` already subscribes to generic `codex.notification` events.
- `apps/web/src/threads/events.ts` and `apps/web/src/threads/useThreadMetadata.ts` already patch thread names from name-update notifications, but need to accept `thread/name/updated`.
- `apps/web/src/api/client.ts` wraps generated OpenAPI endpoints and needs a typed rename helper after OpenAPI regeneration.
- `apps/web/src/threads/ThreadPanel.tsx` owns the main selected-thread header and three-dot menu. This is the intended UI surface.
- `apps/web/src/threads/SubagentThreadViewer.tsx` is observer-oriented and should not gain rename controls in this plan.
- `apps/web/src/threads/cache.ts` already has `updateThreadEverywhere`, pinned cache helpers, and snapshot merge protection that can be reused for the canonical rename response.
- Existing tests in `apps/web/src/App.mvp.shell.test.tsx`, `apps/web/src/threads/events.test.ts`, and `apps/web/src/events/stream.test.ts` cover thread metadata/name update flows and are the closest frontend test seams.

## Milestones

### 1. Gateway Rename API

Scope: `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/api.rs`, focused backend tests.

Work:

- Add `CodexClient::thread_set_name(thread_id, name)` that calls app-server method `thread/name/set` with `{ threadId, name }`.
- Add gateway DTOs:
  - `RenameThreadRequest { name: String }`
  - `RenameThreadResponse { thread: ThreadSummary }`
- Add `PATCH /v1/threads/{thread_id}/name`.
- Trim `request.name` in the route and return `400` for empty or whitespace-only values before calling app-server.
- Call `thread/name/set` with the trimmed name, then call `thread/read` summary and apply `apply_thread_summary_state` so the response includes gateway-owned pin/read/composer overlays.
- Return the canonical `ThreadSummary` in `RenameThreadResponse`.
- Add the route and DTOs to `apps/gateway/src/api.rs` so `/openapi.json` includes the public contract.

Exit criteria:

- Backend route test proves whitespace-only names return `400` and do not call app-server.
- Backend route test proves a valid rename sends `thread/name/set` with the trimmed name and returns the read-back `ThreadSummary`.
- `cargo fmt` passes.
- Focused gateway tests for the thread route pass.

### 2. App-Server Name Update Event Compatibility

Scope: `apps/gateway/src/events.rs`, `apps/gateway/src/routes/mod.rs` SSE tests, `apps/web/src/threads/events.ts`, `apps/web/src/threads/events.test.ts`, `apps/web/src/events/stream.test.ts`.

Work:

- Update gateway live-event filtering so `thread/name/updated` is treated as normal thread metadata for selected-thread SSE.
- Update frontend `threadNameUpdateFromEvent` to accept all known app-server method spellings:
  - `thread/name/updated`
  - `thread/nameupdated`
  - `thread/name_updated`
- Preserve existing handling of `threadName` and `thread_name` payload keys.
- Ensure name-update events with `threadName: null` do not accidentally replace a thread display name with an empty string. This plan does not add a clear-name UI.

Exit criteria:

- Gateway SSE test proves a live `thread/name/updated` notification reaches a selected-thread stream.
- Frontend event tests prove `thread/name/updated` parses to `{ threadId, name }`.
- Existing `thread/nameUpdated` tests either remain passing or are updated to cover compatibility intentionally.

### 3. Frontend API And Cache Integration

Scope: generated OpenAPI artifacts, `apps/web/src/api/client.ts`, `apps/web/src/App.tsx`, `apps/web/src/threads/cache.ts` if needed, focused shell tests.

Work:

- Regenerate frontend OpenAPI types from a running gateway after the backend route is added.
- Add `renameThread(threadId, name): Promise<ThreadSummary>` to `apps/web/src/api/client.ts`.
- Add a React Query mutation in `App.tsx` for thread rename.
- On successful response, patch the renamed thread everywhere through existing cache helpers and update `routeSelectedThread` when it is the selected thread.
- Keep SSE `thread/name/updated` handling as the convergence path for other tabs and late events.
- Add a lightweight two-tab-shaped test: one simulated client performs or observes a rename, another receives `thread/name/updated`, and the sidebar/header converge without reload.

Exit criteria:

- Generated `apps/web/src/api/generated/schema.ts` includes the new route and DTOs.
- Frontend tests prove a canonical rename response updates the selected header and sidebar.
- Frontend tests prove a `thread/name/updated` event updates cached thread summaries without reload.
- The two-tab-shaped test covers same-user convergence required by `AGENTS.md`.

### 4. Main Thread Rename Modal

Scope: `apps/web/src/threads/ThreadPanel.tsx`, nearby component tests or app shell tests, `apps/web/src/styles` only if layout needs it.

Work:

- Add a "Rename thread" item to the existing main selected-thread three-dot menu.
- Open a Mantine modal with a `TextInput` for the thread name.
- Seed the input from `selectedThread.name` only when it exists.
- Show the current display title as placeholder when `selectedThread.name` is absent.
- Validate on submit by trimming and rejecting empty values inline.
- Keep the modal open and preserve typed input on gateway/app-server failures.
- Disable submit while the rename mutation is pending.
- Close the modal after the canonical response has patched the current tab.
- Do not expose rename controls in `SubagentThreadViewer`.

Exit criteria:

- Component/app shell test proves the menu item opens the modal for the main selected thread.
- Test proves an existing custom name is prefilled.
- Test proves a generated/preview title is placeholder-only, not input value.
- Test proves whitespace-only submit shows an inline error and does not call the API.
- Test proves gateway failure leaves the modal open with typed input preserved.
- Test proves successful rename closes the modal and updates visible thread title.

### 5. Verification And Browser Validation

Scope: focused backend/frontend commands and `$agent-browser` UI validation.

Work:

- Run backend focused tests for thread rename route and SSE name update compatibility.
- Run frontend focused tests for API/cache/event/modal behavior.
- Run frontend build after generated OpenAPI updates.
- Use `$agent-browser` against the local Vite app to inspect the open-thread three-dot rename flow on desktop and mobile widths.

Exit criteria:

- `cargo fmt` passes.
- Focused `cargo test` targets for thread route/events pass.
- `cd apps/web && npm test -- App.mvp.shell.test.tsx threads/events.test.ts events/stream.test.ts` passes, adjusted to exact test files touched during implementation.
- `cd apps/web && npm run build` passes.
- `$agent-browser` confirms:
  - Rename appears only in the main selected-thread three-dot menu.
  - The modal input and buttons fit on mobile width.
  - Empty/whitespace validation is inline.
  - Successful rename updates the header/sidebar without reload.

## Verification

- Inspect app-server request/notification schemas before implementation:
  - `apps/gateway/app-server-schema/0.128.0/json/v2/ThreadSetNameParams.json`
  - `apps/gateway/app-server-schema/0.128.0/json/v2/ThreadNameUpdatedNotification.json`
- Verify the public gateway contract through `/openapi.json` after adding the route.
- Regenerate frontend OpenAPI types only after the gateway route exists and the gateway is running.
- Keep local/VPN-only gateway assumptions unchanged; this feature does not add auth or public exposure.

## Risks And Open Questions

- App-server may emit only `thread/name/updated` and no full thread payload. The frontend must update from both the canonical rename response and the lightweight notification.
- App-server may update `updatedAt` on rename. This plan accepts canonical ordering instead of preserving old sidebar position.
- App-server notification can carry `threadName: null`, but this plan has no clear-name UI. Event handling should avoid turning that into an empty custom title.
- If implementation discovers app-server rejects rename for some thread states, keep the modal open and surface the error inline; do not add speculative state-specific UI until the behavior is observed.
