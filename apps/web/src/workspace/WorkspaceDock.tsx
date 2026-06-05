import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { WorkspaceModel, WorkspacePane } from "./paneTypes";
import { paneTitle } from "./paneTypes";
import { WorkspacePaneRenderer } from "./paneRegistry";
import { hasDockviewPanels, layoutMatchesWorkspacePanes } from "./workspaceLayoutCodec";

type DockviewPaneParams = {
  activePaneId: string | null;
  pane: WorkspacePane;
};

type WorkspaceDockProps = {
  onActivePaneChange: (paneId: string | null) => void;
  onLayoutChange: (layout: unknown, activePaneId: string | null) => void;
  onPaneClose: (paneId: string, layout: unknown) => void;
  workspace: WorkspaceModel;
};

export function WorkspaceDock({
  onActivePaneChange,
  onLayoutChange,
  onPaneClose,
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

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      syncWorkspaceIntoDockview(event.api, workspace, suppressEventsRef, onLayoutChange);
      disposablesRef.current = [
        event.api.onDidLayoutChange(() => scheduleLayoutChange(event.api)),
        event.api.onDidActivePanelChange((panel) => {
          if (!suppressEventsRef.current) {
            onActivePaneChange(panel?.id ?? null);
          }
        }),
        event.api.onDidRemovePanel((panel) => {
          if (!suppressEventsRef.current) {
            onPaneClose(panel.id, event.api.toJSON());
          }
        }),
      ];
    },
    [onActivePaneChange, onPaneClose, scheduleLayoutChange, workspace],
  );

  useEffect(() => {
    const api = apiRef.current;
    if (api) {
      syncWorkspaceIntoDockview(api, workspace, suppressEventsRef, onLayoutChange);
    }
  }, [onLayoutChange, workspace]);

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
    <div className="kodex-workspace-dock dockview-theme-dark" data-testid="workspace-dock">
      <DockviewReact components={components} disableFloatingGroups onReady={handleReady} />
    </div>
  );
}

function WorkspaceDockPane({ params }: IDockviewPanelProps<DockviewPaneParams>) {
  return (
    <div className="kodex-workspace-pane-host" data-pane-kind={params.pane.kind}>
      <WorkspacePaneRenderer
        key={params.pane.id}
        pane={params.pane}
        isActive={params.activePaneId === params.pane.id}
      />
    </div>
  );
}

export function syncWorkspaceIntoDockview(
  api: DockviewApi,
  workspace: WorkspaceModel,
  suppressEventsRef: { current: boolean },
  onReconciledLayout?: (layout: unknown, activePaneId: string | null) => void,
) {
  suppressEventsRef.current = true;
  let shouldPersistLiveLayout = false;
  try {
    if (canReconcileWorkspacePanelsInPlace(api, workspace)) {
      shouldPersistLiveLayout = reconcileWorkspacePanelsInPlace(api, workspace);
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
      addWorkspacePanels(api, workspace);
    }
    if (workspace.activePaneId) {
      api.getPanel(workspace.activePaneId)?.focus();
    }
  } catch {
    api.clear();
    addWorkspacePanels(api, workspace);
  } finally {
    window.setTimeout(() => {
      suppressEventsRef.current = false;
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

function reconcileWorkspacePanelsInPlace(api: DockviewApi, workspace: WorkspaceModel) {
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
      ...(firstPane && api.getPanel(firstPane.id)
        ? { floating: false as const, position: { referencePanel: firstPane.id, direction: "right" as const } }
        : {}),
    });
    layoutChanged = true;
  }

  if (workspace.activePaneId) {
    api.getPanel(workspace.activePaneId)?.focus();
  }
  return layoutChanged;
}

function addWorkspacePanels(api: DockviewApi, workspace: WorkspaceModel) {
  const [firstPane] = workspace.panes;
  for (const [index, pane] of workspace.panes.entries()) {
    api.addPanel<DockviewPaneParams>({
      id: pane.id,
      component: "workspacePane",
      title: paneTitle(pane),
      params: { pane, activePaneId: workspace.activePaneId ?? null },
      ...(index > 0 && firstPane
        ? { floating: false as const, position: { referencePanel: firstPane.id, direction: "right" as const } }
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
