# Timeline Replay Removal Plan

## Scope

Remove persisted gateway event replay from canonical timeline loading and recovery. Thread history should load deterministically from Codex app-server snapshots, then use selected-thread live streaming only as a low-latency overlay. Gateway-owned persisted state remains allowed for approvals, server requests, warnings, debug/audit visibility, and read markers.

This plan is a follow-up to [App-server read-through thread sync](app-server-read-through-sync.md). It tightens the architecture after the hard cut to app-server-canonical thread history.

## Status

Proposed.

## Problem

The current implementation already loads selected thread history from `thread/read includeTurns:true`, but it still keeps legacy event replay in several timeline-adjacent paths:

- selected-thread initial load fetches persisted events after the snapshot for approvals, metadata, cursor alignment, and debug timeline rows
- global and selected SSE clients can still deliver raw app-server notifications and normalized timeline events from persisted SQLite events
- read/unread logic still has compatibility code for event-sequence-based completion markers
- tests and mocks still model initial timeline state as event replay in several places

This creates fragile mixed semantics. Snapshot data uses app-server turn/item identity and completed-turn counts, while replay data uses gateway event sequence numbers and only includes events observed by this gateway process.

## Target Architecture

- Clicking a thread performs one deterministic selected-thread snapshot load:
  - `GET /v1/threads/{threadId}` calls app-server `thread/read includeTurns:true`
  - frontend renders that snapshot as the canonical timeline
  - frontend marks the selected thread seen based on app-server completed-turn marker data
- Selected-thread SSE starts after the snapshot is applied:
  - live updates are transient timeline hints, not history replay
  - missed updates are recovered by fetching another snapshot
  - reconnect or stream uncertainty triggers snapshot refresh, not persisted timeline replay
- Persisted gateway event storage remains only for gateway-owned or diagnostic domains:
  - approvals and approval resolution
  - app-server server requests that require browser decisions
  - warnings/errors/debug audit records
  - optional raw app-server notification debug view
- Timeline reducers should not need to distinguish "legacy replay" from "app-server snapshot" as canonical data sources.

## Non-Goals

- Do not remove approval persistence.
- Do not remove `/v1/events` entirely if approvals/debug still need it.
- Do not expose raw debug replay through normal `/v1/events` query parameters.
- Do not add WebSockets.
- Do not build broad background indexing of all app-server history.
- Do not reintroduce a gateway-owned durable timeline cache.

## Backend Milestone 1: Split Timeline Streaming From Event Replay

Failing tests first:

- `GET /v1/events?threadId=<id>` no longer returns persisted timeline history events such as `codex.notification`, `timeline.item_upsert`, `timeline.item_delta`, `timeline.turn_upsert`, `timeline.thread_status`, or `timeline.thread_metadata` for canonical replay.
- Approval and warning events remain replayable through `/v1/events`.
- Existing approval flows still replay pending approval events after reload.
- SSE for a selected thread can still send live normalized timeline events while the gateway observes app-server notifications.

Implementation:

- Add event replay filtering so timeline kinds are excluded from HTTP replay by default.
- Move raw persisted event replay to a separate diagnostic endpoint, for example `GET /v1/debug/events` or `GET /v1/threads/{threadId}/debug/events`.
- Do not add an `includeDebug=true` escape hatch to `/v1/events`; the normal event route should remain narrow enough that canonical timeline code cannot accidentally depend on raw replay again.
- Keep persisted `approval.created`, `approval.resolved`, and `gateway.warning` replay behavior.
- Keep live broadcast behavior for selected-thread normalized timeline events.
- Update route tests to assert replay filtering and approval preservation.

Exit conditions:

- No canonical frontend timeline code depends on `/v1/events` returning timeline history.
- Approval replay still works after page reload.
- Debug/audit access to raw gateway events is available only through the explicit debug endpoint and is documented as diagnostic/local-only.
- `cargo test` passes.

## Backend Milestone 2: Snapshot Recovery Instead Of Timeline Replay

Failing tests first:

- Selected-thread SSE reconnect does not replay persisted timeline events to reconstruct items.
- When selected-thread SSE reconnects after missed live updates, gateway/frontend can recover by fetching `GET /v1/threads/{id}` again.
- Synthetic snapshot refresh events do not advance or depend on persisted event cursors.
- A thread externally advanced while the gateway was down converges after selection without any gateway event rows.

Implementation:

- Treat selected-thread stream cursor as transport-only for live events and approvals, not as a timeline-history source.
- On reconnect, stale cursor, lagged receiver, or selected-stream error, emit or trigger a snapshot refresh rather than replaying timeline rows.
- Keep selected-thread reconciliation bounded to selected/subscribed thread reads.
- Prefer explicit `timeline.snapshot_required` or client-side refetch signal over synthetic replay rows when the stream cannot guarantee continuity.

Exit conditions:

- Timeline correctness after reconnect is proven by snapshot refetch, not replay.
- Selected thread can recover missed external changes after gateway downtime.
- No duplicate final rows after reconnect and snapshot refresh.
- `cargo test` and relevant frontend tests pass.

## Frontend Milestone 1: Deterministic Thread Open Pipeline

Failing tests first:

- Opening a thread calls `getThreadDetail` and renders snapshot rows before consuming selected-thread live updates.
- Opening a thread does not call `listEvents` for timeline reconstruction.
- Existing threads with completed turns do not become unread simply because global event replay connects.
- Opening an idle existing thread never flips the composer from Send to Stop unless the snapshot has an active turn.

Implementation:

- Refactor `useSelectedThreadTimeline` into an explicit state machine:
  - `idle`
  - `loadingSnapshot`
  - `streamingLive`
  - `refreshingSnapshot`
  - `error`
- Remove timeline event replay from the selected-thread open path.
- Fetch approvals/debug data through domain-specific hooks instead of the timeline loader.
- Apply selected-thread live updates only after the snapshot load token matches the current selected thread.
- On stream reconnect or snapshot refresh, replace/upsert from snapshot and preserve unresolved optimistic messages.

Exit conditions:

- Thread open behavior is deterministic and independent of persisted timeline event rows.
- Rapid thread switching cannot apply stale replay events to the wrong thread.
- Composer active/idle state derives from snapshot/live turn status only.
- `cd apps/web && npm test` passes.

## Frontend Milestone 2: Read Markers Use App-Server Turn Markers Only

Failing tests first:

- A replayed raw `turn/completed` event with a high gateway sequence number cannot create unread state for a thread whose app-server completed marker is already seen.
- A selected thread is marked seen using the latest app-server completed-turn marker from thread list/detail data.
- A background thread becomes unread only when a normalized live turn completion advances a known app-server marker, not because of legacy event sequence replay.

Implementation:

- Remove fallback event-sequence read marker logic from app-server-backed threads.
- Prefer stable app-server completed-turn identity if available; otherwise keep the current completed-turn count as the explicit temporary marker.
- Make read-state functions accept marker source metadata so legacy events cannot be mixed with snapshot markers.
- Keep backend `thread_reads` gateway-owned, but key semantics to app-server completed-turn markers rather than event `seq`.

Exit conditions:

- Read/unread state is deterministic across reloads and gateway restarts.
- Existing completed old threads do not become unread on selection or stream connect.
- New live completions still mark unselected threads unread and selected threads seen.
- Backend and frontend read-state tests pass.

## Frontend Milestone 3: Simplify Timeline Event Reducer Contract

Failing tests first:

- Timeline reducer accepts only canonical snapshot loads and normalized live timeline updates.
- Raw `codex.notification` events are hidden/debug-only and cannot create visible timeline rows.
- `timeline.thread_metadata` and `timeline.thread_status` events do not affect timeline items unless explicitly handled as live-state metadata.

Implementation:

- Split reducer entry points:
  - `applyTimelineSnapshot`
  - `applyLiveTimelineUpdate`
  - `applyDebugEvent`
- Remove generic `applyTimelineEvent` use from canonical timeline paths.
- Keep presentation helpers for app-server `ThreadItem` shapes.
- Move approval and thread-title handling out of timeline reducer dependencies.

Exit conditions:

- Timeline reducer has one canonical item path for snapshot/upsert item shapes.
- Debug events are opt-in and cannot change active-turn/composer state.
- Reducer tests cover duplicate prevention, optimistic reconciliation, live deltas, and terminal turn state.
- `cd apps/web && npm test` passes.

## Frontend Milestone 4: Test Fixture And E2E Cleanup

Failing tests first:

- Test fixtures fail if they provide only legacy timeline replay where a snapshot is required.
- E2E flow verifies opening an existing thread from a snapshot without replayed timeline events.
- E2E flow verifies the composer remains Send for an idle historical thread after the selected-stream refresh interval.

Implementation:

- Update gateway mocks to model `GET /v1/threads/{id}` snapshots as the default source of timeline rows.
- Remove broad event-fixture helpers from tests that are no longer testing replay/debug behavior.
- Add a Playwright regression for:
  - old thread opens from snapshot
  - no unread indicator appears after selection
  - composer does not flip to Stop after several seconds on idle history
- Keep approval replay fixtures under approval-specific tests.

Exit conditions:

- `cd apps/web && npm test` passes.
- `cd apps/web && npm run test:e2e` passes.
- Test names and fixtures reflect the snapshot-first architecture.

## Backend Milestone 3: Documentation And API Contract Cleanup

Failing tests first:

- OpenAPI/generated frontend types no longer imply timeline history replay is required for selected-thread loading.
- README/API docs state snapshots are canonical, `/v1/events` is gateway-owned operational/live transport, and raw persisted replay is diagnostic-only through `/v1/debug/events`.

Implementation:

- Update backend route docs and OpenAPI descriptions where helpful.
- Add OpenAPI coverage for the explicit debug endpoint if it is part of the public local API surface.
- Regenerate frontend API types if route query parameters or DTOs change.
- Update `README.md` with the deterministic selected-thread load sequence.
- Update `AGENTS.md` only if workflow rules change.
- Keep this plan and [plans/index.md](index.md) current.

Exit conditions:

- Public docs no longer describe gateway event replay as timeline history.
- Public docs clearly separate `/v1/events` from diagnostic raw replay endpoints.
- Generated frontend types are current if API changed.
- `cargo test`, `cd apps/web && npm test`, `cd apps/web && npm run build`, and `cd apps/web && npm run test:e2e` pass.

## End-to-End Regression Plan

Scenarios:

- Existing idle thread:
  - Start gateway and web.
  - Open a thread that already has completed app-server turns.
  - Verify the timeline renders from snapshot.
  - Wait longer than the selected-thread refresh interval.
  - Verify the composer remains Send and the thread does not gain an unread dot.

- Existing active thread:
  - Open a thread whose snapshot has an active non-terminal turn.
  - Verify composer shows Stop.
  - Verify live deltas update the active row.
  - Verify terminal turn update or snapshot refresh returns composer to Send.

- External update while gateway is up:
  - Keep a thread selected in the web UI.
  - Advance the thread through another app-server client.
  - Verify selected-thread snapshot refresh shows the new turn without manual reload.

- External update while gateway is down:
  - Stop gateway.
  - Advance a thread through another app-server client.
  - Restart gateway and open the thread.
  - Verify timeline, title/metadata, and read state converge from snapshot with no event replay dependency.

- Approval replay:
  - Trigger a permission request.
  - Reload the page.
  - Verify pending approval is still visible and actionable.
  - Resolve the approval and verify it does not reappear.

- SSE reconnect:
  - Open a thread and force selected stream disconnect/reconnect.
  - Verify the app refetches or receives a snapshot refresh.
  - Verify no duplicate timeline rows and no stale Stop button.

Commands:

- `CARGO_TARGET_DIR=/tmp/kodex-target cargo fmt --check`
- `CARGO_TARGET_DIR=/tmp/kodex-target cargo clippy --all-targets -- -D warnings`
- `CARGO_TARGET_DIR=/tmp/kodex-target cargo test`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- `cd apps/web && npm run test:e2e`

## Design Decisions

- Remove timeline replay first; remove the event table only if a later plan replaces approval/debug persistence.
- Use a separate debug endpoint for raw persisted event replay; do not add debug replay flags to `/v1/events`.
- Treat selected-thread snapshot refetch as the recovery primitive for missed or uncertain timeline updates.
- Keep live SSE for responsiveness, not correctness.
- Keep deployment assumptions local/VPN-only; this plan does not add auth.
