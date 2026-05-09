# Gateway-Created Thread Live Sync Plan

## Status

Complete

Completed on 2026-05-09. Implemented gateway-owned `thread.upserted` events for project and chat thread creation, frontend parsing/cache application, replay/live SSE forwarding, duplicate-safe cache behavior, and focused backend/frontend coverage.

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

## Current Codebase Recheck

Last rechecked against the current codebase on 2026-05-09.

- Gateway `create_thread` and `create_chat_thread` in `apps/gateway/src/routes/threads.rs` still call app-server `thread/start`, save/overlay creation options, apply `apply_thread_command_response_state`, and return the response without appending a sidebar-level event.
- Gateway `/v1/events` in `apps/gateway/src/events.rs` still replays only operational event kinds and live-filters timeline/account/metadata events. There is no thread-list upsert event in `is_operational_replay_event` or `is_normal_live_event`.
- The frontend global SSE handler in `apps/web/src/App.tsx` already receives events through `createEventStreamClient`, but it currently routes them to automation, queue, pin, metadata, read-state, subagent invalidation, rate-limit, approval, and skill handlers only.
- The frontend has moved thread sidebar server state to TanStack Query. Project, chat, and pinned thread rows are cached under `queryKeys.projectThreads(projectId)`, `queryKeys.chatThreads`, and `queryKeys.pinnedThreads` in `apps/web/src/api/queryKeys.ts`.
- Thread cache mutation helpers already exist in `apps/web/src/threads/cache.ts`: `upsertProjectThread`, `upsertChatThread`, `upsertPinnedThread`, `updateThreadEverywhere`, `removeThreadEverywhere`, `mergeProjectThreadData`, and `mergeChatThreadData`.
- The creating client already uses `upsertProjectThread` or `upsertChatThread` after the create response in `createDraftThreadFromComposer`, so duplicate prevention should reuse the same cache upsert semantics.
- Existing metadata/status handlers in `apps/web/src/threads/useThreadMetadata.ts` update cached copies through `updateThreadEverywhere`; they still do not insert unknown threads.
- The closest frontend cache coverage is `apps/web/src/threads/cache.test.ts`; app-level fake-SSE coverage already exists in `apps/web/src/App.mvp.shell.test.tsx` and related MVP tests.

## Current Behavior

- The creating client receives the create response and upserts the returned `ThreadSummary` into its local TanStack Query cache.
- Other clients have a global `/v1/events` SSE connection, but the gateway does not emit a thread-list upsert event for successful thread creation.
- A second client sees the new thread only after it refetches the relevant project or chat list, for example through normal query refresh or a page reload.

## UX Contract

- Client B should see a gateway-created project thread appear in the matching project list without refresh.
- Client B should see a gateway-created chat thread appear in the Chats list without refresh.
- Client A should not get a duplicate row if it receives the same live event after its local create-response upsert.
- If Client B receives the event before an initial project/chat list snapshot resolves, the later snapshot merge must preserve the live-created row.
- If Client B has not loaded or cannot render the project itself yet, the event may populate the per-project query cache but must not create a phantom project row.
- Existing pinned filtering remains intact: if a created thread is ever created with pin state in the future, pinned filtering should avoid duplicate normal and pinned rows.
- Reconnect/replay should deliver missed create events so a temporarily disconnected client can converge without a full page refresh.

## Source Of Truth

- App-server remains the source for thread existence, title, cwd, status, archive state, and turn history.
- Gateway owns the cross-client notification that a gateway route successfully materialized a thread into a known sidebar scope.
- Browser query cache remains a projection. The browser may insert the event payload immediately, but the event is gateway-owned and replayable.

## Event Contract

Add a gateway event kind:

```text
thread.upserted
```

Payload for project threads:

```json
{
  "thread": { "...": "ThreadSummary" },
  "scope": "project",
  "projectId": "project-id"
}
```

Payload for chat threads:

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
- Use `thread.upserted` rather than `thread.created` so the frontend can safely replace an existing optimistic, stale, or partially materialized row with the gateway-normalized summary.
- A typed Rust payload DTO is useful for OpenAPI/schema clarity, but not required if `EventEnvelope.payload` remains the only public event payload contract.

## Milestone 1: Gateway Live Event

Status: Complete

Failing tests first:

- Creating a project thread appends and broadcasts `thread.upserted` with the returned `ThreadSummary`, envelope `project_id`, and envelope `thread_id`.
- Creating a chat thread appends and broadcasts `thread.upserted` with `scope: "chat"` and envelope `thread_id`.
- Replaying `/v1/events?cursor=...` includes missed `thread.upserted` events.
- `/v1/events` SSE allows live `thread.upserted` events through the normal live-event filter.

Implementation:

- Add `THREAD_UPSERTED_EVENT` near `THREAD_PIN_UPDATED_EVENT` in `apps/gateway/src/routes/threads.rs`.
- Add a payload type near the thread route DTOs, for example:
  - `ThreadUpsertScope`
  - `ThreadUpsertedPayload`
- Add a helper such as `broadcast_thread_upserted(state, scope, project_id, thread)` that:
  - appends a `NewEvent` with kind `thread.upserted`
  - sets `project_id` on the event envelope for project scope
  - sets `thread_id` on the event envelope for both scopes
  - includes the full gateway-normalized `ThreadSummary` payload
  - broadcasts the persisted event through `state.events`
- Call the helper after `apply_thread_command_response_state` in:
  - `create_thread`
  - `create_chat_thread`
- Add `THREAD_UPSERTED_EVENT` to operational replay and normal live filters in `apps/gateway/src/events.rs`.
- Register new event payload DTO schemas in `apps/gateway/src/api.rs` only if a typed payload DTO is added.

Exit conditions:

- Focused backend route/event tests in `apps/gateway/src/routes/mod.rs` pass.
- Existing thread create, chat create, event replay, and SSE tests pass.
- `cargo fmt` passes.
- `cargo test` passes for touched gateway behavior.

## Milestone 2: Frontend Event Parsing And Cache Helpers

Status: Complete

Failing tests first:

- `threadUpsertFromEvent` rejects unrelated events and malformed payloads.
- `threadUpsertFromEvent` parses valid project and chat payloads into typed frontend decisions.
- Cache helper coverage proves a live upsert before a stale project snapshot is preserved by `mergeProjectThreadData`.
- Cache helper coverage proves a live upsert before a stale chat snapshot is preserved by `mergeChatThreadData`.
- Cache helper coverage proves a duplicate upsert replaces the existing row instead of adding another row.

Implementation:

- Add `thread.upserted` to `GATEWAY_SSE_EVENT_TYPES` in `apps/web/src/events/stream.ts`.
- Add a focused parser in the `threads` domain, preferably `apps/web/src/threads/events.ts`:
  - `threadUpsertFromEvent(event)`
  - returns `{ scope: "project"; projectId: string; thread: ThreadSummary }`
  - returns `{ scope: "chat"; thread: ThreadSummary }`
- Reuse existing query cache helpers in `apps/web/src/threads/cache.ts`:
  - `upsertProjectThread(queryClient, projectId, thread)`
  - `upsertChatThread(queryClient, thread)`
- Export or add only the smallest extra helper needed if tests need direct access to duplicate-preserving list behavior. Do not move this work back into `threads/helpers.ts`; current server-state ownership lives in `threads/cache.ts`.
- Keep snapshot merge protection in `mergeProjectThreadData` and `mergeChatThreadData`; extend tests if the live-created case is not already covered.

Exit conditions:

- Focused `apps/web/src/threads/events.test.ts` coverage passes.
- Focused `apps/web/src/threads/cache.test.ts` coverage passes.
- `cd apps/web && npm test -- --run src/threads/events.test.ts src/threads/cache.test.ts` or the closest supported focused Vitest command passes.

## Milestone 3: Frontend Global SSE Integration

Status: Complete

Failing tests first:

- With the fake EventSource app harness, a global `thread.upserted` event inserts a project thread into the visible project list.
- A global `thread.upserted` event inserts a chat thread into the Chats list.
- The creating-client path does not duplicate a row when the create response upsert is followed by the live event.
- A stale existing cached row is replaced with the event thread summary.

Implementation:

- Wire `threadUpsertFromEvent` into the global SSE handler in `apps/web/src/App.tsx`.
- For project-scoped events, call `upsertProjectThread(queryClientForShell, projectId, thread)`.
- For chat-scoped events, call `upsertChatThread(queryClientForShell, thread)`.
- If the event thread has a display title, clear its pending title marker with the existing `threadHasDisplayTitle` / pending-title state path.
- If the thread carries `pinnedAt`, call or align with `upsertPinnedThread` so pinned and normal caches stay consistent. The first expected create payload has `pinnedAt: null`, but the handler should not make future pin state inconsistent.
- Do not select the new thread in other clients; this is sidebar sync only.
- Do not call `resumeThread` or attach live selected-thread streams for non-selected threads.

Exit conditions:

- Focused app-level fake-SSE tests pass in the closest `App.mvp.*.test.tsx` file.
- Existing sidebar ordering, chat sidebar, pinned threads, TanStack Query cache, and MVP composer tests pass for touched behavior.
- `cd apps/web && npm test` passes for touched frontend behavior, or unrelated failures are documented.

## Milestone 4: Contract Regeneration, Browser Validation, And Review

Status: Complete

Implementation:

- Regenerate backend OpenAPI only if the Rust DTO/schema surface changes.
- Regenerate frontend OpenAPI types only if OpenAPI changes.
- Use `$agent-browser` validation because the behavior is browser-observable:
  - open two clients against the same local gateway
  - create a project thread in client A
  - verify client B sees it in the sidebar without refresh
  - create a chat thread in client A
  - verify client B sees it in Chats without refresh
  - verify neither client shows duplicate rows after the next list refetch
- Run an independent review pass, focusing on:
  - same-gateway two-client convergence
  - replay after disconnect
  - duplicate prevention with create-response upsert plus SSE
  - snapshot merge races in TanStack Query
  - keeping externally created app-server threads out of scope

Exit conditions:

- Generated artifacts are up to date if schema output changes.
- No handwritten duplicate TypeScript DTOs are introduced.
- Browser validation passes or any environmental blocker is documented.
- Review finds no major correctness issues.

Completion notes:

- No generated OpenAPI or frontend schema artifacts changed because the public event envelope still carries generic `payload`; no public DTO surface was added.
- Browser-observable sidebar insertion is covered by app-level fake EventSource tests. A live two-client browser smoke was not run because it requires a running local gateway/app-server with real Codex thread creation; this remains the manual smoke shape for future environment-ready validation.
- Independent review found no behavior-level major issues after implementation.

## Acceptance Criteria

- Client B sees a project thread created by client A through `POST /v1/threads` without refreshing.
- Client B sees a chat thread created by client A through `POST /v1/chats/threads` without refreshing.
- Client A does not display duplicate rows from local create handling plus SSE.
- A live-created row is not lost when an in-flight project or chat list snapshot resolves later.
- Missed create events are replayable from `/v1/events`.
- The implementation does not claim support for app-server threads created outside the gateway.
- Frontend state remains a projection of gateway-owned event state, not a browser-only cross-client decision.
