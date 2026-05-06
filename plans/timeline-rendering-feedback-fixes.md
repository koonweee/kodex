# Timeline Rendering Feedback Fixes Plan

## Status

Proposed.

## Scope

Implement the concrete UI fixes from `timeline-rendering-feedback.md` except native plan rendering and timeline fixture/dev QA pages, which are intentionally out of scope for this plan.

Included:

- Render file-change patches with an inspectable diff viewer.
- Show failed command executions with an explicit failed status, including collapsed command rows.
- Open local Markdown links in an in-app right-side viewer/editor pane instead of only opening a raw preview link.

Excluded:

- Native `turn/plan/updated` or `item.type: plan` rendering changes.
- A general fixture page for hard-to-trigger timeline item kinds.
- Broad redesign of timeline grouping or work-row behavior.

## Current Code Grounding

- Timeline renderers live in `apps/web/src/timeline/renderers.tsx`.
- `FileChangeBlock` currently renders only an action badge plus path text, even though `createPresentationItem` stores collected unified diff text on `TimelineItem.output`.
- `CommandBlock` currently shows `Success` only when `item.status === "completed"` and has no matching `Failed` indicator for `item.status === "failed"`.
- Collapsed command rows are rendered specially inside `ActivityItemRenderer`; their summary uses `commandSummary(item)` without status-specific tone or text.
- Assistant markdown link behavior is centralized in `assistantMarkdownComponents`.
- Local Markdown links already route through `localMarkdownPreviewHref(threadId, href)` and `filePreviewUrl(threadId, path)`, but they still render as normal anchors with `target="_blank"` and `download`.
- `TimelineView` passes `onImageOpen` down through timeline renderers. A Markdown pane opener can follow the same prop path.
- The gateway already serves Markdown bytes via `GET /v1/threads/{threadId}/files/preview`, exposed in `apps/web/src/api/client.ts` as `filePreviewUrl(threadId, path)`.
- `ThreadPanel` owns the timeline surface and receives `onImageOpen`; it is the natural place to pass an `onMarkdownOpen` callback through to `TimelineView`.
- `App.tsx` already owns modal/lightbox state with `lightboxImage`; it should similarly own right-side file preview pane state.

## UX Direction

Keep timeline activity rows compact by default, but make expanded rows genuinely inspectable.

- File change row summary should remain concise: action + filename/path count.
- Expanded file change should show a syntax-aware unified diff with additions, deletions, hunk headers, and file names.
- Failed commands should be visually distinguishable without requiring the user to parse exit output.
- Markdown links should open an in-app side pane on normal click. Modifier-click and context-menu behavior should keep normal browser navigation affordances.
- The Markdown pane should be a right-side overlay/pane, not a full-page navigation.

## Dependency Decision

Use `react-diff-view` for unified diff rendering.

Rationale:

- The app already has React-rendered timeline components, so a React diff component fits better than generated HTML.
- `TimelineItem.output` already contains unified diff text for schema-valid `fileChange.changes[]`.
- Styling can stay under `apps/web/src/styles/timeline.css` or a new focused file-preview stylesheet instead of adopting a large external theme wholesale.

Add dependency in `apps/web/package.json`:

- `react-diff-view`

Avoid for this milestone:

- `diff2html`, because generated HTML adds styling and sanitization complexity.
- A custom diff parser, because unified diff parsing has enough edge cases to justify a maintained library.

## Milestone 1: Failed Command Status

Status: Proposed.

Failing tests first:

- Extend `apps/web/src/timeline/renderers.test.tsx` with a failed `command_execution` item.
- Assert the expanded command row renders a visible `Failed` status.
- Assert the collapsed command summary has a failure affordance, such as failure text, danger tone, or an accessible label.
- Add a cancelled command case only if the current renderer has enough status plumbing to support it without widening scope.

Implementation:

- Update `CommandBlock` in `apps/web/src/timeline/renderers.tsx`.
- Add a small helper such as `commandStatusMeta(status)` returning label, tone, and icon.
- Render:
  - `completed`: existing `Check` + `Success`
  - `failed`: `AlertTriangle` + `Failed`
  - `cancelled`: muted `Cancelled`, if covered
  - `approval_required`: waiting/approval text, if already representable
- Update the command branch in `ActivityItemRenderer` so collapsed command rows reflect failed status before expansion.
- Add CSS classes in `apps/web/src/styles/timeline.css` only if existing `kodex-ui-text` tones are insufficient.

Exit conditions:

- Failed command rows are visibly different from successful command rows in collapsed and expanded states.
- Existing command success rendering remains unchanged.
- Focused timeline renderer tests pass.

## Milestone 2: File Change Diff Viewer

Status: Proposed.

Failing tests first:

- Extend `apps/web/src/timeline/renderers.test.tsx` with a `file_change` item containing:
  - `action: "update"`
  - `path: "timeline-rendering-feedback.md"`
  - `output: "@@ -1 +1 @@\n-old\n+new"`
- Assert the expanded row renders a diff region, hunk header, removed line, and added line.
- Keep a fallback test for a file change without `output`, asserting the current path-only display still renders.

Implementation:

- Install `react-diff-view`.
- Add a focused component, likely `apps/web/src/timeline/FileDiffViewer.tsx`, to keep `renderers.tsx` from growing.
- `FileDiffViewer` responsibilities:
  - accept unified diff text and optional path/action metadata
  - parse the unified diff with the library
  - render unified view first; split view is out of scope
  - gracefully fall back to a `<Code block>` if parsing fails
- Update `FileChangeBlock` to render:
  - compact metadata row: action badge, path(s)
  - diff viewer when `item.output` is present
  - existing text fallback when no diff is present
- Keep dimensions stable with CSS so long lines scroll horizontally rather than expanding the entire timeline.
- Add accessible labeling, for example `aria-label="File diff for timeline-rendering-feedback.md"`.

Exit conditions:

- Schema-valid file-change diffs are visible without opening debug payloads.
- Multiple file paths still have a readable summary.
- Long diff lines do not break timeline layout.
- Focused renderer tests pass.

## Milestone 3: Markdown Side Pane

Status: Proposed.

Failing tests first:

- Add renderer coverage in `apps/web/src/timeline/renderers.test.tsx`:
  - local `.md` absolute path link calls `onMarkdownOpen` on normal click
  - modifier-click does not intercept browser behavior
  - non-Markdown links remain normal anchors
- Add shell/thread panel coverage in the closest existing app or thread panel test:
  - clicking a local Markdown link opens a right-side pane
  - the pane fetches preview content from `filePreviewUrl(threadId, path)`
  - closing the pane returns focus to the timeline link or a stable close control

Implementation:

- Add a new type in a small module, for example `apps/web/src/files/types.ts`:
  - `MarkdownPreviewRequest = { path: string; href: string; title?: string; fragment?: string }`
- Add `fetchThreadFilePreview(threadId, path)` to `apps/web/src/api/client.ts` or a focused file-preview API helper. It should use the existing `filePreviewUrl`.
- Add `apps/web/src/files/MarkdownPreviewPane.tsx`:
  - right-side Mantine `Drawer` or app-shell side pane
  - title from filename
  - tabs/segmented control for `Preview` and `Source`
  - preview rendered through `ReactMarkdown` with `remark-gfm` and `remark-breaks`
  - source as read-only code initially
  - loading, error, unsupported, and empty states
- Wire state in `App.tsx`, parallel to `lightboxImage`:
  - `markdownPreview: MarkdownPreviewRequest | null`
  - close handler
  - callback passed into `KodexShellView`/`ThreadPanel`/`TimelineView`
- Extend renderer option plumbing:
  - `TimelineRendererOptions` gains `onMarkdownOpen`
  - `TimelineView`, `TimelineItemRenderer`, `TimelineActivityGroupRenderer`, `TimelineWorkRowRenderer`, and `AssistantMessageMarkdown` pass it through.
- Update `assistantMarkdownComponents`:
  - detect `localMarkdownPreviewHref`
  - on normal click, prevent default and call `onMarkdownOpen`
  - preserve regular href for copy/open in new tab
  - do not set `download` when the side-pane handler is available, unless we add a separate download action in the pane

Editor boundary:

- The first implementation should be a viewer with a source tab, not a saving editor.
- Add an explicit follow-up note in the component or plan comments for future editing:
  - save support needs backend write semantics, conflict handling, and trusted-local deployment copy.
  - do not POST local file writes through the preview endpoint.

Exit conditions:

- Local Markdown links open in a right-side in-app pane on normal click.
- External links and modifier-click behavior remain browser-native.
- The pane handles loading/error states without disrupting timeline virtualization.
- No backend API contract change is required unless a later save/edit feature is added.
- Focused renderer and shell/thread tests pass.

## Verification

Run after implementation:

- `cd apps/web && npm test -- timeline/renderers.test.tsx`
- Closest shell/thread panel test file that covers pane wiring.
- `cd apps/web && npm run build`

Manual QA:

- Re-run a small timeline QA pass covering:
  - a failed command
  - a file change with diff output
  - a Markdown local-file link
- Verify collapsed work rows still measure correctly after expanding file diffs and opening/closing the Markdown pane.

## Risks And Constraints

- `react-diff-view` may need CSS tuning to fit the existing subdued timeline design.
- Large diffs can become expensive inside a virtualized timeline. Start with collapsed activity rows and avoid rendering diff bodies until the row is expanded.
- Markdown side pane fetches local files through an endpoint that is intentionally scoped to localhost/trusted VPN assumptions. Keep that security assumption visible in code comments only where it affects behavior.
- Editing Markdown is deliberately deferred because file writes require a separate authorization and conflict model.
