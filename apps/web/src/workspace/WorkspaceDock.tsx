import { WorkspaceRightHeaderActions } from "./WorkspaceRightHeaderActions";
import { WorkspaceDefaultTab } from "./WorkspaceDefaultTab";
import { WorkspaceTabOverflowActions } from "./WorkspaceTabOverflowActions";
import {
  DockviewReact,
  themeAbyss,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
  type BuiltInContextMenuItem,
  type ReactContextMenuItemConfig,
  type IDockviewPanelProps,
} from "dockview";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { applyResponsiveWorkspaceMode, serializeWorkspaceDock, type ResponsiveDockviewSession } from "./responsiveDockview";
import { panelPlacementOptions } from "./autoPanelPlacement";
import { focusWorkspaceDockPanel } from "./focusWorkspaceDockPanel";
import type { WorkspaceModel, WorkspacePane } from "./paneTypes";
import type { WorkspacePaneOpenOptions, WorkspacePanePlacementHintsById } from "./panePlacement";
import { paneTitle } from "./paneTypes";
import { WorkspacePaneRenderer } from "./paneRegistry";
import { useWorkspace } from "./WorkspaceProvider";
import { hasDockviewPanels, layoutMatchesWorkspacePanes } from "./workspaceLayoutCodec";

type DockviewPaneParams = {
  activePaneId: string | null;
  pane: WorkspacePane;
};

type WorkspaceDockProps = {
  singlePane?: boolean;
  onApiReady?: (api: DockviewApi) => void;
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
  gap: 1,
  edgeGroupCollapsedSize: 34,
  dndOverlayMounting: "absolute",
  dndPanelOverlay: "group",
  dndTabIndicator: "line",
  dndOverlayBorder: "1px solid var(--kodex-border-accent-soft)",
  tabAnimation: "smooth",
  tabGroupIndicator: "none",
} satisfies DockviewTheme;

export function WorkspaceDock({
  singlePane = false,
  onApiReady,
  onActivePaneChange,
  onLayoutChange,
  onPaneClose,
  onPanePlacementHintsConsumed,
  onVisiblePaneIdsChange,
  panePlacementHintsById = {},
  workspace,
}: WorkspaceDockProps) {
  const { openDraftThreadPane, paneThreadContextsById, threadProjectIdsById } = useWorkspace();
  const apiRef = useRef<DockviewApi | null>(null);
  const suppressEventsRef = useRef(false);
  const singlePaneRef = useRef(singlePane);
  singlePaneRef.current = singlePane;
  const responsiveSession = useRef<ResponsiveDockviewSession>({ active: false, previousMaximizedPanelId: null });
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
      if (suppressEventsRef.current || singlePaneRef.current) {
        return;
      }
      const livePanelIds = new Set(api.panels.map((panel) => panel.id));
      if (workspace.panes.some((pane) => !livePanelIds.has(pane.id))) {
        return;
      }
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(() => {
        onLayoutChange(serializeWorkspaceDock(api, responsiveSession.current), api.activePanel?.id ?? null);
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
      onApiReady?.(event.api);
      syncWorkspaceIntoDockview(
        event.api,
        workspace,
        suppressEventsRef,
        (_layout, activePaneId) => onLayoutChange(serializeWorkspaceDock(event.api, responsiveSession.current), activePaneId),
        panePlacementHintsById,
        onPanePlacementHintsConsumed,
      );
      applyResponsiveWorkspaceMode(event.api, singlePaneRef.current, responsiveSession.current);
      reportVisiblePaneIds(event.api);
      disposablesRef.current = [
        event.api.onDidLayoutChange(() => {
          scheduleLayoutChange(event.api);
          reportVisiblePaneIds(event.api);
        }),
        event.api.onDidActivePanelChange((panel) => {
          applyResponsiveWorkspaceMode(event.api, singlePaneRef.current, responsiveSession.current);
          if (!suppressEventsRef.current) {
            onActivePaneChange(panel?.id ?? null);
          }
          reportVisiblePaneIds(event.api);
        }),
        event.api.onDidRemovePanel((panel) => {
          if (!suppressEventsRef.current) {
            onPaneClose(panel.id, serializeWorkspaceDock(event.api, responsiveSession.current));
          }
          reportVisiblePaneIds(event.api);
        }),
        event.api.onDidAddPanel(() => reportVisiblePaneIds(event.api)),
        event.api.onDidAddGroup(() => reportVisiblePaneIds(event.api)),
        event.api.onDidRemoveGroup(() => reportVisiblePaneIds(event.api)),
        event.api.onDidMovePanel(() => reportVisiblePaneIds(event.api)),
        event.api.onDidMaximizedGroupChange(() => reportVisiblePaneIds(event.api)),
      ];
    },
    [
      onActivePaneChange,
      onApiReady,
      onPaneClose,
      onPanePlacementHintsConsumed,
      panePlacementHintsById,
      reportVisiblePaneIds,
      scheduleLayoutChange,
      workspace,
    ],
  );
  const getTabContextMenuItems = useCallback(
    ({ panel }: { panel: { id: string; params?: unknown } }) => {
      const params = panel.params as DockviewPaneParams | undefined;
      if (!params?.pane) {
        return [];
      }
      return workspaceTabContextMenuItems({
        openDraftThreadPane,
        panelId: panel.id,
        pane: params.pane,
        threadProjectIdsById,
        loadedProjectId: paneThreadContextsById[params.pane.id] ? paneThreadContextsById[params.pane.id].projectId ?? null : undefined,
      });
    },
    [openDraftThreadPane, paneThreadContextsById, threadProjectIdsById],
  );

  useEffect(() => {
    const api = apiRef.current;
    if (api) {
      syncWorkspaceIntoDockview(
        api,
        workspace,
        suppressEventsRef,
        (_layout, activePaneId) => onLayoutChange(serializeWorkspaceDock(api, responsiveSession.current), activePaneId),
        panePlacementHintsById,
        onPanePlacementHintsConsumed,
      );
      applyResponsiveWorkspaceMode(api, singlePaneRef.current, responsiveSession.current);
      reportVisiblePaneIds(api);
    }
  }, [onLayoutChange, onPanePlacementHintsConsumed, panePlacementHintsById, reportVisiblePaneIds, workspace]);

  useLayoutEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    applyResponsiveWorkspaceMode(api, singlePane, responsiveSession.current);
    reportVisiblePaneIds(api);
  }, [singlePane, reportVisiblePaneIds]);

  useEffect(
    () => () => {
      apiRef.current = null;
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
        disableDnd={singlePane}
        locked={singlePane}
        disableFloatingGroups
        getTabContextMenuItems={getTabContextMenuItems}
        leftHeaderActionsComponent={singlePane ? undefined : WorkspaceTabOverflowActions}
        onReady={handleReady}
        rightHeaderActionsComponent={singlePane ? undefined : WorkspaceRightHeaderActions}
        theme={kodexDockviewTheme}
      />
    </div>
  );
}

export function workspaceTabContextMenuItems({
  openDraftThreadPane,
  panelId,
  pane,
  threadProjectIdsById,
  loadedProjectId,
}: {
  openDraftThreadPane: (projectId?: string | null, options?: WorkspacePaneOpenOptions) => Promise<void>;
  panelId: string;
  pane: WorkspacePane;
  threadProjectIdsById: Record<string, string>;
  loadedProjectId?: string | null;
}): Array<BuiltInContextMenuItem | ReactContextMenuItemConfig> {
  const projectId = loadedProjectId === undefined ? projectIdForWorkspacePane(pane, threadProjectIdsById) : loadedProjectId;
  if (!projectId) {
    return [];
  }
  return [
    {
      label: "New chat in project",
      action: () => {
        void openDraftThreadPane(projectId, {
          duplicate: true,
          placement: { direction: "within", sourcePaneId: panelId },
        });
      },
    },
  ];
}

function projectIdForWorkspacePane(pane: WorkspacePane, threadProjectIdsById: Record<string, string>): string | null {
  if (pane.kind !== "thread") {
    return null;
  }
  if (pane.target.mode === "draft") {
    return typeof pane.target.projectId === "string" && pane.target.projectId.length > 0 ? pane.target.projectId : null;
  }
  return threadProjectIdsById[pane.target.threadId] ?? null;
}

export function visibleDockviewPanelIds(api: Pick<DockviewApi, "groups" | "activePanel">): string[] {
  const panelIds = new Set<string>();
  for (const group of api.groups) {
    if (group.api?.isVisible === false) continue;
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
      // Attached thread viewports preserve virtualized scroll state across tab switches.
      for (const pane of workspace.panes) {
        api.getPanel(pane.id)?.api.setRenderer(pane.kind === "thread" ? "always" : "onlyWhenVisible");
        api.getPanel(pane.id)?.update({
          params: { pane, activePaneId: workspace.activePaneId ?? null },
        });
      }
    } else {
      addWorkspacePanels(api, workspace, panePlacementHintsById, consumedPlacementHintIds);
    }
    if (workspace.activePaneId) {
      focusWorkspaceDockPanel(api.getPanel(workspace.activePaneId));
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
      renderer: pane.kind === "thread" ? "always" : "onlyWhenVisible",
      title: paneTitle(pane),
      params: { pane, activePaneId: workspace.activePaneId ?? null },
      ...panelPlacementOptions(api, pane, firstPane, panePlacementHintsById, consumedPlacementHintIds, kodexDockviewTheme.gap),
    });
    layoutChanged = true;
  }

  if (workspace.activePaneId) {
    focusWorkspaceDockPanel(api.getPanel(workspace.activePaneId));
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
      renderer: pane.kind === "thread" ? "always" : "onlyWhenVisible",
      title: paneTitle(pane),
      params: { pane, activePaneId: workspace.activePaneId ?? null },
      ...(index > 0
        ? panelPlacementOptions(api, pane, firstPane ?? null, panePlacementHintsById, consumedPlacementHintIds, kodexDockviewTheme.gap)
        : {}),
    });
  }
}

function stableJsonKey(value: unknown): string {
  return JSON.stringify(value);
}

function panelParamsMatch(params: unknown, pane: WorkspacePane, activePaneId: string | null): boolean {
  const current = params as DockviewPaneParams | undefined;
  return current?.activePaneId === activePaneId && stableJsonKey(current?.pane) === stableJsonKey(pane);
}
