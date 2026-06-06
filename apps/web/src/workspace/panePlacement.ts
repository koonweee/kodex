import type { WorkspaceModel } from "./paneTypes";

export type WorkspacePaneSplitDirection = "above" | "below" | "left" | "right";

export type WorkspacePanePlacementHint = {
  direction: WorkspacePaneSplitDirection;
  referencePaneId: string;
};

export type WorkspacePanePlacementIntent = "draftThread" | "duplicate" | "generatedUi" | "terminal" | "thread";

export type WorkspacePanePlacementOptions = {
  direction?: WorkspacePaneSplitDirection;
  sourcePaneId?: string | null;
};

export type WorkspacePaneOpenOptions = {
  duplicate?: boolean;
  placement?: WorkspacePanePlacementOptions;
};

export type WorkspacePanePlacementHintsById = Record<string, WorkspacePanePlacementHint>;

export function resolvePanePlacementHint(
  workspace: WorkspaceModel,
  intent: WorkspacePanePlacementIntent,
  options: WorkspacePanePlacementOptions = {},
): WorkspacePanePlacementHint | null {
  const referencePaneId = validPaneId(workspace, options.sourcePaneId)
    ?? validPaneId(workspace, workspace.activePaneId)
    ?? workspace.panes[0]?.id
    ?? null;
  if (!referencePaneId) {
    return null;
  }
  return {
    direction: options.direction ?? defaultDirectionForIntent(intent),
    referencePaneId,
  };
}

function defaultDirectionForIntent(intent: WorkspacePanePlacementIntent): WorkspacePaneSplitDirection {
  return intent === "terminal" ? "below" : "right";
}

function validPaneId(workspace: WorkspaceModel, paneId: string | null | undefined): string | null {
  return paneId && workspace.panes.some((pane) => pane.id === paneId) ? paneId : null;
}
