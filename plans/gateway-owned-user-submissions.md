# Gateway-Owned User Submissions Plan

## Scope

Move direct composer submissions from browser-owned optimistic timeline items to gateway-owned submission state, while preserving immediate local feedback in the sending tab.

This covers idle-thread sends and first-message draft-thread sends. Active-turn follow-up messages already use the gateway queue and pending-commit lifecycle from [gateway-queue-persistence.md](gateway-queue-persistence.md) and [gateway-pending-steer-commit.md](gateway-pending-steer-commit.md); this plan should align with those semantics rather than replacing them.

The target behavior is same-gateway, single-user, multi-client correctness. Two browser clients connected to the same gateway should converge through gateway state, snapshots, and SSE without relying on text/image heuristics in React.

## Status

Proposed.

## Current Problem

Direct sends are currently optimistic only inside the selected browser timeline:

- `apps/web/src/composer/useComposerOrchestration.ts` creates an optimistic row before `startTurn` resolves.
- `apps/web/src/timeline/reducer.ts` stores that row as a normal `TimelineItem` with `source = "optimistic"` and later mutates it into an app-server-backed row.
- Snapshot reconciliation starts from `optimisticOnlyTimeline`, replays app-server items, then tries to match user messages by text, image compatibility, and turn compatibility.
- Stale snapshots and replayed live events require extra guards such as `knownAppServerItemIds`, `skipOptimisticUserMessageMatch`, and fractional sequence bumps for unmatched local rows.

That design is fragile under timing changes. It is also not a good multi-client source of truth: other clients do not know about the sending tab's optimistic row, so they must still infer identity from app-server item content.

Relevant current code:

- Direct send orchestration: `apps/web/src/composer/useComposerOrchestration.ts`
- Optimistic timeline reducer helpers: `apps/web/src/timeline/reducer.ts`
- Selected thread snapshot/SSE loading: `apps/web/src/timeline/useSelectedThreadTimeline.ts`
- Turn-start route: `apps/gateway/src/routes/turns.rs`
- Normalized timeline event ingestion: `apps/gateway/src/events.rs`
- Thread detail snapshot projection: `apps/gateway/src/routes/threads.rs`
- Existing gateway queue model: `apps/gateway/src/queue.rs` and `apps/gateway/src/store.rs`

## Principles

- Gateway owns shared submission lifecycle. Browsers may render pre-ack local echo, but gateway state becomes authoritative as soon as it acknowledges the submit.
- Identity is explicit. Match pending submissions to app-server user-message items by gateway-stored `clientRequestId`/submission metadata, not by text/image content except as a temporary migration fallback.
- Snapshots include pending submission state. A reconnecting or second browser must not need local React state to show accepted-but-uncommitted user messages.
- Canonical app-server thread history remains canonical. Gateway pending submissions are an overlay while app-server has not committed the user item.
- Confirmed app-server user-message items replace pending submission presentation without duplicate user bubbles.
- Same-text duplicate messages must be safe. The gateway must never delete or confirm the wrong pending submission because two messages have identical text and image count.
- Public contracts stay generated. Rust DTOs generate OpenAPI; frontend types come from `apps/web/src/api/generated/schema.ts`.
- Preserve local/VPN-only deployment assumptions.

## Data Model

Add a gateway-owned direct submission table, separate from `queued_turn_inputs`.

Suggested table: `direct_turn_submissions`

- `id text primary key`
- `thread_id text not null`
- `client_request_id text not null`
- `input_json text not null`
- `options_json text not null`
- `status text not null`
- `server_turn_id text`
- `server_item_id text`
- `pending_skill_mentions_id text`
- `last_error text`
- `created_at text not null`
- `updated_at text not null`
- `accepted_at text`
- `confirmed_at text`
- `deleted_at text`

Suggested constraints and indexes:

- Unique idempotency key: `(thread_id, client_request_id)`.
- Active read index: `(thread_id, deleted_at, status, created_at)`.
- Confirmation lookup index: `(thread_id, server_turn_id, status, created_at)`.
- Server item lookup index: `(thread_id, server_item_id)`.

Suggested statuses:

- `submitting`: gateway persisted the request and is calling app-server `turn/start`.
- `accepted`: app-server accepted `turn/start`, but committed user-message history has not been observed.
- `confirmed`: gateway linked this submission to an app-server user-message item.
- `failed`: gateway could not complete `turn/start`; the error is visible to all clients.

Rows may be soft-deleted after confirmation so pending lists stay small, but the confirmed `server_item_id` mapping should remain queryable for snapshot enrichment and diagnostics.

## Public Gateway Contract

### Turn Start

Extend `TurnStartRequest` in `apps/gateway/src/routes/turns.rs`:

```rust
pub struct TurnStartRequest {
    pub input: Vec<UserInput>,
    pub client_request_id: Option<String>,
    #[serde(flatten)]
    pub options: TurnStartOptions,
}
```

Behavior:

1. If `clientRequestId` is absent, gateway generates one for legacy clients.
2. Gateway reconciles or reads `thread_runtime_state` before direct start.
3. If the thread is active, gateway must not trust the browser's stale idle view. Initial behavior should return a clear `409 Conflict` or `400 Bad Request` instructing the client to queue/steer instead. A later unified endpoint may internally route to `queued_turn_inputs`, but this plan does not require that.
4. Gateway resolves skill inputs as today.
5. Gateway inserts or returns the existing submission for `(thread_id, client_request_id)`.
6. Gateway broadcasts `direct_submission.item_upsert` before calling app-server.
7. Gateway calls app-server `turn/start`.
8. On success, gateway marks the submission `accepted`, broadcasts `direct_submission.item_upsert`, saves turn options, and returns the submission.
9. On failure, gateway marks the submission `failed`, broadcasts `direct_submission.item_upsert`, cleans up pending skill mentions, and returns the error.

Idempotency rule:

- A duplicate POST with the same `(thread_id, clientRequestId)` must not call app-server twice.
- If the stored submission is `submitting`, `accepted`, or `confirmed`, return that state.
- If the stored submission is `failed`, require a new `clientRequestId` for retry unless the implementation adds an explicit retry route later.

Response shape:

```rust
pub struct TurnStartResponse {
    pub submission: DirectTurnSubmission,
    pub raw_response: Option<RawAppServerResponse>,
}
```

The web client currently ignores the raw response, so the important generated type is `submission`.

### Submission DTO

Add a public DTO, generated into frontend types:

```rust
pub struct DirectTurnSubmission {
    pub id: String,
    pub thread_id: String,
    pub client_request_id: String,
    pub input: Vec<UserInput>,
    pub options: TurnStartOptions,
    pub status: DirectTurnSubmissionStatus,
    pub server_turn_id: Option<String>,
    pub server_item_id: Option<String>,
    pub last_error: Option<String>,
    pub display: DirectTurnSubmissionDisplay,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
```

`display` should be gateway-normalized so clients do not re-implement message projection:

```rust
pub struct DirectTurnSubmissionDisplay {
    pub text: String,
    pub images: Vec<DirectTurnSubmissionImage>,
    pub skill_mentions: Vec<TimelineSkillMention>,
}
```

The image DTO should represent local image paths and previewable uploaded image references in generated gateway types. The frontend can then map those generated values to its existing `TimelineImage` presentation shape.

### Thread Detail Snapshot

Extend `ThreadDetailResponse` in `apps/gateway/src/app_server_api.rs` after the app-server payload is adapted by gateway routes:

```rust
pub struct ThreadDetailResponse {
    pub thread: ThreadSummary,
    pub turns: Vec<ThreadTurnSnapshot>,
    pub live_state: ThreadLiveState,
    pub pending_submissions: Vec<DirectTurnSubmission>,
    pub raw_payload: Value,
}
```

Gateway route behavior in `apps/gateway/src/routes/threads.rs`:

- Load app-server `thread/read` as today.
- Enrich snapshot items with skill mentions as today.
- Attach non-deleted `submitting`, `accepted`, and `failed` direct submissions for the thread.
- Do not attach `confirmed` rows as pending submissions.
- Optionally enrich `ThreadItemSnapshot` with `clientRequestId`/`submissionId` when `server_item_id` is known.

### SSE Events

Add event kinds:

- `direct_submission.item_upsert`
- `direct_submission.item_deleted`

Payload for upsert is `DirectTurnSubmission`.

Payload for delete:

```json
{
  "id": "...",
  "threadId": "...",
  "clientRequestId": "...",
  "serverItemId": "..."
}
```

Event replay behavior:

- Add these events to backend operational replay/live filters in `apps/gateway/src/events.rs`.
- Add these event types to `GATEWAY_SSE_EVENT_TYPES` in `apps/web/src/events/stream.ts`.
- They are gateway-owned operational state, like queue and approval events. They must be replayable through `/v1/events`.

## Gateway Reconciliation

Add reconciliation when app-server emits a committed user-message item.

Trigger points:

- Normalized live item upserts in `apps/gateway/src/events.rs::timeline_item_upsert_event`.
- Thread-detail snapshot enrichment in `apps/gateway/src/routes/threads.rs` so reconnects can converge even if the live event was missed.

Matching algorithm for direct submissions:

1. Only consider user-message app-server items with `thread_id` and `turn_id`.
2. Prefer explicit stored mapping if `server_item_id` is already known.
3. Otherwise select the oldest `accepted` direct submission for the same `thread_id` that has no `server_item_id`.
4. Use the existing pending-steer compare-key helper style as a guard only:
   - concatenate text inputs
   - count image/localImage inputs
   - compare against app-server user-message projection
5. If the front accepted submission matches, set `server_turn_id`, `server_item_id`, `status = confirmed`, `confirmed_at`, commit pending skill mentions to the item id, and broadcast `direct_submission.item_deleted`.
6. If it does not match, do not scan later rows. Leave the row pending and log/debug the mismatch.

The front-only rule mirrors the pending-steer plan and avoids deleting the wrong row for duplicate text.

When broadcasting the normalized `timeline.item_upsert`, include the linked `clientRequestId` and/or `submissionId` in `TimelineItemUpsertPayload` or `ThreadItemSnapshot`. This lets the frontend reconcile by explicit identity when it receives the timeline event before the delete event.

Ordering rule:

- Broadcast or deliver the app-server-backed `timeline.item_upsert` before deleting the pending submission where practical.
- Frontend reducers must still tolerate either order because SSE reconnection can replay events around snapshot refreshes.

## Frontend Rendering Model

Split direct pending submissions from canonical timeline state.

Current model:

```text
TimelineState.items includes app-server items and optimistic user messages.
```

Target model:

```text
Rendered timeline = canonical app-server timeline + gateway direct submissions + local pre-ack echo
```

Frontend state ownership:

- Canonical app-server items stay in `TimelineState`.
- Gateway direct submissions live in a separate reducer keyed by `submission.id` and `clientRequestId`.
- Local pre-ack echo lives in a tiny per-tab map keyed by `clientRequestId`.
- When gateway response or SSE upsert arrives for a `clientRequestId`, remove the local pre-ack echo.
- When `direct_submission.item_deleted` arrives, remove the gateway pending submission.
- When a snapshot arrives, replace gateway pending submissions for that thread from `pendingSubmissions` and then apply queued SSE deltas.

Composer changes in `apps/web/src/composer/useComposerOrchestration.ts`:

- Generate `clientRequestId` before local echo.
- Pass `clientRequestId` to `startTurn`.
- Stop calling `addOptimisticUserMessage` for direct idle sends.
- Render a local pre-ack echo only until gateway acknowledges.
- Restore the composer or mark the gateway submission failed according to the gateway response/error.

Timeline reducer simplification in `apps/web/src/timeline/reducer.ts`:

- Remove or deprecate direct-send optimistic helpers:
  - `addOptimisticUserMessage`
  - `updateOptimisticUserMessage`
  - `removeOptimisticUserMessage`
  - `optimisticOnlyTimeline`
  - `shouldCarryLocalUserMessageAcrossSnapshot`
  - `moveUnmatchedLocalUserMessagesAfterSnapshot`
- Keep a fallback user-message de-dupe path temporarily for old timeline events that lack submission identity.
- Prefer `clientRequestId`/`submissionId`/`serverItemId` matching before any text/image equivalent matching.

Presentation:

- Pending gateway submission renders with the same user-message visual treatment.
- Status label maps:
  - local pre-ack: `Sending`
  - `submitting`: `Sending`
  - `accepted`: `Sending`
  - `failed`: `Failed`
- Confirmed app-server messages show no pending label.

## Failure And Retry Policy

For direct idle sends:

- Gateway `failed` state is shared and visible to all clients.
- The sending tab may restore text and attachments to the composer if it is still in the same composer context.
- Other clients should see the failed pending submission or an unobtrusive failed send row until it is dismissed.

To keep the first implementation narrow:

- Do not add a direct-submission retry route in Milestone 1.
- Retrying from the composer creates a new `clientRequestId`.
- Add a delete/dismiss endpoint only if failed shared rows need manual cleanup:
  - `DELETE /v1/threads/{threadId}/direct-submissions/{submissionId}`

## Milestones

### Milestone 1: Gateway Store And Contract

Status: Proposed.

Failing tests first:

- Store migration creates `direct_turn_submissions`.
- Store insert is idempotent for `(thread_id, client_request_id)`.
- Duplicate active insert does not create a second row.
- Status transitions cover `submitting -> accepted -> confirmed` and `submitting -> failed`.
- OpenAPI includes `clientRequestId`, `TurnStartResponse`, `DirectTurnSubmission`, and snapshot `pendingSubmissions`.

Implementation:

- Add store structs and methods in `apps/gateway/src/store.rs`.
- Add `DirectTurnSubmissionStatus` and DTO schemas.
- Extend `TurnStartRequest` and introduce `TurnStartResponse`.
- Extend `ThreadDetailResponse` with `pending_submissions`.
- Add generated OpenAPI coverage.

Exit conditions:

- Focused store and route contract tests pass.
- `cargo test -p kodex-gateway` passes for touched backend modules.
- No handwritten frontend DTOs are introduced.

### Milestone 2: Gateway-Owned Start Lifecycle

Status: Proposed.

Failing tests first:

- `POST /v1/threads/{threadId}/turns` broadcasts a `direct_submission.item_upsert` before calling app-server.
- Successful app-server `turn/start` marks the row `accepted` and broadcasts another upsert.
- Failed app-server `turn/start` marks the row `failed`, broadcasts upsert, and deletes pending skill mentions.
- Duplicate POST with the same `clientRequestId` returns the existing submission and does not call app-server twice.
- Direct submission events replay through `/v1/events`.

Implementation:

- Update `apps/gateway/src/routes/turns.rs` to persist submissions around app-server calls.
- Add submission event append/broadcast helpers, following queue event patterns in `apps/gateway/src/queue.rs`.
- Add event allowlist updates in `apps/gateway/src/events.rs`.
- Preserve existing turn option persistence behavior after successful app-server acceptance.

Exit conditions:

- Route tests prove broadcast ordering and idempotency.
- Backend event replay tests include direct submission events.
- Existing active-turn queue behavior remains unchanged.

### Milestone 3: Confirmation From App-Server Items

Status: Proposed.

Failing tests first:

- A committed app-server `userMessage` confirms and deletes only the oldest matching accepted direct submission.
- Duplicate same-text submissions confirm one row per committed user item in order.
- A stale committed user item from an older turn does not delete a newer accepted submission.
- Mismatched front submission does not scan and delete later submissions.
- Snapshot thread detail confirms missed live commits and excludes confirmed submissions from `pendingSubmissions`.

Implementation:

- Add direct-submission compare-key helpers near existing pending-steer compare-key logic or in a shared gateway helper.
- Call reconciliation from `timeline_item_upsert_event`.
- Call reconciliation/enrichment during `get_thread` snapshot processing.
- Store `server_turn_id` and `server_item_id` for confirmed rows.
- Include explicit submission identity in normalized timeline item payloads when known.

Exit conditions:

- Backend event tests cover same-text and stale-event cases.
- Snapshot refresh converges after missing live SSE.
- Pending skill mentions still commit to the app-server item id.

### Milestone 4: Frontend Pending Submission State

Status: Proposed.

Failing tests first:

- Direct send creates a local echo before gateway response.
- Gateway upsert replaces local echo with gateway pending submission by `clientRequestId`.
- A second rendered App instance receives the gateway pending submission through SSE without local state.
- `direct_submission.item_deleted` removes the pending row only after the app-server user item is available.
- Snapshot `pendingSubmissions` renders accepted submissions after reload/reconnect.
- Same-text duplicate sends do not merge in the frontend unless gateway identity matches.

Implementation:

- Add frontend API types by regenerating from gateway OpenAPI.
- Add a direct-submission reducer under a focused module such as `apps/web/src/submissions`.
- Update `createEventStreamClient` event type list.
- Update `useSelectedThreadTimeline` to apply snapshot `pendingSubmissions` and submission SSE events.
- Update composer start-turn call to send `clientRequestId`.
- Stop adding direct-send optimistic items to `TimelineState`.
- Add rendering integration that overlays local echo and gateway submissions into timeline rows.

Exit conditions:

- Focused frontend tests pass.
- Same-user two-tab test shape proves convergence through gateway state/SSE without reload.
- Existing image upload tests still cover immediate local feedback and retry behavior.

### Milestone 5: Remove Heuristic Optimistic Reconciliation

Status: Proposed.

Failing tests first:

- Snapshot refresh does not need to carry direct optimistic user messages in `TimelineState`.
- Replayed user-message events reconcile by `serverItemId` or submission identity.
- Stale same-text snapshots do not require fractional local sequence movement.
- Legacy events without submission identity still do not duplicate obvious app-server rows.

Implementation:

- Remove direct-send use of `addOptimisticUserMessage`.
- Delete direct optimistic carry-forward logic once tests prove pending submissions cover the scenarios.
- Keep a narrow legacy fallback for app-server duplicate replay only.
- Update old optimistic tests to target gateway submissions or delete tests that codify removed behavior.

Exit conditions:

- `apps/web/src/timeline/reducer.ts` no longer owns direct-send optimistic lifecycle.
- No direct-send visual behavior depends on one tab's React state after gateway acknowledgement.
- Frontend unit/component tests and backend tests pass.

## Verification

Backend:

- `cargo fmt`
- `cargo test -p kodex-gateway`
- Route/OpenAPI tests for new DTOs and events.

Frontend:

- `cd apps/web && npm run generate:api` after gateway contract changes.
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Focused two-tab component/SSE tests for direct submissions.
- Agent-browser smoke pass for desktop and mobile send flows after frontend integration.

Review gate:

- Independent review pass before marking each implementation chunk complete.
- Explicitly check two-client convergence before marking the plan complete.

## Non-Goals

- No multi-gateway distributed submission coordination.
- No WebSocket transport.
- No public internet auth changes.
- No app-server protocol changes unless the checked-in generated schema already supports a better identity field.
- No handwritten API contract docs beyond this plan.
- No retry UX overhaul beyond preserving current composer retry behavior.
