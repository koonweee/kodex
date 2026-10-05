import { act, render, waitFor } from "@testing-library/react";
import type { ITerminalOptions } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { XtermTerminal } from "./XtermTerminal";

const xtermMock = vi.hoisted(() => ({
  instances: [] as Array<{
    cols: number;
    dispose: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    options: ITerminalOptions;
    rows: number;
    write: ReturnType<typeof vi.fn>;
  }>,
  Terminal: class MockXterm {
    cols = 80;
    rows = 24;
    options: ITerminalOptions;

    constructor(options: ITerminalOptions) {
      this.options = options;
      xtermMock.instances.push(this);
    }

    dispose = vi.fn();
    focus = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    open = vi.fn();
    write = vi.fn();
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: xtermMock.Terminal,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    fit = vi.fn();
  },
}));

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  binaryType: BinaryType = "blob";
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readyState = MockWebSocket.CONNECTING;

  constructor(readonly url: string) { MockWebSocket.instances.push(this); }

  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
  send = vi.fn();
}

describe("XtermTerminal live theme updates", () => {
  const originalGetComputedStyle = window.getComputedStyle;

  beforeEach(() => {
    xtermMock.instances = [];
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () =>
        ({
          getPropertyValue: (name: string) => {
            const scheme = document.documentElement.getAttribute("data-kodex-color-scheme");
            const values =
              scheme === "light"
                ? {
                    "--kodex-bg-selected-strong": "rgb(205, 220, 255)",
                    "--kodex-terminal-bg": "rgb(250, 250, 250)",
                    "--kodex-text-primary": "rgb(10, 10, 10)",
                  }
                : {
                    "--kodex-bg-selected-strong": "rgb(35, 50, 80)",
                    "--kodex-terminal-bg": "rgb(15, 15, 15)",
                    "--kodex-text-primary": "rgb(240, 240, 240)",
                  };
            return values[name as keyof typeof values] ?? "";
          },
        }) as CSSStyleDeclaration,
    );
    document.documentElement.setAttribute("data-kodex-color-scheme", "dark");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.getComputedStyle = originalGetComputedStyle;
    document.documentElement.removeAttribute("data-kodex-color-scheme");
  });

  it("reapplies xterm theme options when the Kodex theme attribute changes", async () => {
    render(<XtermTerminal webSocketUrl="ws://localhost/terminal" />);

    expect(xtermMock.instances[0]?.options.theme).toMatchObject({
      background: "rgb(15, 15, 15)",
      foreground: "rgb(240, 240, 240)",
    });

    document.documentElement.setAttribute("data-kodex-color-scheme", "light");

    await waitFor(() => {
      expect(xtermMock.instances[0]?.options.theme).toMatchObject({
        background: "rgb(250, 250, 250)",
        foreground: "rgb(10, 10, 10)",
        selectionBackground: "rgb(205, 220, 255)",
      });
    });
  });

  it("keeps an attached shell connected when its status callback changes during Stop", () => {
    const initial = vi.fn();
    const latest = vi.fn();
    const view = render(<XtermTerminal webSocketUrl="ws://localhost/terminal" onConnectionStateChange={initial} />);
    const socket = MockWebSocket.instances[0]!;
    act(() => socket.onopen?.(new Event("open")));
    expect(initial).toHaveBeenLastCalledWith("open");

    view.rerender(<XtermTerminal webSocketUrl="ws://localhost/terminal" onConnectionStateChange={latest} />);
    expect(socket.close).not.toHaveBeenCalled();
    expect(xtermMock.instances[0]!.dispose).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => socket.onclose?.(new CloseEvent("close")));
    expect(latest).toHaveBeenLastCalledWith("closed");
    expect(initial).toHaveBeenLastCalledWith("open");
  });

  it("closes the old attachment when the shell target changes", () => {
    const state = vi.fn();
    const view = render(<XtermTerminal webSocketUrl="ws://localhost/old" onConnectionStateChange={state} />);
    const socket = MockWebSocket.instances[0]!;
    view.rerender(<XtermTerminal webSocketUrl="ws://localhost/new" onConnectionStateChange={state} />);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(xtermMock.instances[0]!.dispose).toHaveBeenCalledOnce();
    expect(MockWebSocket.instances.map((socket) => socket.url)).toEqual(["ws://localhost/old", "ws://localhost/new"]);
    act(() => MockWebSocket.instances[1]!.onopen?.(new Event("open")));
    expect(state).toHaveBeenLastCalledWith("open");
  });
});
