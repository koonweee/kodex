# Project-Local Pinned Threads Plan

## Status

Complete. Implemented project-local pinned thread rendering, pinned-first project ordering, collapsed-project pinned visibility, pinned-cache project merge coverage, focused frontend tests, build verification, browser validation, and independent review.

## Goal

Remove the global Pinned section from the Projects tab and render pinned project threads inside their owning project groups instead. Pinned project threads should sort to the top of that project, stay visible when the project is collapsed, and continue using gateway-owned pin state. This is a frontend presentation change only; the gateway pin API, OpenAPI schema, and durable SQLite source of truth remain unchanged.

## Settled Product Decisions

- Scope is Projects tab only.
- Pinned chat behavior is unchanged for this plan.
- Within a project, pinned threads sort before title-pending and approval-needed rows.
- Pinned project threads remain visible when their project is collapsed.
- No separate handwritten API contract docs are needed because the public API contract does not change.

## Pre-Implementation State

- `apps/web/src/App.tsx` derives `sidebarPinnedThreads`, `sidebarChatThreads`, and `sidebarThreadsByProjectId` before passing `workspaceSidebarProps`.
- `sidebarThreadsByProjectId` currently uses `withoutPinnedProjectThreads`, so project-pinned rows are stripped from normal project groups before rendering.
- `apps/web/src/threads/WorkspaceSidebar.tsx` computes `sortedPinnedThreads`, filters them by `sidebarScope`, and renders `.kodex-pinned-section` before the project tree.
- Project groups render their threads from `threadsByProjectId[project.id]` through `sortThreadsForSidebar`.
- `sortThreadsForSidebar` prioritizes title-pending and approval-needed rows, then recency and stable title/id tie-breakers.
- `sortPinnedThreadsForSidebar` sorts with the existing attention priority before the pin-time tie-breaker, which does not match the new project-local ordering decision.
- Collapsed projects currently surface only selected, unread completed agent turn, and in-progress threads through `threadSurfacesWhenProjectCollapsed`.
- Existing pin ownership and two-tab convergence are already gateway-owned through pin/unpin API calls, TanStack Query caches, and `thread.pin_updated` SSE handling.

## Non-Goals

- No backend route, database, OpenAPI, generated schema, or API client change.
- No change to pin/unpin mutation behavior or gateway-owned source of truth.
- No change to pinned chat behavior unless implementation discovers a direct regression in the shared pinned section path.
- No drag ordering for pinned rows.
- No new project collapse preference model beyond the existing `collapsedProjectIds` browser-local disclosure state.

## Code Seams

- `apps/web/src/App.tsx`
  - `sidebarPinnedThreads`, `sidebarChatThreads`, and `sidebarThreadsByProjectId` around the sidebar prop derivation.
  - `workspaceSidebarProps` where `pinnedThreads` and `threadsByProjectId` are passed into `WorkspaceSidebar`.
- `apps/web/src/threads/helpers.ts`
  - `sortThreadsForSidebar`, `sortPinnedThreadsForSidebar`, `compareSidebarThreads`, `comparePinnedAt`, and `withoutPinnedProjectThreads`.
  - Add a project-local sorter instead of changing pinned-section ordering globally.
- `apps/web/src/threads/WorkspaceSidebar.tsx`
  - Imports for `sortPinnedThreadsForSidebar` and `sortThreadsForSidebar`.
  - Pinned section derivation and rendering before the Projects section.
  - Project group rendering where `projectThreads`, `visibleProjectThreads`, and `renderedProjectThreads` are derived.
  - `threadSurfacesWhenProjectCollapsed`.
- `apps/web/src/threads/WorkspaceSidebar.reorder.test.tsx`
  - Existing pinned-section tests around project/chats scope and section collapse.
  - Project collapse and project thread rendering tests.
- `apps/web/src/threads/helpers.test.ts`
  - Sidebar thread ordering coverage.
- `apps/web/src/styles/sidebar.css`
  - `.kodex-pinned-section` remains valid if pinned chats still use it; remove only project-specific assumptions if any are introduced.

## Milestones

### 1. Lock Project-Local Pinned Behavior With Tests

Scope: `apps/web/src/threads/WorkspaceSidebar.reorder.test.tsx` and `apps/web/src/threads/helpers.test.ts`.

Work:

- Replace or rewrite the Projects-tab expectation that pinned rows render above projects.
- Add a test proving a project-pinned thread renders inside its project `role="group"` and no `.kodex-pinned-section` is rendered while the Projects scope is active.
- Add a test proving a project-pinned row uses `onSelectThread(projectId, threadId)`, not `onSelectPinnedThread`.
- Add a test proving the pin control still calls `onUnpinThread(threadId)`.
- Add a test proving collapsed projects still show pinned rows.
- Add helper ordering coverage for a project list containing:
  - newer pinned thread,
  - older pinned thread,
  - title-pending thread,
  - approval-needed thread,
  - recent unpinned thread.

Exit criteria:

- Focused tests fail before implementation for the new project-local behavior.
- Tests explicitly encode pinned-first ordering and collapsed-project visibility.

### 2. Reshape Sidebar Data Without Changing Gateway Ownership

Scope: `apps/web/src/App.tsx`.

Work:

- Keep `sidebarPinnedThreads` available for the unchanged Chats-tab pinned section.
- Keep filtering pinned rows out of `sidebarChatThreads` while pin state is trusted.
- Stop filtering project-pinned rows out of `sidebarThreadsByProjectId`, or replace `withoutPinnedProjectThreads` with a narrower helper that only applies when a global project pinned section is still needed.
- Preserve the existing `pinnedStateTrusted` guard so startup does not duplicate rows before pin state has been hydrated.
- Leave selected-thread lookup and automation target option behavior unchanged; these paths can still read from project, chat, and pinned caches.

Exit criteria:

- Project thread props include pinned project rows once pin state is trusted.
- Chat thread props still exclude pinned chat rows when the pinned cache is trusted.
- No OpenAPI or generated frontend API artifacts are modified.

### 3. Add Project-Local Pinned Ordering

Scope: `apps/web/src/threads/helpers.ts`, `apps/web/src/threads/helpers.test.ts`, and `apps/web/src/threads/WorkspaceSidebar.tsx`.

Work:

- Add a helper such as `sortProjectThreadsForSidebar(threads, approvals, pendingTitleThreadIds)`.
- Implement its comparator so project rows sort by:
  - pinned rows first, newest `pinnedAt` first,
  - existing attention priority from `threadPriority`,
  - `updatedAt desc`,
  - `createdAt desc`,
  - display title,
  - thread id.
- Keep `sortPinnedThreadsForSidebar` unchanged so any remaining pinned chat section keeps its current behavior.
- Use the new project-local sorter in the project group map instead of `sortThreadsForSidebar`.

Exit criteria:

- `helpers.test.ts` proves pinned project rows outrank title-pending and approval-needed rows.
- Existing generic sidebar and pinned-section ordering tests still pass unless intentionally updated for Projects-only behavior.

### 4. Render Project Pinned Rows In Their Project Groups

Scope: `apps/web/src/threads/WorkspaceSidebar.tsx` and `apps/web/src/styles/sidebar.css`.

Work:

- Remove the global pinned section from the Projects scope by gating the existing `.kodex-pinned-section` render to Chats scope only, or by deriving pinned rows only for the Chats scope.
- Remove project-specific pinned-scope helpers if they become unused:
  - `sidebarProjectScopeLookup`
  - `pinnedThreadMatchesSidebarScope`
  - `pinnedThreadBelongsToProject`
- Keep the project thread row selection path as `onSelectThread(project.id, threadId)`.
- Update `threadSurfacesWhenProjectCollapsed` to include pinned rows.
- Keep search behavior project-local: a pinned project thread that matches search should keep its project group visible even if the project name does not match.
- Keep existing pin/unpin row affordances and mobile touch behavior unchanged.

Exit criteria:

- Projects tab has no standalone Pinned section.
- Pinned project rows render under their projects, remain selected correctly, and retain pin/unpin controls.
- Collapsed project groups show pinned rows.
- Search finds pinned project rows within their project groups.
- If pinned chats still use `.kodex-pinned-section`, existing chat pinned behavior remains intact.

### 5. Verification And Review

Scope: frontend tests, browser validation, and independent review.

Work:

- Run focused frontend tests:
  - `cd apps/web && npm test -- src/threads/helpers.test.ts src/threads/WorkspaceSidebar.reorder.test.tsx`
- Run a broader frontend check if the implementation touches shell prop derivation or cache assumptions:
  - `cd apps/web && npm test -- src/App.mvp.shell.test.tsx src/threads/cache.test.ts`
- Build if the implementation changes imports or shared helper exports:
  - `cd apps/web && npm run build`
- Use `$agent-browser` against the local web app to validate:
  - Projects tab does not show a global Pinned section.
  - A pinned project thread appears at the top of its project.
  - Collapsing the project keeps the pinned row visible.
  - Chats tab pinned behavior is unchanged.
  - Narrow/mobile shape still exposes the pin/unpin control without hover.
- Perform an independent review pass as required by `AGENTS.md`.

Exit criteria:

- Focused tests and relevant broader checks pass.
- Browser validation confirms the observable Projects-tab UX.
- Review finds no major issues.
- `plans/index.md` remains current if implementation starts or completes.

## Risks And Open Questions

- If `GET /v1/sidebar/threads` or a scoped project list omits pinned project rows because a pinned-list-only cache path has fresher data, the implementation may need a small frontend merge helper that injects project-owned pinned summaries into the corresponding project group. Prefer first checking whether preserving `threadsByProjectId` pinned rows in `App.tsx` is sufficient.
- Pinned chat rendering shares the global pinned section component. If gating the section to Chats scope leaves confusing copy, keep the label `Pinned` for Chats and avoid broader copy changes in this plan.
- Project identity matching should not move to browser inference. The project row should render from `threadsByProjectId[project.id]`; do not use cwd matching in the browser as durable project ownership unless the existing gateway data lacks `projectId` and no project-group cache contains the row.
