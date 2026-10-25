import type RFB from "@desktop-vendor/core/rfb.js";
import type { DesktopDisplay } from "../bridge";

// One iframe, one selected native monitor. IDs belong to the current server
// inventory; geometry is used only to recognize a selection after renumbering.
export function createMonitorSelection(viewer: () => RFB | null, changed: () => void, cancelPaste: () => void,
  failed: (failure: "protocol" | "timeout", retryable: boolean) => void) {
  let displays: DesktopDisplay[] = [];
  let keys = new Map<number, string>();
  let selectedDisplay: number | undefined;
  let pending: number | undefined;
  let wanted: string | undefined;
  let displayError: string | undefined;
  let displayLoading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clearDeadline() { clearTimeout(timer); timer = undefined; }
  function fail(failure: "protocol" | "timeout", retryable: boolean) {
    clearDeadline(); displayLoading = false;
    displayError = failure === "timeout" ? "The Mac display did not respond. Reconnect to try again." : "The Mac returned unsupported display information.";
    changed(); failed(failure, retryable);
  }
  function deadline() { clearDeadline(); timer = setTimeout(() => fail("timeout", true), 5000); }
  function refresh() {
    cancelPaste(); displayLoading = true; displayError = undefined;
    if (timer === undefined) deadline();
    changed();
  }
  function request(target: RFB, id: number) {
    if (pending === id) return;
    pending = id; target.selectDesktopDisplay(id); deadline();
  }
  return {
    state: () => ({ displays, selectedDisplay, displayLoading, displayError }),
    refresh,
    begin() { clearDeadline(); displays = []; keys.clear(); selectedDisplay = pending = undefined; displayLoading = true; displayError = undefined; },
    cancel() { clearDeadline(); pending = undefined; displayLoading = false; },
    connected(target: RFB) {
      if (target.appleDesktop) { if (displayLoading) deadline(); }
      else { displayLoading = false; target.viewOnly = false; changed(); }
    },
    receive(target: RFB) {
      const info = target.desktopInfo;
      if (!info) return;
      refresh();
      if (info.displays.length) {
        const ordered = [...info.displays].sort((a, b) => Number(b.main) - Number(a.main) || a.x - b.x || a.y - b.y || a.id - b.id);
        if (ordered.filter((display) => display.main).length !== 1) { fail("protocol", false); return; }
        keys = new Map(ordered.map((display) => [display.id, display.main ? "main" : JSON.stringify([display.x, display.y, display.width, display.height])]));
        displays = ordered.map((display, index) => ({ id: display.id, isMain: display.main,
          name: `${display.main ? "Main display" : `Display ${index + 1}`} (${display.width} × ${display.height})` }));
        if (selectedDisplay === undefined || !keys.has(selectedDisplay) || keys.get(selectedDisplay) !== wanted) {
          const matches = displays.filter((display) => keys.get(display.id) === wanted);
          selectedDisplay = (matches.length === 1 ? matches[0] : displays.find((display) => display.isMain))!.id;
        }
        wanted = keys.get(selectedDisplay);
      }
      if (selectedDisplay === undefined) return;
      if (info.selectedDisplay === selectedDisplay) {
        pending = undefined;
        // Also tells the RFB owner which acknowledged framebuffer to request.
        if (info.displays.length) target.selectDesktopDisplay(selectedDisplay);
      } else request(target, selectedDisplay);
      changed();
    },
    ready(target: RFB) {
      if (!displayLoading || !target.desktopReady || target.desktopInfo?.selectedDisplay !== selectedDisplay) return;
      clearDeadline(); displayLoading = false; displayError = undefined;
      target.viewOnly = false; changed();
    },
    select(id: number) {
      const target = viewer();
      if (!target || displayLoading || displayError || id === selectedDisplay || !keys.has(id)) return;
      cancelPaste(); target.viewOnly = true;
      selectedDisplay = id; wanted = keys.get(id); displayLoading = true;
      request(target, id); changed();
    },
  };
}
