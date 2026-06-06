# Mobile Workspace Single-Pane Switcher Plan

## Status

Complete.

## Context

Kodex currently has two different thread-workspace render paths:

- Desktop renders the frontend-owned workspace model through `apps/web/src/workspace/WorkspaceShell.tsx`, `WorkspaceDock.tsx`, and `WorkspacePaneRenderer`.
- Narrow viewports render either `narrowAppSurfacePane` or the older selected-thread path, `ThreadPanel + ComposerPanel`, from `apps/web/src/shell/KodexShellView.tsx`.

The target change is to reduce mobile/desktop split-brain by making narrow viewports use the same workspace pane model and pane components as desktop. Desktop keeps Dockview splits/tabs. Mobile shows one visible workspace pane at a time, with a compact header switcher that lists all open workspace panes and focuses the selected pane. Mobile should not expose Dockview close/X chrome in the primary switcher.

Relevant code seams:

- `apps/web/src/App.tsx` owns shell coordination, selected thread state, composer bridge wiring, generated UI narrow state, and `useSingleThreadWorkspace`.
- `apps/web/src/shell/KodexShellView.tsx` chooses between `WorkspaceShell`, `ThreadPanel + ComposerPanel`, and `narrowAppSurfacePane`.
- `apps/web/src/workspace/WorkspaceProvider.tsx` owns local pane state, `activePaneId`, `openThreadPane`, `openDraftThreadPane`, `openGeneratedUiPane`, `openTerminalPane`, `focusPane`, `paneHeaderActionsById`, pane persistence, and the workspace SSE stream.
- `apps/web/src/workspace/paneRegistry.tsx` already exposes `WorkspacePaneRenderer`, which renders the same pane implementation independent of Dockview.
- `apps/web/src/panes/thread/ThreadPane.tsx` contains the pane-local thread timeline, thread header/actions, and `renderThreadComposer` integration.
- `apps/web/src/panes/generatedUi/GeneratedUiWorkspacePane.tsx` and `apps/web/src/panes/terminal/TerminalPane.tsx` are already workspace pane components.
- `apps/web/src/threads/ThreadPanel.tsx` is the selected-thread mobile path that duplicates thread header, timeline, actions, and generated UI toggling behavior.
- `apps/web/src/threads/WorkspaceSidebar.tsx` currently receives `useSingleThreadMode` behavior through `WorkspaceSidebarWithPaneActions`; in single-thread mode it bypasses workspace pane opening/focus.
- `apps/web/src/styles/workspace.css`, `shell.css`, `preferences.css`, `generated-ui.css`, and `terminal.css` contain the relevant narrow layout and pane-host styles.

## Current State Audit

- The workspace model is already the right shared source for local pane concerns. `WorkspaceProvider` persists `panes`, `activePaneId`, and `dockviewLayout` through `paneStore.ts`; local focus and pane identity are browser-local, which fits `AGENTS.md`.
- Dockview is not required to render a pane. `WorkspacePaneRenderer` can render `ThreadPane`, `GeneratedUiWorkspacePane`, or `TerminalPane` directly.
- Narrow mode currently avoids Dockview chrome, and tests assert that behavior in `apps/web/src/App.mvp.shell.test.tsx`. The new mobile shell should preserve "no Dockview on narrow" while replacing `ThreadPanel + ComposerPanel` with a single active workspace pane.
- `ThreadPane` already uses `renderThreadComposer` from `App.tsx`, so mobile can reuse the same composer bridge used by desktop panes instead of the shell-level `ComposerPanel`.
- Existing generated UI mobile handling is split: `ThreadPanel` has show/hide app surface actions and `App.tsx` tracks `narrowAppSurfaceThreadId`. The workspace model already supports `generatedUi` panes, so mobile generated UI should move to the pane switcher rather than a separate shell overlay path.
- Existing terminal behavior is pane-based, but `terminal.css` has narrow bottom-sheet styling for `.kodex-terminal-host`. The mobile single-pane host must decide whether terminal panes should look like normal full-height panes inside the mobile workspace or keep sheet-like styling only for any non-workspace terminal overlay.
- `WorkspaceProvider.onVisiblePaneIdsChange` currently derives visible thread ids from Dockview's visible groups. A mobile single-pane shell must report the active pane id so read-state/presence and visible-thread effects do not depend on Dockview being mounted.
- `WorkspaceSidebarWithPaneActions` already knows how to open/focus workspace panes on desktop, but intentionally skips that work when `useSingleThreadMode` is true. That branch is the key place to remove the mobile split after the single-pane shell exists.
- The current workspace helper direction is reusable: `WorkspaceProvider` has provider-level focus-or-open behavior through `focusPaneOrAppend`, always-new behavior through `appendPane`/`openNewTerminalPane`, resource-specific `openThreadPane`, `openGeneratedUiPane`, and terminal focus-or-open via `openTerminalPane`. The plan should extend those helpers rather than reimplementing ad hoc pane lookup in sidebar code.

## Target Architecture

Introduce a mobile workspace shell, tentatively `WorkspaceSinglePaneShell`, that renders the active pane from the same workspace model:

```tsx
<WorkspaceSinglePaneShell />
```

The shell should:

- Read `workspace.panes`, `workspace.activePaneId`, `focusPane`, `paneHeaderActionsById`, and `onVisiblePaneIdsChange` from `useWorkspace()`.
- Render one compact header with:
  - a sidebar button using `onShowMobileSidebar`,
  - a Mantine `Menu` or `Combobox` showing the active pane title,
  - all workspace panes as switcher options,
  - the active pane's registered `paneHeaderActionsById[activePaneId]`.
- Render only the active pane through `WorkspacePaneRenderer`.
- Avoid Dockview, Dockview tabs, split panes, drag/drop, middle-click close, floating groups, and primary close/X controls on mobile.
- Call `focusPane(pane.id)` when a switcher item is selected.
- Call `onVisiblePaneIdsChange([activePane.id])` while mounted, and clear or update it on active-pane changes/unmount.
- Dismiss the narrow sidebar after sidebar-triggered pane focus/open actions. The provider helpers should stay viewport-agnostic; the sidebar wrapper should call the existing route/mobile-panel dismissal path after a successful user action.

Desktop should keep `WorkspaceShell` and Dockview unchanged.

## Milestones

### 1. Characterize The Current Split And Lock The Shared-Pane Goal

- Scope: `apps/web/src/App.mvp.shell.test.tsx`, `apps/web/src/workspace/*`, current narrow shell tests.
- Work:
  - Add or update focused tests that describe the intended narrow behavior before implementation: no Dockview chrome, one visible workspace pane, active pane chosen from `workspace.activePaneId`, and a pane switcher listing multiple open panes.
  - Keep existing tests that protect mobile sidebar route state and "show sidebar/show thread" behavior.
  - Avoid CSS-string-only tests for visual details; assert rendered behavior, ARIA labels, active pane focus, and pane content.
- Exit criteria:
  - The new narrow workspace tests fail against the current `ThreadPanel + ComposerPanel` path for the right reason.
  - Existing desktop workspace tests still describe the Dockview behavior that must remain unchanged.

### 2. Add The Single-Pane Workspace Shell

- Scope:
  - `apps/web/src/workspace/WorkspaceSinglePaneShell.tsx`
  - `apps/web/src/workspace/paneRegistry.tsx`
  - `apps/web/src/workspace/WorkspaceProvider.tsx`
  - `apps/web/src/styles/workspace.css`
- Work:
  - Implement `WorkspaceSinglePaneShell` using `WorkspacePaneRenderer` rather than Dockview.
  - Add a mobile pane switcher using Mantine primitives and `paneTitle()` from `paneTypes.ts`.
  - Reuse active pane header actions from `paneHeaderActionsById`, matching the Dockview header action contract.
  - Report visible pane ids from the single-pane shell so `onVisibleThreadIdsChange` and workspace stream presence remain correct without Dockview.
  - Add empty/error fallback behavior matching `WorkspaceShell` when the workspace is unavailable.
  - Do not add pane-opening policy to this component. It should switch visible panes by calling `focusPane`; open/focus creation policy remains in `WorkspaceProvider`.
- Exit criteria:
  - Focused workspace tests cover active-pane rendering, switcher focus behavior, header actions, empty workspace fallback, and visible pane reporting.
  - `cd apps/web && npm test -- workspace` passes.

### 3. Route Narrow Thread Workspace Through The Shared Shell

- Scope:
  - `apps/web/src/shell/KodexShellView.tsx`
  - `apps/web/src/App.tsx`
  - `apps/web/src/shell/useShellSelection.ts`
  - `apps/web/src/threads/WorkspaceSidebar.tsx`
- Work:
  - Change the `mainPane === "thread"` branch so narrow viewports render `WorkspaceSinglePaneShell` and desktop renders `WorkspaceShell`.
  - Remove the narrow `ThreadPanel + ComposerPanel` main-pane branch after tests are moved to pane-backed behavior.
  - Update `WorkspaceSidebarWithPaneActions` so mobile thread selection calls the same `openThreadPane(threadId, title)` helper as desktop. That helper should focus an existing pane for the thread or open one if missing; explicit duplicate actions remain the only duplicate-thread path.
  - Update sidebar terminal launch to call `openTerminalPane()`, which should focus an existing terminal pane or open one if missing. Keep `openNewTerminalPane()` for the pane-local terminal `+` action.
  - Ensure create-chat/create-thread flows use `openDraftThreadPane(...)` for the pane model rather than relying on shell-level draft state alone. If duplicate draft creation is desired, it should be explicit in the options and covered by tests.
  - After sidebar-triggered thread, draft, generated UI, or terminal focus/open actions on narrow viewports, dismiss the sidebar by using the same selected-route/mobile-panel path that currently returns `mobilePanel` to `"chat"`.
  - Keep Automations and Project panes outside the workspace canvas for this plan.
- Exit criteria:
  - Narrow tests verify selecting an existing thread from the sidebar focuses or opens its workspace pane and returns to the chat panel.
  - Narrow tests verify creating a chat or project thread opens a draft workspace pane and preserves draft composer behavior.
  - Narrow tests verify sidebar terminal launch focuses an existing terminal pane, creates one only when missing, and returns to the chat panel.
  - Desktop tests verify sidebar selection still opens/focuses Dockview panes and does not collapse desktop behavior.
  - `cd apps/web && npm test -- App.mvp.shell.test.tsx App.navigation.test.tsx` passes.

### 4. Collapse Generated UI Mobile Handling Into Workspace Panes

- Scope:
  - `apps/web/src/App.tsx`
  - `apps/web/src/panes/generatedUi/GeneratedUiWorkspacePane.tsx`
  - `apps/web/src/generatedUi/GeneratedUiPane.test.tsx`
  - `apps/web/src/App.generatedUi.test.tsx`
  - `apps/web/src/styles/generated-ui.css`
- Work:
  - Replace `narrowAppSurfaceThreadId` / `narrowAppSurfacePane` shell state with `openGeneratedUiPane(...)` and active-pane switcher behavior.
  - Ensure the thread pane action that opens generated UI calls the existing provider helper so it focuses an existing `generatedUi` pane for the same latest thread surface or opens one if missing, on both desktop and mobile.
  - Decide in code whether the generated UI pane's own hide/close affordance is omitted on mobile or moved to secondary pane actions; do not expose a primary X in the mobile switcher.
  - Keep app-surface bridge submissions and optimistic timeline updates routed through `publishThreadPaneTimelineAction`.
- Exit criteria:
  - Tests verify generated UI opens as a workspace pane on narrow viewports and appears in the mobile pane switcher.
  - Tests verify pressing the generated UI action again focuses the existing generated UI pane instead of creating a duplicate.
  - Tests verify generated UI revisions and submissions still converge through the workspace stream.
  - `cd apps/web && npm test -- App.generatedUi.test.tsx generatedUi` passes.

### 5. Remove Or Isolate The Old Selected-Thread Main Path

- Scope:
  - `apps/web/src/threads/ThreadPanel.tsx`
  - `apps/web/src/composer/ComposerPanel.tsx`
  - `apps/web/src/timeline/useSelectedThreadTimeline.ts`
  - `apps/web/src/App.tsx`
  - related tests under `apps/web/src/App.mvp.*.test.tsx`
- Work:
  - Audit which selected-thread state remains necessary for URL routing, sidebar highlighting, notifications, and non-workspace panes.
  - Remove shell-level timeline/composer rendering from the narrow thread workspace path once all thread display is pane-backed.
  - Keep `ComposerPanel` only if still used for a non-pane draft path; otherwise plan a follow-up cleanup rather than mixing it into this change.
  - Keep `ThreadPanel` only if Automations/Project or another route still needs it; otherwise mark it dead and delete with focused tests updated.
  - Preserve gateway-owned lifecycle and read/unread convergence rules from `AGENTS.md`; do not make mobile React state the source of truth for active turns, queued input, read state, or settings.
- Exit criteria:
  - Static search shows narrow thread workspace rendering no longer imports or renders `ThreadPanel + ComposerPanel`.
  - Focused tests still pass for selected-thread route/deep-link behavior, read state, queue rows, approvals, stop/interrupt, and composer send from the active mobile pane.
  - `cd apps/web && npm test -- App.mvp.composer-input.test.tsx App.mvp.approvals-ui.test.tsx App.mvp.approvals-stream.test.tsx` passes.

### 6. Responsive Styling And Browser Validation

- Scope:
  - `apps/web/src/styles/workspace.css`
  - `apps/web/src/styles/shell.css`
  - `apps/web/src/styles/preferences.css`
  - `apps/web/src/styles/generated-ui.css`
  - `apps/web/src/styles/terminal.css`
- Work:
  - Add mobile single-pane workspace styles with stable dimensions for the header, switcher, pane host, and active pane content.
  - Keep width-based layout separate from touch/coarse-pointer ergonomics per `AGENTS.md`.
  - Review generated UI and terminal narrow rules so workspace panes fill the mobile pane area without accidental overlay/sheet positioning.
  - Verify text does not overflow the switcher, pane menu, header actions, or sidebar controls on narrow widths.
- Exit criteria:
  - `cd apps/web && npm run build` passes.
  - `$agent-browser` validates:
    - desktop fine pointer at about `1440x1000`: Dockview splits/tabs and pane actions still work,
    - narrow fine pointer at about `700x900`: one active pane, switcher opens, sidebar toggle works, no Dockview chrome,
    - mobile/touch-sized viewport around `390x844`: one active pane, switcher options fit, composer and generated UI/terminal panes remain usable.
  - Browser validation checks console errors and screenshots for overlapping header/switcher/content.

## Verification

- Focused tests:
  - `cd apps/web && npm test -- workspace`
  - `cd apps/web && npm test -- App.mvp.shell.test.tsx App.navigation.test.tsx`
  - `cd apps/web && npm test -- App.generatedUi.test.tsx generatedUi`
  - `cd apps/web && npm test -- App.mvp.composer-input.test.tsx App.mvp.approvals-ui.test.tsx App.mvp.approvals-stream.test.tsx`
- Build:
  - `cd apps/web && npm run build`
- Static review:
  - `rg -n "ThreadPanel|narrowAppSurface|useSingleThreadWorkspace|WorkspaceSinglePaneShell|WorkspaceShell" apps/web/src`
  - `git diff --check`
- Browser validation:
  - Use `$agent-browser` against the local Vite app for desktop, narrow fine-pointer, and mobile/touch-shaped viewports.

## Risks And Open Questions

- User-owned source changes already exist in `apps/web/src/panes/generatedUi/GeneratedUiWorkspacePane.tsx`, `apps/web/src/panes/thread/ThreadPane.tsx`, and `apps/web/src/workspace/paneRegistry.tsx`; implementation must read and preserve those changes rather than overwriting them.
- Terminal pane mobile styling may currently assume a bottom-sheet host. The implementation should decide from rendered behavior whether terminal panes need a workspace-specific class to avoid overlay-like sizing.
- Removing `ThreadPanel` entirely may be larger than the first implementation chunk. It is acceptable to leave dead-code cleanup as a follow-up if the narrow thread workspace no longer renders it and the remaining references are clearly non-active or test-only.
- The mobile pane switcher should start without primary close/X controls. If mobile pane cleanup becomes necessary, add it later as a secondary overflow action with explicit tests for not deleting backend resources.
