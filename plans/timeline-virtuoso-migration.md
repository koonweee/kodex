# Timeline Virtuoso Migration Plan

## Status

Complete.

## Context

The web timeline currently uses `@tanstack/react-virtual` directly in `apps/web/src/timeline/TimelineView.tsx`. The observed bug is that a large file-changes block can overlap later user-message rows, and switching to another thread and back clears the problem. A related symptom is that the file-changes block can jump or disappear around expansion.

The likely root cause is not bad timeline ordering. Rows are absolutely positioned from virtualizer offsets, while file-change rows and completed work rows can change height after their first measurement. When a large row grows without a reliable remeasurement, later rows keep stale `translateY(...)` positions.

This plan intentionally favors structural simplification over measurement bandaids:

- Migrate the main timeline list to OSS `react-virtuoso`, not the commercial `VirtuosoMessageList`.
- Flatten or bound dynamic timeline rows so one virtual item does not contain an unbounded nested timeline.
- Add regression tests that reproduce the earlier overlap and file-change jumping failure modes before replacing the virtualizer.

Official library grounding:

- React Virtuoso documents automatic handling for variable item sizes and dynamic size changes via `ResizeObserver`: https://virtuoso.dev/react-virtuoso/
- TanStack Virtual documents `measureElement`/`measure` as caller-owned responsibilities for dynamic measurement: https://tanstack.com/virtual/latest/docs/api/virtualizer

## Current State

- `apps/web/package.json` depends on `@tanstack/react-virtual` and does not currently depend on `react-virtuoso`.
- `TimelineView` derives rows with `deriveTimelineRows(...)`, creates a TanStack virtualizer, and absolutely positions rows with `transform: translateY(...)`.
- `TimelineView` has a `fallbackVirtualItems(...)` path that manually spaces rows by `112px`; this is unsafe for variable-height rows.
- `deriveTimelineRows(...)` chunks activity items at `MAX_ACTIVITY_ITEMS_PER_ROW = 12`, but file changes are grouped into one unbounded `file_changes` row.
- Completed work rows can contain `collapsedRows`, and those collapsed rows can include file-change panels, activity groups, and full item renderers nested inside the single measured work row.
- `TimelineFileChangesRenderer` renders every changed file in one panel and each modified file can mount a `FileDiffViewer` after expansion.
- `apps/web/src/test/setup.ts` currently stubs `ResizeObserver` as a no-op, so unit tests do not naturally exercise dynamic resize behavior.
- Existing focused coverage lives in:
  - `apps/web/src/timeline/derive.test.ts`
  - `apps/web/src/timeline/TimelineView.test.ts`
  - `apps/web/src/timeline/TimelineView.render.test.tsx`
  - `apps/web/src/timeline/renderers.test.tsx`
  - `apps/web/tests/mvp.spec.ts`

## Non-Goals

- Do not migrate to the paid `VirtuosoMessageList` package in this plan.
- Do not change gateway timeline contracts, generated OpenAPI types, or backend state ownership.
- Do not redesign the visual appearance of timeline rows beyond what is required to make row boundaries stable.
- Do not add custom manual measurement infrastructure as the long-term solution.

## Milestones

### 1. Reproduce The Current Timeline Layout Bugs

- Scope: `apps/web/src/timeline/TimelineView.render.test.tsx`, `apps/web/src/timeline/TimelineView.test.ts`, `apps/web/tests/mvp.spec.ts`, and test helpers under `apps/web/src/test`.
- Work:
  - Add a deterministic timeline fixture with a user message, a growing file-change block of at least 20 entries, a completed work row, and a later user message with an inline skill badge.
  - Add a component-level regression test that proves visible rows remain ordered when a file-change row grows across rerenders without switching threads.
  - Add a component-level regression test for expanding and collapsing a file-change diff while a later message remains below it.
  - Add an e2e or `$agent-browser` validation scenario that loads a mocked long timeline, waits for file-change growth, and asserts row bounding boxes do not overlap.
  - Replace or extend the no-op `ResizeObserver` test shim only where needed so resize-driven behavior can be exercised deterministically.
- Exit criteria:
  - At least one new test fails against the current TanStack implementation before the migration fix.
  - Tests cover both passive growth and file-diff expansion, not only the user-click path.
  - The test fixture captures the screenshot shape: large file-changes panel followed by a user message with an inline skill badge.

### 2. Bound And Simplify Timeline Row Derivation

- Scope: `apps/web/src/timeline/derive.ts`, `apps/web/src/timeline/derive.test.ts`, and affected renderer tests.
- Work:
  - Introduce bounded file-change grouping, similar to `MAX_ACTIVITY_ITEMS_PER_ROW`, so one file-change virtual item cannot grow without limit.
  - Preserve stable row keys as file-change groups grow. Row keys should not cause completed rows to remount unnecessarily during live updates.
  - Revisit completed work rows that currently contain `collapsedRows`. Prefer a shallow work summary row plus sibling rows when expanded, or keep nested content only if it is bounded and covered by layout tests.
  - Keep final-answer divider behavior and prominent turn results unchanged.
  - Update row derivation tests for chunked file changes, completed work rows, and context compaction/image-generation exceptions.
- Exit criteria:
  - File-change rows are bounded by an explicit max size.
  - Row derivation tests prove stable ordering and keys as file-change item counts grow.
  - A single virtual item no longer contains an unbounded nested list of file changes.

### 3. Replace TanStack Timeline Virtualization With OSS Virtuoso

- Scope: `apps/web/package.json`, `apps/web/package-lock.json`, `apps/web/src/timeline/TimelineView.tsx`, and timeline CSS in `apps/web/src/styles/shell.css`.
- Work:
  - Add `react-virtuoso`.
  - Replace `useVirtualizer`, `rowVirtualizer.measureElement`, manual spacer/absolute-positioned rows, and `fallbackVirtualItems(...)` with OSS `Virtuoso`.
  - Keep `TimelineRowView` and the existing row renderer components where possible; the migration should replace list mechanics, not rewrite every renderer.
  - Configure the Virtuoso scroller to use the existing `.kodex-timeline-scroll` container or an equivalent contained scroll root that preserves the thread header/composer layout.
  - Preserve bottom-following semantics:
    - initial thread open settles at the latest row
    - live output follows only when already near the bottom
    - the scroll-to-bottom control still appears when the user is reading older content
  - Remove now-unused initial-bottom settling helpers and tests only after equivalent Virtuoso behavior is covered.
  - Remove `@tanstack/react-virtual` if no other app code uses it.
- Exit criteria:
  - Timeline rendering no longer uses manual `translateY(...)` row positioning.
  - No hardcoded `112px` fallback row positioning remains.
  - `npm run build` succeeds with the new dependency set.
  - Existing timeline renderer behavior remains visually and functionally intact.

### 4. Stabilize Dynamic Rows And Interactions

- Scope: `apps/web/src/timeline/renderers.tsx`, `apps/web/src/timeline/FileDiffViewer.tsx`, `apps/web/src/styles/timeline.css`, and focused renderer tests.
- Work:
  - Ensure file-change diff bodies mount only on expansion, but expansion does not rely on caller-owned virtual row measurement.
  - Keep long diff lines horizontally scrollable inside `FileDiffViewer`, not layout-expanding.
  - Audit other dynamic timeline content for the same risk: images, Markdown preview links, command output, collab-agent previews, approvals, and debug disclosures.
  - Remove bespoke measurement calls from nested `<details>` handlers if Virtuoso handles resize observation.
  - Keep row CSS margin-free at item boundaries because Virtuoso warns that protruding margins can break content measurement.
- Exit criteria:
  - Expanding/collapsing file diffs does not move unrelated later rows into overlap.
  - Dynamic content uses padding/gap inside measured items rather than external margins that can escape measurement.
  - Focused renderer tests still pass for file diff viewer, command output, Markdown, skill badges, and work rows.

### 5. Browser Validation And Review Gate

- Scope: `apps/web/tests/mvp.spec.ts`, `$agent-browser` validation, and review/fix-loop output.
- Work:
  - Add or update Playwright coverage for a mocked long thread with:
    - at least 20 file changes
    - a later user message with a skill badge
    - file-change expansion and collapse
    - live update growth while already viewing the thread
  - Use `$agent-browser` to validate the real browser layout at desktop fine pointer, narrow fine pointer, and narrow touch/mobile shapes when layout or input-modality behavior is affected.
  - Validate that switching away and back is no longer required to fix row placement.
  - Run an independent review pass for the migration and simplification.
- Exit criteria:
  - No row bounding-box overlaps in automated/browser validation.
  - Existing MVP timeline flows still pass.
  - Review reports no major issues, or every major issue is fixed before completion.

## Verification

Run focused checks after each milestone where relevant:

- `cd apps/web && npm test -- --run src/timeline/derive.test.ts`
- `cd apps/web && npm test -- --run src/timeline/TimelineView.test.ts src/timeline/TimelineView.render.test.tsx`
- `cd apps/web && npm test -- --run src/timeline/renderers.test.tsx`
- `cd apps/web && npm run test:e2e -- --project=chromium`
- `cd apps/web && npm run build`

Manual/browser validation:

- `$agent-browser` or Playwright screenshot pass on a mocked long timeline before and after file-change growth.
- Desktop fine pointer: open thread, confirm initial bottom alignment, expand/collapse file diffs, verify no overlap.
- Narrow fine pointer: repeat layout check with the single-panel shell.
- Narrow touch/mobile: verify scroll-to-bottom and file-change expansion are reachable without hover.

## Risks And Open Questions

- Virtuoso's measurement model is more automatic, but it still relies on sane item CSS. Timeline row margins and nested layout overflow must be audited during migration.
- `Virtuoso` may want to own the scroll container. If reusing `.kodex-timeline-scroll` proves brittle, the implementation should move the scroll root inside `TimelineView` and update `ThreadPanel` wiring deliberately.
- The current `onReady` and initial-bottom-settling behavior was added to avoid skeleton-to-content flashes. The replacement must preserve user-visible readiness without reintroducing custom measurement loops.
- If chunked file changes make the timeline too verbose, use collapsed chunk summaries rather than reverting to one unbounded file-change row.
- If OSS `Virtuoso` cannot preserve bottom-pinned behavior with the existing shell constraints, pause before considering the commercial message-list package; document the exact OSS limitation first.
