import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getPwaUpdateState,
  getServiceWorkerRegistration,
  registerKodexServiceWorker,
  registerPwaServiceWorker,
  resetPwaServiceWorkerStateForTests,
  setRegisterSWLoaderForTests,
  subscribeToPwaUpdates,
} from "./registerServiceWorker";
import type { RegisterSWOptions } from "vite-plugin-pwa/types";

afterEach(() => {
  resetPwaServiceWorkerStateForTests();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("registerKodexServiceWorker", () => {
  it("checks for updates in an open tab and when it returns to the foreground", async () => {
    vi.useFakeTimers();
    const original = navigator.serviceWorker;
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const update = vi.fn().mockResolvedValue(undefined);
    const registration = { scope: "/", update } as unknown as ServiceWorkerRegistration;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: Object.assign(new EventTarget(), { getRegistration: vi.fn().mockResolvedValue(registration), controller: {} }),
    });
    setRegisterSWLoaderForTests(() => Promise.resolve((options) => {
      options?.onRegisteredSW?.("/sw.js", registration);
      return vi.fn().mockResolvedValue(undefined);
    }));

    try {
      await registerPwaServiceWorker();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(update).toHaveBeenCalledTimes(1);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(update).toHaveBeenCalledTimes(1);

      visibility.mockReturnValue("hidden");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(update).toHaveBeenCalledTimes(1);

      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      expect(update).toHaveBeenCalledTimes(2);
    } finally {
      resetPwaServiceWorkerStateForTests();
      visibility.mockRestore();
      vi.useRealTimers();
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: original });
    }
  });

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
    subscribeToPwaUpdates(listener);

    await registerPwaServiceWorker();
    controllerChangeListeners[0]();
    expect(getPwaUpdateState().needRefresh).toBe(false);
    registerOptions?.onNeedRefresh?.();
    await getPwaUpdateState().updateServiceWorker?.();

    expect(registerOptions?.immediate).toBe(true);
    expect(listener).toHaveBeenLastCalledWith({
      needRefresh: true,
      updateServiceWorker: expect.any(Function),
    });
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
    expect(controllerChangeListeners).toHaveLength(1);
    expect(registerOptions?.onNeedReload).toEqual(expect.any(Function));
    const pageReload = vi.fn();
    try {
      vi.stubGlobal("window", { location: { origin: window.location.origin, reload: pageReload } });
      registerOptions?.onNeedReload?.();
      expect(pageReload).not.toHaveBeenCalled();
      controllerChangeListeners[0]();
      registerOptions?.onNeedReload?.();
      controllerChangeListeners[0]();
      expect(pageReload).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: originalServiceWorker });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: originalSecureContext });
  });

  it("does not reload on a later worker activation after an update request failed", async () => {
    const pageReload = vi.fn();
    const original = navigator.serviceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: Object.assign(new EventTarget(), { getRegistration: vi.fn() }),
    });
    setRegisterSWLoaderForTests(() => Promise.resolve((options) => {
      options?.onRegisteredSW?.("/sw.js", { scope: "/" } as ServiceWorkerRegistration);
      return vi.fn().mockRejectedValue(new Error("update failed"));
    }));

    try {
      await registerPwaServiceWorker();
      vi.stubGlobal("window", { location: { origin: window.location.origin, reload: pageReload } });
      await expect(getPwaUpdateState().updateServiceWorker?.()).rejects.toThrow("update failed");
      navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
      expect(pageReload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: original });
    }
  });

  it("preserves a passive tab and reloads only the tab that explicitly accepts an update", async () => {
    const pageReload = vi.fn();
    const original = navigator.serviceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: Object.assign(new EventTarget(), { getRegistration: vi.fn(), controller: {} }),
    });
    setRegisterSWLoaderForTests(() => Promise.resolve((options) => {
      options?.onRegisteredSW?.("/sw.js", { scope: "/" } as ServiceWorkerRegistration);
      return vi.fn().mockResolvedValue(undefined);
    }));

    try {
      await registerPwaServiceWorker();
      vi.stubGlobal("window", { location: { origin: window.location.origin, reload: pageReload } });
      // Another tab's update can replace this controller even if this tab
      // missed the waiting-worker notification entirely.
      navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
      expect(getPwaUpdateState().needRefresh).toBe(true);
      expect(pageReload).not.toHaveBeenCalled();

      await getPwaUpdateState().updateServiceWorker?.();
      navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
      expect(pageReload).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: original });
    }
  });

  it.each(["callback", "delayed callback", "throw"])("removes its reload listener after a registration %s failure", async (failure) => {
    const original = navigator.serviceWorker;
    const worker = Object.assign(new EventTarget(), { getRegistration: vi.fn() });
    const remove = vi.spyOn(worker, "removeEventListener");
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
    setRegisterSWLoaderForTests(() => Promise.resolve((options) => {
      const error = new Error("registration failed");
      if (failure === "throw") throw error;
      if (failure === "delayed callback") queueMicrotask(() => options?.onRegisterError?.(error));
      else options?.onRegisterError?.(error);
      return vi.fn();
    }));
    try {
      await expect(registerPwaServiceWorker()).resolves.toMatchObject({ registered: false, reason: "failed" });
      expect(remove).toHaveBeenCalledWith("controllerchange", expect.any(Function));
      expect(getPwaUpdateState().updateServiceWorker).toBeNull();
    } finally {
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: original });
    }
  });

  it("does not register a worker against a separate API origin", async () => {
    const original = navigator.serviceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: vi.fn() },
    });
    vi.stubEnv("VITE_KODEX_API_BASE_URL", "https://another-gateway.example");
    const loader = vi.fn().mockRejectedValue(new Error("should not register"));
    setRegisterSWLoaderForTests(loader);

    try {
      await expect(registerPwaServiceWorker()).resolves.toEqual({ registered: false, reason: "cross-origin-api" });
      await expect(getServiceWorkerRegistration()).rejects.toThrow("cross-origin-api");
      expect(loader).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: original });
    }
  });

  it("allows an explicitly configured same-origin API", async () => {
    const original = navigator.serviceWorker;
    const registration = { scope: "/" } as ServiceWorkerRegistration;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: vi.fn() },
    });
    vi.stubEnv("VITE_KODEX_API_BASE_URL", window.location.origin);
    setRegisterSWLoaderForTests(() => Promise.resolve((options) => {
      options?.onRegisteredSW?.("/sw.js", registration);
      return vi.fn();
    }));

    try {
      await expect(registerPwaServiceWorker()).resolves.toEqual({ registered: true, registration });
    } finally {
      Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: original });
    }
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
