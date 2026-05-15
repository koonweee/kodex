import { describe, expect, it, vi } from "vitest";

import { registerKodexServiceWorker } from "./registerServiceWorker";

describe("registerKodexServiceWorker", () => {
  it("returns unsupported when service workers are unavailable", async () => {
    const original = navigator.serviceWorker;
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });

    await expect(registerKodexServiceWorker()).resolves.toEqual({ registered: false, reason: "unsupported" });

    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: original });
  });

  it("registers the root service worker when supported", async () => {
    const register = vi.fn().mockResolvedValue({ scope: "/" });
    const originalServiceWorker = navigator.serviceWorker;
    const originalSecureContext = window.isSecureContext;
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register } });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });

    const result = await registerKodexServiceWorker();

    expect(result.registered).toBe(true);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: originalServiceWorker });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: originalSecureContext });
  });
});
