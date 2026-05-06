# Sidebar Row Primitives Plan

## Status

Complete. Pass 1 implemented shared section/project row primitives and collapsible Pinned behavior. Pass 2 moved thread rows onto the shared frame with reserved pin/action and trailing rails. Focused tests, build, full frontend tests, visual validation, and independent review passed.

## Goal

Replace ad hoc sidebar row markup with shared row primitives that keep icon rails, labels, disclosure chevrons, and trailing actions aligned across Pinned, Projects, Chats, project rows, and later thread rows.

The refactor should preserve existing sidebar behavior while making row spacing deliberate instead of incidental. The immediate visual goals are:

- Section labels stay aligned to the left sidebar content edge.
- Project rows reserve a leading folder icon rail.
- Thread rows eventually reserve a leading pin/action rail.
- Rows with possible trailing actions reserve a right action rail.
- Expandable rows show a disclosure chevron after the text on hover/focus, and keep it visible when collapsed.
- Rows that do not expand can omit disclosure entirely.

## Existing Code

- Sidebar rendering is concentrated in `apps/web/src/threads/WorkspaceSidebar.tsx`.
- Sidebar styles live in `apps/web/src/styles/sidebar.css`.
- Pinned currently renders a one-off section title and thread list above Projects.
- Projects and Chats currently use `SectionToggle`.
- Project rows currently use custom `.kodex-project-row` and `.kodex-project-title` markup.
- Thread rows currently use a separate container/select/action layout with a left pin control and right action slot.

## Proposed Components

Add shared row components under `apps/web/src/threads/sidebarRows.tsx`.

Core layout primitive:

- `SidebarRowFrame`
  - Owns the grid, rails, gaps, typography, selected/hover/focus classes, and action/disclosure placement.
  - Does not impose button semantics by itself.

Section wrapper:

- `SidebarSectionDisclosureRow`
  - Used by Pinned, Projects, and Chats.
  - The label/chevron area is a button and toggles collapse.
  - Trailing actions are sibling buttons, not nested buttons.
  - Section labels do not reserve a leading icon rail.

Item/action wrapper:

- `SidebarActionDisclosureRow`
  - Used by project rows in the first pass.
  - Supports a leading icon rail, label, disclosure, and trailing action rail.
  - Keeps trailing actions separate from the main clickable area to avoid invalid nested button markup.

Thread wrapper:

- Thread rows use the shared row frame after the frame contract is stable.
  - It should reserve a leading pin/action rail.
  - It should reserve the trailing action rail for progress, unread, archive, and related controls.
  - It should preserve the current select, pin/unpin, hover/focus, approval badge, and mobile behavior.

## Layout Rules

The shared row frame should use fixed internal regions rather than loose `left` and `right` slots:

- `leadingIcon`: fixed rail for folder or pin/action controls when reserved.
- `label`: flexible text/content area.
- `disclosure`: chevron immediately after text, not in the far-right action rail.
- `trailingActions`: fixed action rail aligned to the row's right edge.

Section rows should set the leading rail to none. Project and thread rows should reserve their relevant leading rails.

The row frame should own spacing values. Callers can provide icons/actions, but should not control row padding, icon size, or rail width directly.

## Mobile UX Considerations

Mobile cannot depend on hover. Any action that is only hover-visible on desktop must remain touch-accessible on mobile.

Requirements:

- Touch targets for interactive row areas and action buttons should be large enough for comfortable tapping. Keep existing mobile row `min-height` behavior or increase it if the new frame makes targets smaller.
- Pin/unpin controls on thread rows must remain visible and tappable on mobile, matching the current no-hover behavior.
- Disclosure chevrons for collapsible sections and project rows should remain discoverable on touch devices. If hover-only visibility makes them too subtle, show chevrons whenever the row is collapsible on mobile.
- Trailing actions must not overlap label text at narrow widths. Reserve the trailing rail for rows with possible actions.
- Collapsed sections must be reversible without hover. The collapsed chevron should stay visible.
- The mobile sidebar scope filters for Projects/Chats must continue to hide and show the same content groups.
- Pinned should disappear when empty on mobile and desktop. When non-empty, it should be collapsible like Projects and Chats.
- Avoid making the entire row toggle when the row has trailing actions. The label/chevron area toggles; trailing action buttons perform their own action.
- Focus-visible styles should remain meaningful for keyboard and switch-control users, even where hover behavior differs by device.

## Implementation Pass 1

Scope: section headers and project rows only.

1. Add `sidebarRows.tsx` with `SidebarRowFrame`, `SidebarSectionDisclosureRow`, and `SidebarActionDisclosureRow`.
2. Add shared CSS classes in `sidebar.css` for row frame, leading rail, label area, disclosure chevron, and trailing action rail.
3. Replace Pinned, Projects, and Chats section headers with `SidebarSectionDisclosureRow`.
4. Add local `pinnedSectionCollapsed` state.
5. Keep Pinned hidden when `visiblePinnedThreads.length === 0`.
6. Hide the pinned `ThreadList` when `pinnedSectionCollapsed` is true.
7. Replace project rows with `SidebarActionDisclosureRow`.
8. Preserve project drag/drop handlers on the row wrapper.
9. Preserve New Project, New Chat, and New Thread callbacks.

## Implementation Pass 2

Scope: thread rows.

Complete.

1. Move `ThreadListRow` onto the shared frame or a thread-specific wrapper built on it.
2. Reserve the leading pin/action rail for all thread rows, including unpinned rows.
3. Preserve desktop hover/focus visibility for pin and archive controls.
4. Preserve mobile always-accessible pin/unpin behavior.
5. Preserve selected, in-progress, unread, pinned, and approval-needed states.
6. Verify pinned and unpinned titles no longer shift when row actions appear.

## Testing Plan

Add focused shared row tests instead of duplicating the same collapse behavior for every section:

- Disclosure row renders the label.
- `aria-expanded` reflects collapsed state.
- Clicking the label/chevron area calls `onToggle`.
- Clicking a trailing action calls its action and does not call `onToggle`.
- Omitting disclosure renders no chevron and no `aria-expanded`.
- Relevant row frame regions/classes are present for leading, label, disclosure, and trailing rails.

Clean up existing tests if shared tests cover the same mechanics:

- Keep integration coverage for Pinned rendering above Projects.
- Keep integration coverage for Pinned disappearing when empty.
- Keep section-specific tests for unique wiring such as New Project and New Chat callbacks.
- Keep project-row tests for project-specific collapse, drag/drop, and New Thread wiring.

## Visual Validation

Use agent-browser to render and inspect the sidebar after each implementation pass.

Desktop checks:

- Pinned, Projects, and Chats section labels align to the same left edge.
- Project folder icons align in a fixed leading rail.
- Section and project disclosure chevrons appear after text on hover/focus and remain visible when collapsed.
- New Project, New Chat, New Thread, archive, progress, and unread controls align to the shared trailing action rail where applicable.
- Pinned section collapse/expand does not shift unrelated rows.

Mobile checks:

- Touch targets remain comfortable in the mobile sidebar.
- Controls that rely on hover on desktop remain visible or otherwise reachable on touch devices.
- Collapsed sections can be expanded without hover.
- Labels do not overlap disclosure chevrons or trailing actions at narrow widths.
- Pinned disappears when empty and is reachable/collapsible when populated.

Capture screenshots at representative desktop and mobile widths and use them to verify alignment, hover/focus states, collapsed states, and no-overlap behavior before considering the pass complete.

## Acceptance Criteria

- Pinned, Projects, and Chats share the same section disclosure row component.
- Pinned disappears when empty and collapses when non-empty.
- Section labels remain left-aligned with the sidebar content edge.
- Project rows use the shared row frame with a leading folder rail and disclosure chevron after text.
- Thread rows use the shared row frame with reserved pin/action and trailing action rails.
- Right-side section and project action icons align through a shared trailing action rail.
- Thread pin, archive, unread, and progress controls align through shared row rails without shifting thread titles on hover.
- Mobile touch controls remain accessible without hover.
- Agent-browser desktop and mobile visual checks pass for alignment, hover/focus, collapsed states, and touch accessibility.
- No nested interactive button markup is introduced.
- Focused frontend tests pass.
- `npm run build` passes.

## Non-Goals

- No backend changes.
- No OpenAPI or generated frontend API changes.
- No persistent collapse state.
- No browser local storage for row UI state.
- No redesign of sidebar information architecture beyond making Pinned collapsible when present.
