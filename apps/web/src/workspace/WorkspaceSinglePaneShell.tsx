import "../styles/workspace.css";

import { ActionIcon, Alert, Button, Center, Group, Loader, Menu, Stack, Text } from "@mantine/core";
import { PanelLeftOpen, X } from "lucide-react";
import { useEffect, useMemo } from "react";

import { paneTitle } from "./paneTypes";
import { WorkspacePaneRenderer } from "./paneRegistry";
import { useWorkspace } from "./WorkspaceProvider";

export function WorkspaceSinglePaneShell() {
  const {
    closePane,
    focusPane,
    isLoading,
    onShowMobileSidebar,
    onVisiblePaneIdsChange,
    focusPulseByPaneId,
    paneHeaderAdornmentsById,
    paneHeaderActionsById,
    workspace,
    workspaceError,
  } = useWorkspace();
  const activePane = useMemo(() => {
    if (workspace.activePaneId) {
      return workspace.panes.find((pane) => pane.id === workspace.activePaneId) ?? workspace.panes[0] ?? null;
    }
    return workspace.panes[0] ?? null;
  }, [workspace.activePaneId, workspace.panes]);
  const activePaneTitle = activePane ? paneTitle(activePane) : "Workspace";
  const activePaneAdornment = activePane ? paneHeaderAdornmentsById[activePane.id] ?? null : null;
  const activePaneActions = activePane ? paneHeaderActionsById[activePane.id] : null;
  const focusPulseToken = activePane ? focusPulseByPaneId[activePane.id] ?? 0 : 0;
  const isOnlyDefaultDraftPane =
    workspace.panes.length === 1 &&
    activePane?.kind === "thread" &&
    activePane.target.mode === "draft" &&
    !activePane.target.projectId &&
    activePane.title === "New chat";
  const canCloseActivePane = Boolean(activePane && !isOnlyDefaultDraftPane);
  const nextActivePaneId = useMemo(() => {
    if (!activePane) {
      return null;
    }
    const activeIndex = workspace.panes.findIndex((pane) => pane.id === activePane.id);
    if (activeIndex < 0) {
      return null;
    }
    return workspace.panes[activeIndex + 1]?.id ?? workspace.panes[activeIndex - 1]?.id ?? null;
  }, [activePane?.id, workspace.panes]);

  useEffect(() => {
    onVisiblePaneIdsChange(activePane ? [activePane.id] : []);
    return () => onVisiblePaneIdsChange([]);
  }, [activePane?.id, onVisiblePaneIdsChange]);

  if (isLoading) {
    return (
      <Center className="kodex-workspace-state" data-testid="workspace-loading">
        <Loader size="sm" />
      </Center>
    );
  }

  if (workspaceError || !activePane) {
    return (
      <Center className="kodex-workspace-state">
        <Alert color="red" title="Workspace unavailable">
          {workspaceError?.message ?? "The workspace could not be loaded."}
        </Alert>
      </Center>
    );
  }

  return (
    <Stack className="kodex-workspace-single-pane-shell" data-testid="workspace-single-pane-shell" gap={0}>
      <Group className="kodex-workspace-single-pane-header" gap={6} wrap="nowrap">
        <ActionIcon
          aria-label="Show sidebar"
          className="kodex-workspace-single-pane-sidebar-button"
          onClick={onShowMobileSidebar}
          type="button"
          variant="subtle"
        >
          <PanelLeftOpen size={17} />
        </ActionIcon>
        <div className="kodex-workspace-single-pane-switcher">
          <Menu position="bottom-start" withinPortal>
            <Menu.Target>
              <Button
                aria-label="Switch workspace pane"
                className="kodex-workspace-single-pane-switcher-button"
                size="compact-sm"
                type="button"
                variant="subtle"
              >
                <span className="kodex-workspace-single-pane-title">
                  <Text className="kodex-workspace-single-pane-title-text" component="span" truncate>
                    {activePaneTitle}
                  </Text>
                  {activePaneAdornment ? (
                    <span
                      aria-label="Pane syncing"
                      className="kodex-workspace-pane-title-adornment"
                      role="status"
                      title="Pane syncing"
                    >
                      {activePaneAdornment}
                    </span>
                  ) : null}
                </span>
              </Button>
            </Menu.Target>
            <Menu.Dropdown aria-label="Workspace panes" className="kodex-workspace-single-pane-menu">
              {workspace.panes.map((pane) => (
                <Menu.Item
                  aria-current={pane.id === activePane.id ? "page" : undefined}
                  key={pane.id}
                  onClick={() => focusPane(pane.id)}
                >
                  {paneTitle(pane)}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        </div>
        <div aria-label="Pane actions" className="kodex-workspace-pane-actions" role="toolbar">
          {canCloseActivePane ? (
            <ActionIcon
              aria-label="Close pane"
              className="kodex-workspace-single-pane-close-button"
              onClick={() => closePane(activePane.id, null, { nextActivePaneId })}
              type="button"
              variant="subtle"
            >
              <X size={14} />
            </ActionIcon>
          ) : null}
          {activePaneActions}
        </div>
      </Group>
      <div className="kodex-workspace-pane-host kodex-workspace-single-pane-host" data-pane-kind={activePane.kind}>
        <WorkspacePaneRenderer key={activePane.id} pane={activePane} isActive />
        {focusPulseToken ? (
          <span
            aria-hidden="true"
            className="kodex-workspace-pane-focus-pulse"
            key={focusPulseToken}
          />
        ) : null}
      </div>
    </Stack>
  );
}
