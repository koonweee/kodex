import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteTerminalSession } from "../api/client";
import { createMemoryWorkspacePaneStore } from "./paneStore";
import type { WorkspacePane, WorkspacePaneState } from "./paneTypes";
import { WorkspaceProvider, useWorkspace } from "./WorkspaceProvider";

const streamClients: Array<{ close: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; threadIds: string[] }> = [];

vi.mock("../events/stream", () => ({
  createEventStreamClient: vi.fn((options: { threadIds?: string[] }) => {
    const client = {
      close: vi.fn(),
      connect: vi.fn(),
      threadIds: options.threadIds ?? [],
    };
    streamClients.push(client);
    return client;
  }),
}));

vi.mock("../api/client", async (importActual) => {
  const actual = await importActual<typeof import("../api/client")>();
  return {
    ...actual,
    deleteTerminalSession: vi.fn(),
  };
});

describe("WorkspaceProvider pane commands", () => {
  afterEach(() => {
    streamClients.length = 0;
    vi.clearAllMocks();
  });

  it("focuses an existing thread pane unless duplicate is requested", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "Thread 1"),
      terminalPane("pane-terminal-1", "terminal-1"),
    ], "pane-terminal-1"));
    renderProvider(store);

    expect(screen.getByTestId("pane-count")).toHaveTextContent("2");

    fireEvent.click(screen.getByRole("button", { name: "Open thread" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-pane")).toHaveTextContent("pane-thread-1");
    });
    expect(screen.getByTestId("pane-count")).toHaveTextContent("2");

    fireEvent.click(screen.getByRole("button", { name: "Duplicate thread" }));

    await waitFor(() => {
      expect(screen.getByTestId("pane-count")).toHaveTextContent("3");
    });
    expect(store.getState().panes.filter((pane) => pane.kind === "thread" && pane.target.mode === "existing" && pane.target.threadId === "thread-1")).toHaveLength(2);
  });

  it("creates terminal panes as new local pane instances and deletes terminal resources on close", async () => {
    vi.mocked(deleteTerminalSession).mockResolvedValue({ id: "terminal-1" });
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "Thread 1"),
      terminalPane("pane-terminal-1", "terminal-1"),
    ], "pane-thread-1"));
    renderProvider(store);

    fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));

    await waitFor(() => {
      expect(screen.getByTestId("pane-count")).toHaveTextContent("3");
    });
    const createdTerminal = store.getState().panes.find((pane) => pane.kind === "terminal" && pane.id !== "pane-terminal-1");
    expect(createdTerminal).toBeTruthy();
    expect(createdTerminal?.target).toEqual({ command: null, cwd: null });

    fireEvent.click(screen.getByRole("button", { name: "Close existing terminal" }));

    await waitFor(() => {
      expect(store.getState().panes.some((pane) => pane.id === "pane-terminal-1")).toBe(false);
    });
    expect(deleteTerminalSession).toHaveBeenCalledWith("terminal-1");
  });

  it("does not retarget an active draft thread pane when opening an existing thread", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      draftThreadPane("pane-draft", "project-1"),
    ], "pane-draft"));
    renderProvider(store);

    fireEvent.click(screen.getByRole("button", { name: "Open thread" }));

    await waitFor(() => {
      expect(screen.getByTestId("pane-count")).toHaveTextContent("2");
    });
    expect(screen.getByTestId("active-pane")).not.toHaveTextContent("pane-draft");
    expect(store.getState().panes.find((pane) => pane.id === "pane-draft")?.target).toEqual({
      mode: "draft",
      projectId: "project-1",
    });
    expect(
      store.getState().panes.some((pane) =>
        pane.kind === "thread" && pane.target.mode === "existing" && pane.target.threadId === "thread-1",
      ),
    ).toBe(true);
  });

  it("opens unseen threads in a new pane instead of retargeting the active existing thread pane", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "Thread 1"),
    ], "pane-thread-1"));
    renderProvider(store);

    fireEvent.click(screen.getByRole("button", { name: "Open unseen thread" }));

    await waitFor(() => {
      expect(screen.getByTestId("pane-count")).toHaveTextContent("2");
    });
    expect(store.getState().panes.find((pane) => pane.id === "pane-thread-1")?.target).toEqual({
      mode: "existing",
      threadId: "thread-1",
    });
    expect(
      store.getState().panes.some((pane) =>
        pane.kind === "thread" && pane.target.mode === "existing" && pane.target.threadId === "thread-2",
      ),
    ).toBe(true);
  });

  it("records centralized placement hints for newly created panes", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "Thread 1"),
    ], "pane-thread-1"));
    renderProvider(store);

    fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));

    await waitFor(() => {
      expect(screen.getByTestId("pane-placement-hints")).toHaveTextContent("below");
    });
    const hints = JSON.parse(screen.getByTestId("pane-placement-hints").textContent ?? "{}");
    expect(Object.values(hints)).toEqual([
      {
        direction: "below",
        referencePaneId: "pane-thread-1",
      },
    ]);
  });

  it("dedupes workspace stream subscriptions by unique thread resource", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "Thread 1"),
      threadPane("pane-thread-2", "thread-1", "Thread 1 copy"),
      generatedUiPane("pane-ui-1", "thread-1"),
      terminalPane("pane-terminal-1", "terminal-1"),
    ]));

    renderProvider(store);

    await waitFor(() => {
      expect(streamClients[0]?.connect).toHaveBeenCalled();
    });
    expect(streamClients[0]?.threadIds).toEqual(["thread-1"]);
  });
});

function renderProvider(paneStore: ReturnType<typeof createMemoryWorkspacePaneStore>) {
  render(
    <WorkspaceProvider paneStore={paneStore}>
      <CommandHarness />
    </WorkspaceProvider>,
  );
}

function CommandHarness() {
  const workspace = useWorkspace();
  return (
    <>
      <span data-testid="pane-count">{workspace.workspace.panes.length}</span>
      <span data-testid="active-pane">{workspace.workspace.activePaneId ?? "none"}</span>
      <span data-testid="pane-placement-hints">{JSON.stringify(workspace.panePlacementHintsById)}</span>
      <button type="button" onClick={() => void workspace.openThreadPane("thread-1", "Thread 1")}>
        Open thread
      </button>
      <button type="button" onClick={() => void workspace.openThreadPane("thread-2", "Thread 2")}>
        Open unseen thread
      </button>
      <button type="button" onClick={() => void workspace.openThreadPane("thread-1", "Thread 1", { duplicate: true })}>
        Duplicate thread
      </button>
      <button type="button" onClick={() => void workspace.openTerminalPane()}>
        Open terminal
      </button>
      <button type="button" onClick={() => workspace.closePane("pane-terminal-1", { panes: [{ id: "pane-thread-1" }] })}>
        Close existing terminal
      </button>
    </>
  );
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

function draftThreadPane(id: string, projectId: string | null = null): WorkspacePane {
  return {
    id,
    kind: "thread",
    target: { mode: "draft", projectId },
    title: "Draft thread",
  };
}

function generatedUiPane(id: string, threadId: string): WorkspacePane {
  return {
    id,
    kind: "generatedUi",
    target: { mode: "latest", threadId },
    title: "Generated UI",
  };
}

function terminalPane(id: string, terminalId: string): WorkspacePane {
  return {
    id,
    kind: "terminal",
    target: { terminalId },
    title: "Terminal",
  };
}
