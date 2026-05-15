import { describe, expect, it, vi } from "vitest";

import { setKodexAppBadge } from "./browserBadge";

describe("setKodexAppBadge", () => {
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
