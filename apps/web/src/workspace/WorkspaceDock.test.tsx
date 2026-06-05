import { describe, expect, it, vi } from "vitest";
import type { DockviewApi } from "dockview";

import { syncWorkspaceIntoDockview } from "./WorkspaceDock";
import type { WorkspaceModel, WorkspacePane } from "./paneTypes";

describe("WorkspaceDock sync", () => {
  it("rebuilds a single-pane workspace instead of hydrating a stale saved split layout", () => {
    const api = fakeDockviewApi([]);
    const suppressEventsRef = { current: false };
    const singlePane = pane("pane-a", "thread", { mode: "existing", threadId: "thread-1" });

    syncWorkspaceIntoDockview(
      api as unknown as DockviewApi,
      workspaceModel([singlePane], "pane-a"),
      suppressEventsRef,
    );

    expect(api.clear).toHaveBeenCalled();
    expect(api.fromJSON).not.toHaveBeenCalled();
    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "pane-a",
        params: { pane: singlePane, activePaneId: "pane-a" },
      }),
    );
    expect(api.addPanel).toHaveBeenCalledTimes(1);
    expect(api.activePanel?.id).toBe("pane-a");
  });

  it("adds new workspace panes without clearing the existing Dockview layout", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeDockviewApi(["pane-a", "pane-b"]);
      const onReconciledLayout = vi.fn();
      const suppressEventsRef = { current: false };

      syncWorkspaceIntoDockview(
        api as unknown as DockviewApi,
        workspaceModel([
          pane("pane-a", "thread", { mode: "existing", threadId: "thread-1" }),
          pane("pane-b", "generatedUi", { mode: "latest", threadId: "thread-1" }),
          pane("pane-c", "terminal", {}),
        ], "pane-c"),
        suppressEventsRef,
        onReconciledLayout,
      );

      expect(api.clear).not.toHaveBeenCalled();
      expect(api.fromJSON).not.toHaveBeenCalled();
      expect(api.addPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "pane-c",
          position: { referencePanel: "pane-a", direction: "right" },
        }),
      );
      expect(api.panels.map((panel) => panel.id)).toEqual(["pane-a", "pane-b", "pane-c"]);
      expect(api.activePanel?.id).toBe("pane-c");
      expect(suppressEventsRef.current).toBe(true);

      await vi.runAllTimersAsync();

      expect(suppressEventsRef.current).toBe(false);
      expect(onReconciledLayout).toHaveBeenCalledWith(
        {
          activePanelId: "pane-c",
          panels: {
            "pane-a": {},
            "pane-b": {},
            "pane-c": {},
          },
        },
        "pane-c",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

type FakeDockviewPanel = {
  focus: ReturnType<typeof vi.fn>;
  id: string;
  params: unknown;
  setTitle: ReturnType<typeof vi.fn>;
  title: string;
  update: ReturnType<typeof vi.fn>;
};

function fakeDockviewApi(panelIds: string[]) {
  let activePanel: FakeDockviewPanel | null = null;
  const panels: FakeDockviewPanel[] = [];
  const api = {
    get activePanel() {
      return activePanel;
    },
    addPanel: vi.fn((options: { id: string; params?: unknown; title?: string }) => {
      const panel = fakePanel(options.id, options.params, options.title ?? options.id, () => {
        activePanel = panel;
      });
      panels.push(panel);
      return panel;
    }),
    clear: vi.fn(() => {
      panels.length = 0;
      activePanel = null;
    }),
    fromJSON: vi.fn(),
    getPanel: vi.fn((id: string) => panels.find((panel) => panel.id === id)),
    panels,
    removePanel: vi.fn((panel: FakeDockviewPanel) => {
      const index = panels.indexOf(panel);
      if (index >= 0) {
        panels.splice(index, 1);
      }
      if (activePanel === panel) {
        activePanel = panels[0] ?? null;
      }
    }),
    toJSON: vi.fn(() => ({
      activePanelId: activePanel?.id ?? null,
      panels: Object.fromEntries(panels.map((panel) => [panel.id, {}])),
    })),
  };
  for (const id of panelIds) {
    const panel = fakePanel(id, { pane: pane(id, "thread", { mode: "existing", threadId: id }) }, id, () => {
      activePanel = panel;
    });
    panels.push(panel);
  }
  activePanel = panels[0] ?? null;
  return api;
}

function fakePanel(id: string, params: unknown, title: string, onFocus: () => void): FakeDockviewPanel {
  const panel: FakeDockviewPanel = {
    id,
    params,
    title,
    focus: vi.fn(onFocus),
    setTitle: vi.fn((nextTitle: string) => {
      panel.title = nextTitle;
    }),
    update: vi.fn((update: { params?: unknown }) => {
      panel.params = update.params ?? panel.params;
    }),
  };
  return panel;
}

function workspaceModel(panes: WorkspacePane[], activePaneId: string | null = panes[0]?.id ?? null): WorkspaceModel {
  return {
    activePaneId,
    dockviewLayout: {
      panels: Object.fromEntries(panes.slice(0, 2).map((workspacePane) => [workspacePane.id, {}])),
    },
    panes,
    schemaVersion: 1,
  };
}

function pane(
  id: string,
  kind: WorkspacePane["kind"],
  target: WorkspacePane["target"],
  title: string | null = null,
): WorkspacePane {
  return {
    id,
    kind,
    title,
    target,
  } as WorkspacePane;
}
