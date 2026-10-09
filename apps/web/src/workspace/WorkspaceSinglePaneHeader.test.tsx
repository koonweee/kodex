import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ThreadSummary } from "../api/client";
import { createMemoryWorkspacePaneStore } from "./paneStore";
import type { WorkspacePane, WorkspacePaneState } from "./paneTypes";
import { WorkspaceProvider, useWorkspace } from "./WorkspaceProvider";
import { WorkspaceSinglePaneHeader } from "./WorkspaceSinglePaneHeader";

describe("WorkspaceSinglePaneHeader", () => {
  it("shows the active pane title and switches selection through the pane manager", async () => {
    const onShowMobileSidebar = vi.fn();
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "First thread"),
      threadPane("pane-thread-2", "thread-2", "Second thread"),
    ], "pane-thread-2"));

    renderShell(store, { onShowMobileSidebar });

    expect(screen.getByRole("button", { name: /switch workspace pane/i })).toHaveTextContent("Second thread");

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

    expect(store.getState().activePaneId).toBe("pane-thread-1");
    expect(screen.getByRole("button", { name: /switch workspace pane/i })).toHaveTextContent("First thread");
    expect(screen.queryByRole("dialog", { name: /active panes/i })).not.toBeInTheDocument();

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
    expect(screen.getByRole("button", { name: /switch workspace pane/i })).toHaveTextContent("Third thread");
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
    expect(screen.getByRole("button", { name: /switch workspace pane/i })).toHaveTextContent("Second thread");
  });

  it("opens a new chat when the last visible pane is closed", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "First thread"),
    ]));

    renderShell(store);

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
    expect(within(screen.getByRole("toolbar", { name: "Pane actions" })).queryByRole("button", { name: /close pane/i })).not.toBeInTheDocument();
  });

  it("hides the close action for the only default new chat pane", () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      draftThreadPane("pane-draft-1", "New chat"),
    ]));

    renderShell(store);

    expect(screen.getAllByText("New chat")).toHaveLength(1);
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

  it("updates running and unread indicators in the selector and pane list ahead of syncing", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("one", "thread-1", "First thread"),
      threadPane("two", "thread-2", "Second thread"),
      draftThreadPane("draft", "New chat"),
    ], "one"));
    const shell = (status: string, unread: boolean) => (
      <MantineProvider><WorkspaceProvider paneStore={store} threadSummariesById={{
        "thread-1": { id: "thread-1", status, unreadCompletedAgentTurn: unread } as ThreadSummary,
        "thread-2": { id: "thread-2", status: "idle", unreadCompletedAgentTurn: true } as ThreadSummary,
      }}>
        <PaneAdornmentHarness paneId="one" />
        <WorkspaceSinglePaneHeader />
      </WorkspaceProvider></MantineProvider>
    );
    const view = render(shell("active", true));
    const switcher = screen.getByRole("button", { name: "Switch workspace pane" });
    expect(within(switcher).getByRole("status", { name: "Thread in progress" })).toBeInTheDocument();
    expect(within(switcher).queryByRole("status", { name: "Pane syncing" })).not.toBeInTheDocument();
    expect(within(switcher).queryByRole("img", { name: "Unread completed agent turn" })).not.toBeInTheDocument();
    fireEvent.click(switcher);
    const manager = await screen.findByRole("dialog", { name: "Active panes" });
    const first = within(manager).getByRole("button", { name: /^First thread/ });
    const second = within(manager).getByRole("button", { name: /^Second thread/ });
    expect(within(first).getByRole("status", { name: "Thread in progress" })).toBeInTheDocument();
    expect(within(second).getByRole("img", { name: "Unread completed agent turn" })).toBeInTheDocument();
    expect(within(manager).getByRole("button", { name: "New chat" })).toBeInTheDocument();
    view.rerender(shell("idle", true));
    expect(within(switcher).getByRole("img", { name: "Unread completed agent turn" })).toBeInTheDocument();
    expect(within(first).getByRole("img", { name: "Unread completed agent turn" })).toBeInTheDocument();
    expect(within(first).queryByRole("status", { name: "Thread in progress" })).not.toBeInTheDocument();
    view.rerender(shell("idle", false));
    expect(within(switcher).getByRole("status", { name: "Pane syncing" })).toBeInTheDocument();
    expect(within(first).getByRole("status", { name: "Pane syncing" })).toBeInTheDocument();
    fireEvent.click(second);
    expect(store.getState().activePaneId).toBe("two");
    expect(within(switcher).getByRole("img", { name: "Unread completed agent turn" })).toBeInTheDocument();
  });

  it("uses the mounted pane status for unlisted chats and ignores stale contexts", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("one", "unlisted", "Unlisted chat"),
    ]));
    function Projection({ threadId, state }: { threadId: string; state: "running" | "unread" }) {
      const { setPaneThreadContext } = useWorkspace();
      useEffect(() => {
        setPaneThreadContext("one", { id: threadId, projectId: null, cwd: "/", indicatorState: state });
      }, [setPaneThreadContext, threadId, state]);
      return <WorkspaceSinglePaneHeader />;
    }
    const shell = (threadId: string, state: "running" | "unread") => (
      <MantineProvider><WorkspaceProvider paneStore={store}>
        <Projection threadId={threadId} state={state} />
      </WorkspaceProvider></MantineProvider>
    );
    const view = render(shell("unlisted", "running"));
    const switcher = screen.getByRole("button", { name: "Switch workspace pane" });
    expect(within(switcher).getByRole("status", { name: "Thread in progress" })).toBeInTheDocument();
    view.rerender(shell("unlisted", "unread"));
    expect(within(switcher).getByRole("img", { name: "Unread completed agent turn" })).toBeInTheDocument();
    view.rerender(shell("old-thread", "unread"));
    expect(within(switcher).queryByRole("img", { name: "Unread completed agent turn" })).not.toBeInTheDocument();
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
  } = {},
) {
  render(
    <MantineProvider>
      <WorkspaceProvider
        onShowMobileSidebar={options.onShowMobileSidebar}
        paneStore={paneStore}
      >
        {options.adornmentPaneId ? <PaneAdornmentHarness paneId={options.adornmentPaneId} /> : null}
        {options.actionPaneId ? <PaneActionHarness paneId={options.actionPaneId} /> : null}
        <WorkspaceSinglePaneHeader />
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
