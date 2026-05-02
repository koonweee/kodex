# Thread Open Performance Plan

## Scope

Reduce visible jank when selecting/opening an existing thread in the React client. This plan is frontend-only unless profiling uncovers a gateway contract issue.

## Status

Complete.

## Current Findings

Profiling the "does codex app server generate thread titles?" thread after the composer draft refactor showed:

- The composer typing hot path no longer rerenders the shell/sidebar/timeline.
- Opening a thread still causes several shell-level commits before the timeline settles.
- `WorkspaceSidebar` and many `ThreadListRow` instances rerender during selection even when most rows only need unchanged data.
- The timeline can report `ready` before dynamic-height virtualized rows have fully measured, which can make thread open feel like it settles after the UI says it is ready.
- Clean user-like scrolling through the long thread is not currently the main bottleneck.

## Milestone 1: Sidebar Render Isolation

Failing tests first:

- Typing or unrelated parent rerenders must not force `WorkspaceSidebar` or unchanged `ThreadListRow` instances to rerender.
- Selecting a different thread should rerender only the previously selected row and the newly selected row when thread data is unchanged.

Implementation:

- Wrap `WorkspaceSidebar` and `ThreadListRow` in `React.memo`.
- Pass each row an `isSelected` boolean rather than the global `selectedThreadId`.
- Avoid per-row inline closures by passing stable project/thread ids to stable parent callbacks.
- Keep hover/archive behavior unchanged.

Exit conditions:

- Existing shell/sidebar tests still pass.
- Focused render-count coverage protects the isolation boundary.

## Milestone 2: Stable Shell Callback Props

Failing tests first:

- Repeated parent renders with unchanged semantic props should not invalidate memoized sidebar rows via new callback identities.

Implementation:

- Stabilize shell callback props with a local event-callback helper so callback identity remains stable while behavior still sees current state.
- Remove avoidable inline callbacks from `workspaceSidebarProps`, `threadPanelProps`, `composerPanelProps`, and `preferencesProps` where they cause broad child rerenders.
- Keep state ownership and API behavior unchanged.

Exit conditions:

- Existing composer, shell, approvals, and timeline tests pass.
- No stale-closure regressions when selecting, archiving, creating, or submitting.

## Milestone 3: Timeline Ready After Initial Measurement

Failing tests first:

- Timeline readiness should wait until the bottom row is rendered and the virtual scroll height has remained stable for the required settle frames.
- Empty timelines and non-bottom user intent still complete readiness without hanging.

Implementation:

- Keep the current dynamic-height virtualizer.
- Make `onReady` fire only after initial bottom reveal and measurement settle, not merely after row data is available.
- Use a bounded settle loop so pathological rows cannot hang readiness indefinitely.

Exit conditions:

- Timeline virtualization tests still pass.
- Opening a long thread does not visibly report ready before the initial row window has settled.

## Milestone 4: Benchmark Loop

Run after implementation:

- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Browser benchmark loop with `agent-browser`:
  - cold refresh
  - select a different thread
  - profile selecting the target long thread until ready
  - repeat at least three times
  - profile user-like scroll through the same long thread

Exit conditions:

- Median open-thread ready time improves or render-count evidence shows the intended sidebar isolation.
- No new long tasks appear in clean user-like scroll traces.
- Update this plan and [plans/index.md](index.md) to `Complete` after tests and benchmark review pass.

## Completion Notes

- Added row-level memoization for the workspace sidebar and stabilized shell callback props that previously invalidated memoized children during thread selection.
- Changed initial timeline readiness to require a stable virtualizer total size, rendered virtual bottom row, rendered DOM bottom row, and a longer quiet window before firing `onReady`.
- Verified with `npm test` and `npm run build` in `apps/web`.
- Re-ran the long-thread open benchmark against "does codex app server generate thread titles?":
  - Final three manual repeat measurements: ~1017 ms, ~1002 ms, ~1129 ms to aligned ready.
  - Post-ready layout settled cleanly in all final repeats: `heightDeltaAfterReady: 0`, `scrollHeightDeltaAfterReady: 0`.
  - Before the final readiness fix, the same strict check still showed 691-1425 px of post-ready height growth; that regression is now covered by the readiness predicate test.
