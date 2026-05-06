# Gateway Pending Steer Commit Plan

## Scope

Make active-turn steer submissions stay visible across all browser clients after app-server accepts `turn/steer` and before the committed user-message item appears in the thread timeline.

This plan fixes the gap where a queued steer row disappears as soon as the user clicks `Steer`, even though the active turn may still be finishing a tool call and has not yet rendered the steered user message. The gateway should own the pending-commit state so multiple tabs connected to the same gateway see the same lifecycle.

## Status

Complete.

## Current Problem

`POST /v1/threads/{threadId}/queued-inputs/{queueId}/steer` currently claims a queue row, calls app-server `turn/steer`, and deletes the row immediately on success. The web client also removes the row locally as soon as the request resolves.

That success only means app-server accepted the steer for the active turn. It does not mean the steered input has appeared in committed thread history. If the assistant is still waiting on a tool call, the message can vanish from the queue before the timeline shows it.

This is also a multi-client correctness problem. A browser-local pending display would only help the tab that clicked `Steer`; other tabs receive the queue delete and still see the message disappear.

## Behavioral Reference

Codex TUI keeps active-turn steers separate from committed history:

- When submitting while an agent turn is running, TUI creates a pending steer instead of rendering it as committed history.
- The pending steer has a small compare key made from concatenated text plus image count.
- When a committed `UserMessage` item arrives, TUI checks only the front pending steer. If it matches, TUI pops it and renders the stored pending display in history.
- If app-server rejects the steer as active-turn-not-steerable, TUI moves the pending steer into the rejected-steer queue.
- If the turn is interrupted before pending steers are acknowledged, TUI restores or resubmits pending steers instead of dropping them.

Relevant upstream files:

- `codex-rs/tui/src/chatwidget.rs`
- `codex-rs/tui/src/chatwidget/user_messages.rs`
- `codex-rs/app-server/README.md`

The checked-in app-server schema and README remain the wire contract. TUI is a real-client sequencing reference, not a replacement for the generated schemas.

## Principles

- Gateway owns shared queue lifecycle. Browsers render queue state and request actions.
- Successful `turn/steer` means `pendingCommit`, not `deleted`.
- Committed app-server user-message items delete matching pending steers.
- Matching is FIFO by thread and accepted turn, not global same-text lookup.
- Do not render accepted steers as normal committed timeline messages until app-server emits the real item.
- Avoid duplicate sends. If recovery cannot prove whether a pending steer committed, require manual retry or requeue conservatively before normal follow-ups.
- Preserve generated OpenAPI as the public contract. Frontend types come from regenerated artifacts.

## Data Model

Extend `QueuedInputStatus`:

```rust
pub enum QueuedInputStatus {
    Queued,
    Submitting,
    Steering,
    PendingCommit,
    Failed,
}
```

Serialized status:

- `pendingCommit`

Add accepted-steer metadata to `queued_turn_inputs`:

- `accepted_turn_id text`
- `accepted_at text`
- `accepted_event_seq integer`

`accepted_turn_id` is required for matching. `accepted_at` and `accepted_event_seq` are useful for recovery, diagnostics, and deterministic stale pending handling.

Keep the row in `GET /v1/threads/{threadId}/queued-inputs` while it is `pendingCommit`. The row remains visible but not actionable.

## Compare Key

Add a gateway helper equivalent to TUI's `PendingSteerCompareKey`:

```rust
struct PendingSteerCompareKey {
    text: String,
    image_count: usize,
}
```

For queued `UserInput[]`:

- concatenate all text inputs in order
- count `image` and `localImage` inputs
- ignore skill and mention inputs if/when the gateway supports them

For committed app-server `userMessage` item content:

- use the same projection from the app-server item payload
- avoid raw JSON equality because app-server may preserve equivalent user content with a different payload shape

Only compare the oldest `pendingCommit` row for the same `thread_id` and `accepted_turn_id`.

## Gateway Contract

Update `POST /v1/threads/{threadId}/queued-inputs/{queueId}/steer`:

- Current response: `QueuedInputDeleteResponse`
- New response: `QueuedInputResponse`

Success flow:

1. Resolve the active turn id as today.
2. Transition row from `queued` to `steering`.
3. Broadcast `turn_queue.item_upsert`.
4. Call app-server `turn/steer`.
5. On success, transition row to `pendingCommit`, store accepted turn metadata, and broadcast `turn_queue.item_upsert`.
6. Return `QueuedInputResponse`.

Failure flow:

- Active-turn-not-steerable or expected-turn errors:
  - transition back to `queued`
  - set `priority = rejectedSteer`
  - preserve `lastError`
  - broadcast upsert
- Generic error:
  - transition to `failed`
  - broadcast upsert

Do not broadcast `turn_queue.item_deleted` on steer acceptance.

## Event Reconciliation

Add reconciliation in gateway app-server event handling for committed user messages.

Trigger:

- app-server event method is `item/completed` or equivalent normalized thread item event
- item type is `userMessage`
- event has `thread_id` and `turn_id`

Algorithm:

1. Compute compare key from committed user-message item content.
2. Load the oldest non-deleted `pendingCommit` queued row where:
   - `thread_id = event.thread_id`
   - `accepted_turn_id = event.turn_id`
3. Compute compare key from that queued row's `input`.
4. If keys match:
   - soft-delete the queued row
   - broadcast `turn_queue.item_deleted`
5. If keys do not match:
   - leave the row untouched
   - do not scan later pending rows
   - optionally log a debug message for diagnosis

The front-only rule preserves order and avoids deleting the wrong row when the user steers duplicate text multiple times.

## Turn End Handling

When a turn reaches idle/completed/system-error and still has `pendingCommit` rows for that `accepted_turn_id`, the gateway must not silently delete them.

Preferred behavior:

- transition unacknowledged pending rows back to `queued`
- set `priority = rejectedSteer`
- set `lastError` explaining that the steer was accepted but not confirmed in committed history
- broadcast upsert
- trigger normal queue drain only after runtime is idle

Manual-retry alternative:

- transition to `failed`
- require the user to retry

Use requeue-before-normal unless implementation evidence shows it can duplicate committed input. It matches the TUI principle that unacknowledged steers are restored rather than dropped.

## Restart Recovery

`recover_queued_inputs_after_restart` currently fails `submitting` and `steering` rows to avoid duplicate sends. Include `pendingCommit`.

Initial conservative behavior:

- mark `pendingCommit` as `failed`
- error text: gateway restarted before the accepted steer could be confirmed; retry manually to avoid duplicate sends
- broadcast upsert during recovery

Future improvement:

- on startup, re-read app-server thread history and reconcile pending rows before deciding whether to fail or requeue them

## Frontend Changes

Update generated OpenAPI types after backend DTO changes.

Update `steerQueuedInput`:

- return `QueuedInput` from `QueuedInputResponse`
- do not return `void`

Update `handleSubmitQueuedSteer`:

- on successful steer, call `onQueuedInputUpsert(row)`
- do not call `onQueuedInputDeleted`

Update `QueuedSteerCard`:

- treat `pendingCommit` like a non-actionable busy state
- keep text/image preview visible
- show a compact status such as `Steering...`
- disable `Steer`, `Retry`, and abort while pending commit unless product wants explicit cancellation semantics later

Existing queue SSE handling can stay mostly unchanged:

- `turn_queue.item_upsert` keeps all clients in sync
- `turn_queue.item_deleted` removes the row only after committed user-message reconciliation

## Tests

Start behavior-changing implementation with failing tests where practical.

Backend route tests:

- Successful queued steer returns `QueuedInputResponse` with status `pendingCommit`.
- Successful queued steer broadcasts `steering` upsert followed by `pendingCommit` upsert, not delete.
- Non-steerable app-server error requeues with `rejectedSteer`.
- Generic app-server error marks failed and remains retryable.

Backend store tests:

- `pendingCommit` serializes/deserializes correctly.
- Accepted metadata is persisted and read back.
- Oldest pending row by `(thread_id, accepted_turn_id)` is selected for matching.
- Restart recovery handles `pendingCommit`.

Backend event tests:

- Matching committed `userMessage` deletes only the front pending row for that turn.
- Duplicate text steers delete one row per committed matching event.
- Non-front match does not delete later rows.
- Committed user message for another turn does not delete pending rows.
- Turn completion with unmatched pending rows requeues or fails according to the chosen policy.

Frontend tests:

- Clicking `Steer` keeps the row visible with pending status after the request resolves.
- The row disappears only after `turn_queue.item_deleted` SSE.
- Multiple queued rows keep stable order and disabled action state.
- Failed steer remains retryable.

Generated contract verification:

- Regenerate OpenAPI.
- Regenerate frontend API types.
- Build frontend and run focused composer tests.

## Milestones

### Milestone 1: Pending Commit Contract

Status: Complete.

- Add `pendingCommit` status and accepted-steer metadata.
- Change steer endpoint response to `QueuedInputResponse`.
- Preserve current non-steerable and generic failure behavior.
- Regenerate OpenAPI and frontend types.

Exit conditions:

- Backend route/store tests cover the new state.
- Frontend compiles against generated types.

### Milestone 2: Event Reconciliation

Status: Complete.

- Add compare-key helper.
- Reconcile committed user-message events against front pending row.
- Broadcast queue delete only after match.
- Handle unmatched pending rows on turn end.

Exit conditions:

- Backend event tests cover match, duplicate text, non-match, wrong turn, and turn end.

### Milestone 3: Frontend Pending UI

Status: Complete.

- Update steer client wrapper and orchestration.
- Render `pendingCommit` rows as visible non-actionable pending steer rows.
- Remove local successful-steer deletion.

Exit conditions:

- Focused composer tests pass.
- Multi-client behavior is covered by gateway upsert/delete event tests and frontend SSE consumption tests.

### Milestone 4: Verification And Documentation

Status: Complete.

- Run backend tests.
- Run frontend tests and build.
- Update README only if public behavior or command docs need it.
- Update `plans/index.md` when status changes.

Exit conditions:

- Tests pass.
- Generated artifacts are current.
- Plan status reflects implementation state.

## Open Questions

- Should unmatched `pendingCommit` rows on normal turn completion be automatically requeued or marked failed for manual retry? Requeue matches TUI behavior more closely, but manual retry minimizes duplicate-send risk.
- Should users be allowed to abort a `pendingCommit` row? Initial answer should be no because app-server has already accepted the steer.
- Should accepted metadata include the app-server JSON-RPC request id if available? It could help diagnostics but is not required for matching.
- Should image compare keys use count only, like TUI, or include normalized paths/URLs? Count aligns with TUI and avoids payload-shape mismatches, but paths may reduce false matches for duplicate image-only steers.
