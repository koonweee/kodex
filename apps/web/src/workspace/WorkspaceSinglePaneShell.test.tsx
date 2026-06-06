import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { createMemoryWorkspacePaneStore } from "./paneStore";
import type { WorkspacePane, WorkspacePaneState } from "./paneTypes";
import { WorkspaceProvider, useWorkspace } from "./WorkspaceProvider";
import { WorkspaceSinglePaneShell } from "./WorkspaceSinglePaneShell";

vi.mock("./paneRegistry", async (importActual) => {
  const actual = await importActual<typeof import("./paneRegistry")>();
  return {
    ...actual,
    WorkspacePaneRenderer: ({ isActive, pane }: { isActive: boolean; pane: WorkspacePane }) => (
      <section data-active={isActive ? "true" : "false"} data-testid={`single-pane-${pane.id}`}>
        {pane.title}
      </section>
    ),
  };
});

describe("WorkspaceSinglePaneShell", () => {
  it("renders only the active pane and switches visible panes from the menu", async () => {
    const onVisibleThreadIdsChange = vi.fn();
    const onShowMobileSidebar = vi.fn();
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "First thread"),
      threadPane("pane-thread-2", "thread-2", "Second thread"),
    ], "pane-thread-2"));

    renderShell(store, { onShowMobileSidebar, onVisibleThreadIdsChange });

    expect(screen.getByTestId("single-pane-pane-thread-2")).toHaveAttribute("data-active", "true");
    expect(screen.queryByTestId("single-pane-pane-thread-1")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(onVisibleThreadIdsChange).toHaveBeenLastCalledWith(["thread-2"]);
    });

    fireEvent.click(screen.getByRole("button", { name: /switch workspace pane/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /first thread/i }));

    expect(screen.getByTestId("single-pane-pane-thread-1")).toHaveAttribute("data-active", "true");
    expect(screen.queryByTestId("single-pane-pane-thread-2")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(onVisibleThreadIdsChange).toHaveBeenLastCalledWith(["thread-1"]);
    });

    fireEvent.click(screen.getByRole("button", { name: /show sidebar/i }));
    expect(onShowMobileSidebar).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole("toolbar", { name: "Pane actions" })).getByRole("button", { name: /close pane/i })).toBeInTheDocument();
  });

  it("closes the active pane and focuses the next pane without opening the switcher", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "First thread"),
      threadPane("pane-thread-2", "thread-2", "Second thread"),
      threadPane("pane-thread-3", "thread-3", "Third thread"),
    ], "pane-thread-2"));

    renderShell(store);

    fireEvent.click(screen.getByRole("button", { name: /close pane/i }));

    await waitFor(() => {
      expect(store.getState().activePaneId).toBe("pane-thread-3");
    });
    expect(store.getState().panes.map((pane) => pane.id)).toEqual(["pane-thread-1", "pane-thread-3"]);
    expect(screen.getByTestId("single-pane-pane-thread-3")).toHaveAttribute("data-active", "true");
    expect(screen.queryByTestId("single-pane-pane-thread-2")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /first thread/i })).not.toBeInTheDocument();
  });

  it("opens a new chat when the last visible pane is closed", async () => {
    const onVisibleThreadIdsChange = vi.fn();
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "First thread"),
    ]));

    renderShell(store, { onVisibleThreadIdsChange });

    fireEvent.click(screen.getByRole("button", { name: /close pane/i }));

    await waitFor(() => {
      expect(store.getState().panes).toHaveLength(1);
      expect(store.getState().panes[0]?.target).toEqual({ mode: "draft" });
    });
    expect(store.getState().activePaneId).toBe(store.getState().panes[0]?.id);
    expect(screen.getAllByText("New chat")).toHaveLength(2);
    await waitFor(() => {
      expect(onVisibleThreadIdsChange).toHaveBeenLastCalledWith([]);
    });
    expect(screen.queryByRole("button", { name: /close pane/i })).not.toBeInTheDocument();
  });

  it("hides the close action for the only default new chat pane", () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      draftThreadPane("pane-draft-1", "New chat"),
    ]));

    renderShell(store);

    expect(screen.getAllByText("New chat")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /close pane/i })).not.toBeInTheDocument();
  });

  it("renders active pane actions in the shared mobile header", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "First thread"),
    ]));

    renderShell(store, { actionPaneId: "pane-thread-1" });

    expect(await screen.findByRole("toolbar", { name: "Pane actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close pane" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread overflow" })).toBeInTheDocument();
  });
});

function renderShell(
  paneStore: ReturnType<typeof createMemoryWorkspacePaneStore>,
  options: {
    actionPaneId?: string;
    onShowMobileSidebar?: () => void;
    onVisibleThreadIdsChange?: (threadIds: string[]) => void;
  } = {},
) {
  render(
    <MantineProvider>
      <WorkspaceProvider
        onShowMobileSidebar={options.onShowMobileSidebar}
        onVisibleThreadIdsChange={options.onVisibleThreadIdsChange}
        paneStore={paneStore}
      >
        {options.actionPaneId ? <PaneActionHarness paneId={options.actionPaneId} /> : null}
        <WorkspaceSinglePaneShell />
      </WorkspaceProvider>
    </MantineProvider>,
  );
}

function PaneActionHarness({ paneId }: { paneId: string }) {
  const { setPaneHeaderActions } = useWorkspace();
  useEffect(() => {
    setPaneHeaderActions(paneId, <button type="button">Thread overflow</button>);
    return () => setPaneHeaderActions(paneId, null);
  }, [paneId, setPaneHeaderActions]);
  return null;
}

function workspaceState(panes: WorkspacePane[], activePaneId: string | null = panes[0]?.id ?? null): WorkspacePaneState {
  return {
    activePaneId,
    dockviewLayout: {
      panes: panes.map((pane) => ({ id: pane.id })),
    },
    panes,
    schemaVersion: 1,
  };
}

function threadPane(id: string, threadId: string, title: string): WorkspacePane {
  return {
    id,
    kind: "thread",
    target: { mode: "existing", threadId },
    title,
  };
}

function draftThreadPane(id: string, title: string): WorkspacePane {
  return {
    id,
    kind: "thread",
    target: { mode: "draft" },
    title,
  };
}
