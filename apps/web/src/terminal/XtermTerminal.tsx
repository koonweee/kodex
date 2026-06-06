import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

import { useInputCapabilities } from "../shared/inputCapabilities";
import { encodeTerminalBegin, encodeTerminalResize, encodeTerminalStdin } from "./terminalProtocol";

type XtermTerminalProps = {
  className?: string;
  inputSignal?: TerminalInputSignal | null;
  onConnectionStateChange?: (state: TerminalConnectionState) => void;
  webSocketUrl: string;
};

export type TerminalConnectionState = "closed" | "connecting" | "error" | "open";
export type TerminalInputSignal = {
  data: string;
  id: number;
};

export function XtermTerminal({ className, inputSignal, onConnectionStateChange, webSocketUrl }: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Xterm | null>(null);
  const { hasTouchInput } = useInputCapabilities();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    onConnectionStateChange?.("connecting");
    const terminal = new Xterm({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      disableStdin: false,
      fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace",
      fontSize: hasTouchInput ? 16 : 13,
      minimumContrastRatio: 4.5,
      scrollback: 5000,
      theme: terminalThemeColors(container),
    });
    const fitAddon = new FitAddon();
    terminalRef.current = terminal;
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    const socket = new WebSocket(webSocketUrl);
    socketRef.current = socket;
    socket.binaryType = "arraybuffer";

    const sendResize = () => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.send(encodeTerminalResize({ cols: terminal.cols, rows: terminal.rows }));
    };

    const fitTerminal = () => {
      try {
        fitAddon.fit();
        sendResize();
      } catch {
        // xterm can throw while the element has no measurable dimensions.
      }
    };

    const dataDisposable = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encodeTerminalStdin(data));
      }
    });
    const themeObserver =
      typeof MutationObserver === "function"
        ? new MutationObserver(() => {
            terminal.options.theme = terminalThemeColors(container);
          })
        : null;
    const resizeObserver =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => requestAnimationFrame(fitTerminal)) : null;
    const visualViewport = window.visualViewport;

    themeObserver?.observe(document.documentElement, {
      attributeFilter: ["data-kodex-color-scheme", "data-mantine-color-scheme"],
      attributes: true,
    });
    resizeObserver?.observe(container);
    window.addEventListener("orientationchange", fitTerminal);
    window.addEventListener("resize", fitTerminal);
    visualViewport?.addEventListener("resize", fitTerminal);
    requestAnimationFrame(fitTerminal);

    socket.onopen = () => {
      onConnectionStateChange?.("open");
      socket.send(encodeTerminalBegin());
      fitTerminal();
    };
    socket.onclose = () => onConnectionStateChange?.("closed");
    socket.onerror = () => onConnectionStateChange?.("error");
    socket.onmessage = (event) => {
      writeSocketMessage(terminal, event.data);
    };

    return () => {
      dataDisposable.dispose();
      themeObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("orientationchange", fitTerminal);
      window.removeEventListener("resize", fitTerminal);
      visualViewport?.removeEventListener("resize", fitTerminal);
      socket.close();
      terminal.dispose();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      if (terminalRef.current === terminal) {
        terminalRef.current = null;
      }
      onConnectionStateChange?.("closed");
    };
  }, [hasTouchInput, onConnectionStateChange, webSocketUrl]);

  useEffect(() => {
    if (!inputSignal) {
      return;
    }
    terminalRef.current?.focus();
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(encodeTerminalStdin(inputSignal.data));
    }
  }, [inputSignal]);

  return <div className={className} ref={containerRef} />;
}

export function terminalThemeColors(element: HTMLElement) {
  const styles = getComputedStyle(element);
  return {
    background: cssVariable(styles, "--kodex-terminal-bg", "#11151f"),
    cursor: cssVariable(styles, "--kodex-text-primary", "#f8fafc"),
    foreground: cssVariable(styles, "--kodex-text-primary", "#e5e7eb"),
    selectionBackground: cssVariable(styles, "--kodex-bg-selected-strong", "#40517a"),
  };
}

function cssVariable(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

function writeSocketMessage(terminal: Xterm, data: unknown) {
  if (typeof data === "string") {
    terminal.write(data);
    return;
  }
  if (data instanceof ArrayBuffer) {
    terminal.write(new Uint8Array(data));
    return;
  }
  if (data instanceof Blob) {
    data.arrayBuffer().then((buffer) => terminal.write(new Uint8Array(buffer)));
  }
}
