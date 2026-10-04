import { describe, expect, it, vi } from "vitest";

import { setKodexAppBadge } from "./browserBadge";

describe("setKodexAppBadge", () => {
  it("delegates a controlled page to the worker's fresh shared read instead of racing tab-local badge counts", async () => {
    const originalWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
    const originalSet = navigator.setAppBadge;
    const postMessage = vi.fn();
    const setAppBadge = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: { postMessage } } });
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: setAppBadge });
    try {
      await expect(setKodexAppBadge(99)).resolves.toBe(true);
      expect(postMessage).toHaveBeenCalledWith({ type: "REFRESH_BADGE" });
      expect(setAppBadge).not.toHaveBeenCalled();
    } finally {
      if (originalWorker) Object.defineProperty(navigator, "serviceWorker", originalWorker);
      else Reflect.deleteProperty(navigator, "serviceWorker");
      Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: originalSet });
    }
  });
  it("degrades when badging is unsupported", async () => {
    const originalSet = navigator.setAppBadge;
    const originalClear = navigator.clearAppBadge;
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: undefined });

    await expect(setKodexAppBadge(1)).resolves.toBe(false);

    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: originalSet });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: originalClear });
  });

  it("sets and clears app badges", async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    const originalSet = navigator.setAppBadge;
    const originalClear = navigator.clearAppBadge;
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: setAppBadge });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: clearAppBadge });

    await expect(setKodexAppBadge(3)).resolves.toBe(true);
    await expect(setKodexAppBadge(0)).resolves.toBe(true);
    expect(setAppBadge).toHaveBeenCalledWith(3);
    expect(clearAppBadge).toHaveBeenCalledTimes(1);

    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: originalSet });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: originalClear });
  });
});
