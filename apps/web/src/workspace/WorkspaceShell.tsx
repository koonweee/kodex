import "dockview/dist/styles/dockview.css";
import "../styles/workspace.css";

import { Alert, Center, Loader, Stack } from "@mantine/core";
import { useRef } from "react";
import type { DockviewApi } from "dockview";
import { WorkspaceSinglePaneHeader } from "./WorkspaceSinglePaneHeader";
import { focusWorkspaceDockPanel } from "./focusWorkspaceDockPanel";

import { WorkspaceDock } from "./WorkspaceDock";
import { useWorkspace } from "./WorkspaceProvider";

export function WorkspaceShell({ singlePane = false }: { singlePane?: boolean }) {
  const dockApi = useRef<DockviewApi | null>(null);
  const {
    clearPanePlacementHints,
    closePane,
    focusPane,
    isLoading,
    onVisiblePaneIdsChange,
    panePlacementHintsById,
    persistLayout,
    workspace,
    workspaceError,
  } = useWorkspace();

  if (isLoading) {
    return (
      <Center className="kodex-workspace-state" data-testid="workspace-loading">
        <Loader size="sm" />
      </Center>
    );
  }

  if (workspaceError || !workspace) {
    return (
      <Center className="kodex-workspace-state">
        <Alert color="red" title="Workspace unavailable">
          {workspaceError?.message ?? "The workspace could not be loaded."}
        </Alert>
      </Center>
    );
  }

  return (
    <Stack className="kodex-workspace-shell" data-single-pane={singlePane ? "true" : undefined} gap={0}>
      {singlePane ? <WorkspaceSinglePaneHeader onClosePane={(paneId, nextActivePaneId) => {
        const api = dockApi.current;
        const panel = api?.getPanel(paneId);
        if (!api || !panel) {
          closePane(paneId, null, { nextActivePaneId });
          return;
        }
        if (nextActivePaneId) focusWorkspaceDockPanel(api.getPanel(nextActivePaneId));
        api.removePanel(panel);
      }} /> : null}
      <WorkspaceDock
        singlePane={singlePane}
        onApiReady={api => { dockApi.current = api; }}
        onActivePaneChange={focusPane}
        onLayoutChange={persistLayout}
        onPanePlacementHintsConsumed={clearPanePlacementHints}
        onPaneClose={closePane}
        onVisiblePaneIdsChange={onVisiblePaneIdsChange}
        panePlacementHintsById={panePlacementHintsById}
        workspace={workspace}
      />
    </Stack>
  );
}
