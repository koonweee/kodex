import type { DesktopBridge, ViewerState } from "./bridge";

// One owner per mounted viewer. Hidden tabs retain this owner and their socket.
export function createDesktopConnection(bridge: DesktopBridge, changed: (state: ViewerState) => void) {
  let disposed = false;
  let attempts = 0;
  let epoch = 0;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let state: ViewerState = { status: "connecting", keyboardOpen: false };
  function clearRetry() { clearTimeout(timer); timer = undefined; }
  function connect() {
    if (disposed) return;
    clearRetry(); epoch++;
    bridge.connect();
  }
  const unsubscribe = bridge.subscribe((next) => {
    if (disposed) return;
    if ((!state.displayLoading && next.displayLoading) || state.selectedDisplay !== next.selectedDisplay) epoch++;
    state = next;
    changed(next);
    if (next.status === "connected") { attempts = 0; clearRetry(); }
    else if (next.status === "connecting" || !next.retryable) clearRetry();
    else if (!timer) {
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5));
      timer = setTimeout(connect, delay);
    }
  });
  connect();
  return {
    reconnect() { if (!disposed) { attempts = 0; connect(); } },
    setActive(next: boolean) {
      if (disposed) return;
      if (active && !next) epoch++;
      active = next; bridge.setActive(next);
    },
    setDisplay(id: number) { if (!disposed) { epoch++; bridge.setDisplay(id); } },
    setTrackpad(enabled: boolean) { if (!disposed) bridge.setTrackpad(enabled); },
    setKeyboard(open: boolean) { if (!disposed) bridge.setKeyboard(open); },
    async pasteFromClipboard(read?: () => Promise<string>) {
      if (disposed || !active || state.status !== "connected" || state.displayLoading || state.displayError) throw new Error("Desktop is disconnected or closed.");
      if (!read) throw new Error("Clipboard reading is unavailable in this browser.");
      const attempt = epoch;
      let text: string;
      try { text = await read(); } catch { throw new Error("Clipboard permission was denied."); }
      if (disposed || !active || epoch !== attempt || state.status !== "connected") throw new Error("Desktop changed or closed before paste.");
      if (!text) throw new Error("The clipboard is empty.");
      await bridge.paste(text);
    },
    dispose() {
      if (disposed) return;
      disposed = true; epoch++; clearRetry(); unsubscribe(); bridge.disconnect();
    },
  };
}
