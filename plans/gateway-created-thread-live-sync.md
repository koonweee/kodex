# Gateway-Created Thread Live Sync Plan

## Status

Proposed

## Goal

When one browser client creates a thread through the Kodex gateway, other browser clients connected to the same gateway should see the new sidebar row without a page refresh.

## Scope

This plan covers only threads created through gateway-owned routes:

- `POST /v1/threads`
- `POST /v1/chats/threads`

The gateway already knows the correct sidebar scope for these routes: project thread creation has `projectId`, and chat thread creation belongs to the flat Chats list.

## Non-Goals

- No support for arbitrary upstream `thread/started` notifications created outside the gateway.
- No cwd-to-project inference for externally created app-server threads.
- No WebSocket transport.
- No browser-local polling loop.
- No changes to public deployment or auth assumptions.
- No sidebar ordering redesign beyond inserting or replacing the new row.

## Current Behavior

- The creating client receives the create response and prepends the returned `ThreadSummary` into local React state.
- Other clients have a global `/v1/events` SSE connection, but the gateway does not emit a thread-list upsert event for successful thread creation.
- Existing thread metadata/status handlers update known rows; they do not insert unknown threads into project or chat lists.
- A second client sees the new thread only after it refetches the relevant list, for example by loading the project/chat list again or refreshing.

## UX Contract

- Client B should see a gateway-created project thread appear in the matching project list if that project list is already loaded.
- Client B should see a gateway-created chat thread appear in the Chats list if chats are already loaded.
- The creating client should not get a duplicate row if it receives the same live event after its local optimistic prepend.
- If the target project or chat list is not loaded in a client, the client may ignore the live event and rely on the normal list fetch when that scope is opened.
- Existing pinned filtering remains intact: if a created thread is ever created with pin state in the future, pinned filtering should avoid duplicate normal and pinned rows.
- Reconnect/replay should deliver missed create events so a temporarily disconnected client can converge without a full page refresh.

## Source Of Truth

- App-server remains the source for thread existence, title, cwd, status, archive state, and turn history.
- Gateway owns the cross-client notification that a gateway route successfully materialized a thread into a known sidebar scope.
- Browser state remains a projection. The browser may insert the event payload immediately, but the event is gateway-owned and replayable.

## Event Contract

Add a gateway event kind:

```text
thread.upserted
```

Payload:

```json
{
  "thread": { "...": "ThreadSummary" },
  "scope": "project",
  "projectId": "project-id"
}
```

For chat threads:

```json
{
  "thread": { "...": "ThreadSummary" },
  "scope": "chat",
  "projectId": null
}
```

Notes:

- Store `project_id` on the event envelope for project thread creation.
- Store `thread_id` on the event envelope for both project and chat thread creation.
- Use `thread.upserted` rather than `thread.created` so the frontend can safely replace an existing optimistic or stale row with the gateway-authoritative summary.

## Milestone 1: Gateway Live Event

Status: Proposed

Failing tests first:

- Creating a project thread appends and broadcasts `thread.upserted` with the returned `ThreadSummary`, envelope `project_id`, and envelope `thread_id`.
- Creating a chat thread appends and broadcasts `thread.upserted` with `scope: "chat"` and envelope `thread_id`.
- Replaying `/v1/events?cursor=...` includes missed `thread.upserted` events.
- `/v1/events` SSE allows live `thread.upserted` events through the normal live-event filter.

Implementation:

- Add `THREAD_UPSERTED_EVENT` near the existing thread event constants in `apps/gateway/src/routes/threads.rs`.
- Add a helper such as `broadcast_thread_upserted(state, scope, project_id, thread)` that:
  - appends a `NewEvent` with kind `thread.upserted`
  - includes the full gateway-normalized `ThreadSummary` payload
  - broadcasts the persisted event through `state.events`
- Call the helper after `apply_thread_command_response_state` in:
  - `create_thread`
  - `create_chat_thread`
- Add `thread.upserted` to operational replay and normal live filters in `apps/gateway/src/events.rs`.
- Register any new event payload DTOs with OpenAPI if event payloads are represented by typed schemas.

Exit conditions:

- Focused backend route/event tests pass.
- Existing thread create, chat create, event replay, and SSE tests pass.
- `cargo fmt` passes.
- `cargo test` passes for touched gateway behavior.

## Milestone 2: Frontend Event Handling

Status: Proposed

Failing tests first:

- With two mounted app clients or an equivalent fake SSE harness, client B inserts a project thread after receiving `thread.upserted`.
- Client B inserts a chat thread after receiving `thread.upserted`.
- Client A does not duplicate its own newly created row when the event arrives after local prepend.
- A stale existing row is replaced with the event thread summary.
- Unknown/unloaded project scopes are ignored without throwing and are later covered by normal `GET /v1/threads`.

Implementation:

- Add `thread.upserted` to `GATEWAY_SSE_EVENT_TYPES` in `apps/web/src/events/stream.ts`.
- Add a focused parser/helper in the `threads` domain, for example:
  - `threadUpsertFromEvent(event)`
  - returns `{ scope: "project"; projectId: string; thread: ThreadSummary }`
  - returns `{ scope: "chat"; thread: ThreadSummary }`
- Add pure helpers in `apps/web/src/threads/helpers.ts`:
  - `upsertThreadForProject(current, projectId, thread)`
  - `upsertThreadInList(current, thread)`
  - preserve existing order by moving newly unseen threads to the front
  - replace in place or move to front for existing materializing rows, depending on current sidebar ordering expectations
- Wire the event into the global SSE handler in `apps/web/src/App.tsx`.
- For project-scoped events, only mutate `threadsByProjectId[projectId]` if that project list is already loaded.
- For chat-scoped events, only mutate `chatThreads` if chats have been loaded. If the app currently treats `chatThreads` as loaded from startup, insert directly.
- Clear pending title state if the event thread has a display title.

Exit conditions:

- Focused frontend helper tests pass.
- Focused app-level two-client or fake-SSE tests pass.
- Existing sidebar ordering, chat sidebar, pinned threads, and MVP composer tests pass for touched behavior.
- `cd apps/web && npm test` passes for touched frontend behavior.

## Milestone 3: Contract Regeneration And Review

Status: Proposed

Implementation:

- Regenerate backend OpenAPI if the event payload DTO affects generated schema output.
- Regenerate frontend API types if OpenAPI changes.
- Run an independent review pass, focusing on:
  - same-gateway two-client convergence
  - replay after disconnect
  - duplicate prevention with the creating client
  - keeping externally created app-server threads out of scope

Exit conditions:

- Generated artifacts are up to date if schema output changes.
- No handwritten duplicate TypeScript DTOs are introduced.
- Review finds no major correctness issues.

## Acceptance Criteria

- Client B sees a project thread created by client A through `POST /v1/threads` without refreshing, when B already has that project list loaded.
- Client B sees a chat thread created by client A through `POST /v1/chats/threads` without refreshing, when B already has the chat list loaded.
- Client A does not display duplicate rows from local create handling plus SSE.
- Missed create events are replayable from `/v1/events`.
- The implementation does not claim support for app-server threads created outside the gateway.
- Frontend state remains a projection of gateway-owned event state, not a browser-only cross-client decision.
