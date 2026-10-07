import { Orientation, type DockviewApi, type IDockviewGroupPanel, type SerializedDockview } from "dockview";
import type { WorkspacePanePlacementDirection, WorkspacePanePlacementHintsById } from "./panePlacement";
import type { WorkspacePane } from "./paneTypes";

// Soft placement targets, not resize constraints. Capacity follows workspace size.
const MIN_PANE_WIDTH = 300;
const MIN_PANE_HEIGHT = 320;

type Position = { direction: "right" } | { referencePanel: string; direction: WorkspacePanePlacementDirection };
type GridNode = SerializedDockview["grid"]["root"];

export function autoPanelPlacement(api: DockviewApi, gap: number): Position {
  const { root, orientation } = api.toJSON().grid;
  const groups = new Map(api.groups
    .filter(group => group.api.location.type === "grid" && group.api.isVisible)
    .map(group => [group.id, group]));
  // The root's horizontal children are columns. A vertical root is one column.
  const nodes = orientation === Orientation.HORIZONTAL && Array.isArray(root.data)
    ? root.data : [root];
  const columns = nodes.filter(node => node.visible !== false)
    .map(node => ({ node, groups: leafGroups(node, groups) }))
    .filter(column => column.groups.length > 0);
  const last = columns.at(-1)?.groups.at(-1)?.activePanel;
  if (!last) return { direction: "right" };

  // Dockview redistributes root columns. Simple vertical stacks remain readable;
  // custom horizontal nesting could shrink inner columns, so leave it alone.
  const simpleColumns = columns.every(({ node }) => !Array.isArray(node.data)
    || node.data.every(child => child.type === "leaf"));
  const width = columns.reduce((sum, column) => sum + Math.min(...column.groups.map(group => group.api.width)), 0);
  if (simpleColumns && (width - gap) / (columns.length + 1) >= MIN_PANE_WIDTH
    && columns.every(column => column.groups.every(group => group.api.height >= MIN_PANE_HEIGHT))) {
    return { direction: "right" };
  }

  // Fill the second row in a fixed right-to-left order. Never split an existing
  // row again, or skip a too-small column to seek spare room somewhere else.
  // Closing other rows can leave a branch wrapper around the sole group.
  const next = [...columns].reverse().find(column => column.groups.length === 1);
  const target = next?.groups[0];
  if (target?.activePanel && target.api.width >= MIN_PANE_WIDTH && target.api.height >= MIN_PANE_HEIGHT * 2 + gap) {
    return { referencePanel: target.activePanel.id, direction: "below" };
  }
  return { referencePanel: last.id, direction: "within" };
}

function leafGroups(node: GridNode, groups: Map<string, IDockviewGroupPanel>): IDockviewGroupPanel[] {
  if (node.visible === false) return [];
  if (Array.isArray(node.data)) return node.data.flatMap(child => leafGroups(child, groups));
  const group = groups.get(node.data.id);
  return group ? [group] : [];
}

export function panelPlacementOptions(
  api: DockviewApi,
  pane: WorkspacePane,
  fallbackReferencePane: WorkspacePane | null,
  panePlacementHintsById: WorkspacePanePlacementHintsById,
  consumedPlacementHintIds: Set<string>,
  gap: number,
): { floating: false; position: Position } | Record<string, never> {
  const hint = panePlacementHintsById[pane.id];
  if (hint) {
    consumedPlacementHintIds.add(pane.id);
    if (hint.direction === "auto" || api.getPanel(hint.referencePaneId)) {
      return {
        floating: false,
        position: hint.direction === "auto"
          ? autoPanelPlacement(api, gap)
          : { referencePanel: hint.referencePaneId, direction: hint.direction },
      };
    }
  }
  if (fallbackReferencePane && api.getPanel(fallbackReferencePane.id)) {
    return {
      floating: false,
      position: autoPanelPlacement(api, gap),
    };
  }
  return {};
}
