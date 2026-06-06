import "dockview/dist/styles/dockview.css";
import "../styles/workspace.css";

import { Alert, Center, Loader, Stack } from "@mantine/core";

import { WorkspaceDock } from "./WorkspaceDock";
import { useWorkspace } from "./WorkspaceProvider";

export function WorkspaceShell() {
  const {
    clearPanePlacementHints,
    closePane,
    focusPane,
    isLoading,
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
    <Stack className="kodex-workspace-shell" gap={0}>
      <WorkspaceDock
        onActivePaneChange={focusPane}
        onLayoutChange={persistLayout}
        onPanePlacementHintsConsumed={clearPanePlacementHints}
        onPaneClose={closePane}
        panePlacementHintsById={panePlacementHintsById}
        workspace={workspace}
      />
    </Stack>
  );
}
