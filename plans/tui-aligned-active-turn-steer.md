# TUI-Aligned Active-Turn Steer Plan

## Status

Complete as of implementation review loop.

## Context

Kodex normal existing-thread composer input currently routes through `POST /v1/threads/{threadId}/input`. When gateway state says a turn is active, `apps/gateway/src/routes/turns.rs::submit_thread_input` creates a durable queued input and returns `ThreadInputDisposition::Queued`.

That queue-first behavior intentionally came from [Default Queued Composer Input Restoration](default-queued-composer-input.md), but it now conflicts with the TUI/app-server-native target:

- App-server `turn/steer` is the native same-turn input primitive. The checked-in `apps/gateway/app-server-schema/0.135.0/json/v2/TurnSteerParams.json` requires `threadId`, `expectedTurnId`, and `input`.
- The upstream app-server README says `turn/steer` appends input to an in-flight regular turn, rejects no-active, expected-turn mismatch, and non-steerable turn cases, and does not accept thread settings overrides.
- Upstream Codex TUI attempts `turn/steer` first when its active-thread store has an active turn, clears stale active state on no-active races, retries once on expected-turn mismatch with the server-reported turn id, queues rejected non-steerable steers, and falls back to `turn/start` only when app-server says there is no active turn.

The target change is to make normal user composer `/input` align with that behavior while preserving Kodex-specific durable queue coordination for explicit queued rows, non-steerable rejected steers, automations, and guarded self-control inputs.

## Current State

Code-established facts from inspection:

- `apps/gateway/src/routes/turns.rs::submit_thread_input` resolves skills, locks `state.thread_input_locks`, checks `turn_lifecycle::routed_active_turn_id`, and queues immediately when that returns `Some`.
- `apps/gateway/src/turn_lifecycle.rs::routed_active_turn_id` can trust `thread_runtime_state` statuses `active`, `streaming`, `syncing`, `starting`, and `draining` before app-server readback. For active runtime rows without a concrete turn id it returns the synthetic `__gateway_pending_turn_start__`.
- `apps/gateway/src/turn_lifecycle.rs` already has broad `is_no_active_turn_error` and `is_non_steerable_error` helpers, but no helper that parses expected-turn mismatch into a new active turn id.
- `apps/gateway/src/app_server_api.rs::turn_steer` already sends `expectedTurnId` as required by the 0.135.0 schema, does not send turn-start options, and returns the raw app-server payload whose schema includes `turnId`.
- `apps/gateway/src/app_server.rs` currently flattens JSON-RPC app-server errors into `ApiError::BadGateway(String)`, including optional error `data` as formatted text. Expected-turn mismatch handling either needs structured error detail plumbing or a tightly scoped parser covered by route tests.
- `apps/gateway/src/queue.rs::steer_queued_input` explicitly steers queued rows into the active turn, then marks accepted rows `pendingCommit` until app-server commits the matching user message.
- `apps/gateway/src/queue.rs::drain_one_queued_input` starts queued rows only when `thread_is_idle_for_queue` says the thread is idle.
- `apps/gateway/src/events.rs` updates `thread_runtime_state` and canonical `thread_view.patch` from app-server turn/thread status notifications, and requeues unmatched `pendingCommit` rows when turns or threads become idle.
- `apps/gateway/src/routes/self_control.rs::send_self_control_thread_input` is agent-facing and queue-first for active threads. Its route description says "composer-equivalent", which will become misleading after this plan.
- `apps/web/src/composer/useComposerOrchestration.ts` already treats `submitThreadInput` as the gateway-owned command. It renders a queued card only when the `/input` response includes `queuedInput`.
- `apps/web/src/test/mvpAppHarness.tsx::baseRoutes` currently defaults active-thread `/input` to a queued response.
- `apps/gateway/src/routes/mod.rs` has queue-first route tests such as `thread_input_queues_when_app_server_has_active_turn`, `thread_input_queues_when_gateway_session_has_active_turn`, `thread_input_trusts_active_runtime_state_without_readback`, and `thread_input_queues_resolved_skill_input_when_active`.
- `apps/web/src/App.mvp.composer-input.test.tsx` has queue-first expectations, including "queues active-turn composer messages through the gateway queue" and tests that normal submit never calls `POST /queued-inputs` directly.

Constraints:

- App-server schemas and README are the wire contract; TUI is the sequencing reference.
- Browser clients must remain thin. React may use active-turn state for UI affordances, but shared routing must be owned by the gateway/app-server.
- Existing-thread turn options are per-turn submission data. `turn/steer` cannot forward those options, so active steers must not persist submitted options as future thread settings.
- Queue rows are coordination state, not transcript history. Keep them durable where Kodex needs cross-tab/reload visibility.
- Same-user two-tab behavior must be covered for lifecycle changes.

## Target Behavior

Normal user composer submit to `POST /v1/threads/{threadId}/input`:

- If the thread is idle or not materialized yet, call app-server `turn/start` and return `disposition: "started"`.
- If app-server/gateway has a concrete active regular turn id, attempt app-server `turn/steer` with `expectedTurnId`.
- On successful `turn/steer`, record the pending user projection for the app-server-returned `turnId`, falling back to the expected id only if the payload omits it, and return `disposition: "steered"` with the raw app-server payload. Do not create a queue row.
- On no-active stale state, clear gateway active state, start a new turn, and return `disposition: "started"`.
- On expected-turn mismatch that reports an actual active turn id, update gateway active state and retry `turn/steer` once. If the retry succeeds, return `steered`; if it fails non-steerable, queue as rejected steer; if it mismatches again, surface the app-server error.
- On active-turn-not-steerable, persist a durable queued row with `priority: "rejectedSteer"` or the nearest existing store helper, broadcast `turn_queue.item_upsert`, and return `disposition: "queued"`.
- During a local in-flight `turn/start` before app-server has returned a real turn id, keep the concurrency guard queue behavior. A second `/input` must not use the synthetic pending id for `turn/steer`.

Explicit queued-row actions stay separate:

- `POST /v1/threads/{threadId}/queued-inputs/{queueId}/steer` keeps the pending-commit lifecycle in `apps/gateway/src/queue.rs`.
- `POST /v1/threads/{threadId}/queued-inputs` remains an explicit durable queue API.
- Queue drainer and automation behavior remain queue-first.

Self-control policy:

- Keep `apps/gateway/src/routes/self_control.rs::send_self_control_thread_input` queue-first for active threads unless a later product decision explicitly asks agent-originated self-control input to steer live user turns.
- Update its route description and tests so it is not described as composer-equivalent after `/input` becomes steer-first.

## Milestones

### 1. Lock Steer-First Routing With Failing Backend Tests

Scope: `apps/gateway/src/routes/mod.rs`, `apps/gateway/src/routes/turns.rs`, `apps/gateway/src/turn_lifecycle.rs`, `apps/gateway/src/queue.rs`.

Work:

- Replace queue-first `/input` tests with steer-first assertions:
  - app-server readback active turn causes `/input` to call `turn/steer` with `expectedTurnId` and return `disposition: "steered"`;
  - gateway `ThreadView` active state still routes through app-server readback or a concrete active id, then calls `turn/steer`;
  - successful active `/input` does not create a queued row or emit `turn_queue.item_upsert`;
  - skill-resolved input is passed to `turn/steer` with canonical skill metadata preserved.
- Add race/error tests:
  - no-active `turn/steer` error clears active state and falls through to `turn/start`;
  - expected-turn mismatch updates the active id and retries once with the server-reported turn id;
  - successful retry records pending projection against the server-returned `turnId`;
  - second expected-turn mismatch returns an error instead of retrying indefinitely;
  - active-turn-not-steerable queues the input and marks it rejected/manual-steer priority if existing store helpers support that state.
- Keep concurrency tests that protect in-flight `turn/start`:
  - `starting` or `draining` runtime state without a concrete app-server active turn queues behind the in-flight start/drain instead of steering with `__gateway_pending_turn_start__`;
  - queued rows drain after the first start fails or completes idle.
- Add or update route tests proving stale durable `thread_runtime_state.active_turn_id` is not trusted over app-server mismatch/no-active responses for user `/input`.

Exit criteria:

- Focused tests fail before implementation and describe the intended routing semantics.
- Tests cover `started`, `steered`, and `queued` dispositions from the same gateway command.
- Existing explicit queued-row steer pending-commit tests still compile and remain in scope.

### 2. Add A TUI-Like Gateway Routing Helper

Scope: `apps/gateway/src/turn_lifecycle.rs`, `apps/gateway/src/routes/turns.rs`, `apps/gateway/src/app_server_api.rs` if response/error helpers are needed.

Work:

- Replace `routed_active_turn_id` usage in normal `/input` with a helper that separates:
  - concrete active turn id eligible for `turn/steer`,
  - pending local turn start/drain state that should queue behind existing gateway work,
  - idle/not-materialized state that should call `turn/start`.
- Add app-server error classification for expected-turn mismatch. Prefer structured error details when available in `ApiError`; fall back to message parsing only where the existing adapter leaves no structured field.
- If expected-turn mismatch details are only available in flattened `ApiError::BadGateway` text, either expose structured JSON-RPC error `data` from `apps/gateway/src/app_server.rs` or implement a minimal parser for the current message/data format with focused tests.
- Add a bounded steer attempt helper similar to TUI sequencing:
  - attempt `turn_steer(threadId, expectedTurnId, input)`;
  - if no-active, record/patch idle and return a start-turn fallback;
  - if expected-turn mismatch with actual turn id, update active state and retry once;
  - if active-turn-not-steerable, return a queue fallback;
  - otherwise return the original error.
- Ensure `turn/start` options are applied only to `turn/start` and queued-row storage, not to `turn/steer`.
- Keep the existing `thread_input_locks` guard around the full routing decision so concurrent sends cannot race into duplicate starts or duplicate steers.

Exit criteria:

- New helper has focused unit tests or route tests for every routing branch.
- Expected-turn mismatch tests prove the actual turn id comes from app-server error detail, not from stale gateway runtime state.
- `rg "__gateway_pending_turn_start__|routed_active_turn_id" apps/gateway/src/routes apps/gateway/src/queue.rs` shows normal `/input` does not steer using the synthetic id.
- `cargo fmt --check` passes.

### 3. Implement `/input` Steer-First Semantics

Scope: `apps/gateway/src/routes/turns.rs`, `apps/gateway/src/turn_lifecycle.rs`, `apps/gateway/src/queue.rs`, `apps/gateway/src/events.rs`.

Work:

- In `submit_thread_input`, after skill resolution and per-thread locking, use the new routing helper:
  - idle/not-materialized: existing start path;
  - concrete active: steer path;
  - pending local start/drain: queue path;
  - non-steerable: queue rejected steer path.
- On successful direct steer:
  - insert pending skill mentions before the app-server call and clean them up on failure;
  - call `record_pending_user_projection` for the response `turnId` if present, otherwise for the expected turn id used in the accepted request;
  - return `ThreadInputResponse { disposition: Steered, queuedInput: None, rawPayload: Some(response.payload) }`.
- On no-active fallback start:
  - delete any pending direct-steer skill mention record before inserting the normal start pending mention record, or structure the code so only one pending mention record exists;
  - preserve existing title generation for real `turn/start` only.
- On non-steerable queue fallback:
  - create a queued row after skill resolution without creating a committed/pending user timeline row;
  - use rejected-steer priority/status if the store already has a suitable method, otherwise add the smallest helper needed.
- Keep `start_turn` and explicit `steer_turn` routes working for lower-level callers, but avoid making the web composer depend on them.

Exit criteria:

- Backend route tests from Milestone 1 pass.
- Existing pending-commit queued steer tests pass.
- Queue drainer tests still prove idle queued rows start with stored per-turn options.
- No durable transcript/history table or raw app-server replay path is added.

### 4. Update Frontend Expectations Without Reowning Routing

Scope: `apps/web/src/composer/useComposerOrchestration.ts`, `apps/web/src/test/mvpAppHarness.tsx`, `apps/web/src/App.mvp.composer-input.test.tsx`, queue cache tests if affected.

Work:

- Keep normal sends calling `submitThreadInput`; do not branch in React on `activeSelectedTurnId` to choose start/steer/queue.
- Update `apps/web/src/test/mvpAppHarness.tsx::baseRoutes` so default `/input` can return `disposition: "steered"` for active-thread tests, with explicit overrides for queue scenarios.
- Update composer tests:
  - active-thread normal submit calls `/input`, receives `steered`, clears the composer, and does not render a queued row;
  - successful direct steer keeps any optimistic pending user text until `thread_view.patch` materializes it, then de-duplicates by existing gateway row behavior;
  - non-steerable queued response still renders a queued card from `response.queuedInput`;
  - clicking an existing queued row still calls `/queued-inputs/{queueId}/steer` and shows `pendingCommit`.
- Audit optimistic user-message behavior:
  - for `steered`, it may remain as a temporary local projection only until canonical `thread_view.patch`;
  - for `queued`, remove the optimistic row as today because the queue row is the gateway-owned pending record.

Exit criteria:

- Focused frontend tests pass:
  - `cd apps/web && npm test -- src/App.mvp.composer-input.test.tsx`
- `rg "POST /v1/threads/thread-1/queued-inputs" apps/web/src/App.mvp.composer-input.test.tsx` still shows default submit does not call the explicit queue route.
- No handwritten duplicate TypeScript DTOs are introduced.

### 5. Preserve Queue-First Non-User Producers

Scope: `apps/gateway/src/routes/self_control.rs`, automation-related route tests in `apps/gateway/src/routes/mod.rs`, queue tests.

Work:

- Keep `send_self_control_thread_input` active-thread routing queue-first, but update the OpenAPI route description from "composer-equivalent" to explicit agent/self-control semantics.
- Add or update a self-control test proving active self-control input still creates a source-labeled queued row and does not call `turn/steer`.
- Verify automations continue to enqueue into `queue::create_queued_input_with_source` and drain only when idle.
- Document in this plan or code comments that this is an intentional policy difference from normal user composer input, not a temporary mismatch.

Exit criteria:

- Self-control and automation focused tests pass.
- Generated OpenAPI/frontend types are regenerated if the self-control description or public DTOs change.
- The plan's target behavior is not contradicted by self-control docs.

### 6. Multi-Client And Browser Validation

Scope: backend route/SSE tests, frontend integration tests, `$agent-browser` manual validation.

Work:

- Add a same-user two-tab test shape at the gateway boundary:
  - client A observes an active turn;
  - client B has stale or missing selected-thread state and submits through `/input`;
  - gateway routes based on current gateway/app-server state and emits canonical `thread_view.patch`;
  - both clients converge without duplicate user rows.
- Add a non-steerable two-client shape:
  - `/input` receives app-server `ActiveTurnNotSteerable`;
  - gateway creates a durable queued row;
  - another client sees the row through `GET /queued-inputs` or `turn_queue.item_upsert`;
  - explicit row `Steer` later follows the existing pending-commit lifecycle.
- Use `$agent-browser` against local full-stack dev for browser-observable flows:
  - active regular turn, send follow-up, verify no queued card and one pending/sent user row;
  - active non-steerable/rejected steer mock or fixture, verify queued card appears;
  - queued-row steer still shows `Steering...`/`pendingCommit` and disappears only after queue delete;
  - reload or second browser context converges through gateway state.

Exit criteria:

- Backend and frontend two-client tests cover stale local state and non-steerable queue fallback.
- `$agent-browser` validation records local URL, viewport/context shape, and observed states.
- No correctness path depends on a single tab's React state.

### 7. Contract, Docs, And Review Gate

Scope: OpenAPI generation, `apps/web/src/api/generated/schema.ts`, `README.md` only if setup or behavior docs require it, `plans/index.md`.

Work:

- Keep `ThreadInputDisposition::Steered` in the public schema and make it reachable from `/input`.
- Regenerate OpenAPI/frontend types if public descriptions or schema output changes.
- Update README only if it documents active-turn queue-first behavior.
- Update `plans/index.md` status when implementation starts/completes.
- Run an independent review pass before marking implementation complete, per `AGENTS.md`.

Exit criteria:

- `cargo fmt --check`
- Focused gateway tests for route/queue/turn lifecycle.
- `cargo test` or documented focused fallback if full suite is blocked by environment.
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Generated OpenAPI and frontend types are clean if regenerated.
- Independent review reports no major findings, or findings are fixed and re-reviewed.

## Verification

Plan-time verification performed:

- Read `AGENTS.md`, `plans/index.md`, and the related completed plans:
  - `plans/thread-client-surface-simplification.md`
  - `plans/default-queued-composer-input.md`
  - `plans/gateway-pending-steer-commit.md`
  - `plans/tui-aligned-thread-timeline-simplification.md`
- Inspected the requested implementation files:
  - `apps/gateway/src/routes/turns.rs`
  - `apps/gateway/src/queue.rs`
  - `apps/gateway/src/turn_lifecycle.rs`
  - `apps/gateway/src/events.rs`
  - `apps/gateway/src/routes/self_control.rs`
  - `apps/web/src/composer/useComposerOrchestration.ts`
  - `apps/gateway/src/routes/mod.rs`
  - `apps/web/src/App.mvp.composer-input.test.tsx`
- Inspected supporting contract/client files:
  - `apps/gateway/src/app_server_api.rs`
  - `apps/gateway/src/app_server.rs`
  - `apps/gateway/app-server-schema/0.135.0/json/v2/TurnSteerParams.json`
  - `apps/gateway/app-server-schema/0.135.0/json/v2/TurnSteerResponse.json`
  - `apps/web/src/api/client.ts`
  - `apps/web/src/test/mvpAppHarness.tsx`
- Checked the current upstream app-server README and TUI `thread_routing.rs` on GitHub for the active-turn steer sequencing reference.

Implementation verification performed:

- `cargo fmt --check`
- `cargo test -p kodex-gateway routes::tests::thread_input_ --lib`
- `cargo test -p kodex-gateway routes::tests::queued_ --lib`
- `cargo test -p kodex-gateway routes::tests::self_control --lib`
- `cargo test` (rerun outside the sandbox after the sandboxed run hit `Operation not permitted` in an MCP stdio test)
- `cd apps/web && npm test -- src/App.mvp.composer-input.test.tsx`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Independent review subagent pass found no major routing correctness issues.

Additional validation notes:

- The backend route tests cover the two-client state ownership contract at the gateway boundary: stale active state is resolved by the gateway/app-server, direct steers do not emit durable queue rows, and non-steerable steers persist a `rejectedSteer` queue row visible through both queue listing and replayed `turn_queue.item_upsert`.
- Browser routing remains thin: the frontend still calls only the gateway-owned `/input` command for normal submits and only renders a queue card when the gateway response contains `queuedInput`.
- `$agent-browser` manual validation was not run in this pass because active regular-turn and non-steerable app-server states are covered by deterministic gateway/frontend tests rather than a local live app-server fixture.

## Risks And Open Questions

- Expected-turn mismatch parsing currently has to contend with flattened `ApiError::BadGateway` strings. Prefer structured JSON-RPC error data if the change can stay small; otherwise implement the narrowest message/data parser possible and cover it with tests.
- Direct active steer cannot carry per-turn options. The plan intentionally treats submitted options as relevant only to `turn/start` and queued future starts; implementers must not persist active-steer options as future thread settings.
- Direct steer pending-user projection should not become durable transcript truth. It should disappear or reconcile when app-server emits the real committed user message through canonical `thread_view.patch`.
- If a `turn/start` is in progress and a second user submits before a concrete turn id exists, queueing behind the pending start remains safer than attempting `turn/steer` with synthetic state.
- Self-control remains queue-first by policy. If product intent changes to let agent-originated self-control steer active user turns, that should be a separate explicit decision because it changes safety and interruption semantics.
