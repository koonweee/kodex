# Timeline Performance Plan

## Scope

Improve the Kodex web timeline so event-heavy threads stay responsive while preserving the current chat-first presentation, debug mode, inline approvals, and fixed header/composer layout.

This is a frontend-only performance plan unless implementation discovers a gateway contract issue. It must not introduce handwritten gateway DTOs or change generated OpenAPI artifacts unless the public API itself changes.

## Status

Proposed.

## Principles

- Red first where practical: add reducer, component, or integration coverage before behavior-changing work.
- Optimize the timeline hot path first. Thread sidebar virtualization is out of scope while `GET /v1/threads` remains capped at a small page size.
- Preserve chat behavior: completed content should remain stable, active streaming rows should update, and scroll anchoring should match user intent.
- Treat scroll position as user intent: follow streaming output only when the user is already near the bottom, and provide an explicit return-to-bottom control when they are reading older content.
- Keep rows protocol-aware and presentation-focused. Do not regress to raw event-log rendering.
- Prefer small, measurable chunks that can be reviewed independently.

## Current Problem

The timeline currently derives and renders all visible rows on every relevant `App` render. Long threads can accumulate many messages, tool calls, markdown blocks, command outputs, approvals, and hidden debug events. The likely costs are:

- render-time sorting, grouping, and segmentation of timeline items
- repeated approval filtering per segment
- rerendering completed markdown and tool rows on unrelated state changes such as composer typing
- one React state update per streamed event
- linear reducer updates as item counts grow
- rendering the entire scrollback even when most rows are offscreen

## Milestone 1: Baseline Coverage and Fixtures

Status: Proposed

Failing tests first:

- Large timeline fixture renders messages, activity groups, approvals, debug items, and streaming updates in the expected order.
- Debug toggle still merges hidden events without mutating timeline state.
- Approval cards stay attached to the correct item or activity group.
- Selected-thread switching continues to ignore stale replay and stream events.

Implementation:

- Add reusable test builders for large `TimelineState` and approval sets.
- Add coverage for composer typing or unrelated app state changes if practical with the existing test stack.
- Capture the current behavior before optimizing internals.

Exit conditions:

- Existing MVP and timeline tests still pass.
- New tests protect ordering, debug visibility, approval placement, and selected-thread isolation.

## Milestone 2: Fix Sort Mutation

Status: Proposed

Failing tests first:

- Rendering the timeline does not mutate `timeline.items`.
- Toggling debug mode preserves reducer-owned item order.

Implementation:

- Always sort a copied array in timeline derivation.
- Avoid any render-time mutation of reducer state.

Exit conditions:

- Timeline render code treats reducer state as immutable.
- Existing timeline ordering remains unchanged.

## Milestone 3: Memoized Timeline Derivation

Status: Proposed

Failing tests first:

- Composer text changes do not recompute timeline grouping and segmentation when timeline inputs are unchanged.
- Debug mode changes recompute only the derived timeline rows that depend on debug visibility.

Implementation:

- Move visible-item selection, sequence sorting, turn grouping, and activity segmentation behind `useMemo`.
- Prefer a flat row model for rendering and later virtualization:
  - `item` rows for message, reasoning, warning, error, and other single blocks
  - `activity` rows for grouped command, file, MCP, dynamic tool, and web-search activity
- Keep row keys stable across rerenders.

Exit conditions:

- Timeline derivation is centralized and reusable by the virtualized renderer.
- Unrelated app state changes do not repeat expensive derivation.

## Milestone 4: Pre-Indexed Approvals

Status: Proposed

Failing tests first:

- Inline approvals still render below matching single-item rows.
- Inline approvals still render below activity groups when an approval targets any item inside the group.

Implementation:

- Build a `Map<string, Approval[]>` once per approval-list change.
- Replace per-row `approvals.filter(...)` scans with map lookups.
- Keep drawer approval behavior unchanged.

Exit conditions:

- Approval placement is identical to the current UI.
- Row rendering no longer scans the full approval list for every segment.

## Milestone 5: Split and Memoize Timeline Components

Status: Proposed

Failing tests first:

- Completed timeline rows do not rerender on composer text changes.
- Active streaming rows still rerender when their item content changes.
- Debug toggle updates row debug disclosures correctly.

Implementation:

- Extract smaller components for timeline rows, approval lists, activity rows, and item rows.
- Wrap stable row/item components with `React.memo`.
- Keep callback props stable with `useCallback` where needed.
- Avoid passing newly allocated arrays or objects to memoized row components unless the content actually changed.

Exit conditions:

- Timeline rows have clear ownership and stable props.
- Unrelated parent renders do not force completed rows to rerender.

## Milestone 6: Memoized Markdown Rows

Status: Proposed

Failing tests first:

- Assistant markdown output remains identical for links, code, lists, line breaks, and HTML skipping.
- Completed assistant messages do not reparse markdown on unrelated state changes.
- Streaming assistant messages still update as deltas arrive.

Implementation:

- Memoize assistant markdown rendering by item identity and text.
- Keep active/running message rows responsive during streaming.
- Preserve current `react-markdown`, `remark-gfm`, and `remark-breaks` behavior.

Exit conditions:

- Markdown rendering remains safe and visually unchanged.
- Completed assistant rows are cheap to keep mounted.

## Milestone 7: Batched Streaming Updates

Status: Proposed

Failing tests first:

- Rapid SSE event bursts produce the same final timeline state as sequential per-event updates.
- Events remain ordered by `seq`.
- Selected-thread switch or unmount flushes or discards queued work without leaking stale events.

Implementation:

- Queue incoming SSE events for the selected thread.
- Flush queued events with `requestAnimationFrame` or a short bounded timer.
- Apply queued events in sequence order through the existing reducer path.
- Flush immediately when changing selected thread or cleaning up a stream subscription.

Exit conditions:

- Event bursts cause fewer React commits.
- Timeline state, active turn state, and approval handling remain correct.

## Milestone 8: Optimized Reducer Storage

Status: Proposed

Failing tests first:

- Replay, delta merge, item completion, hidden debug items, and turn grouping retain current behavior.
- Long active turns update existing items without repeated linear scans.

Implementation:

- Normalize timeline state internally with ordered IDs plus keyed item storage.
- Replace `findIndex` item updates with direct keyed updates.
- Keep render derivation ordered and compatible with the flat row model from Milestone 3.
- Avoid exposing normalized internals outside the timeline state module unless needed.

Exit conditions:

- Reducer tests pass with the normalized storage.
- Per-event update cost no longer scales primarily with visible item count.

## Milestone 9: Dynamic-Height Virtualization

Status: Proposed

Failing tests first:

- A large timeline renders only visible rows plus overscan.
- Rows with markdown, command output, approvals, and expanded details measure correctly.
- Streaming at the bottom keeps the latest row visible only when the user is already near the bottom.
- Scrolling up preserves reading position while new events arrive.
- When the user is scrolled up and newer timeline content exists below the viewport, a floating scroll-to-bottom button appears centered above the composer.

Implementation:

- Add `@tanstack/react-virtual` or an equivalent maintained dynamic-height virtualizer.
- Virtualize the flat timeline row model, not nested activity items.
- Use `.kodex-timeline-scroll` as the scroll parent.
- Use dynamic measurement because row heights are variable.
- Add modest overscan to avoid visible pop-in.
- Add bottom anchoring:
  - auto-scroll when the user is near the bottom
  - preserve position when the user has intentionally scrolled up
  - show a floating scroll-to-bottom button centered over the composer when the user is not near the bottom and newer timeline content exists below the viewport
  - hide the button after the user returns near the bottom
- Keep the floating button clear of the composer controls on desktop and mobile.

Exit conditions:

- Large timelines mount only the visible row window plus overscan.
- Expanding details and debug disclosures update measurements correctly.
- Fixed thread header and composer remain outside the virtualized scroll region.
- Streaming conversations auto-follow only from a near-bottom scroll position, and the floating button restores the latest content whenever the user has scrolled up and content exists below the viewport.

## Review Gate

- Run `cd apps/web && npm test`.
- Run `cd apps/web && npm run build`.
- Use the app with an event-heavy thread on desktop and mobile viewports.
- Perform an independent review pass or self-review for each implementation chunk.
- Do not mark this plan complete until the milestones above are implemented, tests pass, and [plans/index.md](index.md) is updated.
