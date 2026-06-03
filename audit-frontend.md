# Frontend Maintainability Audit

Scope: `apps/web` React/Vite/TypeScript code, frontend tests, generated API type usage, SSE/event/timeline/client state boundaries, CSS, and component organization.

This audit was produced from an independent frontend subagent pass. It is a cleanup and maintainability report, not an implementation plan.

## Executive Summary

The frontend is well organized by domain in several important places, especially `events`, `timeline` state reduction, generated API typing, and thread cache helpers.

The main maintainability pressure is concentrated in a few oversized coordinator, rendering, surface, and test files where domain logic is still bundled together.

## Prioritized Opportunities

### P1: Extract shell coordination out of `App.tsx`

References:
- `apps/web/src/App.tsx:227`
- `apps/web/src/App.tsx:919`
- `apps/web/src/App.tsx:1336`
- `apps/web/src/App.tsx:1723`

`App.tsx` is 1,800+ lines and now owns selection, sidebar cache mutation, live event handlers, route application, and prop assembly.

Why this helps: the repo guidance wants `App.tsx` to stay a shell coordinator. Pulling domain orchestration into hooks/modules would make selection, cache, and event behavior easier to test without rendering the full app.

Suggested shape:
- Extract `useShellSelection`, `useSidebarThreadCaches`, and `useLiveEventHandlers` incrementally.
- Preserve current behavior with focused tests around project/thread/chat selection transitions and live thread cache updates.
- Avoid moving gateway-owned lifecycle truth into React state during the extraction.

### P1: Share selected and readonly timeline stream mechanics

References:
- `apps/web/src/timeline/useSelectedThreadTimeline.ts:66`
- `apps/web/src/timeline/useSelectedThreadTimeline.ts:235`
- `apps/web/src/timeline/useReadonlyThreadTimeline.ts:20`
- `apps/web/src/timeline/useReadonlyThreadTimeline.ts:104`

The selected and readonly timeline hooks duplicate queueing, animation-frame flushing, snapshot refresh, stale stream protection, and canonical event filtering.

Why this helps: this is the critical `thread_view` boundary. Drift between the two hooks could make selected and readonly thread views reconcile differently.

Suggested shape:
- Extract a small `useThreadViewStream` or `useTimelineEventQueue` helper.
- Keep selected-only concerns, such as approvals and queue filtering, outside the shared primitive.
- Test `thread_view.refresh_required`, stale stream cancellation, missed delta recovery, and batched canonical updates.

### P1: Split timeline rendering and CSS by renderer family

References:
- `apps/web/src/timeline/renderers.tsx:32`
- `apps/web/src/timeline/renderers.tsx:644`
- `apps/web/src/timeline/TimelineView.tsx:35`
- `apps/web/src/styles/timeline.css:1`

`renderers.tsx` is 1,500+ lines and `timeline.css` is 900+ lines. Adding a new timeline item type requires navigating registry, markdown, toolbar, file diff, image, debug, and styling concerns together.

Why this helps: timeline renderer work is likely to keep growing. Smaller renderer families would reduce regression risk and make targeted tests easier to maintain.

Suggested shape:
- Keep a small renderer registry.
- Move message/toolbar, activity rows, file changes/diffs, images, collaboration/debug, and markdown helpers into separate modules.
- Split renderer tests similarly, leaving one registry smoke test.

### P2: Consolidate app-level test builders

References:
- `apps/web/src/App.test.tsx:33`
- `apps/web/src/App.test.tsx:288`
- `apps/web/src/test/mvpAppHarness.tsx:98`
- `apps/web/src/test/mvpAppHarness.tsx:329`

`App.test.tsx` duplicates `FakeEventSource`, canonical timeline builders, projection patch builders, and snapshot helpers already present in `test/mvpAppHarness.tsx`.

Why this helps: duplicated test infrastructure raises contract drift risk, especially around canonical thread-view events.

Suggested shape:
- Migrate remaining app tests to the shared harness.
- Extract canonical thread-view builders into a timeline test helper.
- Split very large app tests by workflow instead of growing MVP-wide suites.

### P2: Make read/unread projection ownership more explicit

References:
- `apps/web/src/threads/useThreadReadState.ts:38`
- `apps/web/src/threads/useThreadReadState.ts:48`
- `apps/web/src/threads/cache.ts:99`
- `apps/web/src/App.mvp.timeline.test.tsx:321`

The frontend synthesizes temporary unread projection from background `thread_view.patch` events, then reconciles with gateway-owned `thread.read_updated`.

Why this helps: the boundary appears intentional, but it is subtle. Naming the projection and merge rules would make it harder to accidentally treat local React state as durable shared truth.

Suggested shape:
- Extract pure helpers such as `projectBackgroundCompletionReadState` and `mergeAuthoritativeReadUpdate`.
- Add tests where local projection is corrected by `thread.read_updated` and refreshed thread summaries.
- Include a same-user two-tab style test shape.

### P2: Remove the remaining handwritten API wire type

References:
- `apps/web/src/api/client.ts:7`
- `apps/web/src/api/client.ts:649`
- `apps/web/src/api/generated/schema.ts:1528`

`ApprovalResponse = Record<string, unknown>` is a small exception to the generated OpenAPI type rule.

Why this helps: approval decisions are cross-boundary API data. The wire type should derive from generated schema, while any normalized local action type should be kept clearly separate.

Suggested shape:
- Alias the generated request body or `ApprovalDecisionRequest["decision"]`.
- Keep local approval action normalization separate from the wire DTO.
- Existing approval action tests plus TypeScript compile coverage should cover most of the risk.

### P2: Break up heavy surface components

References:
- `apps/web/src/threads/WorkspaceSidebar.tsx:109`
- `apps/web/src/threads/WorkspaceSidebar.tsx:803`
- `apps/web/src/projects/ProjectPane.tsx:42`
- `apps/web/src/PreferencesModal.tsx:38`

`WorkspaceSidebar`, `ProjectPane`, and `PreferencesModal` mix data fetching, mutations, local interaction state, and large render trees.

Why this helps: these files are past the repo's preferred size thresholds. Extracting feature-local panels and hooks would make UI changes less coupled to unrelated workflows.

Suggested shape:
- Extract sidebar section/search/drag hooks.
- Extract project preview service components.
- Extract preference tab panels with local query hooks.
- Move tests with the extracted domain pieces.

### P3: Centralize SSE event kind definitions

References:
- `apps/web/src/events/stream.ts:22`
- `apps/web/src/timeline/threadViewGuard.test.ts:6`
- `apps/web/src/events/liveRouting.ts:57`

The named SSE event list and guardrail source list are hand-maintained.

Why this helps: the existing guardrail is valuable, but new lifecycle events could still be added inconsistently.

Suggested shape:
- Move event names to an exported `eventKinds.ts` allowlist.
- Test the allowlist directly.
- Keep the raw app-server lifecycle guardrail.

## Healthy Areas To Preserve

- The canonical timeline boundary is strong. References: `apps/web/src/timeline/reducer.ts:69`, `apps/web/src/timeline/batch.ts:4`, `apps/web/src/timeline/threadViewGuard.test.ts:32`.
- Event routing is centralized and readable. Reference: `apps/web/src/events/liveRouting.ts:13`.
- Generated OpenAPI usage is mostly clean through `apps/web/src/api/client.ts`.
- Thread cache merging has focused helpers and tests. Reference: `apps/web/src/threads/cache.ts:99`.
- CSS consistently uses design tokens and pointer/touch media queries, especially in `apps/web/src/styles/sidebar.css:465` and `apps/web/src/styles/composer.css:382`.

## Notes

No tests were run for this audit because it is documentation-only.
