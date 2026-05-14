# Message Toolbar Timestamps Plan

## Status

Complete.

## Context

Add a muted timestamp beside the copy control for visible user messages and final assistant messages in the web timeline. The timestamp should read like `2:03:22 PM` for today, `yesterday 9:18:04 AM`, or `3d ago 9:44:10 PM`, using the user's local time.

The UI change belongs in the frontend timeline surface:

- `apps/web/src/timeline/renderers.tsx` owns `UserMessageBubble`, `AssistantMessageMarkdown`, and the current `MessageCopyToolbar`.
- `apps/web/src/timeline/TimelineView.tsx` derives rows and passes renderer props.
- `apps/web/src/timeline/derive.ts` owns visible timeline row ordering.
- `apps/web/src/timeline/state.ts`, `presentationShared.ts`, and `reducer.ts` own `TimelineItem` fields and event/snapshot normalization.
- `apps/web/src/styles/timeline.css` owns message bubble, assistant markdown, and toolbar styling.
- Focused renderer and row tests live in `apps/web/src/timeline/renderers.test.tsx`, `TimelineView.render.test.tsx`, `derive.test.ts`, and reducer snapshot/lifecycle tests.

## Current State

- `MessageCopyToolbar` is a local renderer helper that renders only the copy button and aligns the toolbar with `data-align="end"` for user messages and `data-align="start"` for assistant messages.
- User messages call `MessageCopyToolbar align="end"` after the bubble, so the button appears under the right-aligned user bubble.
- Final assistant messages call `MessageCopyToolbar align="start"` after Markdown content; non-final assistant messages do not render copy controls.
- Live timeline events include `EventEnvelope.receivedAt`, but `TimelineItem` does not expose a stable timestamp field for renderers.
- Snapshot-loaded items are converted to synthetic events in `snapshotItemEvent` with `receivedAt: new Date(0).toISOString()`, while turn snapshots already expose `startedAt` and `completedAt`. The timestamp UI must not render `1970-01-01` data for snapshots.
- Optimistic user messages do not currently record a creation timestamp.

## Milestones

### 1. Timestamp Data Model

Scope: `apps/web/src/timeline/state.ts`, `presentationShared.ts`, `reducer.ts`, and focused reducer tests.

Work:

- Add an optional `timestampMs` field to `TimelineItem`.
- Populate live items from parsed `EventEnvelope.receivedAt` in `createBaseItem`.
- Preserve the earliest meaningful item timestamp when merging live deltas/upserts, unless the existing item has no timestamp.
- Populate optimistic user messages with `Date.now()` when `addOptimisticUserMessage` creates the local row, then preserve that timestamp through confirmation.
- Populate snapshot items from turn-level times instead of the synthetic epoch:
  - user messages: prefer `turn.startedAt`.
  - final assistant messages: prefer `turn.completedAt`, then `turn.startedAt`.
  - other snapshot items can use `turn.startedAt` as a fallback only if needed by existing renderers; this plan only renders message timestamps.
- Keep `receivedAt: new Date(0).toISOString()` as an internal synthetic event detail if needed for ordering/debug, but do not use it for visible message timestamps.

Exit criteria:

- Reducer tests prove live user/assistant items receive `timestampMs` from `receivedAt`.
- Snapshot tests prove user and final assistant messages get non-epoch timestamps from `ThreadTurnSnapshot.startedAt`/`completedAt`.
- Optimistic user message tests prove the local timestamp survives app-server confirmation.

### 2. Message Timestamp Selection

Scope: `apps/web/src/timeline/derive.ts`, `TimelineView.tsx`, and focused row/render tests.

Work:

- Compute visible message timestamp ids after `deriveTimelineRows` has produced visible rows.
- Include visible `user_message` rows and final-answer `assistant_message`/legacy `agent_message` rows that have `timestampMs`.
- Do not show timestamps on intermediate or working assistant messages.
- Do not show timestamps on hidden debug items or collapsed work/activity rows.
- Pass a small renderer prop such as `toolbarTimestampMs` into `TimelineItemRenderer` for every visible message row with a timestamp.

Exit criteria:

- `TimelineView.render.test.tsx` or `renderers.test.tsx` covers multiple user and final assistant messages and verifies eligible visible messages show a timestamp.
- Existing virtualized row rendering behavior stays unchanged except for the new toolbar metadata.

### 3. Shared Message Toolbar Component

Scope: `apps/web/src/timeline/renderers.tsx` and `apps/web/src/styles/timeline.css`.

Work:

- Replace `MessageCopyToolbar` with a more general `MessageToolbar` that renders standardized muted toolbar items.
- Keep the copy behavior and "Copied message" transient state unchanged.
- Add a `MessageToolbarTimestamp` item that formats local time as:
  - `h:mm:ss AM/PM` for same local calendar day.
  - `yesterday h:mm:ss AM/PM` for the previous local calendar day.
  - `<n>d ago h:mm:ss AM/PM` for older dates.
- Set a `title` or accessible label with the full local date/time for the timestamp so compact relative text still has precise detail.
- Enforce render order by role/alignment:
  - user toolbar: timestamp left of copy icon.
  - assistant toolbar: copy icon left of timestamp.
- Keep copy controls limited to existing copyable messages; non-final assistant messages do not render toolbar timestamps.
- Keep the copy button muted like today and apply the same muted visual treatment to the timestamp.

Exit criteria:

- Renderer tests verify user toolbar DOM/order is timestamp then copy.
- Renderer tests verify assistant toolbar DOM/order is copy then timestamp.
- Copy tests still pass for user and final assistant messages.
- Timestamp format tests cover same-day 12-hour time-only, yesterday, and multi-day-old dates with deterministic fake timers.

### 4. Styling And Browser Validation

Scope: `apps/web/src/styles/timeline.css`, focused frontend commands, and `$agent-browser` validation.

Work:

- Update `.kodex-message-toolbar` to support a small horizontal item set with stable spacing, wrapping resistance, and muted color.
- Add shared item styling for toolbar text and icon buttons so the timestamp and copy control read as one quiet toolbar.
- Keep right-aligned user rows within `.kodex-user-message-stack` max width and avoid text overlap on narrow mobile widths.
- Validate desktop and mobile timeline rendering in the browser with a thread that has at least two user messages and two final assistant messages.

Exit criteria:

- `cd apps/web && npm test -- timeline/renderers.test.tsx timeline/TimelineView.render.test.tsx` passes.
- `cd apps/web && npm run build` passes.
- `$agent-browser` screenshots or inspection confirm:
  - user timestamps sit left of the copy icon.
  - final assistant timestamps sit right of the copy icon.
  - non-final assistant messages do not show toolbar timestamps or copy controls.
  - toolbar text does not overlap bubbles or Markdown on mobile width.

## Verification

- Run the focused timeline tests first while implementing each milestone.
- Run `cd apps/web && npm test -- timeline/renderers.test.tsx timeline/TimelineView.render.test.tsx timeline/reducer.snapshot.test.ts timeline/reducer.optimistic.test.ts`.
- Run `cd apps/web && npm run build`.
- Use `$agent-browser` against the local Vite app to inspect desktop and mobile message toolbars after the frontend is running.

## Risks And Open Questions

- App-server snapshots currently expose turn timestamps but not item-level timestamps. This plan uses turn-level timestamps for snapshot-loaded messages; if app-server later exposes item timestamps, `ThreadItemSnapshot` should carry them through the gateway and `TimelineItem.timestampMs` can switch to item precision.
- The formatter should use local calendar days, not 24-hour intervals, so `yesterday` remains correct around midnight.
