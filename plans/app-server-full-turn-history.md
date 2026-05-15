# Codex 0.130.0 Bump And Full Turn History Plan

## Status

Complete.

## Problem

`GET /v1/threads/{thread_id}` currently builds thread detail from app-server `thread/read` with `includeTurns: true`. On the observed thread `019e2a06-ec1d-7cf1-9f08-203638fbeab8`, that native snapshot returned only user messages, assistant messages, and file changes. The gateway event store had additional live events for command execution and reasoning, but those did not appear in the snapshot and therefore did not render in the worked section.

Do not repair this by merging gateway event-store history into snapshots. The gateway should continue treating app-server as the canonical history source and should use the native app-server APIs that expose richer persisted turn history.

## Upstream Version Scope

Move the pinned Codex app-server schema and expected runtime from `0.128.0` to stable `0.130.0`.

Reasons:

- The checked-in `0.128.0` `ThreadTurnsListParams` schema has `threadId`, `cursor`, `limit`, and `sortDirection`, but no `itemsView`.
- Upstream `0.130.0` release notes include app-server paging for large threads with `notLoaded`, `summary`, or `full` turn item views.
- The current upstream app-server README documents `thread/turns/list` with `itemsView`, `nextCursor`, and `backwardsCursor`.

Implementation requirements:

- Update the local Codex binary used by the gateway to `0.130.0`.
- Regenerate schemas with `apps/gateway/scripts/generate-app-server-schema.sh 0.130.0`.
- Replace schema include paths and constants in `apps/gateway/src/schema.rs`.
- Update docs that mention `apps/gateway/app-server-schema/0.128.0/json`.
- Update tests and fixtures that assert `cliVersion: "0.128.0"` only where they represent the current schema/runtime version.
- Keep experimental API initialization enabled, since `thread/turns/list` and `itemsView` are still experimental API surface in the app-server docs.

## Implementation Plan

### 1. Add native paged full-history reads

Add app-server adapter support in `apps/gateway/src/app_server_api.rs`:

- Add a typed `ThreadTurnItemsView` enum for `notLoaded`, `summary`, and `full`.
- Add a `ThreadTurnsListPage` parser for `data`, `nextCursor`, `backwardsCursor`, and raw payload.
- Add `thread_turns_list_page(thread_id, cursor, sort_direction, items_view, limit)`.
- Add `thread_turns_list_full(thread_id)` that requests `sortDirection: "asc"`, `itemsView: "full"`, follows `nextCursor`, and returns ordered `ThreadTurnSnapshot` values.

Use existing `ThreadTurnSnapshot::from_payload` and `ThreadItemSnapshot::from_payload` so the gateway remains pass-through for app-server turn item variants. The DTOs are already generic enough to carry `commandExecution` and `reasoning` raw payloads if app-server returns them.

### 2. Make thread detail use full turns

Update the selected-thread detail path in `apps/gateway/src/routes/threads.rs`:

- Stop relying on `thread/read includeTurns: true` as the rich history source.
- Read thread metadata with `thread/read` without populated turns, or add an adapter helper that returns the same `ThreadDetailResponse` shell with empty turns.
- Populate `ThreadDetailResponse.turns` from `thread_turns_list_full`.
- Keep `apply_thread_detail_response_state` behavior unchanged so gateway-owned sidebar, pin, read, and skill metadata overlays still apply after the native snapshot is assembled.

Do not read from `events` to backfill missing snapshot items. The event table remains live transport/replay/debug state, not canonical completed thread history.

### 3. Keep related routes consistent

Audit every code path that currently calls `thread_read(thread_id)` for completed-turn or detail semantics:

- `GET /v1/threads/{thread_id}` should use the full turn-list path.
- Read/seen state should continue using gateway-owned seen markers but compare against the app-server completed turns returned by the native history source.
- Resume and fork paths can remain on their existing response flow initially, but include a follow-up check for whether `excludeTurns: true` plus `thread/turns/list itemsView: "full"` should replace eager populated turns for large histories.

### 4. Preserve frontend behavior, then verify richer items render

The frontend should not need a new public DTO if `ThreadDetailResponse.turns[].items[].rawPayload` keeps the same shape. Add focused tests anyway:

- Backend route test proving `GET /v1/threads/{id}` sends `thread/turns/list` with `itemsView: "full"` and returns `commandExecution` and `reasoning` items from that response.
- Backend pagination test proving multiple pages are concatenated in ascending order.
- Frontend timeline test proving command execution and reasoning items from an initial snapshot render inside the worked section, without relying on live SSE events.
- Regression test proving the gateway does not merge stored `events` into a snapshot when app-server omits an item.

### 5. Runtime verification

After implementation:

- Run focused gateway tests around app-server adapter and thread routes.
- Run focused frontend timeline tests and `cd apps/web && npm run build`.
- Start the fullstack dev environment.
- Use agent-browser against `http://127.0.0.1:5173/threads/019e2a06-ec1d-7cf1-9f08-203638fbeab8`, expand the worked section, and verify whether command and reasoning rows now appear.
- If that historical thread still lacks rich persisted history under app-server `full`, create or use a new `0.130.0` thread with `persistExtendedHistory` coverage and verify the same UI path there.

## New Upstream Features Since 0.128.0 To Consider

Worth implementing now:

- `thread/turns/list itemsView`: implement now. This directly fixes full worked-section history without gateway-side merging.
- Better ThreadStore summaries, renames, resume, and fork behavior for pathless threads: audit after the schema upgrade because it may simplify local fallback handling around missing rollout paths.
- More turn item coverage from `0.129.0`, including apply-patch file changes, image view items, MCP tool calls, and stored web search/tool calls: verify existing timeline renderers still handle these as first-class or hidden fallback items.

Separate plan:

- Live config refresh for app-server threads is covered by [App-server live config refresh plan](app-server-live-config-refresh.md). Keep that work separate so the schema/runtime bump and thread history fix can land without a broader settings refactor.

Potential later follow-ups:

- `excludeTurns: true` for resume/fork plus paged `thread/turns/list`: useful for large-thread performance once the detail endpoint is on paged reads.
- `thread/turns/items/list`: documented as reserved and currently unsupported upstream, so do not implement yet.
- `remote-control`: possibly useful for a future control-plane mode, but not needed for local gateway history correctness.
- Plugin share metadata, discoverability controls, and bundled hook details: relevant to the plugin UI later, not this plan.
- Bedrock `aws login` credentials: relevant only if gateway exposes or documents Bedrock account setup.
- `view_image` selected-environment resolution: relevant to file previews and multi-environment sessions, but not needed for this snapshot fix.

## Risks

- `itemsView: "full"` can only return what app-server persisted. If an older rollout lacks rich persisted history, the gateway must not fill it from local events just to make one historical thread look complete.
- Full views can be large. The implementation must page with `nextCursor` and avoid assuming one response contains all turns.
- The schema upgrade may introduce request/response shape changes outside this path. Keep the first implementation narrow and update only code required by validation failures and compile/test failures.
- `0.131.0-alpha.*` releases exist upstream, but this plan intentionally targets stable `0.130.0`.

## Exit Conditions

- Checked-in app-server schema is regenerated for `0.130.0`.
- Gateway thread detail uses native `thread/turns/list` with `itemsView: "full"` for selected-thread snapshots.
- Command execution and reasoning items returned by app-server full history are present in `GET /v1/threads/{thread_id}` and render in the worked section.
- No gateway event-store merge is introduced for completed history.
- Focused backend/frontend tests and manual agent-browser verification pass or document an app-server persistence limitation for pre-upgrade historical threads.

## Completion Notes

- `apps/gateway/app-server-schema/0.130.0/json` is checked in and `apps/gateway/src/schema.rs` points at it.
- `GET /v1/threads/{thread_id}` now reads metadata with `thread/read includeTurns:false` and populates turns from paginated `thread/turns/list` with `itemsView:"full"`.
- Other operational `CodexClient::thread_read` call sites keep the old eager `thread/read includeTurns:true` behavior where they need app-server's current operational thread shape rather than selected-thread full history.
- Backend tests cover full-history pagination, command/reasoning item projection, and the no-gateway-event-merge regression.
- Frontend snapshot tests cover command/reasoning items rendering through worked rows.
- Agent-browser smoke confirmed the updated app loads, but the historical thread `019e2a06-ec1d-7cf1-9f08-203638fbeab8` returned unavailable in this local gateway/app-server context. No replacement persisted `0.130.0` thread with rich command/reasoning history was available without starting new model work, so the exact historical-thread browser verification is documented as blocked by local app-server/thread availability rather than repaired with gateway event-store backfill.
