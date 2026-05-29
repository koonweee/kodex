# Native iOS Streaming Patch Rendering Plan

## Context

- The native iOS client currently connects to the gateway SSE endpoint but treats selected-thread `thread_view.patch` events as invalidation signals and refetches `GET /v1/threads/{threadId}` for every patch.
- The web client already renders assistant streaming from gateway-owned canonical `thread_view.patch` payloads in `apps/web/src/timeline/useSelectedThreadTimeline.ts`, `apps/web/src/timeline/reducer.ts`, and `apps/web/src/timeline/batch.ts`.
- The gateway creates those patch events from app-server assistant deltas in `apps/gateway/src/events.rs`, folding raw `item/agentmessage/delta` and `item/assistantmessage/delta` into the canonical thread-view projection before clients see them.
- The iOS target should preserve the same ownership boundary: render canonical gateway snapshots and patches, and use `thread_view.refresh_required` plus reconnect recovery to refetch authoritative snapshots.

## Current State

- `apps/ios/Sources/KodexCore/LiveUpdates.swift` opens `GET /v1/events` with `Accept: text/event-stream` through `URLSession.shared.bytes(for:)`, parses SSE `data:` lines, and exposes `GatewayLiveEnvelope` values through `AsyncThrowingStream`.
- `GatewayLiveEventDecoder` currently collapses `thread_view.patch` to `.threadViewPatch(threadId:)`, discarding `viewRevision`, `scope`, `rows`, `upsertRows`, `removeRowIds`, and `liveState`.
- `apps/ios/Sources/KodexIOS/ConnectionView.swift` starts a selected-thread stream with `threadId=...` and a global stream with `excludeThreadId=...`. `handleLiveEvent` calls `loadSelectedThread` for selected-thread patches, refresh-required events, queue events, and approval events.
- `loadSelectedThread` refetches the full thread snapshot, approvals, queue, skills, and composer settings through `LiveGatewayService`.
- `apps/ios/Sources/KodexCore/GatewayProbe.swift` owns the lightweight `TimelineRow`, `ThreadTimeline`, `ThreadDetail`, and `WorkspaceNormalizer.mergeOlderHistory` models that SwiftUI renders.
- `apps/ios/Sources/KodexAPI/LiveGatewayService.swift` has private decoding and mapping helpers for `ThreadTimelineSnapshotDTO` and `ThreadTimelineRowDTO`. Similar mapping is needed for live patch rows.
- `AGENTS.md` requires native iOS UI work to preserve gateway-owned state boundaries and to update fixture UI tests and simulator screenshots when visible shared surfaces change.

## Principles

- Red first where practical: add focused Swift tests for patch decoding and timeline reduction before changing live selected-thread behavior.
- Canonical only: iOS must not render raw app-server lifecycle events or raw `timeline.item_delta` as transcript truth.
- Snapshot-backed recovery: any gap, decode failure, `thread_view.refresh_required`, reconnect uncertainty, or selected-thread switch should converge through `GET /v1/threads/{threadId}`.
- Thin UI state: applying patches in SwiftUI is a local projection of gateway-owned canonical patches, not a new source of lifecycle truth.
- Keep scope narrow: do not redesign queue, approval, unread, notification, or composer settings handling in this plan unless needed for patch correctness.

## Milestones

### 1. Decode Canonical Thread View Patches In iOS

- Scope: `apps/ios/Sources/KodexCore/LiveUpdates.swift`, `apps/ios/Tests/KodexCoreTests/NativeMilestoneTests.swift`, and focused coverage in `apps/ios/Tests/KodexCoreTests/LiveGatewayServiceTests.swift` if shared model helpers move.
- Work:
  - Introduce a `GatewayThreadViewPatch` or similarly named `Sendable`/`Equatable` Core model with `threadId`, `viewRevision`, `scope`, `liveState`, `rows`, `upsertRows`, and `removeRowIds`.
  - Model patch scopes explicitly: `full_snapshot`, `turn`, and `lifecycle`, with unknown scopes treated as non-renderable and refetch-worthy.
  - Add a Core decoding shape for canonical timeline rows that maps enough gateway payload to existing `TimelineRow`: `id`, `kind`, `displayOrder`, `status`, `items`, optional `item`, `fileChanges`, and `work`.
  - Update `GatewayLiveEvent.threadViewPatch` to carry the decoded patch instead of only a thread ID.
  - Keep `thread_view.refresh_required` as a separate event that carries only the target thread ID.
  - Preserve `GatewayLiveEnvelope.seq` and `GatewayStreamCheckpoint` cursor behavior.
- Exit criteria:
  - A failing-then-passing Swift test proves `GatewayLiveEventDecoder` decodes a `thread_view.patch` containing `scope`, `viewRevision`, `upsertRows`, `removeRowIds`, `liveState`, and assistant message text.
  - Existing queue, approval, pin, notification, read, and unknown event decoder tests still pass.
  - `GatewayEventScope.selected` and `.global` continue to route by patch `threadId`.

### 2. Add A Core Timeline Patch Reducer

- Scope: `apps/ios/Sources/KodexCore/GatewayProbe.swift` or a new nearby Core file such as `ThreadTimelineReducer.swift`, plus `apps/ios/Tests/KodexCoreTests/LiveGatewayServiceTests.swift` or a new focused reducer test file.
- Work:
  - Add a pure helper such as `ThreadTimeline.applying(_ patch: GatewayThreadViewPatch) -> ThreadTimelinePatchResult`.
  - Ignore stale patches where `patch.viewRevision <= current.viewRevision`.
  - For `full_snapshot`, require `rows` and replace current rows with mapped canonical rows.
  - For `turn`, apply `removeRowIds`, upsert mapped rows by `id`, and sort by `displayOrder`.
  - For `lifecycle`, update `liveState` and `viewRevision` without changing rows.
  - Preserve `olderCursor` and `hasOlder` across live patches so lazy older-history paging remains intact.
  - Return a result that distinguishes `applied`, `ignoredStale`, and `needsSnapshotRefresh` so stream handling can make conservative recovery decisions.
- Exit criteria:
  - Tests cover incremental assistant row text replacement, row removal, lifecycle-only live-state updates, stale revision ignoring, full snapshot replacement, and preservation of older-history paging fields.
  - Reducer behavior is deterministic for out-of-order rows and duplicate row IDs.
  - No SwiftUI view code is required to know patch internals.

### 3. Apply Selected-Thread Patches Without Full Refetch

- Scope: `apps/ios/Sources/KodexIOS/ConnectionView.swift`, `apps/ios/Sources/KodexIOS/ConnectionModel.swift`, and selected-thread tests if a model-level coordinator is extracted.
- Work:
  - Change `handleLiveEvent` so selected-thread `.threadViewPatch(patch)` applies the Core reducer to `model.state.selectedThread` when `patch.threadId == selectedThreadId`.
  - Refetch selected thread only when the patch result requests a snapshot refresh, the event is `thread_view.refresh_required`, a decode error closes the stream, or stream reconnect handling detects uncertainty.
  - Keep queue and approval events on the existing conservative `loadSelectedThread` path for this plan.
  - Keep global stream handling focused on workspace/sidebar updates; do not render timeline patches for non-selected threads.
  - After a successful full selected-thread load, keep `startSelectedStream(threadId)` behavior and cursor resume intact.
- Exit criteria:
  - A selected-thread patch updates the rendered `TimelineRowView` data without invoking `loadSelectedThread`.
  - `thread_view.refresh_required` still invokes `loadSelectedThread`.
  - Queue and approval events still refresh the selected thread and related request cards.
  - Stop still routes through `LiveGatewayService.stopCurrentTurn` and converges through the same refetch/reconnect path.

### 4. Batch High-Frequency Streaming Patches

- Scope: `apps/ios/Sources/KodexIOS/ConnectionView.swift` or a small selected-stream coordinator owned by `ConnectionModel`.
- Work:
  - Add a selected-thread patch buffer that accumulates `GatewayLiveEnvelope` values for a short interval, targeting roughly one UI mutation per frame or small time slice.
  - Coalesce superseded turn patches similarly to the web `coalesceTimelineEventBatch` behavior when a batch contains multiple turn-scoped patches for the same thread, turn, and row IDs without removals.
  - Flush patches on `MainActor` in sequence order, applying the reducer and falling back to `loadSelectedThread` if any patch cannot be applied safely.
  - Flush or cancel pending patches when the selected thread changes, the stream task is cancelled, or a refresh-required event arrives.
- Exit criteria:
  - Tests or model-level coverage prove multiple assistant text patches coalesce into the latest row content while preserving ordered non-coalescible events.
  - SwiftUI state mutation count is bounded by the batch flush cadence during rapid assistant output.
  - Selected-thread switches cannot apply buffered patches to the wrong thread.

### 5. Live And Simulator Validation

- Scope: iOS test commands, simulator smoke flows, and visible thread timeline surfaces.
- Work:
  - Run the focused Swift package tests for decoder and reducer behavior.
  - Run the existing iOS simulator test workflow after patch application changes.
  - Use a live gateway smoke flow to send a prompt and observe assistant text growing without per-patch full-thread refetches.
  - Validate reconnect by interrupting or forcing the selected stream to close, then confirm the app refetches and resumes from the checkpoint.
  - Capture updated simulator screenshots for affected thread timeline/composer surfaces if visible behavior changes enough to update artifacts.
- Exit criteria:
  - `cd apps/ios && swift test` passes.
  - Xcode/simulator UI tests for `KodexIOS` pass, or any known environmental blocker is documented with the exact failed command.
  - Live smoke confirms streaming text appears incrementally and remains correct after reconnect/refetch.
  - Existing older-history lazy loading still merges older rows without dropping live rows.

## Verification

- `cd apps/ios && swift test`
- XcodeBuildMCP simulator build/test for the `KodexIOS` scheme after session defaults are verified.
- Existing live scripts when a gateway and authenticated account are available:
  - `apps/ios/scripts/run-live-e2e.sh`
  - `apps/ios/scripts/run-live-e2e-api-scenarios.sh`
- Manual live check:
  - Start a real gateway.
  - Open the iOS live client.
  - Send a prompt that streams for several seconds.
  - Confirm assistant text updates incrementally without a full selected-thread refetch per patch.
  - Trigger or simulate stream reconnect and confirm snapshot recovery.

## Risks And Open Questions

- `LiveUpdates.swift` lives in `KodexCore`, while generated OpenAPI patch types live in `KodexAPI`. The implementation should avoid a dependency cycle by either defining a small Core patch DTO or moving only reusable row-normalization logic into Core.
- `TimelineRow` is intentionally lightweight compared with the full web canonical row model. The first implementation should map only fields already rendered by native iOS and keep richer row rendering as a separate UI parity plan.
- Frequent refetches currently also refresh approvals, queues, skills, and composer settings. Applying patches directly means those side effects no longer occur on every assistant delta, which is desirable, but queue and approval events must continue to refresh their own surfaces.
- If live patch decode fails because the gateway contract changes, the client should prefer snapshot refetch and a visible status message over silently dropping transcript updates.
- Background iOS behavior is out of scope. Foreground SSE streaming remains separate from APNS notification and app-resume refetch behavior.
