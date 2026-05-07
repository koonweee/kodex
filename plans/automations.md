# Gateway Automations Plan

## Status

Complete. Implemented gateway-owned automation storage, scheduler processing, source-labeled queued inputs, public automation routes, operational SSE events, generated frontend API types, and focused backend/frontend verification. No frontend management UI is included in v1.

## Goal

Add gateway-owned automations that send a prompt to a target thread on a recurring schedule. A firing should behave like user-submitted thread input after it reaches the gateway queue: the same queued-input statuses, app-server `turn/start` path, approvals, timeline events, and multi-tab reconciliation should apply.

## Settled Product Decisions

- An automation must have a non-empty `name`, non-empty `prompt`, `targetThreadId`, `schedule.startAt`, and `schedule.repeatEvery`.
- `repeatEvery` accepts seconds, minutes, and hours, canonicalized to seconds.
- Minimum interval is 30 seconds.
- Scheduler cadence is wall-clock based. Missed slots are skipped rather than shifting future runs.
- Coalesce due work: each automation may have at most one pending or in-flight firing at a time.
- On gateway restart, overdue active automations get at most one catch-up firing, then `nextRunAt` advances to the next future cadence slot.
- Automations only enqueue input for the next idle turn. They do not auto-steer active turns.
- Once a prompt reaches the queue, it is fired-and-forgotten. Pausing or deleting an automation affects only future firings.
- Turn options use the latest gateway-owned composer settings for the target thread at firing time. If no thread settings exist, use default `TurnStartOptions`.
- Queue rows created by automations include source labels so clients can identify automation-originated queued input.
- Pre-queue failures are recorded, exposed on the automation, and advance cadence.
- Auto-pause after 5 consecutive pre-queue failures.
- App-server unready is a scheduler gate, not an automation failure.
- v1 exposes automation state, not full run history.
- First implementation is gateway API, OpenAPI, and generated frontend types only. No frontend automation UI in this plan.

## Non-Goals

- No cron-expression parser.
- No frontend management UI.
- No full public run-history API in v1.
- No distributed scheduler, external worker, Redis, or multi-gateway coordination.
- No browser-local automation state.
- No prompt templating, variables, dynamic thread selection, or project-wide fanout.
- No automatic cancellation of queued inputs after pause/delete.
- No app-server protocol changes.

## Source Of Truth

- Gateway SQLite owns automation definitions, due times, failure counters, and internal run idempotence records.
- App-server remains the source for thread existence, runtime state, and turn execution.
- `queued_turn_inputs` remains the execution handoff to app-server.
- Browser clients project gateway state from HTTP snapshots and SSE events; correctness must not depend on one tab's React state.

## File Seams

Backend:

- `apps/gateway/src/store.rs`
  - Add `automations` and `automation_runs` tables in `Store::migrate`.
  - Add `QueuedInputSourceType` or equivalent string field support on `QueuedInput`.
  - Add source columns to `queued_turn_inputs`.
  - Add store helpers for create/list/get/update/pause/resume/delete automation.
  - Add due-claim helpers that enforce coalescing and idempotence.
  - Add focused store tests near existing queue/thread state tests.
- `apps/gateway/src/automation.rs` or `apps/gateway/src/automations.rs`
  - New module for scheduler loop, schedule math, run claiming, failure handling, and queue creation.
  - Keep app-server readiness gating and fake-clock-friendly logic here.
- `apps/gateway/src/queue.rs`
  - Add an internal queue creation helper that accepts source metadata and already-resolved turn options.
  - Keep public user-created queued inputs source-labeled as manual or `None`, depending on API compatibility choice.
  - Continue using existing queue drain behavior for automation input.
- `apps/gateway/src/routes/automations.rs`
  - Add public API routes and DTOs.
- `apps/gateway/src/api.rs`
  - Register automation routes and schemas with OpenAPI.
- `apps/gateway/src/main.rs`
  - Start automation recovery/scheduler after queued-input recovery and before serving traffic, or immediately after state creation if the scheduler handles app-server readiness gating.
- `apps/gateway/src/events.rs`
  - Add automation state events to normal operational event filtering.

Frontend/API artifacts:

- `apps/web/src/api/generated/schema.ts`
  - Regenerate after OpenAPI changes.
- `apps/web/src/api/client.ts`
  - Add typed wrappers only if needed for near-term API usage. No UI route or component work in this plan.

Docs:

- `plans/index.md`
  - Track plan status.
- `README.md`
  - Update only when routes or behavior become implemented.

## Data Model

Add gateway tables:

```sql
create table if not exists automations (
    id text primary key,
    name text not null,
    prompt text not null,
    target_thread_id text not null,
    start_at text not null,
    repeat_every_seconds integer not null,
    next_run_at text not null,
    status text not null,
    paused_reason text,
    last_run_at text,
    last_queued_input_id text,
    last_error text,
    consecutive_failure_count integer not null default 0,
    created_at text not null,
    updated_at text not null,
    deleted_at text
);

create table if not exists automation_runs (
    id text primary key,
    automation_id text not null,
    scheduled_for text not null,
    status text not null,
    queued_input_id text,
    error text,
    created_at text not null,
    updated_at text not null,
    unique (automation_id, scheduled_for)
);
```

Extend `queued_turn_inputs`:

```sql
alter table queued_turn_inputs add column source_type text;
alter table queued_turn_inputs add column source_id text;
```

Indexes:

- `automations_due_idx` on `(status, deleted_at, next_run_at)`.
- `automation_runs_pending_idx` on `(automation_id, status, created_at)`.
- `queued_turn_inputs_source_idx` on `(source_type, source_id)`.

Status values:

- Automation: `active`, `paused`.
- Automation run: `pending`, `queued`, `failed`.
- Queue source type: `automation` for automation-created rows. Manual rows may be `null` to avoid unnecessary public enum churn.

Notes:

- `target_thread_id` intentionally does not reference a gateway thread table because app-server owns thread storage.
- `automation_runs` is internal in v1. It exists for idempotence, coalescing, source labels, and debugging.
- Soft-delete automations with `deleted_at` so source labels can still resolve historically if needed.

## Schedule Semantics

`nextRunAt` is the next wall-clock slot, not "last completion plus interval".

Due calculation:

- If `now < nextRunAt`, do nothing.
- If `now >= nextRunAt`, the due slot is the current `nextRunAt`.
- After considering the due slot, advance `nextRunAt` to the first slot strictly greater than `now`.
- If a pending or in-flight run exists for that automation, do not create a new run; still keep `nextRunAt` on the next future cadence slot so missed slots are skipped.

Restart:

- Scheduler startup uses the same due calculation.
- An overdue automation can create at most one catch-up run.
- Old `pending` run records without a queued input should be recoverable by retrying pre-queue work or marking failed, depending on where the prior process stopped. Avoid duplicate queued inputs by relying on `unique(automation_id, scheduled_for)` and source labels.

## Coalescing Definition

An automation has pending or in-flight work if either:

- an internal `automation_runs` row for the automation has `status = 'pending'`, or
- a run has `status = 'queued'` and its `queued_input_id` still points to a non-deleted queued row in a pre-terminal queue state.

For v1, once a queue row is deleted by queue drain after successful `turn/start`, the automation is no longer considered in-flight. The resulting app-server turn may still be active, but that turn is ordinary thread state. This matches the fired-and-forgotten decision.

## Gateway API

Routes:

- `GET /v1/automations`
  - Optional `threadId` filter.
  - Returns active and paused non-deleted automations.
- `POST /v1/automations`
  - Creates an automation.
  - Validates required fields, interval floor, and target thread existence.
- `GET /v1/automations/{automationId}`
  - Returns one automation.
- `PATCH /v1/automations/{automationId}`
  - Updates name, prompt, target thread, schedule, or status fields.
  - Recomputes `nextRunAt` when schedule fields change.
- `POST /v1/automations/{automationId}/pause`
  - Sets `status = paused`.
- `POST /v1/automations/{automationId}/resume`
  - Sets `status = active`.
  - If `nextRunAt` is in the past, leave it due so the scheduler can perform the normal single catch-up behavior.
- `DELETE /v1/automations/{automationId}`
  - Soft-deletes the automation.
  - Does not delete existing queue rows.

DTO sketch:

```json
{
  "id": "automation-1",
  "name": "Daily status",
  "prompt": "Summarize current repo state and next actions.",
  "targetThreadId": "thread-123",
  "schedule": {
    "startAt": "2026-05-07T15:00:00Z",
    "repeatEvery": {
      "value": 1,
      "unit": "hours"
    }
  },
  "nextRunAt": "2026-05-07T16:00:00Z",
  "status": "active",
  "pausedReason": null,
  "lastRunAt": null,
  "lastQueuedInputId": null,
  "lastError": null,
  "consecutiveFailureCount": 0,
  "createdAt": "2026-05-07T14:00:00Z",
  "updatedAt": "2026-05-07T14:00:00Z"
}
```

## Events

Add operational gateway events:

- `automation.item_upsert`
- `automation.item_deleted`

`automation.item_upsert` payload is the public automation DTO. It is emitted on create, update, pause, resume, scheduler state changes, failure updates, and auto-pause.

`automation.item_deleted` payload:

```json
{
  "id": "automation-1"
}
```

Queue events remain the source for visible queued prompt state:

- `turn_queue.item_upsert` includes `sourceType` and `sourceId` for automation-created rows.
- `turn_queue.item_deleted` remains unchanged unless implementation needs source metadata for diagnostics.

## Scheduler Behavior

Loop shape:

- Tick at a small bounded interval, for example every 1 second, but only claim rows whose `nextRunAt <= now`.
- If app-server is not ready, do not claim or fail due automations.
- Claim due automations through store helpers that advance `nextRunAt` atomically with run creation or skip.
- For each claimed due run:
  - Load latest stored thread composer settings.
  - Use `TurnStartOptions::default()` when no stored settings exist.
  - Resolve prompt input for the target thread.
  - Create a source-labeled queued input.
  - Mark run `queued`.
  - Update automation `lastRunAt`, `lastQueuedInputId`, clear `lastError`, reset `consecutiveFailureCount`.
  - Broadcast automation and queue events.
  - Trigger queue drain for the target thread.

Pre-queue failure handling:

- Mark run `failed`.
- Set automation `lastError`.
- Increment `consecutiveFailureCount`.
- If `consecutiveFailureCount >= 5`, set `status = paused` and `pausedReason = "tooManyFailures"` or equivalent stable value.
- Broadcast `automation.item_upsert`.
- Do not count app-server unready as a failure.
- Do not inspect or react to later turn/approval/tool failures after the input has reached the queue.

## Validation

Create/update validation:

- `name.trim()` must not be empty.
- `prompt.trim()` must not be empty.
- `targetThreadId` must point to an app-server-readable thread.
- `repeatEverySeconds >= 30`.
- `startAt` must parse as an absolute timestamp.
- Schedule updates should preserve wall-clock cadence from the new `startAt` and interval, not from previous run completion.

Source-label validation:

- Public manual queue creation cannot spoof automation source fields.
- Internal automation queue creation is the only v1 path that writes `sourceType = automation`.

## Backend Milestone 1: Store And Schedule Math

Failing tests first:

- Migrations create automation tables and source columns.
- Automation create/list/get/update/delete round trip validates required fields and interval floor.
- Schedule math advances `nextRunAt` to the first future cadence slot after `now`.
- Due claiming creates one run for an overdue automation and advances `nextRunAt`.
- Due claiming is idempotent for the same scheduled slot.
- Coalescing prevents a second due run while a pending or queued run exists.
- Five consecutive pre-queue failures auto-pause the automation.
- Soft-deleted automations are not claimed or listed.

Implementation:

- Add DTO/domain structs in the store or automation module.
- Add SQL tables, indexes, and migration compatibility helpers.
- Add pure schedule helper functions with unit tests.
- Add store methods for automation CRUD and due claiming.
- Add source fields to `QueuedInput` and row mapping.

Exit conditions:

- Focused store/schedule tests pass.
- Existing queue tests still pass with nullable source fields.

## Backend Milestone 2: Scheduler To Queue Integration

Failing tests first:

- A due automation creates one queued input with `sourceType = automation`.
- The queued input uses latest stored thread composer settings for that target thread.
- If no stored settings exist, default turn options are used.
- Active target thread leaves automation input queued; idle target thread drains through existing `turn_start`.
- App-server unready does not fail, advance failure count, or auto-pause the automation.
- Prompt resolution failure marks the run failed and updates automation error state.
- Gateway restart with overdue automation performs single catch-up.
- Existing fired-and-forgotten queued inputs survive pause/delete.

Implementation:

- Add scheduler module with fake-clock-friendly due processing.
- Add internal queue creation helper that accepts source metadata.
- Start scheduler from `main`.
- Reuse `queue::trigger_queue_drain` after source-labeled queue creation.
- Broadcast automation state and queue events.

Exit conditions:

- Scheduler integration tests pass with fake app-server.
- No duplicate queue rows are created under repeated ticks.
- Existing queue drain behavior remains unchanged for manual user input.

## Backend Milestone 3: Public API And OpenAPI

Failing tests first:

- `POST /v1/automations` validates required fields and interval floor.
- `POST /v1/automations` rejects an unreadable target thread.
- `GET /v1/automations` returns non-deleted automations and supports `threadId`.
- `PATCH /v1/automations/{id}` updates fields and recomputes schedule when needed.
- Pause/resume/delete routes update state and emit automation events.
- `/openapi.json` includes automation routes, DTOs, schedule schemas, and queue source fields.

Implementation:

- Add `routes/automations.rs`.
- Register routes and schemas in `api.rs`.
- Add API client wrappers only if needed.
- Regenerate frontend OpenAPI types after the gateway is running.

Exit conditions:

- `cargo test` passes.
- Frontend generated schema includes automation and queue source types.
- No frontend UI behavior changes are required.

## Frontend Artifact Milestone: Types Only

Failing tests first:

- Existing frontend tests compile against the regenerated queue DTO with nullable source fields.

Implementation:

- Regenerate `apps/web/src/api/generated/schema.ts`.
- Update `apps/web/src/api/client.ts` only for lightweight automation wrappers if useful for manual/API testing.
- Do not add visible automation UI.

Exit conditions:

- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes if generated types affect build output.

## Acceptance Criteria

- Gateway can create, list, update, pause, resume, and delete automations through public HTTP routes.
- Active automations fire on their wall-clock cadence with a 30 second minimum interval.
- Missed intervals coalesce; no automation can create an unbounded prompt backlog.
- Gateway restart creates at most one catch-up firing per overdue automation.
- App-server unready delays due firings without marking failures.
- Pre-queue failures are visible and auto-pause after five consecutive failures.
- Automation-created queued inputs carry stable source labels.
- Queue drain and app-server turn behavior match normal user-submitted queued input after the row is created.
- Pausing or deleting an automation does not remove already queued work.
- OpenAPI and generated frontend types include the new API and queue source fields.
- Backend tests cover store, schedule math, scheduler integration, route validation, coalescing, restart, and failure handling.

## Review And Rollout

- Keep the first implementation behind normal local/VPN gateway assumptions; do not imply public-safe unattended execution.
- Run an independent review pass before marking complete.
- Before completion, specifically review two-tab correctness:
  - one tab creates/pauses/deletes an automation,
  - another tab observes automation and queue events through gateway-owned state/SSE,
  - reload reconciles from HTTP state without browser-local ownership.
- Update `README.md` only after routes are implemented and verified.
