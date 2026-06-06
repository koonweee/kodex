import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalSessionInfo } from "../../api/client";
import { useGatewayTerminalSession } from "../../terminal/useGatewayTerminalSession";
import type { WorkspacePane } from "../../workspace/paneTypes";
import { TerminalPane } from "./TerminalPane";

const workspaceMocks = vi.hoisted(() => ({
  openTerminalPane: vi.fn(),
  setPaneHeaderActions: vi.fn(),
  setPaneTabStatus: vi.fn(),
  updatePane: vi.fn(),
}));

vi.mock("../../workspace/WorkspaceProvider", () => ({
  useWorkspace: () => ({
    openTerminalPane: workspaceMocks.openTerminalPane,
    setPaneHeaderActions: workspaceMocks.setPaneHeaderActions,
    setPaneTabStatus: workspaceMocks.setPaneTabStatus,
    updatePane: workspaceMocks.updatePane,
  }),
}));

vi.mock("../../terminal/useGatewayTerminalSession", () => ({
  useGatewayTerminalSession: vi.fn(),
}));

vi.mock("../../terminal/XtermTerminal", () => ({
  XtermTerminal: ({ inputSignal, webSocketUrl }: { inputSignal?: { data: string } | null; webSocketUrl: string }) => (
    <div data-input-signal={inputSignal?.data ?? ""} data-testid="xterm-terminal" data-websocket-url={webSocketUrl} />
  ),
}));

const session: TerminalSessionInfo = {
  command: "/bin/zsh",
  createdAt: "2026-06-04T20:00:00Z",
  cwd: "/tmp/worktree",
  historySizeBytes: 0,
  id: "terminal-1",
  status: "running",
  title: "worktree: /bin/zsh",
};

describe("TerminalPane", () => {
  beforeEach(() => {
    workspaceMocks.openTerminalPane.mockReset();
    workspaceMocks.openTerminalPane.mockResolvedValue(undefined);
    workspaceMocks.setPaneHeaderActions.mockReset();
    workspaceMocks.setPaneTabStatus.mockReset();
    workspaceMocks.updatePane.mockReset();
    workspaceMocks.updatePane.mockResolvedValue(undefined);
    vi.mocked(useGatewayTerminalSession).mockReset();
    vi.mocked(useGatewayTerminalSession).mockReturnValue({
      createNewSession: vi.fn(),
      error: null,
      isLoading: false,
      recoverSession: vi.fn(),
      session,
      stopSession: vi.fn(),
    });
  });

  it("creates an independent terminal session and persists its id into the pane target", async () => {
    renderTerminalPane(workspacePane({ cwd: "/tmp/worktree" }));

    expect(useGatewayTerminalSession).toHaveBeenCalledWith(true, {
      createRequest: { command: undefined, cwd: "/tmp/worktree", title: undefined },
      preferredTerminalId: null,
      reuseRunning: false,
    });
    await waitFor(() => {
      expect(workspaceMocks.updatePane).toHaveBeenCalledWith("pane-terminal", {
        target: {
          command: "/bin/zsh",
          cwd: "/tmp/worktree",
          terminalId: "terminal-1",
        },
        title: "worktree: /bin/zsh",
      });
    });
    expect(screen.getByTestId("xterm-terminal").getAttribute("data-websocket-url")).toContain(
      "/v1/terminals/terminal-1/ws",
    );
  });

  it("reuses the pane target terminal id without rewriting the pane", () => {
    renderTerminalPane(workspacePane({ terminalId: "terminal-1" }));

    expect(useGatewayTerminalSession).toHaveBeenCalledWith(true, {
      createRequest: { command: undefined, cwd: undefined, title: undefined },
      preferredTerminalId: "terminal-1",
      reuseRunning: false,
    });
    expect(workspaceMocks.updatePane).not.toHaveBeenCalled();
  });

  it("opens the terminal plus action as a sibling tab in the current tab group", async () => {
    renderTerminalPane(workspacePane({ terminalId: "terminal-1" }));
    const actions = workspaceMocks.setPaneHeaderActions.mock.calls.find(([paneId]) => paneId === "pane-terminal")?.[1];

    render(<MantineProvider>{actions}</MantineProvider>);
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));

    await waitFor(() => {
      expect(workspaceMocks.openTerminalPane).toHaveBeenCalledWith({
        cwd: "/tmp/worktree",
        placement: { direction: "within", sourcePaneId: "pane-terminal" },
      });
    });
    expect(vi.mocked(useGatewayTerminalSession).mock.results[0]?.value.createNewSession).not.toHaveBeenCalled();
  });

  it("does not render the terminal title, status, and cwd as an in-pane header", () => {
    renderTerminalPane(workspacePane({ terminalId: "terminal-1" }));

    expect(screen.queryByText("worktree: /bin/zsh")).not.toBeInTheDocument();
    expect(screen.queryByText("/tmp/worktree")).not.toBeInTheDocument();
  });
});

function renderTerminalPane(pane: WorkspacePane) {
  return render(
    <MantineProvider>
      <TerminalPane isActive pane={pane} />
    </MantineProvider>,
  );
}

function workspacePane(target: Record<string, unknown>): WorkspacePane {
  return {
    id: "pane-terminal",
    kind: "terminal",
    target,
    title: null,
  };
}
