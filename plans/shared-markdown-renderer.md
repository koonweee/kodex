# Shared Markdown Renderer Plan

## Status

Complete.

## Scope

Extract the custom Markdown rendering used by timeline assistant/collab messages into a shared frontend module, then use that module from both timeline renderers and the Markdown preview pane.

This is frontend-only. It does not change gateway APIs, OpenAPI output, app-server contracts, or shared multi-client state.

## Context

- Timeline Markdown rendering lives in `apps/web/src/timeline/renderers.tsx`.
- `AssistantMessageMarkdown` and `CollabAgentMarkdownPreview` render with `ReactMarkdown`, `assistantMarkdownRemarkPlugins`, `skipHtml`, and `assistantMarkdownComponents(...)`.
- `assistantMarkdownComponents(...)` currently owns custom behavior for:
  - local image links via `localImagePreviewHref(...)`
  - local Markdown links via `localMarkdownPreviewHref(...)`
  - block/inline code styling and code-copy buttons
  - Mantine-backed Markdown tables
  - paragraph and table cell styling
- The preview pane in `apps/web/src/files/MarkdownPreviewPane.tsx` uses a separate plain `ReactMarkdown` call with only `remarkGfm` and `remarkBreaks`.
- Desktop should present Markdown previews as a large modal; narrower screens can keep the right-side drawer behavior.
- Preview-pane scroll/layout CSS is in `apps/web/src/styles/timeline.css`, including `.kodex-markdown-preview-rendered` and `.kodex-markdown-preview-source`.

## Current State

- Markdown preview content does not inherit the timeline renderer's code block, table, paragraph, local link, or `skipHtml` behavior.
- Timeline-local helper functions make direct reuse awkward because `renderers.tsx` also owns unrelated timeline item rendering.
- Existing focused tests cover opening the preview pane in `apps/web/src/App.test.tsx` and Markdown link interception in `apps/web/src/timeline/renderers.test.tsx`.
- Current uncommitted preview-pane scroll work keeps drawer chrome fixed while source/preview panes own their own scrolling; the shared renderer work should preserve that behavior.

## Milestones

### 1. Extract Shared Markdown Rendering

- Scope: `apps/web/src/timeline/renderers.tsx`, a new shared Markdown module under `apps/web/src/markdown/`, and related imports.
- Work:
  - Move `assistantMarkdownRemarkPlugins`, `assistantMarkdownComponents`, `AssistantCodeBlock`, code clipboard helpers, Markdown table cell styling, and local image/Markdown link helpers into a shared module.
  - Export a small component or factory that accepts `threadId`, optional `onImageOpen`, optional `onMarkdownOpen`, and Markdown text.
  - Keep timeline-specific wrappers such as `kodex-assistant-message-stack`, final-message copy toolbar, and timeline item labels in `renderers.tsx`.
  - Preserve existing local Markdown/image link behavior for timeline messages.
- Exit criteria:
  - `AssistantMessageMarkdown` and `CollabAgentMarkdownPreview` compile using the shared module.
  - Existing timeline renderer tests still pass.

### 2. Use Shared Renderer In Markdown Preview Pane

- Scope: `apps/web/src/files/MarkdownPreviewPane.tsx` and preview-specific CSS in `apps/web/src/styles/timeline.css`.
- Work:
  - Replace the preview pane's plain `ReactMarkdown` call with the shared Markdown renderer.
  - Preserve preview-specific `.kodex-markdown-preview-rendered` as the bounded scroll container.
  - Pass `threadId` so relative local preview URLs remain thread-scoped.
  - Use `skipHtml` through the shared renderer for parity with timeline Markdown.
  - Render desktop previews as a large centered Mantine `Modal`, while retaining the `Drawer` presentation for narrow screens.
- Exit criteria:
  - Preview mode renders shared code blocks and Mantine table wrappers.
  - Source mode still scrolls inside `.kodex-markdown-preview-source`.
  - The modal/drawer body remains non-scrolling for preview-pane content.

### 3. Verification And Browser Review

- Scope: focused tests, production build, and browser-observable pane behavior.
- Work:
  - Add or update focused tests proving the preview pane uses shared Markdown behavior, such as a code-copy button or Mantine table rendering in preview mode.
  - Run focused frontend tests that cover `App.test.tsx` and `timeline/renderers.test.tsx`.
  - Run `npm run build` in `apps/web`.
  - Use `agent-browser` to open a stubbed thread, open a Markdown preview, verify Preview/Source controls, source scrolling, and rendered preview scrolling.
  - Run an independent review/fix loop and repeat until no major issues remain.
- Exit criteria:
  - Focused tests and build pass.
  - Browser review confirms the preview pane uses shared rendering without regressing scroll behavior.
  - Independent review says `No major issues remain.`

## Verification

- `cd apps/web && npm test -- App.test.tsx src/timeline/renderers.test.tsx`
- `cd apps/web && npm run build`
- `agent-browser` validation against a local Vite app with stubbed gateway routes:
  - open a thread with a local Markdown link
  - verify desktop opens a large modal and mobile/narrow screens can still use the drawer path
  - verify preview mode renders shared Markdown chrome
  - verify source mode scrolls inside the source renderer
  - verify modal/drawer header and mode controls remain visible

## Risks And Open Questions

- Shared link helpers currently depend on thread-scoped file preview URLs from `apps/web/src/api/client.ts`; extraction must avoid introducing timeline-to-files circular imports.
- `AssistantCodeBlock` includes a copy button and timer state; moving it into a shared module must preserve cleanup behavior and tests should catch regressions.
- Preview pane may not need image-lightbox opening on rendered image links yet; if no `onImageOpen` is passed, shared rendering should keep native link behavior.
