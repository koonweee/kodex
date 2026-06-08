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
  it("renders only the active pane and switches visible panes from the pane manager", async () => {
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
    const manager = await screen.findByRole("dialog", { name: /active panes/i });
    const paneButtons = within(manager).getAllByRole("button", { name: /^(second|first) thread$/i });
    expect(paneButtons.map((button) => button.textContent)).toEqual(["Second thread", "First thread"]);
    const activePaneButton = within(manager).getByRole("button", { name: /^second thread$/i });
    expect(activePaneButton).toHaveAttribute("aria-current", "page");
    await nextTick();
    expect(activePaneButton).not.toHaveFocus();
    expect(within(manager).getAllByRole("button").some((button) => button === document.activeElement)).toBe(false);
    expect(within(manager).queryByRole("button", { name: /close pane manager/i })).not.toBeInTheDocument();
    expect(within(manager).queryByRole("button", { name: /new pane/i })).not.toBeInTheDocument();
    fireEvent.click(within(manager).getByRole("button", { name: /^first thread$/i }));

    expect(screen.getByTestId("single-pane-pane-thread-1")).toHaveAttribute("data-active", "true");
    expect(screen.queryByTestId("single-pane-pane-thread-2")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /active panes/i })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(onVisibleThreadIdsChange).toHaveBeenLastCalledWith(["thread-1"]);
    });

    fireEvent.click(screen.getByRole("button", { name: /show sidebar/i }));
    expect(onShowMobileSidebar).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole("toolbar", { name: "Pane actions" })).queryByRole("button", { name: /close pane/i })).not.toBeInTheDocument();
  });

  it("closes the active pane from the pane manager and focuses the next pane", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "First thread"),
      threadPane("pane-thread-2", "thread-2", "Second thread"),
      threadPane("pane-thread-3", "thread-3", "Third thread"),
    ], "pane-thread-2"));

    renderShell(store);

    fireEvent.click(screen.getByRole("button", { name: /switch workspace pane/i }));
    const manager = await screen.findByRole("dialog", { name: /active panes/i });
    fireEvent.click(within(manager).getByRole("button", { name: /close pane second thread/i }));

    await waitFor(() => {
      expect(store.getState().activePaneId).toBe("pane-thread-3");
    });
    expect(store.getState().panes.map((pane) => pane.id)).toEqual(["pane-thread-1", "pane-thread-3"]);
    expect(screen.getByTestId("single-pane-pane-thread-3")).toHaveAttribute("data-active", "true");
    expect(screen.queryByTestId("single-pane-pane-thread-2")).not.toBeInTheDocument();
    expect(within(manager).queryByRole("button", { name: /^second thread$/i })).not.toBeInTheDocument();
    expect(within(manager).getByRole("button", { name: /^third thread$/i })).toHaveAttribute("aria-current", "page");
  });

  it("closes a pane from the pane manager row without switching away from the active pane", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "First thread"),
      threadPane("pane-thread-2", "thread-2", "Second thread"),
      threadPane("pane-thread-3", "thread-3", "Third thread"),
    ], "pane-thread-2"));

    renderShell(store);

    fireEvent.click(screen.getByRole("button", { name: /switch workspace pane/i }));
    const manager = await screen.findByRole("dialog", { name: /active panes/i });
    fireEvent.click(within(manager).getByRole("button", { name: /close pane third thread/i }));

    await waitFor(() => {
      expect(store.getState().panes.map((pane) => pane.id)).toEqual(["pane-thread-1", "pane-thread-2"]);
    });
    expect(store.getState().activePaneId).toBe("pane-thread-2");
    expect(screen.getByTestId("single-pane-pane-thread-2")).toHaveAttribute("data-active", "true");
  });

  it("opens a new chat when the last visible pane is closed", async () => {
    const onVisibleThreadIdsChange = vi.fn();
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "First thread"),
    ]));

    renderShell(store, { onVisibleThreadIdsChange });

    fireEvent.click(screen.getByRole("button", { name: /switch workspace pane/i }));
    const manager = await screen.findByRole("dialog", { name: /active panes/i });
    fireEvent.click(within(manager).getByRole("button", { name: /close pane first thread/i }));

    await waitFor(() => {
      expect(store.getState().panes).toHaveLength(1);
      expect(store.getState().panes[0]?.target).toEqual({ mode: "draft" });
    });
    expect(store.getState().activePaneId).toBe(store.getState().panes[0]?.id);
    expect(within(screen.getByRole("button", { name: /switch workspace pane/i })).getByText("New chat")).toBeInTheDocument();
    expect(within(manager).getByRole("button", { name: /^new chat$/i })).toHaveAttribute("aria-current", "page");
    await waitFor(() => {
      expect(onVisibleThreadIdsChange).toHaveBeenLastCalledWith([]);
    });
    expect(within(screen.getByRole("toolbar", { name: "Pane actions" })).queryByRole("button", { name: /close pane/i })).not.toBeInTheDocument();
  });

  it("hides the close action for the only default new chat pane", () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      draftThreadPane("pane-draft-1", "New chat"),
    ]));

    renderShell(store);

    expect(screen.getAllByText("New chat")).toHaveLength(2);
    expect(within(screen.getByRole("toolbar", { name: "Pane actions" })).queryByRole("button", { name: /close pane/i })).not.toBeInTheDocument();
  });

  it("renders active pane actions in the shared mobile header", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "First thread"),
    ]));

    renderShell(store, { actionPaneId: "pane-thread-1" });

    expect(await screen.findByRole("toolbar", { name: "Pane actions" })).toBeInTheDocument();
    expect(within(screen.getByRole("toolbar", { name: "Pane actions" })).queryByRole("button", { name: "Close pane" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thread overflow" })).toBeInTheDocument();
  });

  it("renders registered pane title adornments beside the mobile pane name", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "First thread"),
    ]));

    renderShell(store, { adornmentPaneId: "pane-thread-1" });

    const switcher = screen.getByRole("button", { name: /switch workspace pane/i });
    expect(within(switcher).getByText("First thread")).toBeInTheDocument();
    expect(within(switcher).getByRole("status", { name: "Pane syncing" })).toBeInTheDocument();
    expect(within(switcher).getByTestId("thread-sync-spinner")).toBeInTheDocument();
  });
});

function renderShell(
  paneStore: ReturnType<typeof createMemoryWorkspacePaneStore>,
  options: {
    adornmentPaneId?: string;
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
        {options.adornmentPaneId ? <PaneAdornmentHarness paneId={options.adornmentPaneId} /> : null}
        {options.actionPaneId ? <PaneActionHarness paneId={options.actionPaneId} /> : null}
        <WorkspaceSinglePaneShell />
      </WorkspaceProvider>
    </MantineProvider>,
  );
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function PaneAdornmentHarness({ paneId }: { paneId: string }) {
  const { setPaneHeaderAdornment } = useWorkspace();
  useEffect(() => {
    setPaneHeaderAdornment(paneId, <span data-testid="thread-sync-spinner" />);
    return () => setPaneHeaderAdornment(paneId, null);
  }, [paneId, setPaneHeaderAdornment]);
  return null;
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
