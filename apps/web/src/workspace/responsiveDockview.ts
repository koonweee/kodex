import type { DockviewApi } from "dockview";

export type ResponsiveDockviewSession = {
  active: boolean;
  previousMaximizedPanelId: string | null;
  restoreSize: { width: number; height: number } | null;
};

// Native maximize keeps the groups and editors mounted. Its hidden sizes are
// absolute, so reveal them at the entry bounds before native proportional resize.
export function applyResponsiveWorkspaceMode(api: DockviewApi, singlePane: boolean, session: ResponsiveDockviewSession) {
  if (singlePane) {
    if (!session.active) {
      session.restoreSize = api.width > 0 && api.height > 0 ? { width: api.width, height: api.height } : null;
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
    else {
      const currentSize = { width: api.width, height: api.height };
      if (session.restoreSize) api.layout(session.restoreSize.width, session.restoreSize.height);
      api.exitMaximizedGroup();
      if (currentSize.width > 0 && currentSize.height > 0) api.layout(currentSize.width, currentSize.height);
    }
    session.active = false;
    session.previousMaximizedPanelId = null;
    session.restoreSize = null;
  }
}

export function serializeWorkspaceDock(api: DockviewApi, session: ResponsiveDockviewSession) {
  const currentSize = { width: api.width, height: api.height };
  const restoreSize = session.active ? session.restoreSize : null;
  // Native serialization temporarily reveals every group. Use their entry
  // bounds so a narrow save cannot change the cached split allocations.
  if (restoreSize) api.layout(restoreSize.width, restoreSize.height);
  let layout: ReturnType<DockviewApi["toJSON"]>;
  try {
    layout = api.toJSON();
  } finally {
    if (restoreSize && currentSize.width > 0 && currentSize.height > 0) api.layout(currentSize.width, currentSize.height);
  }
  // Only the presentation-owned maximize marker is omitted from saved state.
  if (session.active && !session.previousMaximizedPanelId && Reflect.has(layout.grid, "maximizedNode")) {
    const grid = { ...layout.grid };
    Reflect.deleteProperty(grid, "maximizedNode");
    return { ...layout, grid };
  }
  return layout;
}
