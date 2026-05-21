# Paged Selected Thread Timeline Plan

## Status

Complete.

## Context

Kodex already uses Codex app-server `0.130.0` schemas and selected-thread snapshots already come from native `thread/turns/list` with `itemsView:"full"`. The current implementation still drains every turn page inside `GET /v1/threads/{threadId}` before the browser can render the selected thread.

The goal is to make selected-thread loading truly windowed:

- Open a thread with a recent full-history window, not the entire durable transcript.
- Load older completed history on demand when the user scrolls upward.
- Keep gateway-owned live projection as the only render source for active turns.
- Keep app-server as the durable completed-history owner.

Relevant upstream findings:

- The current Codex TUI uses app-server `thread/resume` and live notifications as its active-thread bootstrap path. It does not appear to use `thread/turns/list` pagination as a normal interactive scrollback mechanism.
- The useful TUI-aligned pattern for Kodex is therefore not "copy TUI pagination"; it is "resume/live owns the head, durable history is bootstrap or scrollback."
- The app-server README documents `excludeTurns: true` for resume/fork when a client plans to page turns separately, and documents `thread/turns/list` with `itemsView`, `nextCursor`, and `backwardsCursor`.
- `thread/turns/items/list` exists in the `0.130.0` schema but upstream docs still treat it as unsupported/reserved for current clients.

Relevant Kodex seams:

- `apps/gateway/src/schema.rs` points at `apps/gateway/app-server-schema/0.130.0/json`.
- `apps/gateway/src/app_server_api.rs::thread_read_full_history` currently calls `thread/read includeTurns:false`, then drains `thread_turns_list_full`.
- `apps/gateway/src/app_server_api.rs::thread_turns_list_page` already exposes `sortDirection`, `itemsView`, `cursor`, and `limit`.
- `apps/gateway/src/routes/threads.rs::get_thread` returns `ThreadViewResponse` for `GET /v1/threads/{threadId}`.
- `apps/gateway/src/thread_view.rs::ThreadViewStore` is the gateway-owned in-memory canonical live projection and already merges snapshots with live deltas while preserving newer live text over stale snapshots.
- `apps/web/src/timeline/useSelectedThreadTimeline.ts` loads one selected snapshot, then subscribes to selected-thread SSE from the snapshot `viewRevision`.
- `apps/web/src/timeline/reducer.ts` applies canonical snapshots and `thread_view.patch` / `thread_view.item_delta`, and intentionally ignores raw app-server lifecycle events as render inputs.
- `apps/web/src/timeline/TimelineView.tsx` uses React Virtuoso and already has bottom-pinned behavior, but it does not yet trigger history loading from top-of-list range events.

## Current State

- Selected-thread correctness is good but opening long threads is all-or-nothing because the gateway drains every app-server turn page before responding.
- The frontend timeline state assumes one canonical snapshot replaces the whole loaded timeline. `applyTimelineSnapshot` creates a fresh state, so page merges need an explicit reducer path instead of reusing that function blindly.
- Timeline row ordering is currently driven by `TimelineItem.displayOrder`. Page-local display orders from independently fetched pages would collide unless the gateway returns a coherent loaded window or the frontend owns rebasing.
- Gateway read state uses `last_completed_agent_turn_seq`, currently derived by counting completed turns from the full turn list. Partial history must not silently undercount unread work.
- Live SSE is already separated from durable history: selected clients render `thread_view.patch` and `thread_view.item_delta`, not raw `timeline.item_delta`.

## Non-Goals

- Do not reintroduce persisted gateway timeline replay as canonical transcript history.
- Do not make the browser render raw app-server item/turn lifecycle events.
- Do not implement `thread/turns/items/list` until upstream documents it as supported.
- Do not add a durable gateway transcript cache. A small in-memory selected-thread window in `ThreadViewStore` is acceptable because the gateway already owns live projection there.
- Do not change the localhost/trusted-VPN deployment assumption.

## Proposed Architecture

Use a gateway-owned selected-thread history window.

Initial selected-thread load should fetch:

- `thread/read includeTurns:false` for metadata.
- One recent `thread/turns/list` page with `sortDirection:"desc"`, `itemsView:"full"`, and a conservative limit such as 50 turns.
- A lightweight completed-turn count path for read/unread state, using `itemsView:"notLoaded"` or `itemsView:"summary"` pages if app-server does not expose a count directly.

The gateway should normalize the recent page into ascending display order before returning it. Older scrollback requests should fetch the next older app-server page and merge it into the gateway's selected-thread window, then return a coherent canonical window with stable display order across all loaded turns.

This intentionally keeps the complicated merge at the gateway boundary, where `ThreadViewStore` already knows how to preserve active live items over stale snapshots. The browser remains thin: it applies a canonical window response and keeps consuming `thread_view.patch` / `thread_view.item_delta` for the live tail.

## Milestones

### 1. Add Paged History DTOs And Adapter Helpers

Scope: `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/api.rs`, schema generation outputs, and route tests in `apps/gateway/src/routes/mod.rs`.

Work:

- Add explicit gateway DTOs for selected-thread history windows, for example:
  - `ThreadTimelinePageQuery { cursor, limit, direction }`
  - `ThreadTimelineWindowPage { olderCursor, newerCursor, hasOlder, limit, loadedTurnCount }`
  - extend `ThreadViewResponse` with optional `historyPage` metadata.
- Keep `ThreadViewResponse.timeline` as the canonical loaded window so existing presentation data shape remains usable.
- Add an adapter helper that returns one `thread/turns/list` page without draining all pages.
- Add a helper that can compute completed-turn count without full item payloads. Prefer `itemsView:"notLoaded"` and `sortDirection:"asc"`/paged counting if app-server does not expose a metadata count.
- Keep `thread_read_full_history` for call sites that still need a full detail shape during migration, but stop treating it as the selected-thread default.

Exit criteria:

- Backend adapter tests prove recent-window requests send `itemsView:"full"`, a finite `limit`, and `sortDirection:"desc"`.
- Backend adapter tests prove completed-turn counting does not request full item payloads.
- OpenAPI includes the new page metadata/query DTOs and generated frontend types can consume them.

### 2. Teach ThreadViewStore About Loaded History Windows

Scope: `apps/gateway/src/thread_view.rs`, `apps/gateway/src/app_server_api.rs`, and focused `thread_view` tests.

Work:

- Add in-memory window metadata to `ThreadView`, including older/newer cursors and whether the start of durable history is loaded.
- Add a method such as `refresh_from_history_window(thread_id, turns, window, revision)` for initial windows.
- Add a method such as `prepend_history_page(thread_id, turns, window, revision)` that merges older completed turns ahead of the currently loaded window.
- Ensure display order is recomputed across the entire loaded window each time a history page is merged.
- Preserve existing live-over-snapshot rules:
  - active turn live text must not be truncated by a stale persisted page;
  - duplicate materialized user/assistant text should collapse;
  - terminal turn snapshots may replace live rows after completion reconciliation.
- Do not broadcast older-page loads as global SSE events by default. Loading old history in one browser tab should not force another tab to jump or expand its timeline.

Exit criteria:

- Unit tests prove an older page prepends before the recent window with stable row order.
- Unit tests prove a live active turn survives older-page and head-page refreshes.
- Unit tests prove a terminal persisted snapshot can replace a completed live projection without duplicate rows.
- Unit tests prove two tabs can keep different visible scroll windows even though they share the same gateway process; a full snapshot refresh may include the larger in-memory window, but no unsolicited scrollback patch is broadcast.

### 3. Change Selected Thread Endpoints To Windowed Loading

Scope: `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/routes/mod.rs`, `apps/gateway/src/turn_lifecycle.rs`, `apps/gateway/src/queue.rs`, and README route notes after implementation.

Work:

- Change `GET /v1/threads/{threadId}` to return metadata plus the recent canonical window instead of draining all full-history pages.
- Add `GET /v1/threads/{threadId}/timeline/pages` or `GET /v1/threads/{threadId}/turns` for older history loading. Prefer a route name that makes clear this is the gateway canonical timeline window, not raw app-server turns.
- Route older-page requests through `ThreadViewStore` so returned `ThreadViewResponse.timeline` has coherent display order across loaded pages and live overlay state.
- On `thread_view.refresh_required`, SSE reconnect, or `turn/completed`, keep the existing full refresh behavior conceptually but only refresh the recent head window plus completed-turn count.
- Update `turn_lifecycle.rs` and `queue.rs` call sites carefully. Runtime active-turn checks may continue to use eager `thread_read` or switch to a cheaper head-window helper only when tests prove active-turn detection remains correct.

Exit criteria:

- Route tests prove `GET /v1/threads/{threadId}` sends exactly one full-item turn page by default, not an unbounded drain.
- Route tests prove older-page endpoint uses the prior `olderCursor`, prepends returned turns, and preserves live active rows.
- Route tests prove read/unread state stays correct for a thread with completed turns outside the initially loaded window.
- Existing queue and active-turn lifecycle tests still pass.

### 4. Add Frontend History Paging Without Raw Event Rendering

Scope: `apps/web/src/api/client.ts`, `apps/web/src/timeline/useSelectedThreadTimeline.ts`, `apps/web/src/timeline/reducer.ts`, `apps/web/src/timeline/state.ts`, `apps/web/src/timeline/TimelineView.tsx`, and focused timeline tests.

Work:

- Add a generated-type-backed API wrapper for the new older-history endpoint.
- Extend `TimelineState` with loaded-history metadata, such as `olderCursor`, `hasOlderHistory`, and `isLoadingOlderHistory`.
- Add a reducer path for applying a canonical history-window response. This can replace the current loaded window if the gateway returns the complete loaded window, but it must preserve `lastSeq` and `viewRevision` guards so stale page responses cannot clobber newer live events.
- Wire Virtuoso top-range detection to call the older-history endpoint when the user scrolls near the top and `hasOlderHistory` is true.
- Preserve bottom-pinned live behavior:
  - loading older history must not auto-scroll the user to the bottom;
  - live deltas should continue to follow output only when already near bottom;
  - a stream reconnect should refresh the recent head without deleting loaded older pages unless the gateway marks the window invalid.
- Keep the guardrail in `apps/web/src/timeline/threadViewGuard.test.ts`: raw `timeline.item_delta` and app-server lifecycle events remain non-render inputs.

Exit criteria:

- Frontend reducer tests prove stale older-page responses do not overwrite newer `thread_view.patch` or `thread_view.item_delta` state.
- Frontend tests prove loading older history prepends rows and preserves current scroll position.
- Frontend tests prove live streaming at the tail continues while an older-page request is in flight.
- Existing timeline rendering, batching, lifecycle, and thread-view guard tests still pass.

### 5. Completion Reconciliation And Gap Recovery

Scope: gateway event handling in `apps/gateway/src/events.rs`, selected timeline hook behavior, and SSE tests in `apps/gateway/src/routes/mod.rs` / `apps/web/src/events`.

Work:

- On `turn/completed`, refresh the recent head window with `itemsView:"full"` and merge it through `ThreadViewStore`. This is the bridge from live in-flight projection to app-server durable history.
- On SSE reconnect or selected-thread lag, keep emitting/handling `thread_view.refresh_required`, but make the refetch bounded to the recent head plus already loaded older window metadata.
- Use `backwardsCursor` where useful to catch updates around the newest loaded durable page after a reconnect. Treat cursor semantics as app-server-owned; do not infer ordering from raw SSE event order.
- If app-server returns a page that no longer lines up with stored window cursors, mark the window invalid and fall back to a fresh recent-window snapshot rather than merging contradictory pages.

Exit criteria:

- Backend SSE tests prove reconnect gaps trigger refresh-required and do not replay raw timeline history.
- Frontend tests prove a live streamed answer becomes a canonical completed answer after a bounded refresh.
- Frontend tests prove an in-flight older-page response cannot delete the active turn after a stream reconnect.
- Two-tab test shape: one tab scrolls older while another receives live completion; both converge through gateway state/SSE without requiring browser-local command routing.

### 6. Verification, Profiling, And Rollout

Scope: generated API artifacts, automated tests, browser validation, and documentation updates.

Work:

- Regenerate OpenAPI and frontend TypeScript types after public DTO/route changes.
- Update `README.md` route notes once behavior changes from full selected snapshots to recent-window snapshots plus on-demand history.
- Update `plans/index.md` when implementation starts or completes.
- Use `$agent-browser` to validate a long thread:
  - direct `/threads/{threadId}` hard load renders recent history quickly;
  - scrolling upward loads older rows without visible jump;
  - live streaming still appends at the bottom;
  - reconnect or refresh-required does not delete loaded older rows or duplicate live rows.

Exit criteria:

- `cargo fmt`
- Focused gateway tests for app-server adapter, thread routes, thread view window merge, SSE refresh, queue/runtime active-turn detection.
- `cd apps/web && npm test -- src/App.mvp.timeline.test.tsx src/timeline/reducer.snapshot.test.ts src/timeline/reducer.lifecycle.test.ts src/timeline/batch.test.ts src/timeline/TimelineView.test.ts`
- `cd apps/web && npm run build`
- `$agent-browser` validation on desktop fine pointer and narrow viewport shapes.
- Independent review pass finds no major issues, especially around two-tab convergence and live/history race handling.

## Risks And Open Questions

- Initial window size is a tuning parameter. The recommended starting point is 50 turns with `itemsView:"full"`, then adjust after profiling real long threads.
- Completed-turn unread counts are the easiest place to regress if the implementation only sees the recent window. Solve this before changing the default selected-thread endpoint.
- `TimelineItem.displayOrder` is currently global within a snapshot. Avoid page-local display-order collisions by making the gateway return a coherent loaded window after every history-page merge.
- Shared `ThreadViewStore` means one tab's older-history load can enlarge the gateway's in-memory selected-thread window. This is acceptable if it is not broadcast as an unsolicited scrollback patch and if stale snapshot guards still protect other tabs.
- App-server cursor semantics belong to app-server. If `backwardsCursor` or anchor inclusion behaves differently than expected on real threads, prefer a bounded fresh recent-window refresh over local inference.
