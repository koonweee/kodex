# Thread Work Duration Plan

## Status

Complete.

## Context

The web timeline renders work rows from gateway-projected turn metadata. While a turn is active, the browser counts elapsed time from `startedAtMs`. When the turn becomes terminal, the renderer freezes the row at `completedAtMs - startedAtMs`.

The observed bug is that a running row can count upward, then immediately switch to `Worked for 0s` when the gateway emits the first completed projection patch. The likely cause is in `apps/gateway/src/thread_session_view.rs`: `timeline_turns_from_items()` synthesizes turn `startedAt` and `completedAt` from the same first item timestamp after `update_turn_status()` marks live items completed.

The target behavior is gateway-owned completed work duration:

- Live patches must preserve a stable turn start time once observed.
- Terminal patches must include a completion time later than or equal to the start time.
- Canonical app-server snapshots with `startedAt` / `completedAt` remain the preferred source of durable history.
- Other browser sessions and devices attached to the same gateway should see the same completed duration through the gateway timeline patch/snapshot.

## Current State

Code-established facts:

- `apps/web/src/timeline/renderers.tsx` renders `Working for ...` while `row.state === "running"` and `Worked for ...` after completion.
- `apps/web/src/timeline/reducer.ts` stores `startedAtMs` and `completedAtMs` from `ThreadTimelineSnapshotTurn` / `ThreadSessionViewPatch.turns`.
- `apps/web/src/timeline/derive.ts` creates work rows from stored turn metadata and marks rows completed for terminal turn status.
- `apps/gateway/src/thread_session_view.rs` owns the in-memory session view and emits `ThreadSessionViewPatch.turns`.
- `ThreadTimelineSnapshot::from_turns()` in `apps/gateway/src/app_server_api.rs` preserves canonical app-server `startedAt` and `completedAt`.
- `ThreadSessionView::to_snapshot()` and `to_patch()` currently rebuild turns from live items using item timestamps.
- `ThreadSessionView::update_turn_status()` marks items terminal but does not store the turn-level `startedAt` / `completedAt` values from `ThreadTurnSnapshot`.

Constraints:

- The gateway is the source of truth for shared timeline/lifecycle projection; frontend-only elapsed fixes would not survive reloads or multi-client viewing.
- Do not change app-server wire contracts or generated schema names unless necessary.
- Public event kind `"timeline.projection_patch"` can remain unchanged.
- Existing dirty work in thread-session-view cleanup files must be preserved.

## Milestones

### 1. Preserve Turn Metadata In Gateway Session View

Scope: `apps/gateway/src/thread_session_view.rs`.

Work:

- Add turn metadata storage to `ThreadSessionView` instead of deriving patch/snapshot turns solely from items.
- On canonical `refresh_from_base`, prefer app-server snapshot turn metadata and merge in any live-only turns that are not yet materialized.
- On live item upsert/delta/pending input, create or update the turn record with a stable `startedAt` derived from the first observed live timestamp.
- On terminal `record_turn_status`, update the turn record with the status and `completedAt` from the app-server turn payload when present; otherwise use a gateway completion timestamp.
- Keep completed duration non-negative by clamping or selecting a completion timestamp no earlier than the preserved start.

Exit criteria:

- A live turn that receives a terminal turn status emits a patch with distinct stable `startedAt` and `completedAt` when time has elapsed.
- Canonical snapshot turns keep app-server `startedAt` / `completedAt`.
- Live-only turns still appear in patches before app-server history materializes.

### 2. Focused Regression Coverage

Scope: `apps/gateway/src/thread_session_view.rs` tests.

Work:

- Add a test for live delta followed by terminal `record_turn_status` proving completed patch duration does not collapse to zero.
- Add or update a test proving canonical snapshot timings override or preserve app-server turn timings after live projection.
- Confirm late deltas after terminal completion remain ignored.

Exit criteria:

- `cargo test thread_session_view -q` passes.
- Tests fail against the old item-derived turn synthesis and pass with turn metadata storage.

### 3. Contract And UI Sanity

Scope: gateway/frontend API contract and web timeline expectations.

Work:

- Confirm no OpenAPI schema change is required; the existing `startedAt` / `completedAt` fields remain the contract.
- Run focused frontend work-row tests to ensure completed durations are still rendered from `completedAtMs - startedAtMs`.
- Avoid browser validation unless the implementation changes browser-visible layout or interactions; this is a data correctness fix under an existing renderer.

Exit criteria:

- `cargo fmt` passes.
- `cargo test thread_session_view -q` passes.
- `cd apps/web && npm test -- src/timeline/renderers.test.tsx src/timeline/derive.test.ts` passes, or any failure is documented as unrelated.
- Static audit shows no need to regenerate OpenAPI or frontend generated types for this fix.

## Verification

- `cargo fmt` passed.
- `cargo test thread_session_view -q` passed.
- `cd apps/web && npm test -- src/timeline/renderers.test.tsx src/timeline/derive.test.ts` passed.
- Static audit completed:
  - inspect `git diff -- apps/gateway/src/thread_session_view.rs apps/web/src/timeline/renderers.tsx apps/web/src/timeline/reducer.ts apps/web/src/timeline/derive.ts`
  - confirm the public patch fields remain `startedAt` and `completedAt`

## Risks And Open Questions

- Live fallback completion timestamps are gateway-observed times, not necessarily exact app-server completion times. They should be replaced by canonical app-server timestamps once a full snapshot arrives.
- Historical turns without app-server timing data can only use best-effort synthesized timing; canonical 0.130.0 full turn history should normally provide durable timings.
- If multiple live items for the same turn arrive out of order, the turn metadata should preserve the earliest observed start rather than following the latest item.
