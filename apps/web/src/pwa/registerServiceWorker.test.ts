import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getPwaUpdateState,
  getServiceWorkerRegistration,
  registerKodexServiceWorker,
  registerPwaServiceWorker,
  resetPwaServiceWorkerStateForTests,
  setPwaReloadForTests,
  setRegisterSWLoaderForTests,
  subscribeToPwaUpdates,
} from "./registerServiceWorker";
import type { RegisterSWOptions } from "vite-plugin-pwa/types";

afterEach(() => {
  resetPwaServiceWorkerStateForTests();
  vi.clearAllMocks();
});

describe("registerKodexServiceWorker", () => {
  it("returns unsupported when service workers are unavailable", async () => {
    const original = navigator.serviceWorker;
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });

    await expect(registerKodexServiceWorker()).resolves.toEqual({ registered: false, reason: "unsupported" });

    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: original });
  });

  it("registers through vite-plugin-pwa and exposes update state", async () => {
    let registerOptions: RegisterSWOptions | undefined;
    const updateServiceWorker = vi.fn().mockResolvedValue(undefined);
    const listener = vi.fn();
    const controllerChangeListeners: Array<() => void> = [];
    const reloadPage = vi.fn();
    const originalServiceWorker = navigator.serviceWorker;
    const originalSecureContext = window.isSecureContext;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: vi.fn((eventName: string, listener: () => void) => {
          if (eventName === "controllerchange") {
            controllerChangeListeners.push(listener);
          }
        }),
        getRegistration: vi.fn().mockResolvedValue({ scope: "/" }),
        ready: Promise.resolve({ scope: "/" }),
      },
    });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    setRegisterSWLoaderForTests(() =>
      Promise.resolve((options) => {
        registerOptions = options;
        options?.onRegisteredSW?.("/sw.js", { scope: "/" } as ServiceWorkerRegistration);
        return updateServiceWorker;
      }),
    );
    setPwaReloadForTests(reloadPage);
    subscribeToPwaUpdates(listener);

    await registerPwaServiceWorker();
    registerOptions?.onNeedRefresh?.();
    await getPwaUpdateState().updateServiceWorker?.();

    expect(registerOptions?.immediate).toBe(true);
    expect(listener).toHaveBeenLastCalledWith({
      needRefresh: true,
      updateServiceWorker: expect.any(Function),
    });
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
    expect(controllerChangeListeners).toHaveLength(1);
    controllerChangeListeners[0]();
    expect(reloadPage).toHaveBeenCalledTimes(1);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: originalServiceWorker });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: originalSecureContext });
  });

  it("returns the active browser service worker registration", async () => {
    const registration = { scope: "/" } as ServiceWorkerRegistration;
    const getRegistration = vi.fn().mockResolvedValue(registration);
    const original = navigator.serviceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration,
        ready: Promise.resolve({ scope: "/ready" } as ServiceWorkerRegistration),
      },
    });
    setRegisterSWLoaderForTests(() =>
      Promise.resolve((options) => {
        options?.onRegisteredSW?.("/sw.js", registration);
        return vi.fn();
      }),
    );

    await expect(getServiceWorkerRegistration()).resolves.toBe(registration);
    await expect(registerKodexServiceWorker()).resolves.toEqual({ registered: true, registration });

    expect(getRegistration).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: original });
  });

  it("falls back to the active browser registration when the PWA callback omits it", async () => {
    const registration = { scope: "/" } as ServiceWorkerRegistration;
    const getRegistration = vi.fn().mockResolvedValue(registration);
    const original = navigator.serviceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration,
        ready: Promise.resolve({ scope: "/ready" } as ServiceWorkerRegistration),
      },
    });
    setRegisterSWLoaderForTests(() =>
      Promise.resolve((options) => {
        options?.onRegisteredSW?.("/sw.js", undefined);
        return vi.fn();
      }),
    );

    await expect(getServiceWorkerRegistration()).resolves.toBe(registration);

    expect(getRegistration).toHaveBeenCalledTimes(1);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: original });
  });

  it("returns failed when vite-plugin-pwa registration fails", async () => {
    const registrationError = new Error("registration failed");
    const onRegisterError = vi.fn();
    const original = navigator.serviceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: vi.fn(),
        ready: Promise.resolve({ scope: "/" } as ServiceWorkerRegistration),
      },
    });
    setRegisterSWLoaderForTests(() => Promise.reject(registrationError));

    await expect(registerPwaServiceWorker({ onRegisterError })).resolves.toEqual({
      registered: false,
      error: registrationError,
      reason: "failed",
    });

    expect(onRegisterError).toHaveBeenCalledWith(registrationError);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: original });
  });

  it("settles failed when the PWA registration callback reports an error", async () => {
    const registrationError = new Error("workbox register failed");
    const onRegisterError = vi.fn();
    const original = navigator.serviceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue(null),
        ready: new Promise(() => undefined),
      },
    });
    setRegisterSWLoaderForTests(() =>
      Promise.resolve((options) => {
        options?.onRegisterError?.(registrationError);
        return vi.fn().mockResolvedValue(undefined);
      }),
    );

    await expect(registerPwaServiceWorker({ onRegisterError })).resolves.toEqual({
      registered: false,
      error: registrationError,
      reason: "failed",
    });

    expect(onRegisterError).toHaveBeenCalledWith(registrationError);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: original });
  });
});
