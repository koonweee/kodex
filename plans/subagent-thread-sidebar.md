# Subagent Thread Sidebar Plan

## Scope

Add a read-only subagent thread viewer for the selected thread. When the gateway reports that the selected active thread has currently loaded descendant subagents, the thread header shows a robot icon beside the existing three-dot menu. The user can toggle a right-side sidebar, manually choose one subagent, and inspect that subagent with the existing timeline renderer.

This feature is intentionally observer-only. It does not switch the active thread, does not call `thread/resume` for subagents, does not render approval action controls in the sidebar, and does not infer canonical subagent relationships from frontend presentation state.

## Settled Decisions

- Discovery is gateway-owned through a typed endpoint, not inferred from collab timeline rows.
- No frontend fallback from `receiverThreadIds`; the robot icon and viewer appear only from gateway data.
- The endpoint returns currently loaded descendant subagents only.
- The viewer loads snapshots with existing `GET /v1/threads/{threadId}` and follows live updates with existing `/v1/events?threadId=...`.
- The viewer must not call `POST /v1/threads/{threadId}/resume`.
- The sidebar is read-only, including approvals.
- Users manually choose which subagent to inspect.
- The robot icon is hidden when no currently loaded subagents exist.
- The sidebar does not default open.
- Desktop uses an inline right-side panel. Mobile can use a drawer if straightforward, but desktop is the first implementation target.
- If the selected subagent disappears while the panel is open, choose the next available subagent; close only when none remain.
- Gateway ordering is stable created order, ascending by `createdAt`, with `id` as a tie-breaker.
- The sidebar reuses `TimelineView` in a compact/read-only container.
- Add generated OpenAPI and generated frontend TypeScript types in the same implementation.

## Current State

- Gateway `CodexClient::thread_read` already calls app-server `thread/read` with `includeTurns: true` and normalizes the response as `ThreadDetailResponse` in `apps/gateway/src/app_server_api.rs`.
- Gateway `GET /v1/threads/{threadId}` in `apps/gateway/src/routes/threads.rs` is already the canonical snapshot source for frontend timelines.
- Gateway SSE in `apps/gateway/src/events.rs` already normalizes app-server notifications into `timeline.item_delta`, `timeline.item_upsert`, `timeline.turn_upsert`, `timeline.thread_status`, and `timeline.thread_metadata` events and filters them by `threadId` for `/v1/events`.
- Frontend selected-thread loading in `apps/web/src/timeline/useSelectedThreadTimeline.ts` already implements the snapshot-first plus thread-filtered-SSE pattern that the subagent viewer can reuse or extract.
- Frontend `ThreadPanel` renders the main `TimelineView` and header action menu in `apps/web/src/threads/ThreadPanel.tsx`.
- Frontend collab rendering in `apps/web/src/timeline/presentationCollab.ts` already knows how to present subagent names from nickname and role, but it is presentation data and should not be the source of truth for discovery.
- `ThreadSummary` currently preserves volatile app-server fields in `raw_payload` but does not expose first-class `agentNickname` or `agentRole`; the new endpoint should expose typed fields instead of requiring frontend raw-payload parsing.
- The checked-in app-server schema under `apps/gateway/app-server-schema/0.128.0/json/v2` includes `ThreadLoadedListResponse`, `agentNickname`, `agentRole`, and `source.subAgent.thread_spawn.parent_thread_id` fields.

## Milestone 1: Gateway Subagent Discovery API

Status: Complete

Scope:

- `apps/gateway/src/app_server_api.rs`
- `apps/gateway/src/routes/threads.rs`
- `apps/gateway/src/routes/mod.rs` tests
- `apps/gateway/src/api.rs` / OpenAPI route registration if needed

Work:

- Add a `ThreadLoadedListResponse` DTO and `CodexClient::thread_loaded_list` wrapper for app-server `thread/loaded/list`.
- Add typed subagent DTOs, for example:
  - `ThreadSubagentSummary`
  - `ThreadSubagentListResponse`
- Include `id`, `parentThreadId`, `agentNickname`, `agentRole`, `status`, `liveState`, and `updatedAt`.
- Add typed `agent_nickname` and `agent_role` fields to `ThreadSummary` if useful for shared parsing, or parse them directly into the subagent DTO.
- Add a helper that extracts `source.subAgent.thread_spawn.parent_thread_id` from app-server thread payloads.
- Implement `GET /v1/threads/{threadId}/subagents`.
- The endpoint should:
  - call `thread/loaded/list`
  - call `thread/read includeTurns:false` or `thread_read_summary` for each loaded id except the parent
  - walk descendant edges rooted at `{threadId}`
  - return only currently loaded descendants
  - sort by `createdAt`, then `id`
  - avoid failing the whole endpoint for one unreadable loaded thread when possible, unless every relevant read fails
- Add focused backend tests for:
  - loaded child and grandchild discovery
  - unrelated loaded threads excluded
  - sorting by `createdAt` then `id`
  - nickname and role projection
  - endpoint returns an empty list when no descendants are loaded

Exit criteria:

- `cargo fmt`
- Focused gateway route/API tests pass.
- `cargo test` passes or any unrelated existing failure is documented.
- `GET /v1/threads/{threadId}/subagents` appears in `/openapi.json`.

## Milestone 2: Generated Contract And Frontend Client

Status: Complete

Scope:

- `apps/web/src/api/generated/schema.ts`
- `apps/web/src/api/client.ts`
- `apps/web/src/api/queryKeys.ts`

Work:

- Regenerate the gateway OpenAPI output after adding the Rust DTOs and route.
- Regenerate frontend OpenAPI TypeScript types with the existing `apps/web` generation command.
- Add generated-type-backed exports for `ThreadSubagentSummary` and `ThreadSubagentListResponse`.
- Add `listThreadSubagents(threadId: string): Promise<ThreadSubagentSummary[]>`.
- Add `queryKeys.threadSubagents(threadId)`.
- Do not add handwritten duplicate DTO interfaces.

Exit criteria:

- Generated schema diff includes the new endpoint and response schemas.
- `cd apps/web && npm test -- --run` passes for focused API/client tests if any are added.
- `cd apps/web && npm run build` passes after frontend integration.

## Milestone 3: Read-Only Subagent Timeline State

Status: Complete

Scope:

- `apps/web/src/timeline/useSelectedThreadTimeline.ts`
- New `apps/web/src/timeline/useReadonlyThreadTimeline.ts` or shared timeline loader hook
- `apps/web/src/timeline/reducer.ts`
- Existing timeline reducer tests as needed

Work:

- Extract the reusable snapshot-first plus thread-filtered-SSE behavior from `useSelectedThreadTimeline` if that keeps duplication low.
- Add a read-only timeline hook for a sidebar thread id:
  - calls `getThreadDetail(subagentThreadId)` for the snapshot
  - applies `applyTimelineSnapshot`
  - opens `createEventStreamClient({ threadId: subagentThreadId })`
  - refetches snapshots on reconnect or `timeline.snapshot_required`
  - does not touch selected-thread read markers
  - does not mutate global selected thread state
  - does not call `resumeThread`
  - ignores approval actions and queue events for sidebar state
- Keep the hook local to the sidebar viewer if sharing would make selected-thread behavior harder to reason about.

Exit criteria:

- Focused Vitest coverage proves the read-only hook loads a snapshot and applies live timeline events for its own thread id.
- Tests prove the hook does not call `resumeThread`.
- Existing selected-thread timeline tests still pass.

## Milestone 4: Sidebar Viewer UI

Status: Complete

Scope:

- `apps/web/src/App.tsx`
- `apps/web/src/shell/KodexShellView.tsx`
- `apps/web/src/threads/ThreadPanel.tsx`
- New `apps/web/src/threads/SubagentThreadViewer.tsx`
- `apps/web/src/styles/shell.css`
- `apps/web/src/styles/timeline.css` or a focused sidebar CSS file

Work:

- Add a selected-parent React Query for `listThreadSubagents(selectedThreadId)`, enabled for normal selected threads.
- Refetch the subagent query when relevant selected-thread SSE/global SSE activity indicates thread status or collab activity changed.
- Poll the subagent query at a modest interval, such as 2 seconds, while the selected parent thread is active; stop polling when idle.
- Add browser-local state for:
  - whether the subagent sidebar is open
  - selected subagent id for the current parent thread
- Default the selected subagent to an active/running row if present, otherwise the first row in gateway order.
- Preserve manual selection while the row remains in the current parent’s subagent list.
- If the selected row disappears, choose the next available row; close the panel only when the list becomes empty.
- Add a robot `ActionIcon` in the thread header immediately before the existing three-dot menu.
- Hide the robot icon when the subagent query has no rows.
- Toggle the sidebar from the robot icon; do not default it open.
- Use existing Mantine themed primitives for control chrome:
  - `ActionIcon` and `Tooltip` for the robot toggle
  - `SegmentedControl`, `Tabs`, or another existing Mantine selection primitive for choosing among subagents
  - `Badge` for status
  - Mantine layout/scroll primitives where they fit the existing shell
  - `Drawer` for mobile only if mobile support is included in this milestone
- Keep custom CSS focused on the sidebar layout, responsive sizing, and compact timeline density rather than one-off button, badge, menu, or selector chrome.
- Render a desktop inline right-side panel with:
  - compact subagent selector for multiple rows
  - selected subagent label from nickname/role/id
  - status indicator
  - compact `TimelineView`
  - no composer
  - no approval action controls
- Add responsive behavior. Mobile can use a Mantine drawer if straightforward; otherwise hide the inline panel on mobile and leave the robot trigger for a later mobile-specific milestone.

Exit criteria:

- Component tests cover:
  - robot icon hidden with zero subagents
  - robot icon visible with at least one subagent
  - icon toggles the sidebar
  - sidebar does not default open
  - manual subagent selection persists while available
  - selected subagent changes or sidebar closes when rows disappear
  - no composer or approval actions render in the sidebar
- `cd apps/web && npm test -- --run` passes.
- `cd apps/web && npm run build` passes.
- `$agent-browser` validation verifies desktop layout, toggle behavior, sidebar readability, no overlapping header controls, and responsive behavior at mobile width.

## Verification

- Backend:
  - `cargo fmt`
  - `cargo test`
  - inspect `GET /openapi.json` for the new `/v1/threads/{threadId}/subagents` path
- Frontend:
  - regenerate API types from the running gateway
  - `cd apps/web && npm test -- --run`
  - `cd apps/web && npm run build`
- Browser:
  - start full-stack dev with the project workflow
  - use `$agent-browser` to verify a selected thread with subagents shows the robot icon, the panel toggles open/closed, the existing three-dot menu remains usable, and the sidebar timeline updates read-only
  - verify a thread without loaded subagents has no robot icon
  - verify mobile behavior does not overlap the main header or composer

## Risks And Open Questions

- App-server notification coverage: live sidebar streaming depends on the gateway receiving notifications for loaded subagent threads. This should hold for currently loaded active descendants, but the implementation should be tested with a real spawned subagent.
- Endpoint partial failures: `thread/loaded/list` can return ids that fail `thread/read`. The plan recommends tolerating individual unreadable rows, but the exact error reporting should be decided during implementation based on existing gateway error conventions.
- Mobile behavior: desktop inline sidebar is required. Mobile drawer support is allowed only if it stays simple; otherwise defer mobile subagent viewing behind a follow-up plan.
- Polling cadence: 2 seconds while the parent is active is a starting point. If it creates unnecessary app-server load, prefer SSE-triggered invalidation plus a slower active-only poll.
- Historical closed subagents are explicitly out of scope. This plan covers currently loaded descendant subagents only.
