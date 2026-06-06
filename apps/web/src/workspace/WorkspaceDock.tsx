import { Menu } from "@mantine/core";
import {
  DockviewDefaultTab,
  DockviewReact,
  themeAbyss,
  type DockviewApi,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanelProps,
} from "dockview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkspaceModel, WorkspacePane } from "./paneTypes";
import type { WorkspacePanePlacementDirection, WorkspacePanePlacementHintsById } from "./panePlacement";
import { paneTitle } from "./paneTypes";
import { WorkspacePaneRenderer } from "./paneRegistry";
import { useWorkspace } from "./WorkspaceProvider";
import { hasDockviewPanels, layoutMatchesWorkspacePanes } from "./workspaceLayoutCodec";

type DockviewPaneParams = {
  activePaneId: string | null;
  pane: WorkspacePane;
};

type WorkspaceDockProps = {
  onActivePaneChange: (paneId: string | null) => void;
  onLayoutChange: (layout: unknown, activePaneId: string | null) => void;
  onPaneClose: (paneId: string, layout: unknown) => void;
  onPanePlacementHintsConsumed?: (paneIds: string[]) => void;
  onVisiblePaneIdsChange?: (paneIds: string[]) => void;
  panePlacementHintsById?: WorkspacePanePlacementHintsById;
  workspace: WorkspaceModel;
};

export const kodexDockviewTheme = {
  ...themeAbyss,
  name: "kodex",
  className: `${themeAbyss.className} kodex-dockview-theme`,
  gap: 6,
  edgeGroupCollapsedSize: 34,
  dndOverlayMounting: "absolute",
  dndPanelOverlay: "group",
  dndTabIndicator: "line",
  dndOverlayBorder: "1px solid var(--kodex-border-accent-soft)",
  tabAnimation: "smooth",
  tabGroupIndicator: "none",
} satisfies DockviewTheme;

export function WorkspaceDock({
  onActivePaneChange,
  onLayoutChange,
  onPaneClose,
  onPanePlacementHintsConsumed,
  onVisiblePaneIdsChange,
  panePlacementHintsById = {},
  workspace,
}: WorkspaceDockProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const suppressEventsRef = useRef(false);
  const debounceRef = useRef<number | null>(null);
  const disposablesRef = useRef<Array<{ dispose: () => void }>>([]);

  const components = useMemo(
    () => ({
      workspacePane: WorkspaceDockPane,
    }),
    [],
  );

  const scheduleLayoutChange = useCallback(
    (api: DockviewApi) => {
      if (suppressEventsRef.current) {
        return;
      }
      const activePaneId = api.activePanel?.id ?? null;
      const livePanelIds = new Set(api.panels.map((panel) => panel.id));
      if (workspace.panes.some((pane) => !livePanelIds.has(pane.id))) {
        return;
      }
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(() => {
        onLayoutChange(api.toJSON(), activePaneId);
      }, 350);
    },
    [onLayoutChange, workspace.panes],
  );
  const reportVisiblePaneIds = useCallback(
    (api: DockviewApi) => {
      onVisiblePaneIdsChange?.(visibleDockviewPanelIds(api));
    },
    [onVisiblePaneIdsChange],
  );

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      syncWorkspaceIntoDockview(
        event.api,
        workspace,
        suppressEventsRef,
        onLayoutChange,
        panePlacementHintsById,
        onPanePlacementHintsConsumed,
      );
      reportVisiblePaneIds(event.api);
      disposablesRef.current = [
        event.api.onDidLayoutChange(() => {
          scheduleLayoutChange(event.api);
          reportVisiblePaneIds(event.api);
        }),
        event.api.onDidActivePanelChange((panel) => {
          if (!suppressEventsRef.current) {
            onActivePaneChange(panel?.id ?? null);
          }
          reportVisiblePaneIds(event.api);
        }),
        event.api.onDidRemovePanel((panel) => {
          if (!suppressEventsRef.current) {
            onPaneClose(panel.id, event.api.toJSON());
          }
          reportVisiblePaneIds(event.api);
        }),
        event.api.onDidAddPanel(() => reportVisiblePaneIds(event.api)),
        event.api.onDidAddGroup(() => reportVisiblePaneIds(event.api)),
        event.api.onDidRemoveGroup(() => reportVisiblePaneIds(event.api)),
        event.api.onDidMovePanel(() => reportVisiblePaneIds(event.api)),
      ];
    },
    [
      onActivePaneChange,
      onPaneClose,
      onPanePlacementHintsConsumed,
      panePlacementHintsById,
      reportVisiblePaneIds,
      scheduleLayoutChange,
      workspace,
    ],
  );

  useEffect(() => {
    const api = apiRef.current;
    if (api) {
      syncWorkspaceIntoDockview(
        api,
        workspace,
        suppressEventsRef,
        onLayoutChange,
        panePlacementHintsById,
        onPanePlacementHintsConsumed,
      );
      reportVisiblePaneIds(api);
    }
  }, [onLayoutChange, onPanePlacementHintsConsumed, panePlacementHintsById, reportVisiblePaneIds, workspace]);

  useEffect(
    () => () => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
      }
      for (const disposable of disposablesRef.current) {
        disposable.dispose();
      }
      disposablesRef.current = [];
    },
    [],
  );

  return (
    <div className="kodex-workspace-dock" data-testid="workspace-dock">
      <DockviewReact
        components={components}
        defaultTabComponent={WorkspaceDefaultTab}
        disableTabsOverflowList
        disableFloatingGroups
        leftHeaderActionsComponent={WorkspaceTabOverflowActions}
        onReady={handleReady}
        rightHeaderActionsComponent={WorkspaceRightHeaderActions}
        theme={kodexDockviewTheme}
      />
    </div>
  );
}

export function WorkspaceDefaultTab(props: IDockviewPanelHeaderProps<DockviewPaneParams>) {
  const { paneTabStatusById } = useWorkspace();
  const pane = props.params.pane;
  const terminalStatus = pane.kind === "terminal" ? paneTabStatusById[props.api.id] : undefined;
  const tabClassName = [
    "kodex-workspace-tab",
    pane.kind === "terminal" ? "kodex-workspace-terminal-tab" : null,
    terminalStatus ? `kodex-workspace-terminal-tab-${terminalStatus}` : null,
  ].filter(Boolean).join(" ");

  return <DockviewDefaultTab {...props} className={tabClassName} />;
}

export function WorkspaceRightHeaderActions({ activePanel }: IDockviewHeaderActionsProps) {
  const { paneHeaderActionsById } = useWorkspace();
  const actions = activePanel?.id ? paneHeaderActionsById[activePanel.id] : null;
  return (
    <div aria-label="Pane actions" className="kodex-workspace-pane-actions" role="toolbar">
      {actions}
    </div>
  );
}

export function WorkspaceTabOverflowActions({ activePanel, panels }: IDockviewHeaderActionsProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [overflowPanelIds, setOverflowPanelIds] = useState<string[]>([]);
  const measureOverflow = useCallback(() => {
    const root = rootRef.current;
    const header = root?.closest(".dv-tabs-and-actions-container");
    const tabsContainer = header?.querySelector<HTMLElement>(".dv-tabs-container");
    if (!tabsContainer) {
      setOverflowPanelIds([]);
      return;
    }
    const containerRect = tabsContainer.getBoundingClientRect();
    const tabElements = Array.from(tabsContainer.querySelectorAll<HTMLElement>(":scope > .dv-tab"));
    const nextIds = panels.flatMap((panel, index) => {
      const tabElement = tabElements[index];
      if (!tabElement) {
        return [];
      }
      const tabRect = tabElement.getBoundingClientRect();
      return tabRect.left < containerRect.left || tabRect.right > containerRect.right ? [panel.id] : [];
    });
    setOverflowPanelIds((current) =>
      current.length === nextIds.length && current.every((id, index) => id === nextIds[index])
        ? current
        : nextIds,
    );
  }, [panels]);

  useEffect(() => {
    const root = rootRef.current;
    const header = root?.closest(".dv-tabs-and-actions-container");
    const tabsContainer = header?.querySelector<HTMLElement>(".dv-tabs-container");
    const frame = window.requestAnimationFrame(measureOverflow);
    if (!header || !tabsContainer || typeof ResizeObserver === "undefined") {
      return () => window.cancelAnimationFrame(frame);
    }
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(tabsContainer);
    observer.observe(header);
    tabsContainer.addEventListener("scroll", measureOverflow, { passive: true });
    window.addEventListener("resize", measureOverflow);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      tabsContainer.removeEventListener("scroll", measureOverflow);
      window.removeEventListener("resize", measureOverflow);
    };
  }, [measureOverflow]);

  const overflowPanels = panels.filter((panel) => overflowPanelIds.includes(panel.id));
  return (
    <div className="kodex-workspace-tab-overflow" ref={rootRef}>
      {overflowPanels.length > 0 ? (
        <Menu position="bottom-start" withinPortal>
          <Menu.Target>
            <button aria-label="More tabs" className="kodex-workspace-tab-overflow-button" type="button">
              +{overflowPanels.length}
            </button>
          </Menu.Target>
          <Menu.Dropdown aria-label="More tabs" className="kodex-workspace-tab-overflow-menu">
            {overflowPanels.map((panel) => (
              <Menu.Item
                aria-current={panel.id === activePanel?.id ? "page" : undefined}
                className="kodex-workspace-tab-overflow-item"
                key={panel.id}
                onClick={() => {
                  panel.focus();
                }}
              >
                {panel.title ?? panel.id}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      ) : null}
    </div>
  );
}

export function visibleDockviewPanelIds(api: Pick<DockviewApi, "groups" | "activePanel">): string[] {
  const panelIds = new Set<string>();
  for (const group of api.groups) {
    const panelId = group.activePanel?.id;
    if (panelId) {
      panelIds.add(panelId);
    }
  }
  if (panelIds.size === 0 && api.activePanel?.id) {
    panelIds.add(api.activePanel.id);
  }
  return Array.from(panelIds);
}

function WorkspaceDockPane({ params }: IDockviewPanelProps<DockviewPaneParams>) {
  const { focusPulseByPaneId } = useWorkspace();
  const focusPulseToken = focusPulseByPaneId[params.pane.id] ?? 0;
  return (
    <div className="kodex-workspace-pane-host" data-pane-kind={params.pane.kind}>
      <WorkspacePaneRenderer
        key={params.pane.id}
        pane={params.pane}
        isActive={params.activePaneId === params.pane.id}
      />
      {focusPulseToken ? (
        <span
          aria-hidden="true"
          className="kodex-workspace-pane-focus-pulse"
          key={focusPulseToken}
        />
      ) : null}
    </div>
  );
}

export function syncWorkspaceIntoDockview(
  api: DockviewApi,
  workspace: WorkspaceModel,
  suppressEventsRef: { current: boolean },
  onReconciledLayout?: (layout: unknown, activePaneId: string | null) => void,
  panePlacementHintsById: WorkspacePanePlacementHintsById = {},
  onPanePlacementHintsConsumed?: (paneIds: string[]) => void,
) {
  suppressEventsRef.current = true;
  let shouldPersistLiveLayout = false;
  const consumedPlacementHintIds = new Set<string>();
  try {
    if (canReconcileWorkspacePanelsInPlace(api, workspace)) {
      shouldPersistLiveLayout = reconcileWorkspacePanelsInPlace(
        api,
        workspace,
        panePlacementHintsById,
        consumedPlacementHintIds,
      );
      return;
    }
    const shouldHydrateSavedLayout =
      workspace.panes.length > 1 &&
      hasDockviewPanels(workspace.dockviewLayout) &&
      layoutMatchesWorkspacePanes(workspace.dockviewLayout, workspace.panes) &&
      (api.panels.length === 0 || livePanelDescriptorsMatchWorkspace(api, workspace));
    api.clear();
    if (shouldHydrateSavedLayout) {
      api.fromJSON(workspace.dockviewLayout as unknown as Parameters<DockviewApi["fromJSON"]>[0], { reuseExistingPanels: false });
      for (const pane of workspace.panes) {
        api.getPanel(pane.id)?.update({
          params: { pane, activePaneId: workspace.activePaneId ?? null },
        });
      }
    } else {
      addWorkspacePanels(api, workspace, panePlacementHintsById, consumedPlacementHintIds);
    }
    if (workspace.activePaneId) {
      api.getPanel(workspace.activePaneId)?.focus();
    }
  } catch {
    api.clear();
    addWorkspacePanels(api, workspace, panePlacementHintsById, consumedPlacementHintIds);
  } finally {
    window.setTimeout(() => {
      suppressEventsRef.current = false;
      if (consumedPlacementHintIds.size > 0) {
        onPanePlacementHintsConsumed?.([...consumedPlacementHintIds]);
      }
      if (shouldPersistLiveLayout) {
        onReconciledLayout?.(api.toJSON(), api.activePanel?.id ?? workspace.activePaneId ?? null);
      }
    }, 0);
  }
}

function canReconcileWorkspacePanelsInPlace(api: DockviewApi, workspace: WorkspaceModel) {
  if (api.panels.length === 0 || workspace.panes.length === 0) {
    return false;
  }
  const workspacePaneIds = new Set(workspace.panes.map((pane) => pane.id));
  return api.panels.some((panel) => workspacePaneIds.has(panel.id));
}

function livePanelDescriptorsMatchWorkspace(api: DockviewApi, workspace: WorkspaceModel) {
  return workspace.panes.every((pane) => {
    const panelPane = (api.getPanel(pane.id)?.params as DockviewPaneParams | undefined)?.pane;
    return Boolean(panelPane) && stableJsonKey(panelPane) === stableJsonKey(pane);
  });
}

function reconcileWorkspacePanelsInPlace(
  api: DockviewApi,
  workspace: WorkspaceModel,
  panePlacementHintsById: WorkspacePanePlacementHintsById,
  consumedPlacementHintIds: Set<string>,
) {
  let layoutChanged = false;
  const workspacePaneIds = new Set(workspace.panes.map((pane) => pane.id));
  for (const panel of [...api.panels]) {
    if (!workspacePaneIds.has(panel.id)) {
      api.removePanel(panel);
      layoutChanged = true;
    }
  }

  for (const pane of workspace.panes) {
    const panel = api.getPanel(pane.id);
    if (!panel) {
      continue;
    }
    const activePaneId = workspace.activePaneId ?? null;
    if (!panelParamsMatch(panel.params, pane, activePaneId)) {
      panel.update({ params: { pane, activePaneId } });
    }
    const nextTitle = paneTitle(pane);
    if (panel.title !== nextTitle) {
      panel.setTitle(nextTitle);
    }
  }

  const firstPane = workspace.panes.find((pane) => api.getPanel(pane.id)) ?? workspace.panes[0] ?? null;
  for (const pane of workspace.panes) {
    if (api.getPanel(pane.id)) {
      continue;
    }
    api.addPanel<DockviewPaneParams>({
      id: pane.id,
      component: "workspacePane",
      title: paneTitle(pane),
      params: { pane, activePaneId: workspace.activePaneId ?? null },
      ...panelPlacementOptions(api, pane, firstPane, panePlacementHintsById, consumedPlacementHintIds),
    });
    layoutChanged = true;
  }

  if (workspace.activePaneId) {
    api.getPanel(workspace.activePaneId)?.focus();
  }
  return layoutChanged;
}

function addWorkspacePanels(
  api: DockviewApi,
  workspace: WorkspaceModel,
  panePlacementHintsById: WorkspacePanePlacementHintsById = {},
  consumedPlacementHintIds: Set<string> = new Set(),
) {
  const [firstPane] = workspace.panes;
  for (const [index, pane] of workspace.panes.entries()) {
    api.addPanel<DockviewPaneParams>({
      id: pane.id,
      component: "workspacePane",
      title: paneTitle(pane),
      params: { pane, activePaneId: workspace.activePaneId ?? null },
      ...(index > 0
        ? panelPlacementOptions(api, pane, firstPane ?? null, panePlacementHintsById, consumedPlacementHintIds)
        : {}),
    });
  }
}

function panelPlacementOptions(
  api: DockviewApi,
  pane: WorkspacePane,
  fallbackReferencePane: WorkspacePane | null,
  panePlacementHintsById: WorkspacePanePlacementHintsById,
  consumedPlacementHintIds: Set<string>,
): { floating: false; position: { direction: WorkspacePanePlacementDirection; referencePanel: string } } | Record<string, never> {
  const hint = panePlacementHintsById[pane.id];
  if (hint) {
    consumedPlacementHintIds.add(pane.id);
    if (api.getPanel(hint.referencePaneId)) {
      return {
        floating: false,
        position: { referencePanel: hint.referencePaneId, direction: hint.direction },
      };
    }
  }
  if (fallbackReferencePane && api.getPanel(fallbackReferencePane.id)) {
    return {
      floating: false,
      position: { referencePanel: fallbackReferencePane.id, direction: "right" },
    };
  }
  return {};
}

function stableJsonKey(value: unknown): string {
  return JSON.stringify(value);
}

function panelParamsMatch(params: unknown, pane: WorkspacePane, activePaneId: string | null): boolean {
  const current = params as DockviewPaneParams | undefined;
  return current?.activePaneId === activePaneId && stableJsonKey(current?.pane) === stableJsonKey(pane);
}
