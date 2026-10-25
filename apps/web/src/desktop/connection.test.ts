import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge, ViewerState } from "./bridge";
import { createDesktopConnection } from "./connection";

function viewer() {
  let listener: (state: ViewerState) => void = () => {};
  const bridge: DesktopBridge = {
    subscribe: vi.fn((next) => { listener = next; return vi.fn(); }),
    connect: vi.fn(() => listener({ status: "connecting", keyboardOpen: false })),
    disconnect: vi.fn(), setActive: vi.fn(), setTrackpad: vi.fn(), setKeyboard: vi.fn(), paste: vi.fn(async () => {}),
  };
  return { bridge, emit: (state: ViewerState) => listener(state) };
}
const failed: ViewerState = { status: "disconnected", keyboardOpen: false, failure: "connection", retryable: true };
const connected: ViewerState = { status: "connected", keyboardOpen: false };

describe("Desktop connection owner", () => {
  afterEach(() => vi.useRealTimers());
  it("opens automatically, retries once per failure with capped backoff, and resets after success", () => {
    vi.useFakeTimers();
    const { bridge, emit } = viewer();
    const connection = createDesktopConnection(bridge, vi.fn());
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = vi.mocked(bridge.connect).mock.calls.length;
      emit(failed); emit(failed);
      vi.advanceTimersByTime(delay - 1);
      expect(bridge.connect).toHaveBeenCalledTimes(before);
      vi.advanceTimersByTime(1);
      expect(bridge.connect).toHaveBeenCalledTimes(before + 1);
    }
    emit(connected); emit(failed);
    vi.advanceTimersByTime(1000);
    expect(bridge.connect).toHaveBeenCalledTimes(9);
    connection.dispose();
  });
  it("keeps hidden connections alive and ignores callbacks/timers after closing", () => {
    vi.useFakeTimers();
    const { bridge, emit } = viewer(); const changed = vi.fn();
    const connection = createDesktopConnection(bridge, changed);
    emit(connected); connection.setActive(false);
    expect(bridge.setActive).toHaveBeenCalledWith(false);
    expect(bridge.disconnect).not.toHaveBeenCalled();
    emit(failed); connection.dispose();
    const calls = changed.mock.calls.length;
    emit(failed); vi.advanceTimersByTime(60000); connection.reconnect();
    expect(changed).toHaveBeenCalledTimes(calls);
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    expect(bridge.disconnect).toHaveBeenCalledTimes(1);
  });
  it("stops for permanent failure and manual Reconnect replaces a queued retry", () => {
    vi.useFakeTimers();
    const { bridge, emit } = viewer(); const connection = createDesktopConnection(bridge, vi.fn());
    emit({ ...failed, failure: "authentication", retryable: false });
    vi.advanceTimersByTime(60000);
    expect(bridge.connect).toHaveBeenCalledTimes(1);
    connection.reconnect(); emit(failed); connection.reconnect();
    vi.advanceTimersByTime(60000);
    expect(bridge.connect).toHaveBeenCalledTimes(3);
    connection.dispose();
  });
  it("does not paste after a pending clipboard permission outlives reconnect or close", async () => {
    for (const action of ["reconnect", "dispose", "hide"] as const) {
      const { bridge, emit } = viewer(); const connection = createDesktopConnection(bridge, vi.fn()); emit(connected);
      let resolve!: (text: string) => void;
      const pending = connection.pasteFromClipboard(() => new Promise<string>((next) => { resolve = next; }));
      if (action === "hide") connection.setActive(false); else connection[action](); emit(connected); resolve("stale text");
      await expect(pending).rejects.toThrow(/changed|closed/);
      expect(bridge.paste).not.toHaveBeenCalled();
      connection.dispose();
    }
  });
  it("reports unavailable, denied and empty clipboards without sending text", async () => {
    const { bridge, emit } = viewer(); const connection = createDesktopConnection(bridge, vi.fn()); emit(connected);
    await expect(connection.pasteFromClipboard()).rejects.toThrow(/unavailable/);
    await expect(connection.pasteFromClipboard(async () => { throw new Error("denied"); })).rejects.toThrow(/denied/);
    await expect(connection.pasteFromClipboard(async () => "")).rejects.toThrow(/empty/);
    expect(bridge.paste).not.toHaveBeenCalled();
    await connection.pasteFromClipboard(async () => "explicit text");
    expect(bridge.paste).toHaveBeenCalledExactlyOnceWith("explicit text");
    connection.dispose();
  });
});
