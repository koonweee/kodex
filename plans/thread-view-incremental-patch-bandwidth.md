# Thread View Incremental Patch Bandwidth Plan

## Status

Proposed.

## Context

Recent selected-thread SSE trimming removed the largest assistant text-delta problem, but a real local Codex model run still shows the wire dominated by repeated cumulative turn patches.

Live profile against a local gateway on `127.0.0.1:8791`:

- Long prompt, interrupted at `180.48s`: `34.02 MiB`, `3405` events, `thread_view.patch` was `33,695,776` bytes (`94.4%`), `155` patch events, average patch `217,392` bytes, max patch `437,723` bytes.
- Short prompt, completed at `47.404s`: `4.91 MiB`, `573` events, `thread_view.patch` was `4,839,953` bytes (`93.9%`), `60` patch events, average patch `80,666` bytes, max patch `158,251` bytes.
- In both runs, `thread_view.item_delta` stayed compact at about `610` bytes per event and no `full_snapshot` patches were observed.

The current hotspot is not SSE framing or terminal full snapshots. It is live `thread_view.patch` events with scope `turn`, especially activity, reasoning, work, and assistant row updates that resend every canonical row for the affected active turn. Frontend patch batching reduces render churn after bytes arrive, but it does not reduce wire size.

## Current State

- `apps/gateway/src/thread_view_patch.rs` exposes `ThreadViewPatchScope::{FullSnapshot, Turn, Lifecycle}`. Turn patches replace all rows for `affectedTurnIds`.
- `apps/gateway/src/thread_view.rs` returns `view.turn_patch(turn_id)` from item upserts and turn-status updates. Text deltas update the in-memory view and emit compact `thread_view.item_delta`, but non-text live updates still use complete turn replacement.
- `apps/gateway/src/events.rs` validates and emits synthetic `thread_view.patch` events through `thread_view_patch_payload_event`.
- `apps/web/src/timeline/reducer.ts` applies `turn` patches by removing every existing row whose `turnId` is in `affectedTurnIds`, then appending the patch rows.
- `apps/web/src/timeline/batch.ts` coalesces complete turn patches within a browser batch. This is useful for UI work, but it cannot reduce network bytes.
- Generated OpenAPI artifacts and generated web API types include the current three patch scopes, so any new scope must be added as a public contract change.

## Recommendation

Add an incremental row patch scope named `row_delta`, with explicit row upserts and row removals. Keep full snapshots and complete turn patches as authoritative recovery, finalization, and reshape tools.

Contract shape:

- Add `ThreadViewPatchScope::RowDelta`, serialized as `row_delta`.
- Add `removed_row_ids: Vec<String>` to `ThreadViewPatch`, serialized as `removedRowIds` and omitted when empty.
- Reuse `rows` for changed or newly inserted canonical `ThreadTimelineRow` values.
- Require `affectedTurnIds` for `row_delta`.
- Validate that every row in a `row_delta` belongs to one of the affected turns.
- Validate that a `row_delta` contains at least one changed row or one removed row id.
- Define omission as preservation: a row omitted from `rows` is not deleted unless its id is present in `removedRowIds`.

Backend emission should compute a before/after row diff for the affected turn and send `row_delta` only when it is smaller and semantically unambiguous. It should fall back to complete `turn` patches for terminal turn finalization, grouping reshapes, missing base rows, broad removals, or any case where the serialized row delta is not smaller than the complete turn patch.

This is the recommended fix because it targets the measured hotspot directly while preserving the current convergence model: snapshots and complete turn patches remain canonical, and incremental patches are only a bandwidth optimization for live row changes.

## Non-Goals

- Do not update native iOS in this plan. Backend and web changes should not be blocked on iOS decoder, reducer, generated artifact, SwiftPM, simulator, or fixture work.
- Do not attempt long-term compatibility for older clients that do not understand `row_delta`; this repository's active web client is the implementation target for this bandwidth pass.

## Milestones

### 1. Add Failing Regression Tests Before Refactoring

Scope:

- `apps/gateway/src/thread_view/tests.rs`
- `apps/gateway/src/events/tests.rs`
- `apps/web/src/timeline/reducer.snapshot.test.ts`
- `apps/web/src/timeline/batch.test.ts`

Work:

- Add a backend byte-budget regression that builds a large active turn with user, activity, reasoning, work, and assistant rows, then applies repeated non-text live row updates. The desired future behavior is `row_delta`, not repeated complete `turn` patches.
- Add backend validation tests for `row_delta`: valid row upsert, valid explicit removal, invalid empty patch, invalid row outside `affectedTurnIds`, and invalid lifecycle/full-snapshot field combinations.
- Add backend event tests proving terminal turn finalization still emits a complete `turn` patch or snapshot path, not a lossy row delta.
- Add frontend reducer tests proving `row_delta` upserts only listed rows, preserves omitted same-turn rows, removes explicit `removedRowIds`, and requests recovery or ignores safely when the base state is not compatible.
- Add frontend batch tests proving row deltas coalesce by thread/turn/row without crossing full snapshots, refresh-required events, or item-delta ordering boundaries.

Exit criteria:

- The new tests fail against the current implementation for the expected reason: `row_delta` does not exist and live row changes still serialize as cumulative turn patches.
- The tests document byte budgets and fallback behavior before production code changes start.

### 2. Extend The Public Patch Contract

Scope:

- `apps/gateway/src/thread_view_patch.rs`
- `apps/gateway/src/app_server_api.rs` if schema annotations or DTO references need updates
- `apps/web/src/api/generated/schema.ts`

Work:

- Add `ThreadViewPatchScope::RowDelta`.
- Add `removed_row_ids` / `removedRowIds` to the patch payload.
- Update validation so each scope has explicit allowed and required fields.
- Regenerate OpenAPI and web generated API artifacts.
- Keep the browser-visible event name as `thread_view.patch`; only the patch scope changes.

Exit criteria:

- Generated contracts include `row_delta` and `removedRowIds`.
- Existing clients still decode `full_snapshot`, `turn`, and `lifecycle` unchanged.

### 3. Implement Backend Row-Diff Emission

Scope:

- `apps/gateway/src/thread_view.rs`
- `apps/gateway/src/thread_view_patch.rs`
- `apps/gateway/src/events.rs`
- focused backend tests

Work:

- Add a helper that captures affected-turn rows before and after a live mutation and diffs by stable row id.
- Add a `ThreadViewPatch::row_delta(...)` constructor.
- Route safe live item upserts and non-terminal row updates through row-delta emission.
- Keep compact `thread_view.item_delta` for assistant text deltas.
- Keep complete `turn` patches for terminal turn status, final item materialization, row grouping changes, context compaction, and any update that would require omission-based deletion.
- Compare serialized `row_delta` and `turn` patch sizes before emission. If the delta is not smaller, emit the existing complete turn patch.

Exit criteria:

- Focused backend tests pass.
- Synthetic repeated live row updates produce bounded `row_delta` wire bytes instead of cumulative turn patch bytes.

### 4. Implement Web Reducer And Batch Support

Scope:

- `apps/web/src/timeline/reducer.ts`
- `apps/web/src/timeline/batch.ts`
- `apps/web/src/timeline/useSelectedThreadTimeline.ts`
- `apps/web/src/timeline/reducer.snapshot.test.ts`
- `apps/web/src/timeline/batch.test.ts`

Work:

- Accept `row_delta` in patch-scope validation.
- Apply row upserts by stable row id while preserving all omitted rows.
- Apply `removedRowIds` explicitly and only for matching selected-thread state.
- Preserve stale-patch and refresh-required behavior when the reducer cannot apply a row delta safely.
- Update hidden diagnostic row bookkeeping for changed and removed rows.
- Update `patchMentionsDeltaTarget` so compact assistant deltas remain ordered around row deltas.
- Coalesce row deltas only when they share compatible thread, turn, and row identities.

Exit criteria:

- Frontend tests pass.
- The browser still treats gateway thread detail snapshots, `thread_view.patch`, and text-only `thread_view.item_delta` as the only visible timeline sources.

### 5. Reprofile And Document The Result

Scope:

- `apps/gateway/scripts/profile-sse-bytes.mjs`
- `README.md` if selected-stream documentation changes
- this plan and `plans/index.md` status updates during implementation

Work:

- Extend the profiler summary if needed so it reports `row_delta` counts, bytes, max event size, and patch-scope breakdown.
- Rerun the real Codex model-call profiler with the same short and long prompts after implementation.
- Compare total bytes, bytes per event kind, max `thread_view.patch` size, and event counts against the observed baseline.
- Update README only if the public event-stream behavior described there changes.

Exit criteria:

- Live profiling shows `thread_view.patch` no longer dominates selected-thread bytes for the measured prompts.
- Automated synthetic tests remain the primary regression guard, with live profiler output as supporting evidence.

## Regression Test Strategy

The implementation must start with failing tests because the contract change is user-visible for the web client.

Minimum automated coverage:

- Backend scope validation and serialized byte-budget tests for repeated large active-turn row updates.
- Backend selected-stream event tests proving safe live updates emit `row_delta` and terminal/final updates still emit complete `turn` patches.
- Frontend reducer tests for row upsert, preservation, explicit removal, stale patch handling, and interaction with text-only item deltas.
- Frontend batch tests for row-delta coalescing and ordering boundaries.

Manual/live coverage:

- Run the selected-thread profiler with actual Codex model calls before and after the change, using the same prompts and gateway shape.
- Start gateway plus web client, run a live response, verify visible streaming, no console errors, reconnect behavior, and same-thread convergence in a second client.

## Verification

- `cargo fmt`
- Focused gateway tests for `thread_view`, event ingestion, selected-thread SSE, and byte budgets.
- `cd apps/web && npm test -- --run src/events/stream.test.ts src/timeline/reducer.snapshot.test.ts src/timeline/batch.test.ts src/timeline/reducer.lifecycle.test.ts src/timeline/threadViewGuard.test.ts`
- `cd apps/web && npm run build`
- Browser validation of a live selected-thread stream and same-gateway second client convergence.
- Independent review pass before marking the plan complete.

## Regression Risk

Expected regression risk is manageable for the active web client if backend contract, generated web types, reducer support, and byte-budget tests ship in the same implementation chunk.

Known risks:

- Older clients that do not understand `row_delta` may request refreshes or ignore patches. Native iOS is explicitly out of scope for this plan, so any future native follow-up should decide whether to support `row_delta` or force snapshot refreshes.
- Row id stability is now more important. If a live update changes grouping or row identity, the backend should emit a complete `turn` patch instead of a row delta.
- Work rows can still be large. If repeated updates replace a single very large work row, this plan reduces cross-row duplication but may not fully solve work-row payload size. A narrower work-row delta would be a follow-up only if profiling still shows that hotspot.
- A stale or missed base state can make an incremental patch unsafe. Reducers must converge by snapshot refresh rather than inventing durable browser state.
- Live model profiles vary by prompt and model behavior, so automated synthetic byte-budget tests are the durable regression guard.
