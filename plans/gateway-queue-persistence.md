# Gateway Queue Persistence Plan

## Scope

Move queued composer follow-up messages from browser-local React state into the Rust gateway so every browser connected to the same gateway sees and operates on the same per-thread queue.

This is a same-gateway, single-user feature. Desktop and iPad browser sessions connected to one gateway should share queued messages, retry state, abort actions, and automatic queue draining. This plan does not support multiple gateway processes coordinating over the same app-server or a distributed queue.

## Status

Proposed.

## Current Problem

Queued composer rows currently live in frontend state inside `useComposerOrchestration`. They are tied to the selected thread, are lost on reload, and cannot be shared across browser instances. The auto-start path uses selected timeline state, so a queued row can be submitted to whichever thread is currently visible instead of the thread where the row was created.

The gateway already owns the app-server connection, SQLite store, event broadcast, and OpenAPI contract, so the queue should move there rather than trying to synchronize browser-local state.

## Principles

- Gateway is the queue owner. Browsers render and request actions; they do not decide when to drain a queued row.
- Queue rows are thread-owned. Every persisted row includes `threadId`, and all start, steer, retry, and abort paths verify that ownership.
- Drain exactly one queued row per idle transition for a thread.
- Preserve local/VPN-only assumptions. Do not imply the gateway is safe to expose publicly.
- Keep generated OpenAPI as the public contract. Frontend types must come from regenerated OpenAPI artifacts.
- Store app-server-shaped `UserInput[]` and turn options. Do not invent duplicate prompt DTOs.
- Avoid duplicate sends. If gateway recovery cannot prove whether an in-flight row was submitted, leave it failed and require user retry.

## Non-Goals

- No multi-gateway or distributed locking support.
- No multi-user authorization, queue permissions, or audit UI.
- No WebSocket transport.
- No browser-to-browser synchronization channel.
- No durable storage of raw browser `File` objects or object URLs.
- No new handwritten API contract docs beyond this implementation plan.

## Proposed Gateway Contract

Routes:

- `GET /v1/threads/{threadId}/queued-inputs`
  - Returns active queue rows for the thread, ordered by `priority`, then `createdAt`.
- `POST /v1/threads/{threadId}/queued-inputs`
  - Body: `{ input: UserInput[], options?: TurnStartOptions }`.
  - Creates a queued follow-up row and broadcasts it.
- `POST /v1/threads/{threadId}/queued-inputs/{queueId}/steer`
  - Attempts to submit the row to the currently active turn for that thread.
  - If the active turn is not steerable, keeps the row queued and prioritizes it as a rejected steer for the next turn.
- `POST /v1/threads/{threadId}/queued-inputs/{queueId}/retry`
  - Requeues a failed row.
- `DELETE /v1/threads/{threadId}/queued-inputs/{queueId}`
  - Aborts an active queued row.

DTOs:

- `QueuedInput`
  - `id`
  - `threadId`
  - `input`
  - `options`
  - `status`: `queued`, `submitting`, `steering`, or `failed`
  - `priority`: `normal` or `rejectedSteer`
  - `attemptCount`
  - `lastError`
  - `createdAt`
  - `updatedAt`
- `QueuedInputListResponse`
  - `queuedInputs`
- `QueuedInputResponse`
  - `queuedInput`

SSE event kinds:

- `turn_queue.item_upsert`
  - Payload is a `QueuedInput`.
- `turn_queue.item_deleted`
  - Payload includes `id` and `threadId`.

Queue event replay should be operational replay, like approval events, so reconnecting clients catch up without needing a full page reload.

## Milestone 1: Public Contract And Store Model

Status: Proposed

Failing tests first:

- Store migration creates `queued_turn_inputs` and `thread_runtime_state`.
- Queue rows round-trip `UserInput[]` and `TurnStartOptions` without shape drift.
- Listing a thread queue excludes deleted/submitted rows and orders rejected steers before normal rows.
- OpenAPI includes the queued-input routes and DTOs.

Implementation:

- Add `queued_turn_inputs`:
  - `id text primary key`
  - `thread_id text not null`
  - `input_json text not null`
  - `options_json text not null`
  - `status text not null`
  - `priority text not null default 'normal'`
  - `attempt_count integer not null default 0`
  - `last_error text`
  - `created_at text not null`
  - `updated_at text not null`
  - `deleted_at text`
- Add `thread_runtime_state`:
  - `thread_id text primary key`
  - `status text not null`
  - `active_turn_id text`
  - `updated_at text not null`
  - `last_event_seq integer`
- Add typed store methods for create, list, mark submitting, mark steering, mark failed, requeue, delete, and claim-next.
- Add index coverage for active thread queue reads and first-row claims.
- Add public Rust DTOs with `utoipa` schemas.

Exit conditions:

- `cargo test -p kodex-gateway store::` or equivalent focused store tests pass.
- `cargo test -p kodex-gateway` route/OpenAPI tests for the new DTOs pass.
- The migration is safe from an existing database with events, projects, approvals, and thread reads.
- No frontend handwritten queue DTOs are introduced.

## Milestone 2: Queue Routes And SSE Synchronization

Status: Proposed

Failing tests first:

- `GET /v1/threads/:threadId/queued-inputs` returns rows only for that thread.
- `POST /v1/threads/:threadId/queued-inputs` persists and broadcasts `turn_queue.item_upsert`.
- `DELETE /v1/threads/:threadId/queued-inputs/:queueId` marks the row deleted and broadcasts `turn_queue.item_deleted`.
- Retry changes a failed row back to queued and broadcasts an upsert.
- Cross-thread queue IDs cannot be read, steered, retried, or deleted through the wrong thread path.
- Queue events replay through `/v1/events` after reconnect.

Implementation:

- Add `routes/queue.rs` or equivalent focused route module.
- Wire routes into the API router and OpenAPI.
- Persist queue upsert/delete events through the existing event store before broadcasting.
- Keep deleted/submitted rows out of list responses.
- Treat abort/delete as idempotent for already-deleted rows owned by the same thread.

Exit conditions:

- Route tests cover list, create, retry, delete, wrong-thread rejection, and SSE replay.
- Queue events appear live in thread-filtered and global `/v1/events` streams.
- Generated `/openapi.json` contains every queued-input route.

## Milestone 3: Gateway Queue Drainer

Status: Proposed

Failing tests first:

- When a thread transitions from active to idle and has two queued rows, the gateway starts exactly one row.
- The second row does not start until the gateway observes the queued turn become active and then idle.
- Completion events for thread A never drain thread B.
- Queue draining still works when the selected browser is viewing a different thread.
- A start failure marks only that row failed and does not retry-loop.
- A gateway restart leaves rows that were `submitting` or `steering` in a failed manual-retry state to avoid duplicate sends.

Implementation:

- Update runtime state from normalized app-server events:
  - Active/running turn upserts set `status = active` and `activeTurnId`.
  - Terminal turn upserts and thread status idle clear `activeTurnId` and set `status = idle`.
- Trigger drain after:
  - enqueue when runtime state is idle,
  - retry when runtime state is idle,
  - terminal turn event for that thread,
  - startup recovery after in-flight rows are normalized.
- Implement one process-local drainer with transactionally claimed rows:
  - Claim first queued row for a thread as `submitting`.
  - Mark thread runtime as pending/active before calling app-server to prevent immediate second claims.
  - Call `turn/start` with the row's `threadId`, `input`, and `options`.
  - On success, delete or mark submitted and broadcast deletion.
  - On failure, mark failed, preserve `lastError`, clear pending runtime state only if no active turn is known, and broadcast upsert.
- Add a small recovery step at startup:
  - `submitting` and `steering` rows become `failed` with a restart message.
  - queued rows remain queued.

Exit conditions:

- Fake app-server integration tests prove one-row-at-a-time draining.
- Tests prove no duplicate `turn/start` call when two clients enqueue or retry concurrently.
- Tests prove terminal events for one thread cannot submit another thread's row.
- Failure and restart recovery leave visible retryable rows.
- The implementation does not require any browser to be focused on the queued thread.

## Milestone 4: Persisted Steering Semantics

Status: Proposed

Failing tests first:

- Steering a queued row uses the active turn ID from gateway runtime state for that row's thread.
- Steering fails with a clear error when the thread has no active turn.
- A successful steer removes only the steered row and broadcasts deletion.
- If app-server reports active-turn-not-steerable, the row remains queued with `priority = rejectedSteer`.
- Generic steer failure marks the row failed and retryable.
- Concurrent steer clicks from two browser instances submit at most once.

Implementation:

- Add `POST /v1/threads/{threadId}/queued-inputs/{queueId}/steer`.
- Claim the row as `steering` before calling app-server.
- Resolve active turn ID from `thread_runtime_state`, not from the browser.
- On successful `turn/steer`, remove the row.
- On app-server non-steerable errors, requeue with rejected-steer priority so it drains before normal follow-ups.
- On generic errors, mark failed.

Exit conditions:

- Backend route tests cover success, no-active-turn, non-steerable requeue, generic failure, and concurrent requests.
- Manual steering behavior matches the TUI principle: rejected steers are retried before normal queued follow-ups.

## Milestone 5: Frontend Queue Migration

Status: Proposed

Failing tests first:

- Active-turn composer submit calls queued-input create instead of storing a local row.
- Queue rows render from gateway responses and SSE events.
- Switching threads hides the previous thread's queue but does not delete it.
- Switching back reloads or restores that thread's queued rows.
- Queue rows created in another browser via SSE render without a page refresh.
- Auto-drained rows disappear from all open clients.
- Failed rows show Retry and remain retryable without looping.

Implementation:

- Regenerate frontend OpenAPI types after backend contract changes.
- Add generated-client-backed queue API wrappers.
- Replace `queuedSteerRows` local ownership with gateway-owned queue state keyed by `threadId`.
- Load selected thread queue with `GET /queued-inputs` when a thread is selected.
- Apply `turn_queue.item_upsert` and `turn_queue.item_deleted` events from global and selected-thread SSE streams.
- On active-turn composer submit:
  - Upload pending images first.
  - Build app-server-shaped `UserInput[]`.
  - Enqueue the row through the gateway.
  - Clear local draft and pending attachments after enqueue succeeds.
- For queued image rows created by another browser, render text and image count. Local object URL thumbnails are same-client only unless a future gateway image-preview route is added.
- Disable row actions while status is `submitting` or `steering`.

Exit conditions:

- `cd apps/web && npm test` covers composer enqueue, SSE sync, thread switch preservation, retry, abort, and steer actions.
- `cd apps/web && npm run build` passes.
- Generated OpenAPI TypeScript output is updated and committed.
- No frontend component decides when to auto-start the next queued turn.

## Milestone 6: Documentation, Verification, And Review

Status: Proposed

Implementation:

- Update `README.md` with the persisted queue behavior and same-gateway-only assumption.
- Keep `AGENTS.md` unchanged unless contributor workflow or commands change.
- Run backend formatting and tests.
- Run frontend tests and build.
- Run Playwright e2e if queue routes affect existing flows.
- Complete an independent review pass before marking the plan complete.

Exit conditions:

- `cargo fmt --check`
- `cargo test`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- `cd apps/web && npm run test:e2e` if affected flows are touched or existing e2e coverage is updated.
- `plans/index.md` status is updated when implementation starts and completes.
- Independent review reports no major issues remain.

## Agent Browser Test Scenarios

Run this pass after Milestone 5 is implemented and automated tests pass. Use the `agent-browser` skill and a single gateway instance with two browser contexts pointed at the same frontend URL.

### Setup

- Start the gateway and frontend against one gateway database.
- Open Desktop context at `1440x1000`.
- Open iPad context at `820x1180`.
- Use the same project and same active thread in both contexts.
- Keep network/devtools notes for every request mismatch, visible stale state, or duplicate send.

### Scenario 1: Cross-Device Queue Creation

- Start a long-running turn in Thread A from Desktop.
- From Desktop, enqueue `First queued from desktop`.
- From iPad, verify the row appears without refresh.
- From iPad, enqueue `Second queued from iPad`.
- Verify both contexts show both rows in the same order.

Expected result:

- Both clients show the same two queued rows for Thread A.
- Gateway logs and captured requests show no `turn/start` for the queued rows while Thread A is active.

### Scenario 2: Thread Ownership While Another Thread Is Visible

- Keep Thread A active with queued rows.
- Switch Desktop to Thread B.
- Leave iPad on Thread A.
- Complete Thread A's active turn.

Expected result:

- The gateway sends `First queued from desktop` to Thread A, not Thread B.
- Desktop does not show Thread A's queue while viewing Thread B.
- iPad shows the first row submitting/removed and the second row still queued.

### Scenario 3: Multi-Row Drain Without Running Event Assumption

- After the first queued row starts, complete its new turn without relying on a visible selected-thread running event in Desktop.
- Observe both clients.

Expected result:

- The second queued row starts only after the first queued turn completes.
- No manual thread selection is required to drain the second row.
- Exactly two `turn/start` calls are made for the two queued rows.

### Scenario 4: Manual Steer From The Other Client

- Start another active turn in Thread A.
- Enqueue one row from Desktop.
- Click `Steer` for that row from iPad.

Expected result:

- The gateway calls `turn/steer` for Thread A's active turn.
- The row disappears from both clients after success.
- No `turn/start` is made for that row.

### Scenario 5: Abort And Retry Synchronization

- Enqueue two rows from different clients.
- Abort the first row from Desktop.
- Force the second row's next start or steer attempt to fail.
- Retry the failed row from iPad.

Expected result:

- Abort removes only the first row from both clients.
- Failure is visible on both clients with retry affordance.
- Retry submits once and removes the row after success.

### Scenario 6: Reload Persistence

- Enqueue rows while Thread A is active.
- Reload the iPad browser.
- Switch iPad away from Thread A and back.

Expected result:

- Queued rows are restored from gateway state.
- Thread switching does not delete queued rows.
- Queue order and failed/retry state are preserved.

### Scenario 7: Image Row Degradation

- From Desktop, enqueue a message with one image attachment while Thread A is active.
- Observe iPad.

Expected result:

- Desktop may show same-client local preview while pending.
- iPad shows a stable text/image-count representation without broken image URLs.
- When the row drains, the final timeline message renders from app-server snapshot/live payloads.

### Scenario 8: Mobile Layout

- On iPad viewport, enqueue enough rows to wrap text and require scrolling.
- Open row actions, retry, abort, and steer states.

Expected result:

- Row text, buttons, and composer controls do not overlap.
- Disabled/submitting rows are visually distinct.
- Queue card remains attached to the composer without hiding the composer input.

### Scenario 9: Concurrent Action Race

- Display the same failed row in both contexts.
- Trigger Retry from Desktop and iPad close together.

Expected result:

- At most one retry claim succeeds.
- Both clients converge to the same row state.
- Gateway sends at most one `turn/start` for the row.

## Risks And Open Questions

- App-server error shapes for steer races must be verified against the checked-in schema and upstream README before implementation.
- If app-server accepts `turn/start` but the gateway crashes before recording deletion, automatic recovery cannot safely know whether the row already started. The plan intentionally marks in-flight rows failed after restart to avoid duplicate sends.
- Cross-device image previews are intentionally minimal until a gateway preview route is justified.
- Existing direct `POST /v1/threads/{threadId}/turns` remains available for immediate idle sends; queued active-turn follow-ups move to the persisted queue contract.
