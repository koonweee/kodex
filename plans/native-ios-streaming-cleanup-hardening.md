# Native iOS Streaming Cleanup And Hardening Plan

## Context

- The main native iOS streaming patch work is already complete in [native-ios-streaming-patches.md](native-ios-streaming-patches.md): iOS reads `GET /v1/events` with `URLSession.shared.bytes(for:)`, decodes canonical `thread_view.patch` events, coalesces selected-thread patches, and applies them through `ThreadTimeline.applying(_:)`.
- The desired direction is still the ChatGPTSwift-style shape: a small async stream abstraction yields typed events, a pure reducer applies assistant text updates, and SwiftUI renders one gateway-owned projection rather than owning durable transcript truth.
- This follow-up plan is a cleanup and hardening pass, not a greenfield refactor and not a provider-direct streaming implementation.

## Current State

- `apps/ios/Sources/KodexCore/LiveUpdates.swift` owns the current idiomatic path:
  - `GatewayEventStream.envelopes()` opens SSE with `Accept: text/event-stream` and `URLSession.shared.bytes(for:)`.
  - `GatewayLiveEventDecoder` decodes `thread_view.patch` into `GatewayThreadViewPatch`.
  - `GatewayLiveEventBatch.coalesce(_:)` drops superseded turn patches inside a small flush window.
- `apps/ios/Sources/KodexCore/GatewayProbe.swift` owns the render model and reducer:
  - `GatewayThreadViewPatch`, `GatewayThreadViewPatchScope`, and `ThreadTimelinePatchResult`.
  - `ThreadTimeline.applying(_:)`, which handles full snapshot, turn, lifecycle, stale, and unsafe patch cases.
- `apps/ios/Sources/KodexIOS/ConnectionView.swift` owns selected/global stream tasks, selected-thread patch buffering, snapshot recovery, reconnect fallback, and conservative refetches for queue/approval/refresh-required events.
- There are leftover compatibility seams that now obscure the canonical streaming path:
  - `apps/ios/Sources/KodexCore/URLSessionGatewayLoader.swift` still defines `LiveUpdateEvent` and `LiveUpdateParser`.
  - `apps/ios/Sources/KodexAPI/LiveGatewayService.swift` still defines `SelectedThreadProjection`, which depends on the legacy `LiveUpdateEvent`.
  - `apps/ios/Tests/KodexCoreTests/NativeMilestoneTests.swift` and `apps/ios/Tests/KodexCoreTests/LiveGatewayServiceTests.swift` still test those legacy surfaces.
- `AGENTS.md` requires native iOS work to preserve gateway-owned lifecycle/thread state, update focused tests, and validate visible iOS surfaces when behavior changes.

## Milestones

### 1. Remove The Legacy Live Event Parser Path

- Scope: `apps/ios/Sources/KodexCore/URLSessionGatewayLoader.swift`, `apps/ios/Sources/KodexAPI/LiveGatewayService.swift`, `apps/ios/Tests/KodexCoreTests/NativeMilestoneTests.swift`, and `apps/ios/Tests/KodexCoreTests/LiveGatewayServiceTests.swift`.
- Work:
  - Delete `LiveUpdateEvent` and `LiveUpdateParser` from `URLSessionGatewayLoader.swift` if no production code uses them.
  - Delete `SelectedThreadProjection` from `LiveGatewayService.swift` if no production code uses it.
  - Remove or rewrite tests that only prove the legacy parser/projection behavior.
  - Keep the lower-level `URLSessionGatewayLoader.load/send` request helpers intact.
- Exit criteria:
  - `rg -n "LiveUpdateEvent|LiveUpdateParser|SelectedThreadProjection" apps/ios/Sources apps/ios/Tests` returns no matches.
  - Existing live stream decoder tests still cover `thread_view.patch`, `thread_view.refresh_required`, queue, approval, read, pin, notification, and unknown event handling.

### 2. Make The Async SSE Boundary Explicit

- Scope: `apps/ios/Sources/KodexCore/LiveUpdates.swift` and nearby tests in `NativeMilestoneTests.swift`.
- Work:
  - Keep `GatewayEventStream.envelopes()` as the single Core streaming entry point for gateway SSE.
  - Add focused tests for multiline SSE `data:` frames, blank-line dispatch, non-2xx failure, cancellation termination, and malformed event recovery behavior where practical.
  - Document in code comments only where helpful that the stream yields gateway envelopes, not model-provider token chunks.
  - Avoid adding Combine, third-party EventSource dependencies, or model-provider-specific parsing.
- Exit criteria:
  - Stream parser tests prove the `URLSession.bytes` line parser behavior that the app relies on.
  - The public Core API reads as one typed async stream feeding `GatewayLiveEnvelope` values.

### 3. Harden Patch Reduction And Coalescing Contracts

- Scope: `GatewayLiveEventBatch`, `ThreadTimeline.applying(_:)`, and focused Core tests.
- Work:
  - Add tests that patches with removals are not coalesced away.
  - Add tests that lifecycle and full-snapshot patches preserve ordering relative to turn patches.
  - Add tests for unsupported scopes and thread ID mismatches returning `needsSnapshotRefresh`.
  - Add tests that full-snapshot rows replace current rows while preserving older-history paging fields.
  - Keep reducer logic pure and independent from SwiftUI.
- Exit criteria:
  - Reducer and batch behavior remains deterministic under out-of-order envelopes, duplicate row IDs, stale revisions, and mixed patch scopes.
  - No SwiftUI view reads patch internals directly.

### 4. Clarify Selected-Stream Ownership In The UI Layer

- Scope: `apps/ios/Sources/KodexIOS/ConnectionView.swift`, `apps/ios/Sources/KodexIOS/ConnectionModel.swift`, and focused model/UI tests if seams are extracted.
- Work:
  - Consider extracting selected-stream patch buffering into a small helper or coordinator only if it reduces `ConnectionView` responsibility without creating a second source of truth.
  - Keep `ConnectionModel` as local UI projection state and keep gateway snapshots/patches as the authority.
  - Preserve selected/global SSE de-duplication through `threadId` and `excludeThreadId`.
  - Keep queue and approval events on conservative refetch paths unless a separate plan changes those surfaces.
  - Ensure selected-thread changes cancel pending patch flushes, recovery tasks, and stale stream tasks.
- Exit criteria:
  - A selected-thread patch can update timeline rows without full selected-thread refetch.
  - `thread_view.refresh_required`, stream disconnect uncertainty, malformed unsafe patches, queue events, and approval events still converge through snapshot reload.
  - No buffered patch can apply after the selected thread changes.

### 5. Validation And Documentation

- Scope: iOS tests, README/plan notes if behavior or commands change, and simulator validation.
- Work:
  - Run focused Swift tests while iterating, then the full iOS Swift test suite.
  - Use XcodeBuildMCP simulator build/test for `KodexIOS` after session defaults are verified.
  - Run live E2E scripts when a real gateway/account are available.
  - Capture screenshots only if visible thread streaming or timeline chrome changes.
  - Update [plans/index.md](index.md) when status changes.
- Exit criteria:
  - `cd apps/ios && swift test` passes.
  - Simulator tests pass or the exact environmental blocker is documented.
  - Live smoke confirms assistant text still streams incrementally from gateway-owned `thread_view.patch` events.

## Verification

- `cd apps/ios && swift test`
- XcodeBuildMCP simulator build/test for the `KodexIOS` scheme after `session_show_defaults`.
- Live checks when available:
  - `apps/ios/scripts/run-live-e2e.sh`
  - `apps/ios/scripts/run-live-e2e-api-scenarios.sh`
- Static ownership checks:
  - `rg -n "LiveUpdateEvent|LiveUpdateParser|SelectedThreadProjection" apps/ios/Sources apps/ios/Tests`
  - `rg -n "thread_view.patch|timeline.item_delta" apps/ios/Sources apps/ios/Tests`

## Risks And Open Questions

- Removing legacy parser types may reveal tests that were acting as broad milestone coverage. Replace them with canonical `GatewayLiveEventDecoder` coverage instead of deleting coverage outright.
- `ConnectionView.swift` already owns many live-client responsibilities. Extracting a coordinator could help, but only if it keeps the gateway-owned thread projection obvious and does not introduce hidden state.
- The native `TimelineRow` model is intentionally lighter than the web canonical row model. Richer rendering parity should stay in a separate UI plan unless a streaming correctness bug requires more fields.
- Malformed live events should prefer snapshot recovery over silent dropping, but repeated malformed events need a bounded retry/status path so the UI does not loop indefinitely.

## Implementation Notes

- Status: Complete.
- Removed the legacy `LiveUpdateEvent` / `LiveUpdateParser` path from `KodexCore` and the stale `SelectedThreadProjection` helper from `KodexAPI`.
- Added `GatewaySSELineParser` and `GatewayEventStreamResponseValidator` so the async SSE boundary is explicit and testable while `GatewayEventStream.envelopes()` remains the single live gateway stream entry point.
- Replaced legacy parser/projection tests with canonical `GatewayLiveEventDecoder`, SSE line parser, HTTP response validation, patch reducer, and patch batch coalescing coverage.
- Kept selected-stream UI ownership unchanged because the existing `ConnectionView` / `ConnectionModel` path already cancels buffered patch flushes on thread changes and applies patches through the Core reducer without a second transcript source of truth.
- Verification completed:
  - `cd apps/ios && swift test` passed with 56 Swift tests after rerunning with sandbox escalation for SwiftPM cache access.
  - XcodeBuildMCP `test_sim` was attempted after configuring `/Users/example/kodex/apps/ios/KodexIOS.xcodeproj`, scheme `KodexIOS`, and an iPhone 17 Pro simulator, but the tool timed out after 120 seconds before returning a result.
  - Fallback simulator verification with `xcodebuild test -project apps/ios/KodexIOS.xcodeproj -scheme KodexIOS -destination 'platform=iOS Simulator,id=9F25D136-BDC8-4D9C-B435-265F27007F79' -derivedDataPath apps/ios/DerivedData` passed after sandbox escalation, including 56 Swift tests and 13 UI tests with 2 expected skips.
  - Static ownership checks passed: no `LiveUpdateEvent`, `LiveUpdateParser`, `SelectedThreadProjection`, or `timeline.item_delta` references remain in iOS source/tests.
  - Live gateway E2E was run against `http://127.0.0.1:8787` after confirming gateway readiness. `apps/ios/scripts/run-live-e2e.sh` passed the live API scenarios and the `KodexIOSLiveE2E` UI smoke. The script then failed at the final APNS fixture step because no simulator remained booted after `xcodebuild test`; the final fixture was completed manually by booting the iPhone 17 Pro simulator, launching `dev.kodex.KodexIOS --ui-testing --fixture-connected`, pushing `apps/ios/Fixtures/unread-agent-message.apns`, and confirming `lastNotificationRouteThreadID == fixture-thread`.
