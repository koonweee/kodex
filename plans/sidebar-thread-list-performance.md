# Sidebar Thread List Performance Plan

## Status

Complete.

Implemented the lightweight/paged list primitives, `/v1/sidebar/threads` snapshot endpoint, frontend startup snapshot hydration, cursor-backed show-more loading, generated API schema updates, browser hard-load profiling, and independent review/fix loop.

## Context

Thread route profiling for `019e25fc-37bb-76a0-9129-78961038397d` showed the selected thread detail endpoint is not the dominant load cost. Direct `GET /v1/threads/{threadId}` calls were roughly 210-224ms for a 1.24MB selected-thread payload, while full page startup was stretched by sidebar/global list hydration:

- `GET /v1/chats/threads` was roughly 0.9-1.2s.
- Per-project `GET /v1/threads?projectId=...&limit=100` calls were roughly 0.6-1.2s each.
- `GET /v1/threads/pinned` returned about 1.8MB and currently calls `thread/read` for each pinned id with `includeTurns: true`.

The goal is to reduce sidebar thread-list request fan-out and list endpoint cost without deferring selected-thread loading, adding caches/persistence, or dropping existing sidebar functionality.

Relevant seams:

- `apps/web/src/App.tsx` currently starts `projectsQuery`, one `useQueries` entry per project for `listThreads(project.id)`, one `chatThreadsQuery`, and one `pinnedThreadsQuery`.
- `apps/web/src/api/client.ts` exposes `listThreads`, `listChatThreads`, and `listPinnedThreads`, but discards list cursors.
- `apps/web/src/api/queryKeys.ts` owns sidebar query keys for project, chat, and pinned thread summaries.
- `apps/web/src/threads/cache.ts` owns thread-summary cache mutation helpers and must remain the single cache write surface.
- `apps/web/src/threads/WorkspaceSidebar.tsx` renders all project sections expanded by default and uses local show-more/show-less over already-loaded rows.
- `apps/gateway/src/routes/threads.rs` owns `GET /v1/threads`, `GET /v1/chats/threads`, and `GET /v1/threads/pinned`.
- `apps/gateway/src/app_server_api.rs` already supports `thread/list` with a single cwd or a list of cwds through `thread_list` and `thread_list_cwds_updated`.
- `apps/gateway/src/app_server_api.rs::thread_read` currently requests `includeTurns: true`; selected-thread detail uses `thread_read_full_history` plus `thread/turns/list`.

## Current State

- Project thread startup is browser-fanned-out: once projects resolve, the frontend sends one project-thread query per project.
- Chat thread listing is backend-unbounded from the browser perspective: `list_all_chat_threads` pages through every app-server chat-list page before responding and then forces `next_cursor = None`.
- Pinned thread listing is detail-heavy: `list_pinned_threads` calls `thread_read` per pinned thread, which includes turns, even though the sidebar only needs `ThreadSummary`.
- Existing `ThreadListResponse` already carries `nextCursor` and `backwardsCursor`, but frontend wrappers return only `threads`.
- Existing sidebar correctness depends on merge-protected Query caches and SSE/mutation helpers in `threads/cache.ts`; replacing fetch shape must preserve late snapshot, pin/unpin, read-state, archive, and title-update convergence.
- Public API contract changes must be expressed through Rust DTOs, generated OpenAPI, and regenerated frontend TypeScript types.

## Non-Goals

- Do not defer sidebar loading behind selected-thread detail as part of this plan.
- Do not add gateway or browser persistence beyond existing SQLite state and existing TanStack Query cache behavior.
- Do not remove existing `/v1/threads`, `/v1/chats/threads`, or `/v1/threads/pinned` routes in this change; keep them compatible for tests, MCP/self-control callers, and incremental rollout.
- Do not change the default sidebar disclosure state or hide project sections to avoid fetching.
- Do not replace the selected-thread timeline reducer or canonical `GET /v1/threads/{threadId}` detail path.

## Milestones

### 1. Add Lightweight And Paged List Primitives

Scope: `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/routes/threads.rs`, route tests in `apps/gateway/src/routes/mod.rs`, and generated API schemas.

Work:

- Add an app-server helper for summary-only `thread/read` that requests `includeTurns: false` and parses only `payload.thread` into `ThreadSummary`.
- Change `GET /v1/threads/pinned` to use summary-only reads, not full `thread_read`, while preserving archive filtering, missing-thread handling, pin overlays, composer settings overlays, and read-state overlays.
- Extend `GET /v1/chats/threads` to accept `cursor` and `limit` through `ThreadListQuery`-equivalent parameters.
- Change chat listing so one request returns one app-server page by default, preserving `nextCursor` instead of draining all pages. Use a conservative default limit such as 100 to match project-thread startup behavior.
- Keep a helper for explicitly draining all chat pages only if a test or caller still needs it; normal sidebar startup should not use it.

Exit criteria:

- Backend tests prove pinned listing sends `thread/read` with `includeTurns: false` and does not include turns in the pinned-list path.
- Backend tests prove chat listing returns the first page, preserves `nextCursor`, and uses the requested/default limit.
- Existing project-thread list behavior remains unchanged for `GET /v1/threads?projectId=...&limit=100`.
- `cargo fmt` and focused gateway route/adapter tests pass.

### 2. Add A Sidebar Thread Snapshot Endpoint

Scope: `apps/gateway/src/routes/threads.rs` or a new sidebar route module, `apps/gateway/src/api.rs`, `apps/gateway/src/routes/mod.rs`, `apps/gateway/src/app_server_api.rs`, and generated OpenAPI.

Work:

- Add a gateway-owned startup endpoint, recommended route: `GET /v1/sidebar/threads`.
- Return a typed response that contains:
  - projects in sidebar order,
  - project thread groups keyed by `projectId`, each with `threads`, `nextCursor`, and `backwardsCursor`,
  - chat threads as a paged `ThreadListResponse`,
  - pinned threads as a lightweight `ThreadListResponse`.
- Preserve current startup semantics for project lists: initial project groups should represent the same first page currently fetched through `GET /v1/threads?projectId=...&limit=100`.
- Internally reduce app-server pressure where safe:
  - Start with exact per-project behavior if that is the simplest correctness-preserving implementation.
  - If using `thread_list_cwds_updated` across project cwds, continue paging until each project has its first 100 rows or app-server pages are exhausted, so one busy project cannot starve other project sections.
  - Bound internal concurrency if exact per-project calls remain necessary.
- Reuse the same overlay path as existing list endpoints: pin state, composer settings, read state, archived filtering, and raw payload synchronization.
- Keep existing scoped endpoints as compatibility and as pagination/refetch endpoints for one section.

Exit criteria:

- Backend tests compare sidebar snapshot project groups against the existing scoped project-thread route for representative projects.
- Backend tests prove chat and pinned sections in the sidebar snapshot use the lightweight/paged paths from Milestone 1.
- The OpenAPI document exposes the new response DTOs, and generated frontend schema can consume them without handwritten DTO duplication.

### 3. Migrate Frontend Startup To The Snapshot

Scope: `apps/web/src/api/client.ts`, `apps/web/src/api/queryKeys.ts`, a new thread/sidebar query hook module, `apps/web/src/App.tsx`, `apps/web/src/threads/cache.ts`, and app/sidebar tests.

Work:

- Add a typed `getSidebarThreads()` API wrapper backed by generated OpenAPI types.
- Add a query key such as `queryKeys.sidebarThreads`.
- Extract startup sidebar fetching from `App.tsx` into a small hook, for example `apps/web/src/threads/useSidebarThreadsQuery.ts`, so `App.tsx` does not grow further.
- Replace startup `projectsQuery`, per-project `useQueries`, `chatThreadsQuery`, and `pinnedThreadsQuery` with one sidebar snapshot query.
- On successful snapshot load, hydrate the existing Query cache slices through `threads/cache.ts` helpers or a dedicated adapter:
  - `queryKeys.projects`
  - `queryKeys.projectThreads(projectId)`
  - `queryKeys.chatThreads`
  - `queryKeys.pinnedThreads`
- Preserve merge-protected behavior for route-selected thread summaries, local create/fork/archive mutations, pin/unpin mutations, pending title rows, unread state, and late snapshots.
- Keep existing scoped query keys usable for targeted invalidation and pagination after the startup snapshot.

Exit criteria:

- Frontend tests prove initial app startup makes one sidebar snapshot request rather than one chat request plus N project-thread requests plus one pinned request.
- Existing App shell tests still pass for project selection, chat selection, pinned filtering, archive removal, read-state updates, live upsert events, and route-selected thread hydration.
- Cache adapter tests cover stale sidebar snapshot merging after a local create, pin/unpin SSE, and selected-thread detail arriving before sidebar startup resolves.

### 4. Preserve Show-More Functionality With Pagination

Scope: `apps/web/src/api/client.ts`, `apps/web/src/threads/WorkspaceSidebar.tsx`, sidebar state/hooks, and focused sidebar tests.

Work:

- Stop treating show-more as purely local once a section has a `nextCursor`.
- For chat threads, append the next page from `GET /v1/chats/threads?cursor=...&limit=...` when the user expands beyond the loaded rows and `nextCursor` is present.
- For project threads, keep using `GET /v1/threads?projectId=...&cursor=...&limit=100` for per-project pagination after the startup snapshot.
- Preserve the current collapsed display limit of five rows before show-more.
- Keep loading/error state local to the section being expanded so one slow project does not block other sidebar sections.
- Ensure pinned remains summary-only; if pinned eventually needs pagination, add it behind the same section-level cursor shape rather than full detail reads.

Exit criteria:

- Sidebar tests prove show-more reveals already-loaded rows without an API call when no cursor exists.
- Sidebar tests prove show-more appends another page when a cursor exists for Chats and for a project section.
- Existing search, collapse, selected-row visibility, and touch/fine-pointer row actions continue to pass.

### 5. Verification, Profiling, And Rollout

Scope: backend and frontend verification plus browser profiling.

Work:

- Regenerate OpenAPI and frontend TypeScript schema after route/DTO changes.
- Run focused backend and frontend checks first, then broader checks when the migration is complete.
- Use `$agent-browser` to profile a hard load of `/threads/019e25fc-37bb-76a0-9129-78961038397d` and compare startup requests with the baseline profile.
- Confirm no selected-thread deferral was introduced: selected detail should still start immediately on a direct `/threads/{threadId}` load.
- Update this plan and `plans/index.md` when implementation starts or completes.

Exit criteria:

- `cargo fmt`
- Focused gateway route/adapter tests for thread list, chat list, pinned list, and sidebar snapshot behavior.
- `cd apps/web && npm test -- src/App.mvp.shell.test.tsx src/threads/cache.test.ts src/threads/WorkspaceSidebar.reorder.test.tsx`
- `cd apps/web && npm run build`
- `$agent-browser` hard-load profile shows fewer initial sidebar HTTP requests and no full-turn pinned-list payload.
- An independent review pass finds no major correctness or two-tab convergence issues.

Verification result:

- `cargo fmt --check` passed.
- `cargo test -p kodex-gateway` passed outside the sandbox after the MCP test hit the sandbox's `Operation not permitted` restriction.
- `cd apps/web && npm test` passed.
- `cd apps/web && npm run build` passed with the existing large-chunk warning.
- `$agent-browser` hard-load profile for `/threads/019e25fc-37bb-76a0-9129-78961038397d` showed selected thread detail starting immediately alongside `/v1/sidebar/threads`; the old startup sidebar fan-out was absent on the profiled 8798 load.

## Risks And Open Questions

- Exact per-project semantics versus app-server batching is the main backend tradeoff. A multi-cwd `thread/list` can reduce app-server scans, but preserving 100 rows per project requires paging until each project has enough rows or app-server is exhausted. The implementation should prefer correctness first, then optimize internal batching after tests lock the contract.
- Summary-only `thread/read` must expose enough metadata to hide archived pinned threads. If app-server omits archive/status fields without turns, pinned should fall back to the cheapest route that provides archive state while still avoiding timeline payloads.
- A single sidebar snapshot changes frontend fetch ownership. Existing SSE/mutation cache helpers must remain authoritative so two tabs converge through gateway state and live events, not through stale local list assumptions.
- Adding cursor-backed show-more changes a UI path that is currently local-only. Tests should cover both already-loaded and network-backed expansion so the behavior stays predictable.
