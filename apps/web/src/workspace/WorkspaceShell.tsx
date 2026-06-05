import "dockview/dist/styles/dockview.css";
import "../styles/workspace.css";

import { Alert, Center, Loader, Stack, Text } from "@mantine/core";

import { WorkspaceDock } from "./WorkspaceDock";
import { useWorkspace } from "./WorkspaceProvider";
import { workspaceSubscribedThreadIds } from "./resourceSubscriptions";

export function WorkspaceShell() {
  const { closePane, focusPane, isLoading, persistLayout, workspace, workspaceError } = useWorkspace();

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

  const subscribedThreadIds = workspaceSubscribedThreadIds(workspace.panes);

  return (
    <Stack className="kodex-workspace-shell" gap={0}>
      <div className="kodex-workspace-toolbar" aria-label="Workspace panes">
        <Text c="dimmed" size="xs">
          {workspace.panes.length} panes · {subscribedThreadIds.length} thread subscriptions
        </Text>
      </div>
      <WorkspaceDock
        onActivePaneChange={focusPane}
        onLayoutChange={persistLayout}
        onPaneClose={closePane}
        workspace={workspace}
      />
    </Stack>
  );
}
