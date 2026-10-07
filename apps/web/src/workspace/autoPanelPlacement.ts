import { Orientation, type DockviewApi, type IDockviewGroupPanel, type SerializedDockview } from "dockview";
import type { WorkspacePanePlacementDirection, WorkspacePanePlacementHintsById } from "./panePlacement";
import type { WorkspacePane } from "./paneTypes";

// Soft placement targets, not resize constraints: manual layouts remain unrestricted.
const MIN_PANE_WIDTH = 480;
const MIN_PANE_HEIGHT = 320;

type Position = { referencePanel: string; direction: WorkspacePanePlacementDirection };

export function autoPanelPlacement(api: DockviewApi, referencePanel: string, gap: number): Position {
  const source = api.getPanel(referencePanel)?.group;
  const grid = api.toJSON().grid;
  const dockedGroups = api.groups.filter((group) => group.api.location.type === "grid" && group.api.isVisible);
  const candidates = dockedGroups
    .filter((group) => group !== source)
    .sort((a, b) => b.api.width * b.api.height - a.api.width * a.api.height);
  if (source) candidates.unshift(source);
  for (const group of candidates) {
    if (group.api.location?.type !== "grid" || !group.api.isVisible) continue;
    const target = group === source ? referencePanel : group.activePanel?.id;
    if (!target) continue;
    const direction = splitDirection(group, gap, grid, dockedGroups);
    if (direction) return { referencePanel: target, direction };
  }
  return { referencePanel, direction: "within" };
}

type GridNode = SerializedDockview["grid"]["root"];

function splitDirection(group: IDockviewGroupPanel, gap: number, grid: SerializedDockview["grid"], groups: IDockviewGroupPanel[]): "right" | "below" | null {
  const { width, height } = group.api;
  if (width >= MIN_PANE_WIDTH * 2 + gap && height >= MIN_PANE_HEIGHT
    && safeDistribution(grid, group.id, Orientation.HORIZONTAL, groups, gap)) return "right";
  if (width >= MIN_PANE_WIDTH && height >= MIN_PANE_HEIGHT * 2 + gap
    && safeDistribution(grid, group.id, Orientation.VERTICAL, groups, gap)) return "below";
  return null;
}

function safeDistribution(grid: SerializedDockview["grid"], groupId: string, axis: Orientation, groups: IDockviewGroupPanel[], gap: number): boolean {
  const parent = findParent(grid?.root, grid?.orientation, groupId);
  if (!parent) return false;
  // A perpendicular split nests only the chosen group. On the same axis,
  // Dockview equalizes all siblings; avoid shrinking nested sibling layouts.
  if (parent.axis !== axis) return true;
  const siblings = parent.children.filter((node) => node.visible !== false);
  if (siblings.some((node) => node.type === "branch")) return false;
  const sizes = siblings.map((node) => {
    const sibling = groups.find((candidate) => !Array.isArray(node.data) && candidate.id === node.data.id);
    return sibling ? (axis === Orientation.HORIZONTAL ? sibling.api.width : sibling.api.height) : 0;
  });
  const minimum = axis === Orientation.HORIZONTAL ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT;
  return (sizes.reduce((sum, size) => sum + size, 0) - gap) / (sizes.length + 1) >= minimum;
}

function findParent(node: GridNode | undefined, axis: Orientation, groupId: string): { axis: Orientation; children: GridNode[] } | null {
  if (!node || !Array.isArray(node.data)) return null;
  if (node.data.some((child) => child.type === "leaf" && !Array.isArray(child.data) && child.data.id === groupId)) {
    return { axis, children: node.data };
  }
  const nextAxis = axis === Orientation.HORIZONTAL ? Orientation.VERTICAL : Orientation.HORIZONTAL;
  for (const child of node.data) {
    const parent = findParent(child, nextAxis, groupId);
    if (parent) return parent;
  }
  return null;
}

export function panelPlacementOptions(
  api: DockviewApi,
  pane: WorkspacePane,
  fallbackReferencePane: WorkspacePane | null,
  panePlacementHintsById: WorkspacePanePlacementHintsById,
  consumedPlacementHintIds: Set<string>,
  gap: number,
): { floating: false; position: { direction: WorkspacePanePlacementDirection; referencePanel: string } } | Record<string, never> {
  const hint = panePlacementHintsById[pane.id];
  if (hint) {
    consumedPlacementHintIds.add(pane.id);
    if (api.getPanel(hint.referencePaneId)) {
      return {
        floating: false,
        position: hint.direction === "auto"
          ? autoPanelPlacement(api, hint.referencePaneId, gap)
          : { referencePanel: hint.referencePaneId, direction: hint.direction },
      };
    }
  }
  if (fallbackReferencePane && api.getPanel(fallbackReferencePane.id)) {
    return {
      floating: false,
      position: autoPanelPlacement(api, fallbackReferencePane.id, gap),
    };
  }
  return {};
}

