# Thread View Item-Delta Bandwidth Guardrails Plan

## Context

Selected-thread SSE traffic can become dominated by repeated full turn patches while an assistant message streams. A deterministic local stress run reproduced the issue:

Status: Complete. Implemented canonical selected-thread `thread_view.item_delta` streaming with an initial base patch, terminal/stale delta suppression, selected-stream-only delta delivery, frontend append/recovery handling, focused regression tests, and before/after benchmark coverage.

```sh
KODEX_BASE_URL=http://127.0.0.1:8787 \
KODEX_CREATE_THREAD=1 \
KODEX_PROJECT_CWD=/Users/example/kodex \
KODEX_PROMPT='Write a detailed 12000-word technical analysis of this repository architecture. Stream the answer naturally and include sectioned detail.' \
KODEX_TIMEOUT_MS=300000 \
apps/gateway/scripts/profile-sse-bytes.mjs > /tmp/kodex-sse-before.json
```

Observed baseline:

- `1390.73 MiB` over `157.985s`
- `528.17 MiB/min`
- `5864` events
- `5855` `thread_view.patch` events
- average `thread_view.patch` size: `249065` bytes
- max `thread_view.patch` size: `266151` bytes

Final after benchmark:

- `40.49 MiB` over `300.446s`
- `8.09 MiB/min`
- `1034` events
- `161` `thread_view.patch` events
- `858` `thread_view.item_delta` events
- max `thread_view.item_delta` size: `629` bytes

The current hotspot is `apps/gateway/src/events.rs::timeline_item_delta_event`: each app-server `item/agentMessage/delta` updates the in-memory thread view and emits a full `thread_view.patch` for the affected turn. As the turn accumulates rows and assistant text, every small text delta retransmits the whole turn.

The upstream Codex app-server lifecycle supports a more compact client shape: item-specific deltas arrive between item start and completion, and final item state remains authoritative. The upstream TUI is useful inspiration for the UI model: committed transcript state plus a mutable active streaming cell. The wire contract remains the generated app-server schema and README, not TUI internals.

## Current State

- `apps/gateway/src/events.rs` emits `thread_view.patch` for each assistant text delta.
- `apps/gateway/src/thread_view.rs` already accumulates assistant delta text into the gateway-owned canonical thread view.
- `apps/web/src/events/stream.ts` does not subscribe to `thread_view.item_delta`.
- `apps/web/src/timeline/useSelectedThreadTimeline.ts` and `useReadonlyThreadTimeline.ts` only treat `thread_view.patch` as canonical render events.
- `apps/web/src/timeline/reducer.ts` applies canonical snapshots and patches, but has no current `thread_view.item_delta` path.
- `plans/streaming-delta-performance.md` is complete but historical; it targeted the older `timeline.item_delta` and `timeline.projection_patch` contract.
- `AGENTS.md` now explicitly requires visible timeline rendering to consume gateway canonical snapshots, `thread_view.patch`, and canonical text-only `thread_view.item_delta` events only.

## Recommendation

Restore a canonical, compact `thread_view.item_delta` event for live assistant text streaming, while keeping snapshots and structural/final `thread_view.patch` events as the source of truth.

This preserves multi-client behavior because deltas are an optimization for clients currently attached to a selected thread. Any client that reconnects, opens late, misses deltas, or sees an out-of-order base refetches the gateway-owned thread detail snapshot or converges through later canonical patches. The browser never owns durable transcript truth.

## Milestones

### 1. Add Failing Bandwidth And Contract Tests

Scope:

- `apps/gateway/src/events/tests.rs`
- `apps/gateway/src/routes/mod.rs`
- any existing selected-thread SSE test helpers

Work:

- Add a backend contract test that injects synthetic `item/agentMessage/delta` app-server notifications and expects live selected-thread SSE to emit `thread_view.item_delta`, not a turn-scoped `thread_view.patch`.
- Add a replay/reconnect test proving historical selected-stream replay does not replay every ephemeral delta. If a cursor gap can include missed deltas, emit or preserve `thread_view.refresh_required` so the client refetches the canonical snapshot.
- Add a deterministic serialized byte-budget test around repeated synthetic deltas. The test should compare compact delta output against the old full-turn patch shape or a fixed maximum budget, so a future regression fails without needing a live model run.
- Keep tests strict about event names: do not reintroduce visible raw `timeline.item_delta`.

Exit criteria:

- The new tests fail against the current implementation for the expected reason: text deltas still produce oversized `thread_view.patch` events.

### 2. Implement Gateway `thread_view.item_delta`

Scope:

- `apps/gateway/src/events.rs`
- `apps/gateway/src/events_replay.rs`
- `apps/gateway/src/thread_view.rs`
- focused backend tests

Work:

- Introduce `THREAD_VIEW_ITEM_DELTA_EVENT_KIND` and a compact payload containing at least `threadId`, `turnId`, `itemId`, `delta`, and a comparable cursor or view watermark.
- In `timeline_item_delta_event`, continue updating the gateway-owned in-memory thread view so snapshots and final patches stay authoritative.
- Emit live `thread_view.item_delta` for app-server assistant text deltas instead of emitting full `thread_view.patch` for every delta.
- Keep `thread_view.patch` for structural changes, lifecycle changes, item completion/final state, approvals, warnings, errors, and any event where compact append semantics are not valid.
- Treat compact deltas as live-only selected-thread traffic. Store only the minimal cursor/watermark needed for ordering and recovery; do not persist or replay transcript text as browser history.
- Update replay classification so selected-stream reconnects converge through patches, operational events, and `thread_view.refresh_required` when needed.

Exit criteria:

- Focused gateway tests pass.
- Selected-thread live traffic contains many small `thread_view.item_delta` events and only bounded structural/final `thread_view.patch` events.

### 3. Implement Web Delta Rendering

Scope:

- `apps/web/src/events/stream.ts`
- `apps/web/src/timeline/useSelectedThreadTimeline.ts`
- `apps/web/src/timeline/useReadonlyThreadTimeline.ts`
- `apps/web/src/timeline/reducer.ts`
- `apps/web/src/timeline/batch.ts`
- focused frontend tests

Work:

- Subscribe EventSource clients to `thread_view.item_delta`.
- Let selected and read-only thread timeline hooks route `thread_view.item_delta` as a canonical render event.
- Add a reducer helper that appends delta text to the matching assistant row or item by `threadId`, `turnId`, and `itemId`.
- If the matching base row is missing, stale, or no longer appendable, trigger the existing snapshot recovery path instead of inventing durable client state.
- Coalesce same-frame delta bursts by thread/turn/item before reducer application.
- Preserve patch and snapshot authority: final/structural `thread_view.patch` events can overwrite or reconcile any live text projection.

Exit criteria:

- Frontend tests prove deltas append into one assistant row, coalesce, do not duplicate after final patches, and recover through snapshots when the base is missing.
- Guardrail tests continue to reject raw app-server timeline events as visible transcript sources.

### 4. Standardize Regression Coverage

Scope:

- `apps/gateway/scripts/profile-sse-bytes.mjs`
- backend byte-budget tests
- frontend timeline tests
- `README.md` if event-stream documentation changes
- generated OpenAPI/frontend API artifacts if public DTOs change

Work:

- Keep `apps/gateway/scripts/profile-sse-bytes.mjs` as the manual before/after profiler. Its top-of-file docs should remain the source for local usage.
- Add an automated synthetic bandwidth guard that runs in normal backend tests and fails if assistant text deltas serialize as full turn patches again.
- If the new payload becomes part of generated API schema, regenerate the gateway OpenAPI output and `apps/web/src/api/generated/schema.ts`.
- Update README event-stream wording from patch-only selected-thread streaming to patch plus canonical text-only item deltas.
- Leave `AGENTS.md` unchanged unless implementation reveals a workflow or ownership rule that needs correction; its current timeline ownership rule already points to this direction.

Exit criteria:

- A normal focused test run catches the old regression without needing a live LLM.
- Manual profiler remains available for real end-to-end confirmation.

### 5. Redo And Compare The Benchmark

Run the same prompt before and after the implementation against the same local gateway shape.

Before:

```sh
KODEX_BASE_URL=http://127.0.0.1:8787 \
KODEX_CREATE_THREAD=1 \
KODEX_PROJECT_CWD=/Users/example/kodex \
KODEX_PROMPT='Write a detailed 12000-word technical analysis of this repository architecture. Stream the answer naturally and include sectioned detail.' \
KODEX_TIMEOUT_MS=300000 \
apps/gateway/scripts/profile-sse-bytes.mjs > /tmp/kodex-sse-before.json
```

After:

```sh
KODEX_BASE_URL=http://127.0.0.1:8787 \
KODEX_CREATE_THREAD=1 \
KODEX_PROJECT_CWD=/Users/example/kodex \
KODEX_PROMPT='Write a detailed 12000-word technical analysis of this repository architecture. Stream the answer naturally and include sectioned detail.' \
KODEX_TIMEOUT_MS=300000 \
apps/gateway/scripts/profile-sse-bytes.mjs > /tmp/kodex-sse-after.json
```

Compare:

```sh
node -e 'const fs=require("fs"); for (const p of ["/tmp/kodex-sse-before.json","/tmp/kodex-sse-after.json"]) { const r=JSON.parse(fs.readFileSync(p,"utf8")); console.log(p, {rawPerMinute:r.rawPerMinuteHuman, bytesPerMinute:r.rawBytesPerMinute, events:r.events, top:r.byKind?.[0], largest:r.largestEvents?.[0]}); }'
```

Success target:

- `thread_view.item_delta` is the top event by count during assistant streaming.
- `thread_view.patch` count is bounded to structural/final updates, not one event per text delta.
- Max live text event size is small and stable as the turn grows.
- Stress-test bytes per minute drop by at least `90%` from the `528.17 MiB/min` baseline, with an aspirational target below `25 MiB/min` for this prompt.

## Verification

- `cargo fmt`
- Focused gateway tests for event ingestion, selected-thread SSE live delivery, replay/reconnect, and byte budgets.
- `cd apps/web && npm test -- --run src/events/stream.test.ts src/timeline/reducer.lifecycle.test.ts src/timeline/batch.test.ts src/timeline/threadViewGuard.test.ts`
- `cd apps/web && npm run build`
- Browser validation against the local app: start a long streaming turn, confirm text streams visibly, reconnect/open a second client, and confirm both clients converge without console errors.
- Manual profiler before/after commands from Milestone 5.
- Independent review pass before marking complete.

## Multi-Client Correctness

This plan preserves multi-client thread viewing by keeping gateway snapshots and patches authoritative. Deltas only improve live rendering for clients already attached to the selected stream.

Required test shapes:

- Two clients open the same selected thread before a long response starts; both receive live `thread_view.item_delta` events and converge on the same final snapshot/patch.
- One client opens mid-stream after missing earlier deltas; it must render from the current thread detail snapshot and then append later deltas.
- One client reconnects from an old cursor that cannot safely replay missed deltas; it must receive `thread_view.refresh_required` or otherwise refetch the canonical snapshot.
- A stale tab must not overwrite or derive durable transcript state from local delta order.

## Risks

- Compact append semantics are only valid for text assistant deltas. Other app-server delta methods should continue through patch or refresh paths until they get their own explicit compact contract.
- If payload ordering uses only event-store cursors, selected streams must handle raw notification cursors and synthetic thread-view cursors consistently.
- Over-aggressive frontend coalescing can hide ordering bugs. Coalescing should merge only deltas with the same thread, turn, and item identity.
- The live benchmark depends on model behavior and prompt length. The automated synthetic byte-budget test is the standard regression guard; the live profiler is supporting evidence.
