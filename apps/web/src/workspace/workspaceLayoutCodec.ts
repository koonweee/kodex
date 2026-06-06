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
  const paneIds = panes.map((pane) => pane.id).sort();
  if (hasDockviewPanels(layout)) {
    const panelIds = Object.keys(layout.panels).sort();
    const gridIds = dockviewGridPanelIds(layout);
    if (!gridIds) {
      return false;
    }
    gridIds.sort();
    return (
      sameSortedIds(panelIds, paneIds) &&
      sameSortedIds(gridIds, paneIds)
    );
  }
  const layoutIds = workspaceLayoutPanelIds(layout).sort();
  return sameSortedIds(layoutIds, paneIds);
}

function sameSortedIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function dockviewGridPanelIds(layout: LayoutObject & { panels: Record<string, unknown> }): string[] | null {
  if (!isRecord(layout.grid) || !isRecord(layout.grid.root)) {
    return null;
  }
  return dockviewGridNodePanelIds(layout.grid.root);
}

function dockviewGridNodePanelIds(node: LayoutObject): string[] | null {
  if (node.type === "branch") {
    if (!Array.isArray(node.data) || node.data.length === 0) {
      return null;
    }
    const ids: string[] = [];
    for (const child of node.data) {
      if (!isRecord(child)) {
        return null;
      }
      const childIds = dockviewGridNodePanelIds(child);
      if (!childIds) {
        return null;
      }
      ids.push(...childIds);
    }
    return ids;
  }

  if (node.type === "leaf") {
    if (!isRecord(node.data) || !Array.isArray(node.data.views) || node.data.views.length === 0) {
      return null;
    }
    const ids: string[] = [];
    for (const view of node.data.views) {
      if (typeof view !== "string") {
        return null;
      }
      ids.push(view);
    }
    return ids;
  }

  return null;
}

export function compactWorkspaceLayout(workspace: WorkspaceModel): unknown {
  return {
    activePaneId: workspace.activePaneId ?? null,
    panes: workspace.panes.map((pane) => ({ id: pane.id })),
  };
}
