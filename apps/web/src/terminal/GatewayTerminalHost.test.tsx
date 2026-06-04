import { MantineProvider } from "@mantine/core";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalSessionInfo } from "../api/client";
import { GatewayTerminalHost } from "./GatewayTerminalHost";
import { useGatewayTerminalSession } from "./useGatewayTerminalSession";

const xtermMock = vi.hoisted(() => ({
  onConnectionStateChange: null as null | ((state: "closed" | "connecting" | "error" | "open") => void),
}));

vi.mock("./XtermTerminal", () => ({
  XtermTerminal: ({
    inputSignal,
    onConnectionStateChange,
    webSocketUrl,
  }: {
    inputSignal?: { data: string; id: number } | null;
    onConnectionStateChange?: (state: "closed" | "connecting" | "error" | "open") => void;
    webSocketUrl: string;
  }) => {
    xtermMock.onConnectionStateChange = onConnectionStateChange ?? null;
    return <div data-input-signal={inputSignal?.data ?? ""} data-testid="xterm-terminal" data-websocket-url={webSocketUrl} />;
  },
}));

vi.mock("./useGatewayTerminalSession", () => ({
  useGatewayTerminalSession: vi.fn(),
}));

vi.mock("../api/client", async (importActual) => {
  const actual = await importActual<typeof import("../api/client")>();
  return {
    ...actual,
    terminalWebSocketUrl: (terminalId: string) => `ws://localhost/v1/terminals/${terminalId}/ws`,
  };
});

const createNewSession = vi.fn();
const recoverSession = vi.fn();
const stopSession = vi.fn();
const session: TerminalSessionInfo = {
  command: "/bin/zsh",
  createdAt: "2026-06-04T20:00:00Z",
  cwd: "/Users/example/kodex",
  historySizeBytes: 0,
  id: "terminal-1",
  status: "running",
  title: "kodex: /bin/zsh",
};

describe("GatewayTerminalHost", () => {
  beforeEach(() => {
    createNewSession.mockReset();
    recoverSession.mockReset();
    stopSession.mockReset();
    xtermMock.onConnectionStateChange = null;
    vi.mocked(useGatewayTerminalSession).mockReturnValue({
      createNewSession,
      error: null,
      isLoading: false,
      recoverSession,
      session,
      stopSession,
    });
  });

  it("renders an active session in the terminal viewport", () => {
    render(
      <MantineProvider>
        <GatewayTerminalHost opened onClose={() => undefined} />
      </MantineProvider>,
    );

    expect(screen.getByText("kodex: /bin/zsh")).toBeInTheDocument();
    expect(screen.getByText("/Users/example/kodex")).toBeInTheDocument();
    expect(screen.getByTestId("xterm-terminal")).toHaveAttribute(
      "data-websocket-url",
      "ws://localhost/v1/terminals/terminal-1/ws",
    );
  });

  it("keeps session controls delegated to the terminal hook", async () => {
    const onClose = vi.fn();
    render(
      <MantineProvider>
        <GatewayTerminalHost opened onClose={onClose} />
      </MantineProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop terminal" }));
    await userEvent.click(screen.getByRole("button", { name: "Close terminal" }));

    expect(createNewSession).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("forwards accessory key input into the terminal viewport", async () => {
    render(
      <MantineProvider>
        <GatewayTerminalHost opened onClose={() => undefined} />
      </MantineProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Tab" }));

    expect(screen.getByTestId("xterm-terminal")).toHaveAttribute("data-input-signal", "\t");
  });

  it("shows reconnectable feedback when the websocket reports an error", async () => {
    render(
      <MantineProvider>
        <GatewayTerminalHost opened onClose={() => undefined} />
      </MantineProvider>,
    );

    act(() => {
      xtermMock.onConnectionStateChange?.("error");
    });

    expect(screen.getByText("Terminal connection failed.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reconnect terminal" }));

    expect(recoverSession).toHaveBeenCalledTimes(1);
  });

  it("shows the loading state before a session is available", () => {
    vi.mocked(useGatewayTerminalSession).mockReturnValue({
      createNewSession,
      error: null,
      isLoading: true,
      recoverSession,
      session: null,
      stopSession,
    });

    render(
      <MantineProvider>
        <GatewayTerminalHost opened onClose={() => undefined} />
      </MantineProvider>,
    );

    expect(screen.getByText("Starting terminal")).toBeInTheDocument();
    expect(screen.queryByTestId("xterm-terminal")).not.toBeInTheDocument();
  });
});
