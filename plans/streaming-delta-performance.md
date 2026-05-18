# Streaming Delta Performance Plan

## Context
- Assistant message streaming currently slows as a thread grows because each app-server assistant delta is folded into the gateway thread session view and broadcast as a full `timeline.projection_patch`.
- The target change is to make assistant deltas lightweight and ephemeral: selected live clients receive compact text deltas, while replay/reconnect correctness comes from canonical snapshots and lower-frequency projection patches.
- Notification behavior is intentionally out of scope.

## Current State
- `apps/gateway/src/events.rs` ingests app-server notifications in `ingest_inbound`, persists a `codex.notification` cursor, normalizes timeline updates, and sends only selected event kinds over `/v1/events`.
- `timeline_item_delta_event` currently appends a `timeline.snapshot_required` cursor through `append_timeline_changed_cursor`, updates `ThreadSessionStore`, then emits `timeline.projection_patch` for every delta.
- `apps/gateway/src/thread_session_view.rs` already keeps the active in-memory text up to date through `record_item_delta`, and ignores late deltas after terminal turns.
- `apps/web/src/events/stream.ts` subscribes to named gateway SSE events. `apps/web/src/timeline/useSelectedThreadTimeline.ts` and `useReadonlyThreadTimeline.ts` currently render only `timeline.snapshot` and `timeline.projection_patch`.
- `apps/web/src/timeline/reducer.ts` has snapshot/patch application as the canonical path, and `apps/web/src/timeline/batch.ts` already coalesces same-frame projection patch bursts.
- Replay is already operational-first: selected thread streams replay projection patches and snapshot-required events, while raw transcript history is not the browser's durable source of truth.

## Milestones

### 1. Gateway Ephemeral Delta Events
- Scope: `apps/gateway/src/events.rs`, `apps/gateway/src/routes/mod.rs`, and nearby backend tests.
- Work:
  - Introduce a compact `timeline.item_delta` event shape containing `threadId`, `turnId`, `itemId`, `delta`, and any available item/message phase metadata.
  - Keep `thread_session_view::record_item_delta` so later patches and snapshots can include the accumulated live text.
  - Stop persisting `timeline.snapshot_required` cursors for assistant deltas and stop broadcasting full `timeline.projection_patch` for each delta.
  - Broadcast delta events live with a monotonic cursor high-water based on the already-persisted raw cursor, but do not make them replayable from the event store.
  - Keep projection patches for structural updates such as item upsert/completion, approval changes, turn completion, and thread status changes.
- Exit criteria:
  - Backend tests prove `item/agentMessage/delta` broadcasts `timeline.item_delta`, does not persist transcript delta text, and does not emit a projection patch per delta.
  - SSE tests prove live selected-thread streams receive `timeline.item_delta`, while replay after a cursor does not replay old deltas.

### 2. Frontend Incremental Delta Rendering
- Scope: `apps/web/src/events/stream.ts`, `apps/web/src/timeline/reducer.ts`, `apps/web/src/timeline/batch.ts`, selected/read-only timeline hooks, and focused timeline tests.
- Work:
  - Subscribe the EventSource client to `timeline.item_delta`.
  - Let selected and read-only timeline hooks treat `timeline.item_delta` as a render event.
  - Add reducer support that appends delta text to the matching assistant item, creating a running placeholder assistant item when the first delta arrives before an item patch.
  - Preserve snapshot/projection patch authority: completed item patches and snapshots can overwrite or reconcile the temporary live text.
  - Coalesce same-frame delta bursts by thread/turn/item before applying reducer updates.
- Exit criteria:
  - Frontend tests prove deltas append into one assistant row, same-frame deltas coalesce, stale lower-seq deltas do not overwrite newer canonical state, and snapshots/patches still reconcile final text.
  - Existing projection patch batching tests still pass.

### 3. Verification And Review
- Scope: focused automated checks plus independent review.
- Work:
  - Run focused backend tests for event ingestion/SSE behavior.
  - Run focused frontend Vitest suites for event stream, timeline reducer lifecycle, and batching.
  - Run `cargo fmt` and the relevant frontend type/test checks if touched generated types or TypeScript contracts require it.
  - Use an independent review pass from `$implement-review-loop`; browser validation is not required because this is transport/reducer behavior and can be covered with unit/integration tests.
- Exit criteria:
  - All focused checks pass or any blocker is documented.
  - Review reports no major issues against this plan and the user request.

## Verification
- `cargo fmt`
- Focused gateway tests around `notification_ingest_emits_normalized_timeline_delta` and selected-thread SSE replay/live behavior.
- Focused web tests: `cd apps/web && npm test -- --run src/events/stream.test.ts src/timeline/reducer.lifecycle.test.ts src/timeline/batch.test.ts`
- Broader checks only if focused verification exposes shared-contract risk.

## Risks And Open Questions
- The gateway still persists a redacted raw `codex.notification` cursor for app-server transcript methods. That is acceptable for monotonic sequence tracking, but text payloads must remain redacted.
- If `timeline.item_delta` becomes part of the generated public OpenAPI contract later, generated frontend types may need regeneration. The initial implementation can keep using the existing generic `EventEnvelope` payload shape.
- If upstream emits non-assistant `/delta` methods with different semantics, the implementation should restrict compact text rendering to assistant/agent message delta methods rather than every method ending in `/delta`.
