import "../styles/workspace.css";

import { ActionIcon, Alert, Button, Center, Drawer, Group, Loader, Stack, Text } from "@mantine/core";
import { Check, PanelLeftOpen, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
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
  const [paneManagerOpened, setPaneManagerOpened] = useState(false);
  const activePane = useMemo(() => {
    if (workspace.activePaneId) {
      return workspace.panes.find((pane) => pane.id === workspace.activePaneId) ?? workspace.panes[0] ?? null;
    }
    return workspace.panes[0] ?? null;
  }, [workspace.activePaneId, workspace.panes]);
  const activePaneTitle = activePane ? paneTitle(activePane) : "Workspace";
  const activePaneAdornment = activePane ? paneHeaderAdornmentsById[activePane.id] ?? null : null;
  const activePaneActions = activePane ? paneHeaderActionsById[activePane.id] : null;
  const recentPanes = useMemo(() => [...workspace.panes].reverse(), [workspace.panes]);
  const focusPulseToken = activePane ? focusPulseByPaneId[activePane.id] ?? 0 : 0;
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
  const closeWorkspacePane = (paneId: string) => {
    closePane(paneId, null, { nextActivePaneId: paneId === activePane?.id ? nextActivePaneId : null });
  };

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
        <AdaptiveIconButton
          className="kodex-workspace-single-pane-sidebar-button"
          label="Show sidebar"
          onClick={onShowMobileSidebar}

        >
          <PanelLeftOpen />
        </AdaptiveIconButton>
        <div className="kodex-workspace-single-pane-switcher">
          <Button
            aria-expanded={paneManagerOpened}
            aria-haspopup="dialog"
            aria-label="Switch workspace pane"
            className="kodex-workspace-single-pane-switcher-button"
            onClick={() => setPaneManagerOpened(true)}
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
          <Drawer.Root
            className="kodex-workspace-pane-manager"
            opened={paneManagerOpened}
            onClose={() => setPaneManagerOpened(false)}
            position="top"
            size="auto"
            trapFocus={false}
            transitionProps={{ duration: 0 }}
          >
            <Drawer.Overlay opacity={0.38} />
            <Drawer.Content aria-label="Active panes">
              <Drawer.Body>
                <Stack className="kodex-workspace-pane-manager-list" gap={4}>
                  {recentPanes.map((pane) => {
                    const title = paneTitle(pane);
                    const isActivePane = pane.id === activePane.id;
                    return (
                      <Group
                        align="center"
                        className="kodex-workspace-pane-manager-row"
                        data-active={isActivePane ? "true" : undefined}
                        gap={6}
                        key={pane.id}
                        wrap="nowrap"
                      >
                        <Button
                          aria-current={isActivePane ? "page" : undefined}
                          className="kodex-workspace-pane-manager-title-button"
                          onClick={() => {
                            focusPane(pane.id);
                            setPaneManagerOpened(false);
                          }}
                          size="compact-md"
                          title={title}
                          type="button"
                          variant="subtle"
                        >
                          <Text className="kodex-workspace-pane-manager-title-text" component="span" truncate>
                            {title}
                          </Text>
                          {isActivePane ? (
                            <span aria-hidden="true" className="kodex-workspace-pane-manager-active-icon">
                              <Check size={16} strokeWidth={2.4} />
                            </span>
                          ) : null}
                        </Button>
                        <ActionIcon
                          aria-label={`Close pane ${title}`}
                          className="kodex-workspace-pane-manager-close-button"
                          onClick={() => closeWorkspacePane(pane.id)}
                          size="lg"
                          type="button"
                          variant="subtle"
                        >
                          <X size={18} />
                        </ActionIcon>
                      </Group>
                    );
                  })}
                </Stack>
              </Drawer.Body>
            </Drawer.Content>
          </Drawer.Root>
        </div>
        <div aria-label="Pane actions" className="kodex-workspace-pane-actions" role="toolbar">
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
