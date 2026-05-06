# Pinned Threads Plan

## Status

Proposed

## Goal

Add gateway-owned pinned threads that can be toggled from the sidebar and rendered in a dedicated Pinned section above Projects. Pin state must be durable across reloads, shared across browser tabs connected to the same gateway, and independent of Codex app-server thread metadata because app-server 0.128.0 does not expose native thread pinning.

## Source Of Truth

- Gateway SQLite owns durable pin state.
- App-server remains the source for thread existence, title, cwd, status, archive state, and turn history.
- The local Codex desktop `.codex/.codex-global-state.json` `pinned-thread-ids` array may be useful as an import/reference hint, but Kodex must not rely on it as authoritative state.
- Checked-in app-server schemas expose no `thread/pin`, `thread/unpin`, pinned field, or pinned filter. `thread/metadata/update` currently supports stored Git metadata only.

## File Seams

Backend:

- `apps/gateway/src/store.rs`
  - Add `thread_pins` in `Store::migrate`.
  - Add store helpers next to existing gateway-owned thread state helpers for `thread_reads`, `thread_composer_settings`, and `queued_turn_inputs`.
  - Add focused store tests near the existing store migration/state tests.
- `apps/gateway/src/app_server_api.rs`
  - Add `pinned_at: Option<String>` to `ThreadSummary`.
  - Keep `ThreadSummary::from_payload` app-server-only and default `pinned_at` to `None`; gateway overlays should populate it.
  - Add normalization tests near `thread_list_normalization_*`.
- `apps/gateway/src/routes/threads.rs`
  - Add `POST /v1/threads/{thread_id}/pin`, `DELETE /v1/threads/{thread_id}/pin`, and `GET /v1/threads/pinned` in `router`.
  - Extend `apply_thread_summary_state` by adding an `apply_thread_pin_state` step alongside `apply_thread_composer_settings` and `apply_thread_read_state`.
  - Ensure `list_threads`, `list_chat_threads`, `get_thread`, `resume_thread`, `fork_thread`, and create responses all pass through that overlay path.
  - Decide archive handling in `archive_thread`.
- `apps/gateway/src/events.rs`
  - Add a gateway live event kind for pin updates, and include it in the normal live-event filter beside `timeline.thread_metadata` and `timeline.thread_status`.
  - Add tests near existing live broadcast and metadata event tests.
- `apps/gateway/src/api.rs`
  - Register new routes and schemas with OpenAPI, matching the existing route registration style.

Frontend:

- `apps/web/src/api/client.ts`
  - Add `listPinnedThreads`, `pinThread`, and `unpinThread` wrappers after the existing thread route helpers.
- `apps/web/src/api/generated/schema.ts`
  - Regenerate from gateway OpenAPI after backend DTO/route changes.
- `apps/web/src/App.tsx` and nearby shell hooks/modules
  - Add `pinnedThreads` state beside `chatThreads` and `threadsByProjectId`.
  - Load pinned threads on startup/reconnect and handle the pin update SSE event.
  - Filter pinned threads out of normal project/chat lists before passing props to the sidebar.
- `apps/web/src/threads/helpers.ts`
  - Add a pinned-aware sidebar comparator or optional tie-breaker instead of embedding ordering logic in the component.
  - Ensure helper updates preserve `pinnedAt`.
- `apps/web/src/threads/WorkspaceSidebar.tsx`
  - Add Pinned section rendering above Projects.
  - Extend `ThreadList`, `ThreadListRow`, `ThreadListRowProps`, and `areThreadListRowPropsEqual` with pin state and callbacks.
  - Reuse the existing right-side action slot for archive/progress/unread and add the new left-side overlay action.
- `apps/web/src/styles/sidebar.css`
  - Add left overlay pin action styles, pinned-row affordance styles, and mobile-specific no-hover behavior.
- Tests:
  - `apps/web/src/threads/WorkspaceSidebar.test.ts`
  - `apps/web/src/threads/WorkspaceSidebar.reorder.test.tsx`
  - `apps/web/src/threads/helpers.test.ts`
  - App-level tests in the closest `App.mvp.*.test.tsx` file for API/SSE movement between pinned and normal sections.

## Acceptance Criteria

- Gateway stores pinned thread ids in SQLite and exposes pin state through generated OpenAPI DTOs.
- `GET /v1/threads`, `GET /v1/chats/threads`, `GET /v1/threads/{threadId}`, create, resume, and fork responses consistently include `pinnedAt: string | null` on `ThreadSummary`.
- New gateway commands can pin and unpin a thread without app-server support.
- Pin and unpin updates are visible in another browser tab through gateway-owned state after refresh, SSE update, or list reconciliation.
- The sidebar renders a Pinned section above Projects when at least one thread is pinned.
- Pinning moves a thread out of its normal Projects or Chats list and into Pinned, avoiding duplicate sidebar rows.
- Unpinning returns the thread to its normal Projects or Chats list according to existing grouping rules.
- Pinned threads keep existing attention ordering behavior for active, approval-needed, unread, and title-pending states, then sort by `pinnedAt` or recency as defined below.
- Desktop thread rows show a pin icon on the left side of the thread title on hover/focus. The icon overlays the title text instead of reserving permanent horizontal space for unpinned rows.
- Pinned rows show a visible pinned icon affordance and allow unpinning from the same location.
- Mobile has a touch-accessible pin/unpin control without relying on hover, and the Pinned section is reachable in the narrow sidebar.
- Focused backend and frontend tests pass, OpenAPI/frontend types are regenerated, and an independent review pass finds no major issues.

## Non-Goals

- No app-server protocol changes.
- No use of browser local storage for pin ownership.
- No per-device pinned ordering in the frontend.
- No drag-and-drop reordering of pinned threads in the first implementation.
- No synchronization with Codex desktop's private `.codex-global-state.json` store beyond optional future import tooling.
- No changes to archive semantics except hiding archived threads from active pinned lists unless a future archived view requires them.

## Data Model

Add a gateway table:

```sql
create table if not exists thread_pins (
    thread_id text primary key,
    pinned_at text not null,
    updated_at text not null
);
```

Indexes:

- `thread_pins_pinned_at_idx` on `pinned_at desc, thread_id`

Notes:

- `thread_id` intentionally does not reference an app-server table because app-server thread storage lives outside the gateway database.
- `pinned_at` is the display-order timestamp and initial ordering key.
- `updated_at` supports future sync/debug/audit use.
- Pinning an already-pinned thread is idempotent and should keep the existing `pinned_at` unless the product later adds "move to top" behavior.

## Gateway API

Public DTO changes:

- Add `pinnedAt: string | null` to `ThreadSummary`.
- Add `PinnedThreadListResponse` only if a separate pinned endpoint is needed; otherwise reuse `ThreadListResponse`.

Routes:

- `POST /v1/threads/{threadId}/pin`
  - Inserts the pin if missing.
  - Returns `{ threadId, pinnedAt }` or a refreshed `ThreadSummary` if implementation can cheaply resolve it.
  - Emits/broadcasts a pin state event for open clients.

- `DELETE /v1/threads/{threadId}/pin`
  - Removes the pin if present.
  - Returns `{ threadId, pinnedAt: null }`.
  - Emits/broadcasts a pin state event for open clients.

- Optional `GET /v1/threads/pinned`
  - Returns pinned thread summaries sorted for the Pinned section.
  - This is useful if the normal project/chat list endpoints remain scoped and do not naturally include every pinned thread.

Preferred first implementation:

- Add `GET /v1/threads/pinned` so the frontend can load pinned threads independently of currently expanded/loaded projects and chat filters.
- Continue annotating every normal thread response with `pinnedAt` so unpin/move behavior and detail views stay coherent.

## Gateway Behavior

- Extend `Store::migrate` with `thread_pins`.
- Add store helpers:
  - `pin_thread(thread_id, now)`.
  - `unpin_thread(thread_id, now)`.
  - `list_pinned_thread_ids()`.
  - `pinned_at_for_thread_ids(thread_ids)`.
- Extend the existing thread summary overlay step, near `apply_thread_summary_state`, to attach `pinnedAt`.
- For `GET /v1/threads/pinned`, page/read thread summaries from app-server by pinned id:
  - Prefer `thread/read` per pinned id if app-server lacks a bulk-by-id list API.
  - Drop pins whose app-server thread cannot be found only from the response, not from storage, unless a later cleanup job is explicitly added.
  - Hide archived pinned threads from the active Pinned section. If `thread/read` exposes archive state unreliably, use the same list/read behavior currently used for active threads.
- On archive, either:
  - Preserve pin state but hide archived threads from active pinned results, preferred because unarchive can restore the pin.
  - Or unpin on archive only if UX explicitly chooses archive as removal from all active navigation.
- On fork, do not copy pin state to the fork by default.
- On thread creation, default `pinnedAt` to null.
- On app-server metadata/name/status events, update matching pinned thread summaries through the same normal thread reconciliation path.

## SSE And Multi-Client Ownership

Add a gateway event, for example:

- `thread.pin_updated`
  - `{ threadId, pinnedAt }`

Frontend behavior:

- On `thread.pin_updated`, update all cached thread summary copies.
- If `pinnedAt` becomes non-null, ensure the thread appears in the pinned cache. If the full summary is missing, fetch the pinned list or thread detail.
- If `pinnedAt` becomes null, remove it from pinned cache and allow normal project/chat caches to display it again.

Two-tab requirement:

- Tab A pins or unpins.
- Tab B receives the event or refreshes list state and converges without reload.
- Tab B must not infer durable pin state from local hover/focus/UI state.

## Frontend Data Flow

API client:

- Regenerate `apps/web/src/api/generated/schema.ts`.
- Add `pinThread(threadId)`, `unpinThread(threadId)`, and `listPinnedThreads()` wrappers in `apps/web/src/api/client.ts`.

App state:

- Add a `pinnedThreads` cache in the shell near `chatThreads` and `threadsByProjectId`.
- Load pinned threads at startup and after reconnect/list reconciliation.
- Update `replaceThreadInList`, `replaceThreadInProjects`, and read-state/name/status helpers to preserve `pinnedAt`.
- When rendering normal project/chat lists, filter out threads with `pinnedAt != null`.
- When rendering the Pinned section, use pinned summaries from the dedicated cache and update them from live thread events when possible.

Ordering:

- Use the existing `sortThreadsForSidebar` priority ordering inside Pinned:
  - title-pending
  - active
  - approval-needed
  - unread
  - normal
- For ties, pinned threads sort by `pinnedAt desc`, then `updatedAt desc`, then title/id. This keeps newly pinned threads near the top while preserving attention-first behavior.
- If the implementation reuses `sortThreadsForSidebar`, add a pinned-aware comparator or optional tie-breaker rather than special-casing in the component.

## Sidebar UX

Placement:

- Render Pinned above Projects and below the mobile header/search controls.
- Hide the section when there are no pinned threads and no search result in pinned threads.
- Include Pinned in search: searching filters pinned rows and normal rows consistently.
- Section collapse state can start local-only like current Projects/Chats collapse state. Persisting collapse state can be a later preference.

Thread row action:

- Add a left-side pin/unpin action to `ThreadListRow`.
- Use lucide `Pin` or `PinOff` if available.
- For unpinned rows on desktop:
  - The pin icon appears on row hover and focus-within.
  - It is absolutely positioned at the left of the title area.
  - It overlays the title text; do not reserve permanent width in the default row layout.
  - Add a subtle text fade or temporary left padding only while hovered/focused if needed to keep the icon legible.
- For pinned rows:
  - The pin icon is visible by default to communicate why the row is in Pinned.
  - Clicking it unpins the thread.
- Keep the existing archive/progress/unread action slot on the right.
- Do not let the pin icon steal row selection when clicking the title; stop propagation only for the pin button.
- Tooltips:
  - "Pin thread" for unpinned rows.
  - "Unpin thread" for pinned rows.

Mobile:

- Do not rely on hover to reveal the pin control.
- In the narrow sidebar, show the pin/unpin icon persistently for rows or expose it through a compact row actions menu.
- Keep tap targets at least 32px high and avoid text/icon overlap that makes the title unreadable.
- The Pinned section should be visible in the default mobile Projects scope because it sits above Projects. If the scope is Chats, pinned rows should still remain available or the filter should become "Pinned / Projects / Chats" before implementation.
- Test at the existing `max-width: 900px` breakpoint and a 390px-wide viewport shape.

## Milestone 1: Gateway Contract And Storage

Status: Proposed

Failing tests first:

- Store test: pin, idempotent pin, unpin, and list pinned ids in timestamp order.
- Route/OpenAPI test: pin and unpin routes exist and return the expected DTO.
- Route test: listed thread summaries include `pinnedAt` when the gateway store has a pin.
- Route test: create/resume/read responses include `pinnedAt: null` unless pinned.

Implementation:

- Add `thread_pins` migration in `Store::migrate`.
- Add store helpers.
- Add pin/unpin routes in `routes/threads.rs`.
- Register routes and OpenAPI schemas in `api.rs`.
- Extend thread summary overlay to include pin state.

Exit conditions:

- Focused gateway tests pass.
- `cargo fmt` passes.
- OpenAPI includes the new field and routes.

## Milestone 2: Pinned Thread Listing And Events

Status: Proposed

Failing tests first:

- Route test: `GET /v1/threads/pinned` returns pinned summaries and excludes missing/archived threads from the active list.
- Event test: pin and unpin broadcast `thread.pin_updated`.
- Two-client route/SSE test shape: one client pins, the other observes the update and later list state converges.

Implementation:

- Add pinned list route.
- Add gateway event type and SSE emission.
- Reuse existing thread read/list normalization for pinned summaries.
- Decide final archive behavior and cover it.

Exit conditions:

- Pinned list is authoritative from gateway state.
- No frontend state is needed for durable correctness.

## Milestone 3: Frontend State And API Wiring

Status: Proposed

Failing tests first:

- API/client test or app test: startup loads pinned threads.
- App state test: pin event moves a thread from project/chat cache to pinned cache.
- App state test: unpin event removes from pinned cache and the normal grouping shows it again.
- App test: two simulated clients converge through mocked SSE/list refresh.

Implementation:

- Regenerate frontend OpenAPI types.
- Add API client wrappers.
- Add `pinnedThreads` state in `App`.
- Load pinned threads independently from project and chat thread lists.
- Filter pinned threads out of normal sidebar groups.
- Handle `thread.pin_updated` in the existing event stream path.

Exit conditions:

- Frontend state is a projection of gateway pin state.
- Reload/fresh render uses server data only.

## Milestone 4: Sidebar UI

Status: Proposed

Failing tests first:

- `WorkspaceSidebar` test: Pinned section renders above Projects.
- `WorkspaceSidebar` test: a pinned thread is not duplicated under its original project/chat group.
- `ThreadListRow` test: desktop hover/focus reveals the left pin icon for unpinned rows.
- `ThreadListRow` test: pinned rows show a visible unpin affordance.
- Mobile/sidebar test: pin/unpin control is reachable without hover at narrow width.

Implementation:

- Extend `WorkspaceSidebar` props with pinned threads and pin callbacks.
- Extend `ThreadList`/`ThreadListRow` with `pinnedAt`, pin action state, and action callbacks.
- Add CSS for left overlay pin action and pinned row affordance in `apps/web/src/styles/sidebar.css`.
- Keep row dimensions stable so hover actions do not shift layout.
- Update memo comparison in `areThreadListRowPropsEqual`.

Exit conditions:

- Sidebar remains keyboard accessible.
- Text does not overlap controls incoherently on desktop or mobile.
- Existing archive/progress/unread behavior still works.

## Milestone 5: Verification And Review

Status: Proposed

Verification:

- `cargo fmt`
- Focused `cargo test` for store/routes/events.
- `cd apps/web && npm test -- WorkspaceSidebar`
- Focused App/sidebar Vitest suites.
- `cd apps/web && npm run build`
- Agent-browser or browser-use smoke for desktop and mobile sidebar:
  - pin from a project thread
  - observe move to Pinned
  - unpin and observe return
  - repeat at narrow viewport

Review:

- Run an independent review pass.
- Check multi-client ownership: durable pin state must live only in gateway SQLite.
- Check OpenAPI/frontend generated types are current.
- Update [plans/index.md](index.md) as statuses change.
