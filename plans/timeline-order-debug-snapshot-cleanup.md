# Timeline Order, Debug, And Snapshot Cleanup Plan

## Status

Complete

## Goal

Simplify timeline ordering and snapshot handling so conversation rendering has one clear display-order concept, debug-only data no longer changes the main reading flow, and app-server snapshots build canonical frontend timeline state directly instead of masquerading as live events.

## Scope

This is a frontend-first cleanup in `apps/web/src/timeline` unless implementation discovers that the gateway needs to expose a missing contract field. The work centers on:

- `apps/web/src/timeline/state.ts`
- `apps/web/src/timeline/reducer.ts`
- `apps/web/src/timeline/derive.ts`
- `apps/web/src/timeline/TimelineView.tsx`
- `apps/web/src/timeline/renderers.tsx`
- timeline reducer, derivation, renderer, and app-level tests

Gateway and generated API files should not change unless the public contract itself changes. If a gateway change becomes necessary, generated OpenAPI and frontend API types must be regenerated rather than handwritten.

## Non-Goals

- No redesign of normal message, activity, file-change, approval, or work-row presentation.
- No new timeline transport. SSE remains the selected-thread live update path.
- No change to `/v1/events`, `/v1/debug/events`, or gateway event persistence unless required by a discovered contract issue.
- No new handwritten API contract docs.
- No claim that the gateway is safe to expose publicly; deployment remains localhost or trusted VPN.

## Current State

- `TimelineItem.seq` in `apps/web/src/timeline/state.ts` is a display-order value, but the name overlaps with `EventEnvelope.seq` and `TimelineState.lastSeq`, which are event cursor concepts.
- `createBaseItem` initializes `TimelineItem.seq` from `EventEnvelope.seq` in `apps/web/src/timeline/presentationShared.ts`, while `applyTimelineSnapshot` creates synthetic snapshot event sequences from `snapshot.turns[].items[]` array position.
- `TimelineView` calls `deriveTimelineRows(timeline, { showDebug })`; `deriveTimelineRows` calls `sortedVisibleTimelineItems`, which sorts by `item.seq`.
- `TimelineTurn.itemIds` is maintained in the reducer as turn membership. `insertWorkRows` groups already-derived rows by `turnId` and does not use `turn.itemIds` for display ordering.
- Debug mode currently appends `timeline.hiddenItems` into the same sorted item stream as visible conversation items. Hidden lifecycle/debug rows can appear before or between user-visible rows when their `seq` is lower.
- Snapshot loading has its own exported entrypoint, `applyTimelineSnapshot`, but it internally creates synthetic `timeline.item_upsert` events and sends them through `applyTimelineEventInternal`.
- Snapshot-specific reducer behavior is spread across synthetic event IDs, `skipOptimisticUserMessageMatch`, `event.id.startsWith("snapshot-")`, and unmatched local-message repositioning.

## Constraints

- Follow AGENTS.md: behavior-changing frontend work should start with focused failing tests where practical.
- Any behavior touching shared thread/project/session state must consider same-user two-tab correctness. This plan is mostly local timeline projection, but snapshot/live convergence tests should cover reconnect and stale live event shapes.
- Frontend API types must remain generated from OpenAPI artifacts.
- Before marking lifecycle work complete, verify that correctness does not depend on one tab's React state for shared state decisions.
- Use `$agent-browser` validation for browser-observable UI changes, especially debug-mode row behavior.
- The upstream app-server README documents `thread/read` history as `turns` with nested `items`, but does not expose a separate item display-order field. Treat the array order returned through the gateway snapshot as the snapshot display source unless the generated app-server schema changes.

## Milestone 1: Name Display Order Explicitly

Status: Complete

Failing tests first:

- Add or update reducer/derive tests that make the distinction between event cursor order and item display order explicit.
- Add a test where a low-sequence stale live event merges into an existing snapshot item without moving that item in display order.

Implementation:

- Rename frontend `TimelineItem.seq` to `displayOrder` in `apps/web/src/timeline/state.ts`.
- Rename `TimelineWorkRow.seq` to `displayOrder` in `apps/web/src/timeline/derive.ts`.
- Rename helper and local variables that refer to item display order:
  - `sortedVisibleTimelineItems` -> `timelineItemsInDisplayOrder`
  - `mergeTimelineDisplaySeq` -> `mergeTimelineDisplayOrder`
  - `firstRowSeq` -> `firstRowDisplayOrder`
  - `nextOptimisticSeq` -> `nextOptimisticDisplayOrder`
- Keep `EventEnvelope.seq`, `TimelineState.lastSeq`, and `events/stream.ts` cursor logic unchanged.
- Update test builders and fixtures to use `displayOrder` for `TimelineItem` construction.

Exit conditions:

- TypeScript compilation catches no stale `TimelineItem.seq` or `TimelineWorkRow.seq` references.
- Focused timeline reducer and derive tests pass.
- The rename introduces no generated API changes.

## Milestone 2: Lock Work Rows To Display Order

Status: Complete

Failing tests first:

- Add a `derive.test.ts` case where `turn.itemIds` and item `displayOrder` intentionally disagree.
- Assert that item rows, activity rows, file-change rows, and the inserted work row follow `displayOrder`.
- Assert that `turn.itemIds` remains available for membership and active/completed turn bookkeeping.

Implementation:

- Keep work-row placement display-order-based unless a new app-server contract explicitly exposes a stronger item-order field.
- Add code comments or type aliases that describe `TimelineTurn.itemIds` as membership/lookup data, not render order authority.
- Ensure `insertWorkRows` does not accidentally use `turn.itemIds` for ordering while still using `timeline.turns` for timing and status metadata.
- If the milestone exposes a real mismatch between snapshot array order and live display order, resolve it in the display-order normalization layer rather than inside render components.

Exit conditions:

- New disagreeing-order test fails before implementation and passes afterward.
- Existing work-row behavior remains unchanged for normal ordered fixtures.
- `cd apps/web && npm test -- --run src/timeline/derive.test.ts` passes.

## Milestone 3: Move Hidden Debug Rows Out Of The Main Timeline Flow

Status: Complete

Failing tests first:

- Update `derive.test.ts` so enabling debug mode does not insert hidden lifecycle/debug items into the main conversation row order.
- Add or update an app-level test that toggles "Show debug events" and verifies visible conversation row order stays stable while debug-only payloads remain reachable.

Implementation:

- Stop `deriveTimelineRows` from appending `timeline.hiddenItems` to the main sorted visible item list.
- Keep `DebugDisclosure` attached to visible rows when `showDebug` is true.
- Add a separate debug surface for hidden items, preferably a single collapsed panel rendered after the main conversation rows in `TimelineView`.
- Render hidden debug items through existing debug disclosure/payload components where possible, avoiding a second raw JSON rendering implementation.
- Preserve `hiddenItems` in reducer state for diagnostic visibility and tests.
- Ensure approvals, virtual row count, scroll-to-bottom behavior, and row keys remain stable when toggling debug mode.

Exit conditions:

- Toggling debug mode no longer changes the relative order of visible conversation rows.
- Hidden lifecycle/debug events remain inspectable in debug mode.
- Focused derive, renderer, and app-level debug tests pass.
- `$agent-browser` validation confirms a real thread with debug mode enabled keeps the conversation readable and exposes hidden debug events in the separate surface.

## Milestone 4: Prototype Direct Snapshot Normalization Under Tests

Status: Complete

Failing tests first:

- Add a test-only helper or internal helper that normalizes `ThreadDetailResponse` directly into timeline items, turns, active turn, and display order.
- Compare direct-normalized output against current `applyTimelineSnapshot` behavior for:
  - plain completed snapshot
  - optimistic user-message reconciliation
  - skill mention projection
  - stale lower-cursor live event after snapshot refresh
  - running snapshot followed by active-turn deltas
  - unmatched local user message moved after snapshot history

Implementation:

- Extract snapshot normalization decisions into named helpers in `apps/web/src/timeline/reducer.ts` or a new timeline snapshot module.
- Model snapshot item order as display order derived from `snapshot.turns` and each turn's `items` array position.
- Preserve existing optimistic reconciliation rules from:
  - `optimisticOnlyTimeline`
  - `snapshotItemShouldSkipLocalUserMessageMatch`
  - `moveUnmatchedLocalUserMessagesAfterSnapshot`
  - `withSnapshotTurnMetadata`
  - `withSnapshotLiveState`
- Keep the current replay path active until the comparison tests prove parity.

Exit conditions:

- Snapshot parity tests document all special cases that must survive migration.
- The helper does not add browser-only shared state decisions.
- Focused snapshot tests pass.

## Milestone 5: Replace Synthetic Snapshot Replay

Status: Complete

Failing tests first:

- Convert the parity tests from Milestone 4 into behavioral tests for the new direct snapshot path.
- Add regression coverage that no reducer branch depends on `event.id.startsWith("snapshot-")`.

Implementation:

- Change `applyTimelineSnapshot` to build canonical timeline state directly from `ThreadDetailResponse`.
- Remove synthetic snapshot event creation from `applyTimelineSnapshot`.
- Remove snapshot-only checks from live-event merge paths where they become unnecessary.
- Keep `applyLiveTimelineUpdate` support for a `timeline.snapshot` event if the stream can still emit one, but route it into the direct snapshot path.
- Ensure live `timeline.item_upsert`, `timeline.item_delta`, `timeline.turn_upsert`, and hidden debug events still use `applyTimelineEventInternal`.
- Re-check stale live replay handling:
  - completed snapshot items should not be duplicated by lower-cursor historical deltas
  - active-turn deltas should still render after refreshed snapshot history
  - historical `appServerSnapshot` source events should not reactivate completed turns

Exit conditions:

- Snapshot tests pass without synthetic event replay.
- Existing selected-thread loading and snapshot-required app tests pass.
- No remaining `event.id.startsWith("snapshot-")` logic is needed for timeline correctness.
- `cd apps/web && npm test -- --run src/timeline/reducer.snapshot.test.ts src/App.mvp.timeline.test.tsx` passes.

## Milestone 6: Review, Build, And Browser Validation

Status: Complete

Implementation:

- Run an independent review pass focused on ordering, debug UX, snapshot/live convergence, and two-tab correctness assumptions.
- Run the focused frontend tests plus build.
- Use `$agent-browser` against the local frontend to inspect:
  - normal completed thread timeline
  - debug mode toggle
  - hidden lifecycle/debug panel
  - active turn with work row
  - snapshot refresh after `timeline.snapshot_required` if a test fixture route or manual setup is available
- If implementation changes public gateway DTOs, regenerate backend OpenAPI and frontend generated schema before review.

Exit conditions:

- `cd apps/web && npm test` passes or the touched focused suites plus any intentionally deferred suites are documented.
- `cd apps/web && npm run build` passes.
- `$agent-browser` screenshots or observations confirm debug mode does not disrupt the main reading flow.
- Review finds no major correctness issues.
- `plans/index.md` status is updated if implementation starts or completes.

## Verification

Focused commands:

- `cd apps/web && npm test -- --run src/timeline/derive.test.ts`
- `cd apps/web && npm test -- --run src/timeline/reducer.snapshot.test.ts`
- `cd apps/web && npm test -- --run src/timeline/renderers.test.tsx src/App.test.tsx src/App.mvp.timeline.test.tsx`
- `cd apps/web && npm run build`

Browser validation:

- Start the full-stack dev environment with the repo skill when needed.
- Use `$agent-browser` to open the local app, toggle debug events, inspect a thread with visible messages plus hidden lifecycle/debug rows, and verify no visible conversation row jumps or reorders.
- Check at least one narrow/mobile viewport if the debug panel adds new layout.

## Risks And Open Questions

- Upstream app-server history has `turns[].items[]` array order but no explicit item display-order field in the generated schema. If app-server later adds such a field, the display-order normalization should consume it in the gateway or frontend generated type path rather than infer from event order.
- Moving hidden debug rows out of the virtualized row stream may require a small layout decision in `TimelineView`: debug panel inside the scroll region after rows, or a separate non-virtualized footer. Prefer inside the scroll region so debug content remains near the timeline context.
- Direct snapshot normalization must preserve optimistic user-message reconciliation exactly; otherwise duplicate user bubbles can reappear after snapshot refresh.
- The current reducer uses `debugEvents` both for visible-row disclosures and hidden-item raw payloads. The new debug surface should reuse that data without making hidden events part of the primary row derivation.
- If any test depends on `state.items.map(...)` raw insertion order, update the expectation only when the test is meant to assert display order. Reducer internals may still maintain insertion order separately from display order.
