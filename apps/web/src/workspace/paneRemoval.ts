import { createDraftThreadPane } from "./paneStore";
import type { WorkspaceModel, WorkspacePane } from "./paneTypes";
import { layoutMatchesWorkspacePanes } from "./workspaceLayoutCodec";

type WorkspacePaneRemovalOptions = {
  dockviewLayout?: unknown;
  nextActivePaneId?: string | null;
};

export function removeWorkspacePanes(
  current: WorkspaceModel,
  shouldRemove: (pane: WorkspacePane) => boolean,
  options: WorkspacePaneRemovalOptions = {},
): WorkspaceModel {
  const closingPaneIds = new Set(current.panes.filter(shouldRemove).map((pane) => pane.id));
  if (closingPaneIds.size === 0) {
    return current;
  }

  const remainingPanes = current.panes.filter((pane) => !closingPaneIds.has(pane.id));
  const panes = remainingPanes.length > 0 ? remainingPanes : [createDraftThreadPane()];
  const preferredActivePaneId =
    options.nextActivePaneId && panes.some((pane) => pane.id === options.nextActivePaneId)
      ? options.nextActivePaneId
      : null;
  let activePaneId = current.activePaneId;

  if (activePaneId && closingPaneIds.has(activePaneId)) {
    const activeIndex = current.panes.findIndex((pane) => pane.id === activePaneId);
    const nearestPane =
      current.panes.slice(activeIndex + 1).find((pane) => !closingPaneIds.has(pane.id)) ??
      current.panes.slice(0, activeIndex).reverse().find((pane) => !closingPaneIds.has(pane.id));
    activePaneId = preferredActivePaneId ?? nearestPane?.id ?? panes[0]?.id ?? null;
  } else if (!panes.some((pane) => pane.id === activePaneId)) {
    activePaneId = preferredActivePaneId ?? panes[0]?.id ?? null;
  }

  const candidateLayout = options.dockviewLayout === undefined
    ? current.dockviewLayout
    : options.dockviewLayout;
  return {
    ...current,
    activePaneId,
    dockviewLayout: layoutMatchesWorkspacePanes(candidateLayout, panes) ? candidateLayout : null,
    panes,
  };
}
