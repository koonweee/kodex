import type RFB from "@desktop-vendor/core/rfb.js";
import type { components } from "../../api/generated/schema";
import type { DesktopDisplay } from "../bridge";

type Target = components["schemas"]["DisplayTarget"];
// One iframe/selection; gateway-owned logical geometry identifies the virtual
// display without confusing physical CoreGraphics IDs with native VNC IDs.
export function createMonitorSelection(viewer: () => RFB | null, changed: () => void, cancelPaste: () => void,
  failed: (failure: "protocol" | "timeout" | "connection", retryable: boolean) => void,
  readPreferred: (signal: AbortSignal) => Promise<Target | null>) {
  let displays: DesktopDisplay[] = [];
  let keys = new Map<number, string>();
  let selectedDisplay: number | undefined;
  let pending: number | undefined;
  let wanted: string | undefined;
  let displayError: string | undefined;
  let displayLoading = false;
  let preferred: Target | null | undefined;
  let resolving = false;
  let revision = 0;
  let targetRead: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clearDeadline() { clearTimeout(timer); timer = undefined; }
  function cancelRead() { revision++; targetRead?.abort(); targetRead = undefined; resolving = false; }
  function fail(failure: "protocol" | "timeout" | "connection", retryable: boolean) {
    clearDeadline(); cancelRead(); displayLoading = false;
    displayError = failure === "timeout" ? "The Mac display did not respond. Reconnect to try again."
      : failure === "connection" ? "The Mac virtual display is unavailable. Reconnecting." : "The Mac returned unsupported display information.";
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
  function ready(target: RFB) {
    if (resolving || !displayLoading || !target.desktopReady || target.desktopInfo?.selectedDisplay !== selectedDisplay) return;
    clearDeadline(); displayLoading = false; displayError = undefined;
    target.viewOnly = false; changed();
  }
  function apply(target: RFB, info: NonNullable<RFB["desktopInfo"]>, preferred: Target | null) {
    if (info.displays.length) {
      const ordered = [...info.displays].sort((a, b) => Number(b.main) - Number(a.main) || a.x - b.x || a.y - b.y || a.id - b.id);
      if (ordered.filter((display) => display.main).length !== 1) { fail("protocol", false); return; }
      const virtual = preferred ? ordered.filter(display => display.x === preferred.x && display.y === preferred.y && display.width === preferred.width && display.height === preferred.height) : [];
      keys = new Map(ordered.map(display => [display.id, display.main ? "main" : JSON.stringify([display.x, display.y, display.width, display.height])]));
      displays = ordered.map((display, index) => ({id: display.id, isMain: display.main,
        name: `${display.main ? "Main display" : virtual.length === 1 && virtual[0].id === display.id ? "Kodex display" : `Display ${index + 1}`} (${display.width} × ${display.height})`}));
      if (selectedDisplay === undefined || !keys.has(selectedDisplay) || keys.get(selectedDisplay) !== wanted) {
        const matches = ordered.filter(display => keys.get(display.id) === wanted);
        const fallback = preferred ? (virtual.length === 1 ? virtual[0] : undefined) : ordered.find(display => display.main);
        const selection = matches.length === 1 ? matches[0] : fallback;
        // Wait for fresh native inventory rather than selecting a physical display
        // when the new virtual display has not appeared in Screen Sharing yet.
        if (!selection) { changed(); return; }
        selectedDisplay = selection.id;
      }
      wanted = keys.get(selectedDisplay);
    }
    if (selectedDisplay === undefined) return;
    if (info.selectedDisplay === selectedDisplay) {
      pending = undefined;
      if (info.displays.length) target.selectDesktopDisplay(selectedDisplay);
    } else request(target, selectedDisplay);
    changed(); ready(target);
  }
  return {
    state: () => ({displays, selectedDisplay, displayLoading, displayError}),
    refresh,
    begin() { clearDeadline(); cancelRead(); preferred = undefined; displays = []; keys.clear(); selectedDisplay = pending = undefined; displayLoading = true; displayError = undefined; },
    cancel() { clearDeadline(); cancelRead(); pending = undefined; displayLoading = false; },
    connected(target: RFB) {
      if (!target.appleDesktop) { displayLoading = false; target.viewOnly = false; changed(); return; }
      if (displayLoading) deadline();
      cancelRead(); resolving = true;
      const current = revision;
      const controller = targetRead = new AbortController();
      void readPreferred(controller.signal).then(value => {
        if (current !== revision || target !== viewer()) return;
        preferred = value; resolving = false; targetRead = undefined;
        if (target.desktopInfo) apply(target, target.desktopInfo, preferred);
      }).catch(() => { if (current === revision && target === viewer()) fail("connection", true); });
    },
    receive(target: RFB) {
      const info = target.desktopInfo;
      if (!info) return;
      refresh();
      // Selection must run inside this event: RFB validates the selected scale
      // before returning from it. Resolve gateway identity once per connection.
      if (preferred !== undefined) apply(target, info, preferred);
    },
    ready,
    select(id: number) {
      const target = viewer();
      if (!target || displayLoading || displayError || id === selectedDisplay || !keys.has(id)) return;
      cancelPaste(); target.viewOnly = true;
      selectedDisplay = id; wanted = keys.get(id); displayLoading = true;
      request(target, id); changed();
    },
  };
}
