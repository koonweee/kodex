# Gateway Canonical Timeline Projection Plan

## Status

Complete.

## Context

The web timeline currently has too much responsibility for reconciling selected-thread snapshots with selected-thread SSE. The immediate bug shape was: a long-running message streamed live, the user switched away and back, and the frontend displayed a stale or partial mix where post-9:02 user/assistant rows disappeared until a hard reload.

The desired direction is to make the React app a thin projection of gateway-owned thread state. The gateway should expose one canonical timeline shape for both resume/snapshot and live stream, and the frontend should stop deciding whether historical rows, live rows, optimistic rows, and stale snapshots should be merged.

This plan builds on, but does not revert, these completed plans:

- [App-server read-through thread sync](app-server-read-through-sync.md): app-server remains canonical for completed thread history.
- [Timeline replay removal](timeline-replay-removal.md): normal `/v1/events` must not become the frontend's persisted timeline-history replay source again.
- [Codex 0.130.0 bump and full turn history](app-server-full-turn-history.md): selected-thread snapshots use `thread/turns/list` with `itemsView:"full"`.
- [Timeline order, debug, and snapshot cleanup](timeline-order-debug-snapshot-cleanup.md): frontend display order is separate from event cursor order.

The upstream Codex TUI model is the architectural reference: resume/read returns thread session/turn data, then the UI consumes app-server events. It does not maintain a second browser-local historical/live merge authority.

## Current State

Backend code paths:

- `apps/gateway/src/routes/threads.rs::get_thread` reads full app-server thread history and returns `ThreadDetailResponse`.
- `apps/gateway/src/app_server_api.rs::ThreadDetailResponse` now includes `timeline: ThreadTimelineSnapshot`, currently flattened from app-server turns only with `revision: 0`.
- `apps/gateway/src/events.rs::ingest_inbound` stores raw app-server notifications, emits normalized `timeline.item_delta`, `timeline.item_upsert`, `timeline.turn_upsert`, `timeline.thread_status`, and `timeline.thread_metadata` events, and schedules selected-thread snapshot refreshes through `timeline.snapshot_required`.
- `apps/gateway/src/events.rs::event_stream` excludes persisted timeline history from normal replay but broadcasts live timeline events and synthetic snapshot-required events.
- `apps/gateway/src/store.rs::append_event` gives normal event rows a monotonic `seq`; frontend SSE reconnect uses that as a transport cursor.

Frontend code paths:

- `apps/web/src/timeline/useSelectedThreadTimeline.ts` connects the selected-thread SSE stream before/around `GET /v1/threads/{id}`, batches live events, and refetches snapshots on reconnect or `timeline.snapshot_required`.
- `apps/web/src/timeline/useReadonlyThreadTimeline.ts` powers read-only/subagent timeline views with its own snapshot-plus-selected-stream path. It already fetches the snapshot before connecting its stream, but still consumes the same granular live event kinds and reducer behavior.
- `apps/web/src/timeline/reducer.ts::applyTimelineSnapshot` now prefers `ThreadDetailResponse.timeline`, but still contains transitional reconciliation:
  - legacy `turns` to timeline path
  - synthetic snapshot `EventEnvelope` construction
  - `carryGatewayStreamItemsAcrossSnapshot`
  - fractional display-order carry (`displayOrder += 0.1`)
  - optimistic/app-server same-text reconciliation heuristics
- `apps/web/src/events/stream.ts` still subscribes to granular timeline delta/upsert/turn/status events.
- `apps/web/src/App.tsx` uses timeline event kinds outside the reducer for sidebar thread refresh, subagent discovery invalidation, live attach decisions, queue/approval routing, and metadata handling. Those call sites must move to projection patch semantics alongside the reducer.
- `apps/web/src/threads/events.ts` and `apps/web/src/threads/useThreadMetadata.ts` parse `timeline.turn_upsert`, `timeline.thread_status`, and `timeline.thread_metadata` for read/unread markers, runtime status, title, context usage, and git metadata. Projection patch work must either preserve these metadata events or replace these parser contracts deliberately.

Constraints from `AGENTS.md`:

- Shared thread/session state that must converge across tabs, reloads, reconnects, or future clients belongs in the gateway or upstream app-server, not React state.
- Snapshot and SSE reconciliation must have a gateway-owned source of truth. If snapshots can overwrite live state, they need a comparable sequence/runtime watermark, or the gateway must emit ordered canonical snapshot events.
- Frontend API types must come from generated OpenAPI.
- Behavior-changing shared lifecycle work needs same-user, two-tab test coverage.

## Target Architecture

- App-server remains canonical for persisted completed turns/items.
- Gateway owns a canonical timeline projection for browser clients:
  - base rows come from app-server full turn snapshots
  - in-flight rows come from gateway-observed live notifications and gateway-owned queued/pending user input state
  - projection rows carry stable app-server item ids when known, gateway ids only for pending rows
  - projection rows carry a monotonic projection revision based on the latest included gateway event/store update
- `GET /v1/threads/{threadId}` returns `ThreadDetailResponse.timeline` as the complete canonical projection known to the gateway at response time.
- Selected-thread SSE emits projection patches from the same gateway projector, not a separate frontend-oriented delta protocol.
- Frontend snapshot handling becomes:
  - replace visible timeline from `snapshot.timeline`
  - preserve only unsent browser-local draft/optimistic rows that have not become gateway-owned
  - ignore/drop live patches whose projection revision is already included by the snapshot
- Frontend live handling becomes:
  - upsert canonical projection rows by row id/item id
  - update active turn state from gateway projection metadata
  - request/refetch snapshot when stream continuity is uncertain
- Raw app-server notifications and raw persisted gateway events remain available for debug/diagnostic surfaces only.

## Non-Goals

- Do not make the gateway SQLite `events` table the canonical completed-history source again.
- Do not backfill completed app-server history from raw gateway event replay.
- Do not add WebSockets.
- Do not redesign timeline presentation, worked-section rendering, approvals UI, or composer chrome.
- Do not remove app-server full-history reads.
- Do not make localhost/VPN deployment assumptions more permissive.

## Milestones

### 1. Lock The Contract With Failing Tests

Scope: backend route/event tests and frontend reducer/app tests.

Work:

- Add backend tests in `apps/gateway/src/app_server_api.rs` and `apps/gateway/src/routes/threads.rs` proving `ThreadDetailResponse.timeline` includes app-server rows in stable display order and exposes a comparable projection revision.
- Add backend event-ingest tests in `apps/gateway/src/events.rs` for a selected active turn where live delta/upsert state is reflected by a later `GET /v1/threads/{threadId}` timeline response.
- Add frontend reducer tests in `apps/web/src/timeline/reducer.snapshot.test.ts` for the observed bug shape:
  - snapshot with old completed rows
  - live running turn receives user + assistant/progress rows
  - later completed canonical snapshot replaces stale live-only rows with app-server rows
  - no rows disappear after switching away and back
- Add an app-level two-tab/same-user test shape in `apps/web/src/App.mvp.timeline.test.tsx` or the closest selected-thread harness:
  - one client misses selected-thread SSE
  - snapshot refetch converges without relying on the other tab's React state

Exit criteria:

- New tests fail against the current transitional projection where the gateway snapshot lacks in-flight live rows.
- Test names describe gateway-owned projection behavior rather than frontend merge behavior.
- Existing focused tests still run once the failing assertions are isolated.

### 2. Add A Gateway Timeline Projector Module

Scope: new backend projection module plus store support.

Work:

- Add a module such as `apps/gateway/src/timeline_projection.rs` responsible for building canonical timeline snapshots and projection patches.
- Move `ThreadTimelineSnapshot::from_turns` flattening out of `app_server_api.rs` or delegate it to the projector so `app_server_api.rs` remains DTO/adapter focused.
- Define projection DTOs in Rust and OpenAPI:
  - `ThreadTimelineSnapshot { revision, items, activeTurnId, liveState }`
  - `ThreadTimelineSnapshotItem { id, threadId, turnId, itemId, itemType, displayOrder, status, timestampMs, payload }`
  - `TimelineProjectionPatch { revision, threadId, items, activeTurnId, liveState }` for selected-thread SSE updates
- Add a lightweight gateway-owned projection store for non-terminal state only, for example:
  - active turn id/status per thread
  - accumulated live item text/state per `thread_id + turn_id + item_id`
  - last included event `seq` as the projection revision
  - pending gateway-owned submitted user input rows if app-server has not yet produced item ids
- Treat that store as an overlay on top of app-server snapshots, not as durable completed-history authority.
- Prune or mark overlay rows reconciled when app-server full-history snapshot includes the corresponding completed turn/item ids.

Exit criteria:

- A backend unit test can build a projection from app-server turns plus live overlay rows without reading raw timeline event replay.
- A completed app-server snapshot wins over live overlay rows for the same item ids.
- Projection revision is monotonic for all included gateway-owned overlay changes.
- `cargo test -p kodex-gateway timeline_projection --lib` or the focused equivalent passes.

### 3. Route Thread Detail Through The Projector

Scope: `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/app_server_api.rs`, generated OpenAPI.

Work:

- Change `get_thread` and `apply_thread_detail_response_state` so `response.timeline` is built by the projector after:
  - app-server full turn history is loaded
  - gateway-owned thread/read/settings overlays are applied
  - skill mentions are enriched
- Ensure the projector overlays active gateway-observed live rows before returning `ThreadDetailResponse`.
- Set `timeline.revision` to the gateway projection high-water included by that response.
- Keep `turns` in `ThreadDetailResponse` for compatibility/debug initially, but document in code that frontend rendering should use `timeline`.
- Regenerate OpenAPI and `apps/web/src/api/generated/schema.ts`.

Exit criteria:

- `GET /v1/threads/{threadId}` includes active in-flight user/assistant rows known to the gateway, even if app-server full history has not yet materialized them.
- Completed app-server history is still not backfilled from raw gateway event history.
- Focused backend route tests pass.
- Frontend generated types include any changed projection fields.

### 4. Emit Live Projection Patches From The Same Gateway Projector

Scope: `apps/gateway/src/events.rs`, `apps/gateway/src/store.rs`, queue/pending-input integration, and frontend event-kind call sites where needed.

Work:

- Refactor `normalized_timeline_events` so inbound app-server notifications update the gateway projector first, then emit live patch events derived from the updated projection row/state.
- Prefer full projection-row upserts over frontend-only deltas:
  - gateway accumulates `item/*/delta` text into the active overlay row
  - SSE emits an upsert/patch containing the current complete row text/state
  - frontend no longer has to aggregate streaming text for correctness
- Keep raw `codex.notification` persisted for debug/audit, but make visible selected-thread timeline events come from projection patches.
- Update selected-thread lag/reconnect handling:
  - if continuity is uncertain, emit `timeline.snapshot_required` with the current transport cursor
  - frontend recovery remains snapshot refetch
  - snapshot revision decides which older patches are ignored after refetch
- Allow selected-thread projection patches with `seq > snapshot.timeline.revision` to replay on SSE connection for transport continuity only. This must not become completed-history reconstruction; a full snapshot remains the recovery path for any gap or uncertainty.
- Reconcile queue/pending steer state through projector-owned rows where the row should be visible across tabs before app-server emits the final user item.
- Update frontend event-kind routing in `apps/web/src/App.tsx`, `apps/web/src/events/stream.ts`, `apps/web/src/timeline/useSelectedThreadTimeline.ts`, `apps/web/src/timeline/useReadonlyThreadTimeline.ts`, `apps/web/src/threads/events.ts`, and `apps/web/src/threads/useThreadMetadata.ts` so projection patches replace the old visible timeline event set where appropriate while thread metadata/status contracts remain explicit.

Exit criteria:

- Live streaming still feels incremental because the gateway emits frequent full-row patches.
- A snapshot fetched after live streaming includes the same active rows and a revision high enough to suppress older patches.
- Existing approval, warning, thread metadata, queue, and automation event replay behavior remains operational.
- Backend tests cover live delta accumulation, item completion replacement, terminal-turn overlay pruning, and lag/snapshot-required recovery.

### 5. Thin The Frontend Timeline Reducer

Scope: `apps/web/src/timeline/reducer.ts`, `state.ts`, `batch.ts`, selected timeline hooks, tests.

Work:

- Make `applyTimelineSnapshot` a direct canonical replacement path:
  - build `TimelineItem[]` from `snapshot.timeline.items`
  - set active turn/live state from `snapshot.timeline`
  - set `lastSeq` or a new `lastRevision` from `snapshot.timeline.revision`
  - preserve only browser-local unsent rows that are intentionally not gateway-owned
- Remove transitional snapshot/live merge helpers once gateway projection covers them:
  - `carryGatewayStreamItemsAcrossSnapshot`
  - `timelineItemHasGatewayStreamUpdate`
  - `payloadSource`
  - fractional carry display-order logic
  - legacy `snapshot.turns` rendering path
  - synthetic snapshot `EventEnvelope` construction
- Replace live `timeline.item_delta` aggregation with projection-row upsert handling.
- Keep presentation normalization in frontend render helpers, but avoid app-server raw payload interpretation for merge decisions.
- Keep debug event handling isolated so raw notifications cannot affect visible timeline state.

Exit criteria:

- `apps/web/src/timeline/reducer.ts` has separate, small paths for:
  - canonical snapshot replacement
  - canonical projection patch upsert
  - debug event append
  - browser-local optimistic draft/pending rows
- No visible timeline correctness path depends on comparing text to decide whether a live row belongs to a snapshot row, except for a narrowly documented unsent-local fallback.
- Focused reducer tests pass:
  - `cd apps/web && npm test -- src/timeline/reducer.snapshot.test.ts`
  - `cd apps/web && npm test -- src/timeline/reducer.lifecycle.test.ts`
  - `cd apps/web && npm test -- src/timeline/batch.test.ts`

### 6. Simplify Selected Thread Resume And Stream Lifecycle

Scope: `apps/web/src/timeline/useSelectedThreadTimeline.ts`, `apps/web/src/timeline/useReadonlyThreadTimeline.ts`, `apps/web/src/events/stream.ts`, app-level timeline tests, and subagent timeline tests.

Work:

- Make selected-thread load order explicit:
  - begin loading snapshot
  - fetch `GET /v1/threads/{threadId}`
  - apply canonical snapshot
  - connect selected-thread SSE using `snapshot.timeline.revision` as the cursor/high-water
- Do not connect selected-thread SSE before the initial snapshot. Replay selected-thread projection patches after the snapshot revision for the narrow race between snapshot response and stream connection.
- Remove frontend behavior that uses stream reconnect status as a merge signal. Reconnect should only request/refetch canonical snapshot.
- Keep `timeline.snapshot_required` as a refetch signal, not as a reducer event.
- Ensure thread switching cancels buffered patches by thread token and cannot apply old-thread patches to the new selected thread.
- Apply the same cursor/revision and snapshot-required rules to read-only subagent timelines so the sidebar observer path does not retain the older granular merge behavior.

Exit criteria:

- The selected-thread hook can be described as "snapshot, then projection patches" without caveats about historical/live merge.
- Read-only/subagent timeline hooks follow the same projection contract and do not need their own reconciliation semantics.
- Rapid thread switching and reconnect tests pass.
- App-level tests in `apps/web/src/App.mvp.timeline.test.tsx` cover:
  - snapshot refresh after `timeline.snapshot_required`
  - active thread streaming while switching away/back
  - stale patch ignored after newer snapshot
- Subagent/read-only timeline coverage in `apps/web/src/App.subagents.test.tsx` or `apps/web/src/threads/SubagentThreadViewer.tsx` tests covers projection patch delivery without leaking approval/queue events into the observer timeline.

### 7. Contract Cleanup And API Type Generation

Scope: OpenAPI, generated frontend schema, API wrappers, docs.

Work:

- Regenerate `/openapi.json` after projection DTO changes.
- Run `cd apps/web && npm run generate:api` or the repo-equivalent command with a running gateway.
- Export any new generated projection types from `apps/web/src/api/client.ts`.
- Update route docs/comments where useful:
  - snapshots are canonical projection state
  - selected-thread SSE carries projection patches and operational events
  - raw event debug remains diagnostic/local-only
- Update this plan status and `plans/index.md` when implementation starts or completes.

Exit criteria:

- No handwritten frontend DTO duplicates.
- Generated schema changes are committed with backend DTO changes.
- `cargo fmt --check`, focused gateway tests, focused frontend tests, and `cd apps/web && npm run build` pass.

### 8. End-To-End And Browser Validation

Scope: same-user multi-client behavior and browser-observable timeline UX.

Work:

- Use `$agent-browser` against the local app to exercise:
  - create/select a thread
  - send a prompt that streams long enough to switch threads
  - switch away and back during streaming
  - verify user, assistant/progress, command/work rows, and final answer remain visible
- Run a two-tab shape:
  - Tab A sends or observes an active turn
  - Tab B opens the same thread after missing earlier patches
  - both converge through gateway snapshot/SSE without reload
- Validate reconnect:
  - force selected-thread stream reconnect or synthetic `timeline.snapshot_required`
  - verify snapshot refresh does not duplicate or drop visible rows
- Validate completed history:
  - open an older idle thread with rich app-server history
  - verify no gateway event replay is needed for completed rows

Exit criteria:

- `$agent-browser` observations confirm the original switch-away/back missing-message bug is gone.
- Same-user two-tab behavior does not depend on one tab's React state.
- Browser console has no runtime errors from projection patches or snapshot refresh.
- Final verification commands pass:
  - `cargo fmt --check`
  - `cargo test -p kodex-gateway`
  - `cd apps/web && npm test`
  - `cd apps/web && npm run build`
  - `cd apps/web && npm run test:e2e` if the touched flows have e2e coverage available

## Migration And Rollout Notes

- Implement this as a hard internal refactor of local gateway/web behavior. No compatibility is required for old in-browser timeline state across reloads.
- Keep `turns` on `ThreadDetailResponse` during the first implementation to avoid coupling projection cleanup with all existing tests and debug consumers. Remove or demote it only in a later API cleanup if no caller needs it.
- Keep old live event kinds temporarily if needed to land backend and frontend milestones independently. Remove them only after frontend consumes projection patches and tests prove parity.
- Do not prune raw debug events from SQLite as part of this plan.
- If a gateway restart happens during an active turn, the projection should rebuild from app-server full history plus any currently available app-server state. If token-level transient deltas are lost across restart before app-server materializes them, snapshot refresh should converge once app-server history catches up; this is acceptable unless a later product decision requires crash-durable token streams.

## Risks And Open Questions

- The exact persistence shape for active overlay rows should be kept small. A new projection table is acceptable if it removes frontend merge logic, but it must not become a second completed-history store.
- App-server may not immediately materialize every active in-flight item in full history. The projector must overlay gateway-observed active rows until terminal app-server history replaces them.
- Moving delta aggregation into the gateway may change the frequency and size of selected-thread SSE events. The implementation should keep batching/backpressure behavior bounded and reuse existing selected-thread batching where practical.
- Optimistic user messages still have one browser-local phase before the gateway accepts the send. The desired endpoint is for gateway-created pending input rows to become visible through the projector quickly, reducing frontend optimistic reconciliation to unsent/draft-only cases.
- Approval rows and queue rows are operational state, not timeline history. They should remain domain-owned and should not be folded into conversation rendering unless a specific UI decision requires it.

## Verification Summary

Planning verification performed:

- Inspected `AGENTS.md` multi-client and API-generation constraints.
- Inspected gateway timeline/event paths in `apps/gateway/src/events.rs`, `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/app_server_api.rs`, and `apps/gateway/src/store.rs`.
- Inspected frontend selected-thread, read-only/subagent timeline, SSE, app-shell event routing, and reducer paths in `apps/web/src/timeline/useSelectedThreadTimeline.ts`, `apps/web/src/timeline/useReadonlyThreadTimeline.ts`, `apps/web/src/events/stream.ts`, `apps/web/src/App.tsx`, `apps/web/src/timeline/reducer.ts`, and `apps/web/src/timeline/state.ts`.
- Inspected prior timeline/app-server plans to avoid reintroducing gateway event replay as completed-history source.
