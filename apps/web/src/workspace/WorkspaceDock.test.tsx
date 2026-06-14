import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DockviewApi } from "dockview";

import {
  WorkspaceDefaultTab,
  WorkspaceRightHeaderActions,
  WorkspaceTabOverflowActions,
  kodexDockviewTheme,
  syncWorkspaceIntoDockview,
  visibleDockviewPanelIds,
  workspaceTabContextMenuItems,
} from "./WorkspaceDock";
import { createMemoryWorkspacePaneStore } from "./paneStore";
import type { WorkspaceModel, WorkspacePane } from "./paneTypes";
import { WorkspaceProvider, useWorkspace } from "./WorkspaceProvider";

describe("WorkspaceDock sync", () => {
  it("uses a compact Kodex Dockview theme instead of the default abyss chrome", () => {
    expect(kodexDockviewTheme.className).toContain("dockview-theme-abyss");
    expect(kodexDockviewTheme.className).toContain("kodex-dockview-theme");
    expect(kodexDockviewTheme.dndTabIndicator).toBe("line");
    expect(kodexDockviewTheme.dndPanelOverlay).toBe("group");
    expect(kodexDockviewTheme.tabAnimation).toBe("smooth");
  });

  it("renders registered active pane actions in the shared Dockview header slot", async () => {
    render(
      <WorkspaceProvider>
        <PaneActionHarness activePaneId="pane-thread" />
      </WorkspaceProvider>,
    );

    expect(await screen.findByRole("toolbar", { name: "Pane actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread overflow" })).toBeInTheDocument();
  });

  it("renders registered pane title adornments beside the desktop tab name", async () => {
    const workspacePane = pane("pane-thread", "thread", { mode: "existing", threadId: "thread-1" }, "First thread");

    render(
      <WorkspaceProvider paneStore={createMemoryWorkspacePaneStore({
        activePaneId: "pane-thread",
        dockviewLayout: null,
        panes: [workspacePane],
        schemaVersion: 1,
      })}>
        <PaneAdornmentHarness activePaneId="pane-thread" pane={workspacePane} />
      </WorkspaceProvider>,
    );

    expect(screen.getByText("First thread")).toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "Pane syncing" })).toBeInTheDocument();
    expect(screen.getByTestId("thread-sync-spinner")).toBeInTheDocument();
  });

  it("renders a dropdown for measured overflow tabs and focuses the chosen panel", async () => {
    const panels = Array.from({ length: 6 }, (_, index) => ({
      focus: vi.fn(),
      id: `pane-${index + 1}`,
      title: `Pane ${index + 1}`,
    }));

    render(
      <MantineProvider>
        <div className="dv-tabs-and-actions-container">
          <div className="dv-tabs-container">
            {panels.map((panel) => (
              <div className="dv-tab" key={panel.id}>
                {panel.title}
              </div>
            ))}
          </div>
          <WorkspaceTabOverflowActions
            activePanel={panels[0] as never}
            api={{} as never}
            containerApi={{} as never}
            group={{} as never}
            headerPosition="top"
            isGroupActive
            panels={panels as never}
          />
        </div>
      </MantineProvider>,
    );
    const tabsContainer = document.querySelector<HTMLElement>(".dv-tabs-container");
    expect(tabsContainer).not.toBeNull();
    vi.spyOn(tabsContainer as HTMLElement, "getBoundingClientRect").mockReturnValue(domRect(0, 360));
    document.querySelectorAll<HTMLElement>(".dv-tab").forEach((tab, index) => {
      vi.spyOn(tab, "getBoundingClientRect").mockReturnValue(domRect(index * 180, index * 180 + 180));
    });

    fireEvent(window, new Event("resize"));
    const moreTabsButton = await screen.findByRole("button", { name: "More tabs" });
    expect(moreTabsButton).toHaveTextContent("+4");

    fireEvent.click(moreTabsButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pane 6" }));

    expect(panels[5]?.focus).toHaveBeenCalledTimes(1);
  });

  it("adds a new draft tab in the current project from a project thread tab context menu", () => {
    const openDraftThreadPane = vi.fn();
    const items = workspaceTabContextMenuItems({
      openDraftThreadPane,
      panelId: "pane-thread",
      pane: pane("pane-thread", "thread", { mode: "existing", threadId: "thread-1" }, "Project thread"),
      threadProjectIdsById: { "thread-1": "project-1" },
    });

    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ label: "New chat in project" });
    if (typeof item === "string") {
      throw new Error("Expected custom context menu item");
    }
    item.action?.();

    expect(openDraftThreadPane).toHaveBeenCalledWith("project-1", {
      duplicate: true,
      placement: { direction: "within", sourcePaneId: "pane-thread" },
    });
  });

  it("does not show the project draft tab action for non-project thread tabs", () => {
    expect(
      workspaceTabContextMenuItems({
        openDraftThreadPane: vi.fn(),
        panelId: "pane-chat",
        pane: pane("pane-chat", "thread", { mode: "existing", threadId: "chat-1" }, "Chat"),
        threadProjectIdsById: {},
      }),
    ).toEqual([]);
  });

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

  it("rebuilds a multi-pane workspace instead of hydrating a saved layout with an empty grid group", () => {
    const api = fakeDockviewApi([]);
    const suppressEventsRef = { current: false };
    const panes = [
      pane("pane-a", "thread", { mode: "existing", threadId: "thread-1" }),
      pane("pane-b", "thread", { mode: "existing", threadId: "thread-2" }),
    ];

    syncWorkspaceIntoDockview(
      api as unknown as DockviewApi,
      {
        activePaneId: "pane-b",
        dockviewLayout: {
          panels: { "pane-a": {}, "pane-b": {} },
          grid: {
            root: {
              type: "branch",
              data: [
                { type: "leaf", data: { id: "empty-group", views: [] } },
                { type: "leaf", data: { id: "group-a", views: ["pane-a"] } },
                { type: "leaf", data: { id: "group-b", views: ["pane-b"] } },
              ],
            },
          },
        },
        panes,
        schemaVersion: 1,
      },
      suppressEventsRef,
    );

    expect(api.clear).toHaveBeenCalled();
    expect(api.fromJSON).not.toHaveBeenCalled();
    expect(api.addPanel).toHaveBeenCalledTimes(2);
    expect(api.addPanel).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "pane-b",
        position: { referencePanel: "pane-a", direction: "right" },
      }),
    );
    expect(api.activePanel?.id).toBe("pane-b");
  });

  it("adds new workspace panes at their placement hint without clearing the existing Dockview layout", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeDockviewApi(["pane-a", "pane-b"]);
      const onReconciledLayout = vi.fn();
      const onPanePlacementHintsConsumed = vi.fn();
      const suppressEventsRef = { current: false };

      syncWorkspaceIntoDockview(
        api as unknown as DockviewApi,
        workspaceModel([
          pane("pane-a", "thread", { mode: "existing", threadId: "thread-1" }),
          pane("pane-b", "appSurface", { mode: "latest", threadId: "thread-1" }),
          pane("pane-c", "terminal", {}),
        ], "pane-c"),
        suppressEventsRef,
        onReconciledLayout,
        {
          "pane-c": { direction: "below", referencePaneId: "pane-b" },
        },
        onPanePlacementHintsConsumed,
      );

      expect(api.clear).not.toHaveBeenCalled();
      expect(api.fromJSON).not.toHaveBeenCalled();
      expect(api.addPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "pane-c",
          position: { referencePanel: "pane-b", direction: "below" },
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
      expect(onPanePlacementHintsConsumed).toHaveBeenCalledWith(["pane-c"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds placement-hinted panes within the reference panel tab group", () => {
    const api = fakeDockviewApi(["pane-a"]);
    const suppressEventsRef = { current: false };

    syncWorkspaceIntoDockview(
      api as unknown as DockviewApi,
      workspaceModel([
        pane("pane-a", "terminal", { terminalId: "terminal-a" }),
        pane("pane-b", "terminal", {}),
      ], "pane-b"),
      suppressEventsRef,
      undefined,
      {
        "pane-b": { direction: "within", referencePaneId: "pane-a" },
      },
    );

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "pane-b",
        position: { referencePanel: "pane-a", direction: "within" },
      }),
    );
  });

  it("reports one visible panel per Dockview group", () => {
    expect(
      visibleDockviewPanelIds({
        activePanel: { id: "pane-a" },
        groups: [
          { activePanel: { id: "pane-a" } },
          { activePanel: { id: "pane-c" } },
          { activePanel: undefined },
        ],
      } as never),
    ).toEqual(["pane-a", "pane-c"]);
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

type FakeDockviewGroup = {
  activePanel: FakeDockviewPanel | null;
};

function PaneActionHarness({ activePaneId }: { activePaneId: string }) {
  const { setPaneHeaderActions } = useWorkspace();
  useEffect(() => {
    setPaneHeaderActions(activePaneId, <button type="button">Thread overflow</button>);
    return () => setPaneHeaderActions(activePaneId, null);
  }, [activePaneId, setPaneHeaderActions]);
  return (
    <WorkspaceRightHeaderActions
      activePanel={{ id: activePaneId } as never}
      api={{} as never}
      containerApi={{} as never}
      group={{} as never}
      headerPosition="top"
      isGroupActive
      panels={[]}
    />
  );
}

function PaneAdornmentHarness({ activePaneId, pane }: { activePaneId: string; pane: WorkspacePane }) {
  const { setPaneHeaderAdornment } = useWorkspace();
  useEffect(() => {
    setPaneHeaderAdornment(activePaneId, <span data-testid="thread-sync-spinner" />);
    return () => setPaneHeaderAdornment(activePaneId, null);
  }, [activePaneId, setPaneHeaderAdornment]);
  return (
    <WorkspaceDefaultTab
      api={{
        close: vi.fn(),
        id: activePaneId,
        onDidTitleChange: () => ({ dispose: vi.fn() }),
        title: pane.title ?? activePaneId,
      } as never}
      containerApi={{} as never}
      params={{ activePaneId, pane }}
      tabLocation="header"
    />
  );
}

function domRect(left: number, right: number): DOMRect {
  return {
    bottom: 32,
    height: 32,
    left,
    right,
    toJSON: () => ({}),
    top: 0,
    width: right - left,
    x: left,
    y: 0,
  };
}

function fakeDockviewApi(panelIds: string[]) {
  let activePanel: FakeDockviewPanel | null = null;
  const panels: FakeDockviewPanel[] = [];
  const groups: FakeDockviewGroup[] = [];
  const api = {
    get activePanel() {
      return activePanel;
    },
    get groups() {
      return groups;
    },
    addPanel: vi.fn((options: { id: string; params?: unknown; title?: string }) => {
      const panel = fakePanel(options.id, options.params, options.title ?? options.id, () => {
        activePanel = panel;
      });
      panels.push(panel);
      groups[0] = { activePanel: panel };
      return panel;
    }),
    clear: vi.fn(() => {
      panels.length = 0;
      groups.length = 0;
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
  if (activePanel) {
    groups.push({ activePanel });
  }
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
