# Frontend P1 Maintainability Cleanup Plan

## Context

- `audit-frontend.md` identifies the highest-priority frontend cleanup pressure in three areas: `apps/web/src/App.tsx`, selected/readonly timeline stream hooks, and timeline renderer/CSS ownership.
- The cleanup is behavior-preserving. Gateway APIs, generated OpenAPI types in `apps/web/src/api/generated/schema.ts`, timeline event contracts, and user-visible flows should stay unchanged.
- The work must preserve the repo's frontend ownership rules: `App.tsx` remains a shell coordinator, timeline behavior stays under `apps/web/src/timeline`, SSE behavior stays under `apps/web/src/events`, and shared lifecycle truth remains gateway-owned.

## Current State

- `apps/web/src/App.tsx` is about 1,800 lines and still owns top-level selection state, sidebar thread cache mutation, route state, live event side effects, and large prop assembly for `KodexShellView`.
- `apps/web/src/timeline/useSelectedThreadTimeline.ts` and `apps/web/src/timeline/useReadonlyThreadTimeline.ts` both implement animation-frame event batching, stale stream token protection, snapshot refresh on `thread_view.refresh_required`, reconnect refresh handling, and canonical event filtering.
- `useSelectedThreadTimeline.ts` also owns selected-only behavior: approval events, queue events, older-history paging, sync notices, materializing-thread retry, and delta-miss diagnostics.
- `apps/web/src/timeline/renderers.tsx` is about 1,500 lines and exports the renderer registry plus message, toolbar, activity, file, image, collaboration, debug, and formatting helpers.
- `apps/web/src/styles/timeline.css` is about 900 lines and mixes timeline viewport/layout styling with message, work/activity, file diff, image, debug, and toolbar styles.
- Existing guardrails and tests include `apps/web/src/timeline/threadViewGuard.test.ts`, `apps/web/src/timeline/reducer.lifecycle.test.ts`, `apps/web/src/timeline/batch.test.ts`, `apps/web/src/timeline/renderers.test.tsx`, `apps/web/src/timeline/TimelineView.render.test.tsx`, and app workflow suites such as `apps/web/src/App.mvp.shell.test.tsx` and `apps/web/src/App.mvp.timeline.test.tsx`.

## Milestones

### 1. Extract Shell Coordination From `App.tsx`

- Scope: `apps/web/src/App.tsx` plus new focused modules under existing ownership directories such as `apps/web/src/shell`, `apps/web/src/threads`, or `apps/web/src/events`.
- Work:
  - Extract route and selection transitions from `KodexShell` into a hook or helper such as `useShellSelection`, covering project selection, draft chat/thread selection, selected-thread replacement, unavailable-thread state, and mobile panel transitions.
  - Extract sidebar cache mutation orchestration into a hook/helper such as `useSidebarThreadCaches`, keeping TanStack Query writes routed through existing helpers in `apps/web/src/threads/cache.ts`.
  - Extract selected/global live event handler assembly into a hook/helper such as `useLiveEventHandlers`, preserving `routeGlobalLiveEvent`, `routeSelectedThreadLiveEvent`, selected-thread exclusion behavior, and gateway-owned lifecycle boundaries.
  - Keep `KodexShell` responsible for wiring hooks into `KodexShellView`, not for owning domain-specific reducer logic.
- Exit criteria:
  - Focused tests cover project/thread/chat selection transitions, route-selected thread repair, and live sidebar cache updates without relying only on a full MVP happy path.
  - Existing app workflow coverage still passes, especially `App.mvp.shell.test.tsx`, `App.mvp.timeline.test.tsx`, `App.navigation.test.tsx`, and `App.subagents.test.tsx`.
  - `App.tsx` is materially smaller and no newly extracted module becomes a catch-all coordinator.

### 2. Share Timeline Stream Mechanics

- Scope: `apps/web/src/timeline/useSelectedThreadTimeline.ts`, `apps/web/src/timeline/useReadonlyThreadTimeline.ts`, and a new shared timeline hook/helper such as `apps/web/src/timeline/useThreadViewStream.ts` or `apps/web/src/timeline/useTimelineEventQueue.ts`.
- Work:
  - Extract common queue scheduling, flush cancellation, stale stream token checks, snapshot refresh sequencing, reconnect refresh handling, and canonical render-event filtering.
  - Keep selected-only concerns in `useSelectedThreadTimeline.ts`: approval event handling, queue event handling, older-history pagination through `getThreadTimelinePage`, `ThreadSyncNotice`, materializing-thread retry, and selected-thread delta-miss diagnostics.
  - Keep readonly-only concerns in `useReadonlyThreadTimeline.ts`: local timeline state, local scroll parent state, and read-only omission of approvals/queue rows.
  - Centralize canonical thread-view event predicates so selected and readonly views cannot drift on `thread_view.patch`, `thread_view.item_delta`, and `thread_view.refresh_required`.
- Exit criteria:
  - Focused timeline tests cover `thread_view.refresh_required`, stream reconnect refresh, stale stream cancellation after thread changes, missed delta recovery, and batched canonical updates for both selected and readonly consumers.
  - `apps/web/src/timeline/threadViewGuard.test.ts` is updated only as needed for moved source files and continues to prevent browser rendering from raw app-server lifecycle events such as `timeline.item_delta`.
  - `npm test -- --runInBand` is not required; the normal Vitest command for the package is sufficient if focused suites remain stable.

### 3. Split Timeline Renderer And CSS Families

- Scope: `apps/web/src/timeline/renderers.tsx`, `apps/web/src/timeline/TimelineView.tsx`, renderer tests, and `apps/web/src/styles/timeline.css`.
- Work:
  - Keep `apps/web/src/timeline/renderers.tsx` as a small public registry/re-export surface for `TimelineItemRenderer`, `TimelineActivityGroupRenderer`, `TimelineFileChangesRenderer`, and `TimelineWorkRowRenderer`.
  - Move message bubble/markdown/toolbar/skill mention behavior into a message renderer module.
  - Move work/activity/command/tool/collaboration/debug renderers into activity-oriented modules.
  - Move file-change/diff rendering into file-oriented modules while continuing to use `apps/web/src/timeline/FileDiffViewer.tsx` and `apps/web/src/timeline/presentationFile.ts`.
  - Move image-related timeline rendering into an image-oriented module that preserves `ImageLightboxImage` and markdown-preview interactions.
  - Split `apps/web/src/styles/timeline.css` into timeline family CSS files imported by `apps/web/src/App.css`, keeping selectors stable unless a rename is required by the extraction.
  - Split `apps/web/src/timeline/renderers.test.tsx` by renderer family after the module boundaries are stable, leaving a registry smoke test in place.
- Exit criteria:
  - Renderer family tests cover command/file warning/error fallback rendering, message markdown and copy toolbar behavior, file diff expansion, image preview/lightbox paths, collaboration result previews, and debug disclosure behavior.
  - `apps/web/src/timeline/TimelineView.render.test.tsx` continues to cover viewport-level behavior such as older-history controls, timestamps, debug row order, and approvals placement.
  - `$agent-browser` validation exercises a real browser timeline after the split: open a thread with user/assistant messages, work/activity rows, file changes, and images if available; verify no console errors, no obvious overlap, and desktop/narrow responsive layout remains coherent.

## Verification

- Run focused frontend tests as each milestone lands, for example:
  - `cd apps/web && npm test -- App.mvp.shell.test.tsx App.mvp.timeline.test.tsx App.navigation.test.tsx`
  - `cd apps/web && npm test -- timeline/reducer.lifecycle.test.ts timeline/batch.test.ts timeline/threadViewGuard.test.ts`
  - `cd apps/web && npm test -- timeline/renderers.test.tsx timeline/TimelineView.render.test.tsx`
- Run the full frontend test suite before completion: `cd apps/web && npm test`.
- Run the frontend build before completion: `cd apps/web && npm run build`.
- Use `$agent-browser` for browser-observable validation after renderer/CSS changes and after the integrated refactor, covering desktop fine pointer plus narrow/mobile layout.
- No OpenAPI regeneration is expected because this plan does not change backend DTOs or API routes.

## Risks And Open Questions

- The shell extraction can accidentally change multi-client state ownership if it treats selected-thread lifecycle, queued input, read state, or thread settings as durable React truth. Keep those decisions routed through gateway-owned APIs/events and existing cache helpers.
- Shared timeline stream mechanics must not erase selected-only delta-miss diagnostics or materializing-thread retry behavior. Treat `useSelectedThreadTimeline.ts` as the stricter behavior source while extracting the common primitive.
- Renderer/CSS splitting is mechanically risky because class names are broad and tests assert visible behavior rather than every layout detail. Keep the first pass mostly move-only, then make any selector cleanup separately.
- P2/P3 audit items are intentionally out of scope for this plan: app-level test builder consolidation, read/unread projection naming, handwritten approval wire type cleanup, heavy surface component extraction, and centralized SSE event kind definitions.
