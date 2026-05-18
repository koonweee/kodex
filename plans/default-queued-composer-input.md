# Default Queued Composer Input Restoration Plan

## Status

Complete.

## Validation Record

- `cargo fmt --check` passed.
- `cargo test -p kodex-gateway routes::tests::thread_input_ --lib` passed with 6 focused routing tests.
- Full `cargo test` passed after rerunning outside the sandbox for the MCP preview test that cannot bind under the default sandbox.
- `cd apps/web && npm test -- App.mvp.composer-input.test.tsx` passed.
- `cd apps/web && npm test` passed.
- `cd apps/web && npm run build` passed with the existing chunk-size warning.
- Browser validation used local Vite at `http://127.0.0.1:5175/threads/thread-1` with a mock gateway at `127.0.0.1:18788`: sending during an active turn displayed a queued row, reloading the thread showed the same shared queued row from `GET /queued-inputs`, and clicking `Steer` moved the row into `Steering...` pending state instead of deleting it immediately.
- Independent review pass found no major correctness issues after implementation; the only low finding was to record this validation in the plan.

## Context

Normal composer sends during an active turn should create a durable per-thread queued input by default. Users can explicitly steer a queued message into the active turn with the existing per-row `Steer` action. The queued rows must remain gateway-owned and visible to all browser clients connected to the same gateway through `GET /v1/threads/{threadId}/queued-inputs` and `turn_queue.*` SSE events.

This restores the behavior introduced by the gateway queue persistence work: the queue is shared, durable, and not browser-local. The current regression came from the later `POST /v1/threads/{threadId}/input` route becoming steer-first for active turns.

## Pre-Implementation State

Code-established facts at plan creation:

- `apps/gateway/src/routes/turns.rs::submit_thread_input` checked `turn_lifecycle::current_active_turn_id` and called app-server `turn/steer` when a turn was active. It returned `ThreadInputDisposition::Steered`.
- `apps/web/src/composer/useComposerOrchestration.ts::handleSubmitTurn` sends existing-thread composer input to `submitThreadInput`. If the response includes `queuedInput`, it upserts the row and renders the queue.
- Durable queue routes still exist in `apps/gateway/src/queue.rs`: list, create, retry, delete, and explicit `POST /v1/threads/{threadId}/queued-inputs/{queueId}/steer`.
- `apps/web/src/composer/QueuedSteerCard.tsx` still renders queued rows with `Steer`, `Retry`, and abort controls.
- Queue rows are already synchronized through `turn_queue.item_upsert` and `turn_queue.item_deleted`, with frontend cache merge protection in `apps/web/src/queuedInputs/cache.ts`.
- `apps/gateway/src/routes/self_control.rs::send_self_control_thread_input` already documents and implements the intended routing shape: idle threads start a turn, active threads receive source-labeled queued input.

Constraints:

- Shared thread/queue state belongs to the gateway or app-server, not React local state.
- Frontend API types must continue to come from generated OpenAPI.
- Visible timeline rendering must keep consuming canonical thread view snapshots/patches; queue state is operational state, not transcript history.
- Same-user, two-client behavior matters for any shared thread state change.

## Target Behavior

- Normal composer submit to an existing active thread:
  - Browser calls `POST /v1/threads/{threadId}/input`.
  - Gateway refreshes from app-server readback and uses that snapshot as the routing authority, updating `ThreadView` as a projection side effect. Cached `ThreadView` active state alone must not queue input because it can be stale.
  - Gateway creates a queued input row with the resolved `UserInput[]` and saved `TurnStartOptions`.
  - Gateway broadcasts `turn_queue.item_upsert`.
  - Gateway returns `ThreadInputResponse { disposition: "queued", queuedInput, rawPayload: null }`.
  - Browser clears the composer and displays the queued row from gateway state.
- Normal composer submit to an idle or not-yet-materialized thread:
  - Gateway starts a turn and returns `disposition: "started"` as today.
- Explicit queued-row steer:
  - `POST /v1/threads/{threadId}/queued-inputs/{queueId}/steer` keeps the existing pending-commit lifecycle.
- Raw explicit turn steer:
  - `POST /v1/threads/{threadId}/turns/{turnId}/steer` remains available for direct explicit callers.

## Non-Goals

- No browser-local queue fallback.
- No multi-gateway distributed queue.
- No change to queue row storage shape unless tests expose a bug.
- No change to app-server `turn/steer` wire contract.
- No new timeline event replay or transcript persistence.

## Milestones

### 1. Lock Backend Default Routing With Failing Tests

Scope: `apps/gateway/src/routes/mod.rs`, `apps/gateway/src/routes/turns.rs`, `apps/gateway/src/turn_lifecycle.rs`, `apps/gateway/src/queue.rs`.

Work:

- Replace or rename tests that currently assert `thread_input_steers_when_app_server_has_active_turn` and `thread_input_steers_when_gateway_session_has_active_turn`.
- Add backend route tests proving:
  - `/v1/threads/{threadId}/input` queues when app-server readback reports an active turn.
  - `/v1/threads/{threadId}/input` queues when app-server readback reports an active turn, including after gateway `ThreadView` already had active state.
  - active-turn `/input` does not call app-server `turn/steer`.
  - queued response includes `disposition: "queued"` and a `queuedInput` with resolved skill metadata preserved through the queue path.
  - stale active-turn state that app-server reports as no longer active starts a new turn rather than queueing indefinitely, matching the existing stale-active recovery intent.

Exit criteria:

- Focused backend tests fail before implementation.
- Tests distinguish default `/input` queueing from explicit queued-row steering.
- No frontend or production implementation is changed in this milestone beyond test scaffolding.

### 2. Restore Gateway Queue-First `/input`

Scope: `apps/gateway/src/routes/turns.rs`, `apps/gateway/src/turn_lifecycle.rs`, `apps/gateway/src/queue.rs`.

Work:

- In `submit_thread_input`, replace the active-turn `turn_steer` branch with `queue::create_queued_input_with_source`.
- Keep `save_thread_turn_options` before queue creation so later drain uses the submitted options.
- Do not create pending skill mention rows for queued default input at enqueue time unless the existing queue creation path requires it; preserve the explicit steer path's pending mention behavior.
- Preserve stale-active recovery:
  - if checking active turn requires app-server readback and app-server indicates no active turn, record idle and fall through to `turn/start`;
  - if current helper cannot express that distinction cleanly, split the helper so queue-first behavior does not turn stale active state into a stuck queue row.
- Leave `steer_turn` and `queue::steer_queued_input` behavior unchanged.

Exit criteria:

- Backend tests from milestone 1 pass.
- Existing queue drainer, pending-commit, and explicit steer tests still pass.
- `cargo fmt --check` passes.

### 3. Refresh Frontend Expectations Without Reowning Queue State

Scope: `apps/web/src/composer/useComposerOrchestration.ts`, `apps/web/src/test/gatewayMock.ts`, `apps/web/src/test/mvpAppHarness.tsx`, `apps/web/src/App.mvp.composer-input.test.tsx`, `apps/web/src/queuedInputs/cache.test.ts`.

Work:

- Keep normal composer submits calling `submitThreadInput`; do not reintroduce browser-side `activeSelectedTurnId ? createQueuedInput(...) : startTurn(...)` routing.
- Update test mocks so fallback `/input` can return `disposition: "queued"` in active-thread scenarios.
- Update composer tests to assert:
  - sending during an active turn shows the queued card from the `/input` response;
  - the browser does not call `/queued-inputs` directly for default submit if `/input` is the gateway-owned command;
  - clicking the queued row `Steer` still calls `/queued-inputs/{queueId}/steer`;
  - the composer remains blocked only for the submit request, not until canonical timeline user-message commit for queued responses.
- Keep queue upsert/delete cache merge tests as the multi-client state source.

Exit criteria:

- Focused composer tests pass.
- No new ad hoc frontend DTOs are introduced.
- `npm test -- App.mvp.composer-input.test.tsx` or the nearest supported focused Vitest command passes.

### 4. Prove Multi-Client Queue Convergence

Scope: backend SSE route tests and frontend app/harness tests.

Work:

- Add or update a backend test proving:
  - client A posts `/input` during an active turn;
  - gateway persists a queue row;
  - `GET /v1/threads/{threadId}/queued-inputs` from client B returns that row;
  - `turn_queue.item_upsert` is replayable through `/v1/events` for reconnecting clients.
- Add or update frontend tests proving:
  - a queued row created by an SSE upsert appears without local submit state;
  - a stale `GET /queued-inputs` snapshot cannot resurrect a row deleted by SSE;
  - selected-thread switch hides another thread's queue without deleting it.
- Keep the queue row keyed by `threadId` in query cache and apply `mergeQueuedInputData`/tombstone helpers rather than local component arrays.

Exit criteria:

- Backend route/SSE tests pass.
- Frontend queue cache and app tests pass.
- Same-gateway multi-client behavior is covered at the store/API/event boundary and at the UI cache boundary.

### 5. Contract, Docs, And Browser Validation

Scope: `apps/gateway/src/routes/turns.rs`, generated OpenAPI artifacts, `apps/web/src/api/generated/schema.ts`, `README.md` only if behavior docs are affected, and browser-observable composer UI.

Work:

- Decide whether to keep `ThreadInputDisposition::Steered` in the public schema:
  - recommended: keep it for compatibility while no normal `/input` path returns it, unless route tests prove it is dead and safe to remove in a generated contract change.
- Regenerate OpenAPI and frontend types only if DTO/schema shape changes.
- Update README only if it currently documents steer-first `/input` behavior or queue behavior needs clarification.
- Run `$agent-browser` validation against the local web app:
  - active thread, type message, send, verify queued card appears;
  - from a second browser context or simulated reload, verify the same queued row is visible;
  - click `Steer`, verify row enters `Steering...`/`pendingCommit` state and is not deleted until queue deletion event.

Exit criteria:

- `cargo fmt --check`
- `cargo test`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- `$agent-browser` validation is recorded with the local URL and observed states.
- `plans/index.md` status is updated when implementation starts or completes.

## Risks And Open Questions

- Stale active-turn detection must not queue a message behind a turn that already ended. The plan keeps the existing stale-active recovery requirement, but implementation should inspect `turn_lifecycle::current_active_turn_id` carefully before changing it.
- The generated `ThreadInputDisposition::Steered` variant may become unused by `/input`. Keeping it is lower risk for clients, but implementers should confirm whether any tests or generated consumers depend on exact enum values.
- Queue creation currently triggers drain immediately. This is correct for idle threads and should no-op for active threads, but tests should prove active-thread default queueing does not race into a new `turn/start` before the current turn's idle event.
- Image queued rows created from another client can show text/image count, not local object URL previews. That is existing queue behavior and not part of this restoration.
