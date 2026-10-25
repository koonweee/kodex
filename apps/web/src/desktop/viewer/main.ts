import RFB from "@desktop-vendor/core/rfb.js";
import type { DesktopBridge, DesktopFailure, ViewerState } from "../bridge";
import { virtualKeyboard } from "./keyboard";
import "./viewer.css";

const screen = document.getElementById("screen")!;
const input = document.getElementById("keyboard") as HTMLTextAreaElement;
let rfb: RFB | null = null;
let socket: WebSocket | null = null;
let active = false;
let trackpad = true;
let generation = 0;
let state: ViewerState = { status: "disconnected", keyboardOpen: false };
const listeners = new Set<(state: ViewerState) => void>();
const failures: DesktopFailure[] = ["unsupportedPlatform", "configuration", "authentication", "passwordAccessDisabled", "protocol", "connection", "timeout"];
function update(next: ViewerState) { state = next; for (const listener of listeners) listener(state); }
const keyboard = virtualKeyboard(input, () => rfb, (keyboardOpen) => update({ ...state, keyboardOpen }));
let cancelPaste: (() => void) | undefined;

function disconnect() {
  generation++;
  cancelPaste?.();
  keyboard.setOpen(false);
  rfb?.disconnect();
  socket?.close();
  rfb = null;
  socket = null;
  screen.replaceChildren();
}
const bridge: DesktopBridge = {
  subscribe(listener) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
  disconnect() { disconnect(); update({ status: "disconnected", keyboardOpen: false }); },
  connect() {
    disconnect();
    const attempt = generation;
    update({ status: "connecting", keyboardOpen: false });
    const url = new URL("/v1/desktop/ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = socket = new WebSocket(url);
    // Register before noVNC so the typed gateway failure wins over its generic
    // disconnect event. Native prose and browser credentials never cross here.
    let gatewayClose = false;
    let protocolFailure = false;
    ws.addEventListener("close", (event) => {
      if (attempt !== generation || protocolFailure) return;
      gatewayClose = true;
      cancelPaste?.();
      let failure: DesktopFailure = "connection";
      if (event.code === 4400 || event.code === 4500) {
        try {
          const reason: unknown = JSON.parse(event.reason);
          if (failures.includes(reason as DesktopFailure)) failure = reason as DesktopFailure;
        } catch { /* A malformed close is a protocol failure. */ }
        if (failure === "connection" && event.code === 4400) failure = "protocol";
      }
      keyboard.setOpen(false);
      update({ status: "disconnected", keyboardOpen: false, failure, retryable: event.code !== 4400 });
    });
    const viewer = rfb = new RFB(screen, ws, { shared: true });
    viewer.viewOnly = false;
    viewer.scaleViewport = true;
    viewer.resizeSession = false;
    viewer.trackpadMode = trackpad;
    viewer.focusOnClick = active;
    viewer.addEventListener("connect", () => {
      if (attempt === generation) update({ status: "connected", keyboardOpen: false });
    });
    viewer.addEventListener("disconnect", () => {
      if (attempt === generation && !gatewayClose) {
        protocolFailure = true;
        cancelPaste?.();
        keyboard.setOpen(false);
        update({ status: "disconnected", keyboardOpen: false, failure: "protocol", retryable: false });
      }
    });
    viewer.addEventListener("credentialsrequired", () => {
      if (attempt !== generation) return;
      bridge.disconnect();
      update({ status: "disconnected", keyboardOpen: false, failure: "protocol", retryable: false });
    });
    bridge.setActive(active);
  },
  setActive(value) {
    active = value;
    document.documentElement.inert = !value;
    keyboard.setActive(value);
    if (rfb) { rfb.focusOnClick = value; if (!value) rfb.blur(); }
  },
  setTrackpad(value) { trackpad = value; if (rfb) rfb.trackpadMode = value; },
  setKeyboard(open) { keyboard.setOpen(open && state.status === "connected"); },
  async paste(text) {
    const viewer = rfb;
    if (!viewer || state.status !== "connected") throw new Error("Desktop is disconnected.");
    if (!text) throw new Error("The clipboard is empty.");
    if (new TextEncoder().encode(text).byteLength > 65536) throw new Error("Clipboard text exceeds 64 KiB.");
    if (cancelPaste) throw new Error("A paste is already in progress.");
    if (!viewer.clipboardSupportsUnicode && /[^\u0000-\u00ff]/u.test(text)) {
      throw new Error("This Mac connection does not support Unicode clipboard text.");
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        viewer.removeEventListener("clipboardwritten", written);
        cancelPaste = undefined;
        if (error) reject(error); else resolve();
      };
      const written = () => finish();
      const timeout = setTimeout(() => finish(new Error("The Mac did not accept clipboard text.")), 3000);
      cancelPaste = () => finish(new Error("Desktop disconnected before paste."));
      viewer.addEventListener("clipboardwritten", written);
      try { viewer.clipboardPasteFrom(text); } catch { finish(new Error("Clipboard text could not be sent.")); }
    });
    if (viewer !== rfb || state.status !== "connected") throw new Error("Desktop disconnected before paste.");
    // macOS Command-V. Clipboard bytes are queued before the shortcut, including
    // the extended clipboard request/provide round trip. Always release Meta.
    viewer.sendKey(0xffeb, "MetaLeft", true);
    try { viewer.sendKey(0x76, "KeyV"); }
    finally { viewer.sendKey(0xffeb, "MetaLeft", false); }
  },
};
window.kodexDesktop = bridge;
// Pal's vendor gesture suppression: prevent iOS native zoom, retain local RFB zoom.
for (const event of ["gesturestart", "gesturechange"]) {
  document.addEventListener(event, (e) => { if ("scale" in e) e.preventDefault(); }, { passive: false });
}
window.addEventListener("pagehide", (event) => {
  const interrupted = state.status !== "disconnected";
  disconnect();
  keyboard.setActive(false);
  // Preserve an already-disconnected typed failure, especially a permanent one.
  if (interrupted) update({ status: "disconnected", keyboardOpen: false, failure: "connection", retryable: event.persisted });
  // A persisted document keeps its handlers when restored from bfcache.
  if (!event.persisted) keyboard.dispose();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) bridge.setActive(active);
});
