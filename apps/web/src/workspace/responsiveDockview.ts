import type { DockviewApi } from "dockview";

export type ResponsiveDockviewSession = {
  active: boolean;
  previousMaximizedPanelId: string | null;
};

// Native maximize hides groups in place and restores their allocated sizes. It
// does not replace the panel renderer or the focused editor when space changes.
export function applyResponsiveWorkspaceMode(api: DockviewApi, singlePane: boolean, session: ResponsiveDockviewSession) {
  if (singlePane) {
    if (!session.active) {
      session.previousMaximizedPanelId = api.groups.find(group => group.api.isMaximized())?.activePanel?.id ?? null;
      session.active = true;
    }
    const active = api.activePanel;
    if (!active) return;
    const previous = session.previousMaximizedPanelId ? api.getPanel(session.previousMaximizedPanelId) : undefined;
    // Selecting another group exits an explicit maximize in native Dockview too.
    if (session.previousMaximizedPanelId && (!previous || previous.group !== active.group)) session.previousMaximizedPanelId = null;
    if (!active.api.isMaximized()) api.maximizeGroup(active);
  } else if (session.active) {
    const previous = session.previousMaximizedPanelId ? api.getPanel(session.previousMaximizedPanelId) : undefined;
    if (previous) api.maximizeGroup(previous);
    else api.exitMaximizedGroup();
    session.active = false;
    session.previousMaximizedPanelId = null;
  }
}

export function serializeWorkspaceDock(api: DockviewApi, session: ResponsiveDockviewSession) {
  const layout = api.toJSON();
  // Native serialization restores underlying group proportions. Only its
  // presentation-owned maximize marker must be omitted from the saved layout.
  if (session.active && !session.previousMaximizedPanelId && Reflect.has(layout.grid, "maximizedNode")) {
    const grid = { ...layout.grid };
    Reflect.deleteProperty(grid, "maximizedNode");
    return { ...layout, grid };
  }
  return layout;
}
