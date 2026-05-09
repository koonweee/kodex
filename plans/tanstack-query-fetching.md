# TanStack Query Fetching Overhaul Plan

## Status

Complete

## Goal

Move frontend server-state fetching that naturally fits query/mutation semantics onto TanStack Query, while leaving specialized reducer and live-stream workflows in their current domain modules unless they can integrate without awkward cache ownership. The immediate product goal is to stop treating "fetching" as "empty data" in sidebar and catalog surfaces, including pinned-thread flicker, while reducing hand-rolled request guards and refresh plumbing.

## Scope

This plan covers frontend data fetching in `apps/web` only:

- Snapshot queries for projects, project threads, chats, pinned threads, approvals, account, rate limits, models, composer settings, skills, automations, and queued inputs.
- Mutations that return or affect those snapshots, including thread create/archive/resume/pin/unpin, automation CRUD/status changes, queued-input actions, approval decisions, account login/logout, and composer settings persistence.
- SSE integration only where migrated cache entries need live patching.

## Non-Goals

- No backend API contract changes unless a migrated query exposes a missing frontend requirement.
- No migration of the timeline reducer to TanStack Query as a primary store.
- No replacement of `createEventStreamClient` or browser `EventSource`.
- No global client-state rewrite for local UI state such as selected thread, sidebar collapse, composer draft text, mobile panel, hover, modals, drag previews, or theme preferences.
- No generated OpenAPI type replacement. `apps/web/src/api/client.ts` remains the typed gateway wrapper layer over generated OpenAPI artifacts.

## Current State

- `apps/web/src/api/client.ts` owns typed request wrappers around `openapi-fetch` for gateway routes such as `listProjects`, `listThreads`, `listPinnedThreads`, `getThreadDetail`, `listQueuedInputs`, `listAutomations`, `getAccount`, `listModels`, `listSkills`, and `getComposerSettings`.
- Startup snapshots are now owned by Query hooks in `App.tsx` and domain hooks. The obsolete `apps/web/src/shell/initialLoad.ts` module has been removed.
- `App.tsx` keeps local UI state for selection, timeline, composer drafts, attachments, modals, and routing, while migrated server snapshots live in Query: projects, project/chat/pinned thread summaries, approvals, selected queued inputs, automations, account, rate limits, skills, models, and composer settings reads.
- Sidebar, automation, queued-input, approval, and rate-limit queries use cache merge rules instead of request-id/revision refs so late snapshots cannot erase newer SSE or mutation data.
- `useSkillCatalog` is a Query-backed catalog hook keyed by cwd, with `skills.changed` forcing a refresh.
- `useSelectedThreadTimeline` intentionally combines `getThreadDetail`, selected-thread SSE, materialization retry, snapshot-required recovery, batched reducer updates, and approval/queue event routing.
- `WorkspaceSidebar` receives arrays, not load states. Empty arrays currently mean both "confirmed empty" and "not loaded yet", which can collapse the Pinned section while `listPinnedThreads` is in flight.

## Settled Design Decisions

- TanStack Query should become the primary owner for sidebar list snapshots. The migration should delete the React-owned `projects`, `chatThreads`, `pinnedThreads`, and `threadsByProjectId` server-state copies from `App.tsx` once equivalent cache behavior is covered.
- Sidebar list ownership migration is all-or-nothing for `projects`, `projectThreads(projectId)`, `chatThreads`, and `pinnedThreads`. Do not migrate pinned-only while project/chat lists remain React-owned because pinned filtering depends on all of those lists moving together.
- Thread summary cache writes must go through a dedicated adapter, for example `apps/web/src/threads/cache.ts`. Direct `queryClient.setQueryData` calls for thread summaries outside that adapter are not allowed.
- Query results are not universally "latest request wins". Domains touched by SSE, local optimistic state, or mutation responses need merge/preserve rules.
- Freshness should be mostly explicit and SSE-driven. Disable automatic focus/reconnect refetch globally by default, then opt individual queries into refetch only when the domain is low risk.
- The first behavior-changing Query milestone after provider setup is the sidebar migration and pinned flicker fix. Lower-risk catalog/account/model conversions come later.

## Fit Assessment

Good TanStack Query fits:

- `GET /v1/projects`
- `GET /v1/threads?projectId=...`
- `GET /v1/chats/threads`
- `GET /v1/threads/pinned`
- `GET /v1/approvals?status=pending`
- `GET /v1/account`
- `GET /v1/account/rate-limits`
- `GET /v1/models`
- `GET /v1/skills?cwd=...&forceReload=...`
- `GET /v1/composer-settings?projectId=...`
- `GET /v1/automations`
- `GET /v1/threads/{threadId}/queued-inputs`

Good mutation fits:

- Thread creation, resume, archive, pin, unpin, seen, queued-input create/retry/steer/delete, turn interrupt/steer/start, automation create/update/pause/resume/delete, approval decision, account login/cancel/logout, image upload, and composer settings persistence.

Keep custom or hybrid:

- `useSelectedThreadTimeline` should stay reducer-owned. TanStack Query may fetch the initial snapshot or refresh snapshot later, but timeline display state should remain in `timeline/reducer.ts` because it merges live events, local optimistic rows, snapshot recovery, and batched streaming updates.
- `uploadImages` can be a mutation but should not be cached as reusable query data.
- `startTurn`, `interruptTurn`, and `steerTurn` can use mutations for status/error reporting, but the canonical visible state still comes from gateway/SSE, timeline reducer updates, and queued-input records.

Replacement-safe query results:

- `GET /v1/projects`
- `GET /v1/models`
- `GET /v1/skills?cwd=...&forceReload=...`, assuming `skills.changed` invalidates/refetches and no local edits exist
- `GET /v1/composer-settings?projectId=...`, with draft overrides kept local
- `GET /v1/account` after explicit login/logout invalidation

Merge-protected query results:

- project, chat, and pinned thread summaries
- pending approvals with tombstones
- queued inputs
- automations
- rate limits when a live update has already arrived
- selected thread detail summaries when they update sidebar caches

## Query Key Shape

Create `apps/web/src/api/queryKeys.ts` with stable keys:

```ts
export const queryKeys = {
  account: ["account"] as const,
  automations: ["automations"] as const,
  chatThreads: ["threads", "chat"] as const,
  composerSettings: (projectId: string | null) => ["composer-settings", projectId ?? "global"] as const,
  models: ["models"] as const,
  pendingApprovals: ["approvals", "pending"] as const,
  pinnedThreads: ["threads", "pinned"] as const,
  projectThreads: (projectId: string) => ["threads", "project", projectId] as const,
  projects: ["projects"] as const,
  queuedInputs: (threadId: string) => ["queued-inputs", threadId] as const,
  rateLimits: ["account", "rate-limits"] as const,
  skills: (cwd: string | null) => ["skills", cwd ?? "global"] as const,
};
```

Implementation can adjust names, but keys should keep domain and scope visible so SSE handlers can patch exact or grouped caches.

## Milestone 1: Install Query Provider And Conventions

Status: Complete

Scope:

- `apps/web/package.json`
- `apps/web/src/main.tsx`
- `apps/web/src/App.tsx`
- new `apps/web/src/api/queryClient.ts`
- new `apps/web/src/api/queryKeys.ts`
- test harness files under `apps/web/src/test`

Work:

- Add `@tanstack/react-query`.
- Create one `QueryClient` with defaults suitable for a local gateway app:
  - low or disabled retry for mutation-like user actions
  - `refetchOnWindowFocus: false` globally
  - `refetchOnReconnect: false` globally unless a domain explicitly opts in
  - enough `gcTime` to keep recent sidebar data when navigating
  - a conservative `staleTime`, adjusted per query only with an explicit reason
- Wrap the app and test harnesses in `QueryClientProvider`.
- Add a test helper that creates an isolated client per test and clears cache between tests.
- Document the project convention:
  - server snapshots live in Query when migrated
  - per-tab UI state stays in React state
  - SSE and mutation responses update Query cache through domain helpers
  - thread summary cache writes go through `threads/cache.ts`
  - Query hooks classify their result handling as replacement-safe or merge-protected
  - timeline reducer remains custom unless a later plan changes it

Exit criteria:

- `cd apps/web && npm test -- App.test.tsx main.test.tsx` passes or equivalent focused provider/harness tests pass.
- `cd apps/web && npm run build` passes after the provider and dependency are wired.
- No domain behavior changes beyond provider setup.

## Milestone 2: Sidebar Query Migration And Pinned Flicker Fix

Status: Complete

Scope:

- `apps/web/src/shell/initialLoad.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/threads/cache.ts`
- `apps/web/src/threads/helpers.ts`
- `apps/web/src/threads/WorkspaceSidebar.tsx`
- `apps/web/src/threads/useThreadMetadata.ts`
- `apps/web/src/threads/useThreadReadState.ts`
- `apps/web/src/threads/events.ts`
- sidebar tests in `apps/web/src/App.mvp.shell.test.tsx`, `apps/web/src/threads/*.test.tsx`

Work:

- Replace `projects`, `threadsByProjectId`, `chatThreads`, and `pinnedThreads` startup fetching together with query hooks:
  - `useProjectsQuery`
  - `useProjectThreadsQuery(projectId)`
  - `useChatThreadsQuery`
  - `usePinnedThreadsQuery`
- Do not migrate pinned-only. Project, chat, and pinned thread lists move as one sidebar ownership slice.
- Keep selected project/thread and draft state in React state.
- Add `apps/web/src/threads/cache.ts` before UI rewiring. It owns all thread-summary `queryClient.setQueryData` calls and exposes helpers such as:
  - `upsertProjectThread(queryClient, projectId, thread)`
  - `upsertChatThread(queryClient, thread)`
  - `upsertPinnedThread(queryClient, thread)`
  - `updateThreadEverywhere(queryClient, threadId, patcher)`
  - `removeThreadEverywhere(queryClient, threadId)`
  - `applyThreadPinState(queryClient, threadId, pinnedAt, knownThread?)`
  - `applyThreadReadState(queryClient, threadId, readState)`
  - `mergeProjectThreadSnapshot(queryClient, projectId, loadedThreads, routeSelectedThread, selectedThreadId)`
- The cache adapter must support:
  - update a thread in all known project-thread caches
  - update a thread in chat and pinned caches
  - remove archived threads from all relevant caches
  - add/remove pinned summaries without duplicating normal lists
- Preserve route-selected hydration behavior. If a deep-linked thread is loaded from detail before its list query resolves, list query success must merge the route-selected summary instead of losing selected-thread title/status.
- Keep a temporary compatibility selector that derives the existing `workspaceSidebarProps` shape from Query results. Delete old React server-state only after the selector passes existing app/sidebar tests.
- Remove `loadProjectThreads` request-id plumbing only after Query cache merge tests and compatibility selector coverage pass.
- Change `WorkspaceSidebar` props so it can distinguish:
  - first load with no data
  - background refetch with previous data
  - confirmed loaded empty
  - error with previous data
- Fix pinned flicker by rendering last known pinned rows during `isFetching` or `isRefetching`, and only hiding the Pinned section when the pinned query is loaded and empty.
- Gate normal-list filtering of pinned rows on trusted pinned state, or derive normal filtering from each thread's `pinnedAt` while ensuring stale pinned rows stay visible until a successful pinned snapshot or live unpin event says otherwise.
- Wire `thread.pin_updated`, `timeline.thread_metadata`, `timeline.thread_status`, and completed-turn read-state events to cache helper updates.

Required mitigation gates:

- Add `threads/cache.ts` with pure cache updater tests before touching `WorkspaceSidebar`.
- Add a failing pinned-refetch flicker test before implementing the UI fix.
- Add stale snapshot tests before deleting React sidebar state:
  - late project list after local create
  - late chat list after local create
  - pinned snapshot pending while project list has pinned rows
  - pin/unpin SSE moving rows across caches
- Keep the compatibility selector until existing App/sidebar tests pass on Query-derived props.
- Delete old React sidebar server-state only after the compatibility selector passes the existing tests and the new stale/flicker tests.
- Run focused tests after each mitigation step, not only at the end.

Exit criteria:

- `threads/cache.ts` tests pass and are the only supported thread-summary cache mutation surface.
- A focused app-level test reproduces delayed `/v1/threads/pinned`: pinned rows remain visible or reserved from last data while refetching and do not disappear from every sidebar section.
- Focused stale snapshot tests pass for late project list, late chat list, delayed pinned snapshot, and pin/unpin SSE row movement.
- Existing pinned threads tests pass.
- Existing sidebar ordering/reorder tests pass.
- A two-tab-shaped fake SSE test covers pin/unpin and metadata cache convergence without browser-local durable decisions.
- The old React-owned `projects`, `chatThreads`, `pinnedThreads`, and `threadsByProjectId` server-state copies are deleted from `App.tsx`, with selected/draft/timeline UI state still local.
- `cd apps/web && npm test -- App.mvp.shell.test.tsx threads` passes, or the nearest focused equivalent if Vitest file filtering differs.
- `$agent-browser` validation covers sidebar startup/refetch behavior on desktop and mobile widths once implementation starts.

## Milestone 3: Automations And Queued Inputs

Status: Complete

Scope:

- automation state in `apps/web/src/App.tsx`
- `apps/web/src/automations/*`
- queued input state in `apps/web/src/App.tsx`
- `apps/web/src/composer/useComposerOrchestration.ts`
- `apps/web/src/composer/QueuedSteerCard.tsx`

Work:

- Convert `listAutomations()` to `useQuery({ queryKey: queryKeys.automations })`, enabled when the Automations pane is first opened or prefetched after startup if that proves cheap.
- Replace `automationsLoaded`, `automationsLoading`, and `automationRevisionRef` with Query cache updates and invalidation.
- Implement automation mutations with `useMutation`, updating cache from mutation responses and from `automation.item_upsert` / `automation.item_deleted` SSE.
- Convert selected-thread `listQueuedInputs(threadId)` to a query keyed by thread id.
- Replace `queueRevisionByThreadIdRef` with cache-level merge rules:
  - queue SSE upsert/delete writes directly into `queuedInputs(threadId)`
  - initial query success sorts rows
  - mutation responses write returned rows into the same cache
  - late snapshots must not resurrect rows deleted or superseded by newer SSE/mutation state
- Keep composer draft state, pending attachment state, send confirmation state, and materializing thread state in local React state.

Exit criteria:

- Existing automation tests pass, especially "refetches when a live automation event arrives before the snapshot resolves".
- Existing queued input tests pass, especially late initial pending response, stale resurrection prevention, retry, steer, and delete flows.
- Focused cache helper tests cover late snapshot versus live update ordering for queued inputs.
- `cd apps/web && npm test -- App.automations.test.tsx App.mvp.composer-input.test.tsx` passes, or the nearest focused equivalent.

## Milestone 4: Convert Simple Read-Only Queries

Status: Complete

Scope:

- `apps/web/src/composer/useSkillCatalog.ts`
- `apps/web/src/composer/useComposerSettingsState.ts`
- account/rate-limit usage in `apps/web/src/App.tsx` and `apps/web/src/account/useAccountSession.ts`
- model loading via `listModels`
- new query hooks under `apps/web/src/api/queries.ts` or colocated domain hooks

Work:

- Replace `useSkillCatalog` request-id state with `useQuery` keyed by cwd and a force-refresh path for `skills.changed`.
- Convert `listModels` and `getComposerSettings(projectId)` hydration to query-backed reads while preserving draft override semantics in `useComposerSettingsState`.
- Convert `getAccount` initial reads to a replacement-safe query.
- Convert `getRateLimits` to a merge-protected query because live rate-limit updates should beat a late initial snapshot.
- Preserve existing account login/logout local state, but update or invalidate the account query after logout/login-related mutations.
- Use Query status flags instead of empty arrays/nulls where UI needs to distinguish first load from refetch.

Exit criteria:

- Focused skill catalog tests cover initial load, cwd change, `skills.changed` invalidation, loading-with-previous-data, and error preservation.
- Composer settings tests still pass, including draft edit protection and selected-thread overrides.
- Account footer tests still pass.
- Rate-limit tests still pass, especially live update before late initial snapshot.
- No handwritten duplicate gateway DTOs are introduced.

## Milestone 5: Mutations And Cache Invalidation Sweep

Status: Complete

Scope:

- thread mutations in `App.tsx` and `useComposerOrchestration`
- approval decisions in `apps/web/src/approvals/useApprovalsState.ts`
- account mutations in `apps/web/src/account/useAccountSession.ts`
- composer setting persistence in `apps/web/src/composer/useComposerSettingsState.ts`
- image upload handling in `apps/web/src/composer/useComposerOrchestration.ts`

Work:

- Wrap direct user actions in `useMutation` where the action has a clear request lifecycle and error path.
- Use mutation responses to update Query cache synchronously where the returned value is authoritative.
- Use `invalidateQueries` for server-derived snapshots where direct cache repair is more complex than refetching.
- Keep explicit local confirmation UI for composer sends/uploads where the user needs immediate status independent of query cache.
- Keep approval tombstone logic if it is still needed to avoid late stale pending approval resurrection; otherwise move it into a cache helper with equivalent tests.
- Add a small mutation error-reporting convention so `reportError` does not have to be threaded through every migrated call site.

Exit criteria:

- Existing approval stream/UI tests pass, including streamed approval before initial pending approvals resolve and stale pending resurrection prevention.
- Composer send, image upload retry, stop, steer, and queued flows pass existing tests.
- Account login/logout tests pass.
- No mutation introduces browser-only ownership for shared thread/session state.

Implementation note:

- Query mutations now cover automations, queued-input create/retry/steer/delete, approval decisions, account login/cancel/logout, composer settings persistence, project creation, archive, pin, and unpin. Composer turn start/stop and image upload still keep their explicit local progress and optimistic timeline handling; their canonical shared state remains gateway/SSE/timeline-owned rather than cached as reusable Query data.

## Milestone 6: Timeline Boundary And Snapshot Hybrid

Status: Complete

Scope:

- `apps/web/src/timeline/useSelectedThreadTimeline.ts`
- `apps/web/src/timeline/reducer.ts`
- selected-thread detail handling in `apps/web/src/App.tsx`

Work:

- Decide whether `getThreadDetail(threadId)` remains fully custom inside `useSelectedThreadTimeline` or uses `queryClient.fetchQuery` as an imperative cache-backed fetch.
- If using Query for snapshots:
  - keep reducer-owned timeline state
  - call `fetchQuery` for snapshot load/refresh
  - keep materialization retry, `timeline.snapshot_required`, reconnect refresh, and selected-thread stream token handling explicit
  - do not render timeline directly from Query `data`
- If keeping fully custom:
  - document the boundary in the new query convention file and leave the hook unchanged except for thread-summary cache updates from snapshots.

Exit criteria:

- Timeline reducer tests pass unchanged.
- Snapshot recovery tests pass, including reconnect and `timeline.snapshot_required`.
- Thread-open performance tests or focused navigation tests still pass.
- The plan's non-goal is preserved: no broad timeline data-store rewrite.

Decision:

- `getThreadDetail(threadId)` remains fully custom inside the selected-thread timeline flow for this overhaul. It handles stream tokens, materialization retry, `timeline.snapshot_required`, reconnect recovery, reducer merges, and side-routing of approval/queue events. Query is used for thread-summary cache updates around the timeline, but timeline display state is not rendered from Query `data`.

## Milestone 7: Cleanup, Docs, And Review

Status: Complete

Scope:

- `apps/web/src/App.tsx`
- `apps/web/src/shell/initialLoad.ts`
- domain hooks touched by earlier milestones
- `README.md`
- `AGENTS.md` only if contributor workflow changes
- `plans/index.md`

Work:

- Delete `initialLoad.ts` if Query hooks fully replace it; otherwise reduce it to non-query startup wiring.
- Remove obsolete request-id and revision refs after tests prove equivalent cache behavior.
- Consolidate cache helper tests near the domain helpers they protect.
- Update README if frontend setup now requires `@tanstack/react-query` concepts, devtools commands, or changed test guidance.
- Update AGENTS only if the frontend workflow/contributor rules change.
- Run an independent review pass focused on:
  - same-user two-tab convergence
  - stale snapshot overwrites
  - query keys and invalidation breadth
  - keeping local UI state out of Query
  - not duplicating generated API types

Exit criteria:

- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes.
- `$agent-browser` validates:
  - desktop sidebar startup and pinned refetch behavior
  - mobile sidebar Projects/Chats/Pinned behavior
  - Automations pane open/load/mutation behavior
  - composer queued-steer behavior after selected-thread switch, covered by deterministic fake-gateway UI tests when no live active-turn gateway state is available for browser smoke
- Review finds no major correctness issues.
- [plans/index.md](index.md) status is updated when implementation starts and when the plan completes.

Completion notes:

- `apps/web/src/shell/initialLoad.ts` was deleted after startup reads moved to Query hooks.
- Query-backed server state now covers sidebar snapshots, automations, selected queued inputs, approvals, account, rate limits, skills, models, and composer settings reads.
- Mutation wrappers now cover the Query-fitting action paths. Composer turn start/stop and image upload keep explicit local progress and timeline/SSE ownership.
- Browser validation covered desktop sidebar startup with pinned rows, mobile Projects/Chats/Pinned navigation, Automations open/load/details, and a mocked automation create mutation. Stale pinned refetch ordering and queued-steer selected-thread switching are covered by focused fake-gateway tests because they require controlled in-flight gateway responses and active-turn state.

## Verification Summary

Implementation chunks should run focused tests first, then broader verification before completion:

- `cd apps/web && npm test -- <focused files>`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- `$agent-browser` for browser-observable sidebar, automations, and composer flows after UI-facing milestones.

No OpenAPI regeneration is expected unless the migration exposes missing gateway response fields. If gateway routes or DTOs change, regenerate frontend API types with a running gateway and `cd apps/web && npm run generate:api`.

## Risks And Open Questions

- Query version: choose the current `@tanstack/react-query` major that matches React 19 and the rest of the frontend toolchain before Milestone 1.
- Cache source of truth: settled as Query-owned for sidebar list snapshots, with `threads/cache.ts` as the hard mutation boundary. The remaining risk is proving the adapter before deleting old React state.
- Deep-link hydration: `mergeRouteSelectedThreadIntoList` currently protects selected route data while list snapshots resolve. The migration needs an equivalent merge/cache seed in `threads/cache.ts`.
- Stale SSE versus snapshot ordering: queued inputs, approvals, automations, rate limits, and thread summaries are merge-protected domains. Query migration must preserve existing stale-response tests and add cache helper tests rather than relying on invalidation alone.
- Refetch defaults: settled as disabled by default for focus/reconnect refetch. Individual opt-ins need an explicit domain reason and tests if they touch SSE-backed data.
- Timeline ownership: forcing the timeline reducer into Query would be high wrangling. The expected boundary is snapshot fetch optional, reducer state custom.
