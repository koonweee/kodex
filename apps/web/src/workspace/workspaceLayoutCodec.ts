import type { WorkspaceModel, WorkspacePane } from "./paneTypes";

type LayoutObject = Record<string, unknown>;

export function isRecord(value: unknown): value is LayoutObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasDockviewPanels(layout: unknown): layout is LayoutObject & { panels: Record<string, unknown> } {
  return isRecord(layout) && isRecord(layout.panels);
}

export function workspaceLayoutPanelIds(layout: unknown): string[] {
  if (!isRecord(layout)) {
    return [];
  }
  if (isRecord(layout.panels)) {
    return Object.keys(layout.panels);
  }
  if (Array.isArray(layout.panes)) {
    return layout.panes.flatMap((pane) => {
      if (typeof pane === "string") {
        return [pane];
      }
      if (isRecord(pane) && typeof pane.id === "string") {
        return [pane.id];
      }
      return [];
    });
  }
  return [];
}

export function layoutMatchesWorkspacePanes(layout: unknown, panes: WorkspacePane[]): boolean {
  const layoutIds = workspaceLayoutPanelIds(layout).sort();
  const paneIds = panes.map((pane) => pane.id).sort();
  return layoutIds.length === paneIds.length && layoutIds.every((id, index) => id === paneIds[index]);
}

export function compactWorkspaceLayout(workspace: WorkspaceModel): unknown {
  return {
    activePaneId: workspace.activePaneId ?? null,
    panes: workspace.panes.map((pane) => ({ id: pane.id })),
  };
}
