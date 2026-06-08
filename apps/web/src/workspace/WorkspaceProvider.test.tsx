import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteTerminalSession } from "../api/client";
import type { EventEnvelope } from "../api/client";
import { createMemoryWorkspacePaneStore } from "./paneStore";
import type { WorkspacePane, WorkspacePaneState } from "./paneTypes";
import { WorkspaceProvider, useWorkspace } from "./WorkspaceProvider";

const streamClients: Array<{
  close: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  emit: (event: EventEnvelope) => void;
  threadIds: string[];
}> = [];

vi.mock("../events/stream", () => ({
  createEventStreamClient: vi.fn((options: { onEvent?: (event: EventEnvelope) => void; threadIds?: string[] }) => {
    const client = {
      close: vi.fn(),
      connect: vi.fn(),
      emit: (event: EventEnvelope) => options.onEvent?.(event),
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
    expect(JSON.parse(screen.getByTestId("focus-pulses").textContent ?? "{}")).toMatchObject({
      "pane-thread-1": expect.any(Number),
    });

    fireEvent.click(screen.getByRole("button", { name: "Duplicate thread" }));

    await waitFor(() => {
      expect(screen.getByTestId("pane-count")).toHaveTextContent("3");
    });
    expect(store.getState().panes.filter((pane) => pane.kind === "thread" && pane.target.mode === "existing" && pane.target.threadId === "thread-1")).toHaveLength(2);
  });

  it("focuses an existing terminal pane unless a new terminal is requested", async () => {
    vi.mocked(deleteTerminalSession).mockResolvedValue({ id: "terminal-1" });
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "Thread 1"),
      terminalPane("pane-terminal-1", "terminal-1"),
    ], "pane-thread-1"));
    renderProvider(store);

    fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-pane")).toHaveTextContent("pane-terminal-1");
    });
    expect(screen.getByTestId("pane-count")).toHaveTextContent("2");
    expect(JSON.parse(screen.getByTestId("focus-pulses").textContent ?? "{}")).toMatchObject({
      "pane-terminal-1": expect.any(Number),
    });

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));

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

  it("switches to an existing app surface tab for the same latest thread surface", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "Thread 1"),
      appSurfacePane("pane-ui-1", "thread-1"),
    ], "pane-thread-1"));
    renderProvider(store);

    fireEvent.click(screen.getByRole("button", { name: "Open app surface" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-pane")).toHaveTextContent("pane-ui-1");
    });
    expect(screen.getByTestId("pane-count")).toHaveTextContent("2");
  });

  it("opens a missing app surface in a new active tab in the source tab group", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "Thread 1"),
    ], "pane-thread-1"));
    renderProvider(store);

    fireEvent.click(screen.getByRole("button", { name: "Open app surface" }));

    await waitFor(() => {
      expect(screen.getByTestId("pane-count")).toHaveTextContent("2");
    });
    const createdPane = store.getState().panes.find((pane) => pane.kind === "appSurface");
    expect(createdPane).toBeTruthy();
    expect(screen.getByTestId("active-pane")).toHaveTextContent(createdPane?.id ?? "");
    expect(JSON.parse(screen.getByTestId("pane-placement-hints").textContent ?? "{}")).toMatchObject({
      [createdPane?.id ?? ""]: {
        direction: "within",
        referencePaneId: "pane-thread-1",
      },
    });
  });

  it("activates app surface panes even when a quiet open is requested", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "Thread 1"),
    ], "pane-thread-1"));
    renderProvider(store);

    fireEvent.click(screen.getByRole("button", { name: "Open app surface quietly" }));

    await waitFor(() => {
      expect(screen.getByTestId("pane-count")).toHaveTextContent("2");
    });
    const createdPane = store.getState().panes.find((pane) => pane.kind === "appSurface");
    expect(createdPane).toBeTruthy();
    expect(screen.getByTestId("active-pane")).toHaveTextContent(createdPane?.id ?? "");
  });

  it("applies app surface presentation requests from the workspace stream", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "Thread 1"),
    ], "pane-thread-1"));
    renderProvider(store);

    await waitFor(() => {
      expect(streamClients[0]?.connect).toHaveBeenCalled();
    });

    streamClients[0].emit(appSurfacePresentationEvent("open", 1));

    await waitFor(() => {
      expect(screen.getByTestId("pane-count")).toHaveTextContent("2");
    });
    expect(screen.getByTestId("active-pane")).not.toHaveTextContent("pane-thread-1");

    streamClients[0].emit(appSurfacePresentationEvent("focus", 2));

    await waitFor(() => {
      expect(screen.getByTestId("active-pane")).not.toHaveTextContent("pane-thread-1");
    });
    expect(store.getState().panes.filter((pane) => pane.kind === "appSurface")).toHaveLength(1);
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

  it("can place a new terminal pane inside the source pane tab group", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "Thread 1"),
      terminalPane("pane-terminal-1", "terminal-1"),
    ], "pane-terminal-1"));
    renderProvider(store);

    fireEvent.click(screen.getByRole("button", { name: "Open terminal tab" }));

    await waitFor(() => {
      expect(screen.getByTestId("pane-placement-hints")).toHaveTextContent("within");
    });
    const hints = JSON.parse(screen.getByTestId("pane-placement-hints").textContent ?? "{}");
    expect(Object.values(hints)).toEqual([
      {
        direction: "within",
        referencePaneId: "pane-terminal-1",
      },
    ]);
  });

  it("closes matching thread panes before invoking archive thread actions", async () => {
    let activePaneWhenArchived: string | null = null;
    const onArchiveThread = vi.fn(() => {
      activePaneWhenArchived = screen.getByTestId("active-pane").textContent;
    });
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "Thread 1"),
      threadPane("pane-thread-1-copy", "thread-1", "Thread 1 copy"),
      threadPane("pane-thread-2", "thread-2", "Thread 2"),
    ], "pane-thread-1"));

    renderProvider(store, { threadActions: { onArchiveThread } });

    fireEvent.click(screen.getByRole("button", { name: "Archive thread" }));

    expect(onArchiveThread).toHaveBeenCalledWith("thread-1");
    expect(activePaneWhenArchived).toBe("pane-thread-2");
    await waitFor(() => {
      expect(store.getState().panes.map((pane) => pane.id)).toEqual(["pane-thread-2"]);
    });
    expect(store.getState().activePaneId).toBe("pane-thread-2");
  });

  it("dedupes workspace stream subscriptions by unique thread resource", async () => {
    const store = createMemoryWorkspacePaneStore(workspaceState([
      threadPane("pane-thread-1", "thread-1", "Thread 1"),
      threadPane("pane-thread-2", "thread-1", "Thread 1 copy"),
      appSurfacePane("pane-ui-1", "thread-1"),
      terminalPane("pane-terminal-1", "terminal-1"),
    ]));

    renderProvider(store);

    await waitFor(() => {
      expect(streamClients[0]?.connect).toHaveBeenCalled();
    });
    expect(streamClients[0]?.threadIds).toEqual(["thread-1"]);
  });
});

function renderProvider(
  paneStore: ReturnType<typeof createMemoryWorkspacePaneStore>,
  options: { threadActions?: ComponentProps<typeof WorkspaceProvider>["threadActions"] } = {},
) {
  render(
    <WorkspaceProvider paneStore={paneStore} threadActions={options.threadActions}>
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
      <span data-testid="focus-pulses">{JSON.stringify(workspace.focusPulseByPaneId)}</span>
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
      <button type="button" onClick={() => void workspace.openAppSurfacePane("thread-1", "App Surface")}>
        Open app surface
      </button>
      <button type="button" onClick={() => void workspace.openAppSurfacePane("thread-1", "App Surface", { activate: false })}>
        Open app surface quietly
      </button>
      <button type="button" onClick={() => void workspace.openNewTerminalPane()}>
        New terminal
      </button>
      <button
        type="button"
        onClick={() => void workspace.openNewTerminalPane({ placement: { direction: "within", sourcePaneId: "pane-terminal-1" } })}
      >
        Open terminal tab
      </button>
      <button type="button" onClick={() => workspace.closePane("pane-terminal-1", { panes: [{ id: "pane-thread-1" }] })}>
        Close existing terminal
      </button>
      <button type="button" onClick={() => workspace.threadActions.onArchiveThread?.("thread-1")}>
        Archive thread
      </button>
    </>
  );
}

function appSurfacePresentationEvent(action: "focus" | "open", seq: number): EventEnvelope {
  return {
    codexMethod: null,
    id: `event-app-surface-presentation-${seq}`,
    itemId: null,
    kind: "app_surface.presentation_requested",
    payload: {
      action,
      sessionId: "session-1",
      threadId: "thread-1",
      title: "App Surface",
    },
    projectId: null,
    receivedAt: "2026-05-01T00:00:00Z",
    seq,
    threadId: "thread-1",
    turnId: null,
  };
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

function appSurfacePane(id: string, threadId: string): WorkspacePane {
  return {
    id,
    kind: "appSurface",
    target: { mode: "latest", threadId },
    title: "App Surface",
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
