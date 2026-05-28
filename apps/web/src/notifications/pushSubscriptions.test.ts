import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteCurrentPushSubscription,
  getCurrentPushSubscriptionStatus,
  upsertPushSubscription,
} from "../api/client";
import { registerKodexServiceWorker } from "../pwa/registerServiceWorker";
import {
  applicationServerKeyBytes,
  browserPushNotificationsSupported,
  disableBrowserPushNotifications,
  enableBrowserPushNotifications,
  loadBrowserPushNotificationState,
} from "./pushSubscriptions";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  deleteCurrentPushSubscription: vi.fn(),
  getCurrentPushSubscriptionStatus: vi.fn(),
  upsertPushSubscription: vi.fn(),
}));

vi.mock("../pwa/registerServiceWorker", () => ({
  registerKodexServiceWorker: vi.fn(),
}));

const mockedRegisterServiceWorker = vi.mocked(registerKodexServiceWorker);
const mockedUpsertPushSubscription = vi.mocked(upsertPushSubscription);
const mockedDeleteCurrentPushSubscription = vi.mocked(deleteCurrentPushSubscription);
const mockedGetCurrentPushSubscriptionStatus = vi.mocked(getCurrentPushSubscriptionStatus);

let originalNotification: PropertyDescriptor | undefined;
let originalPushManager: PropertyDescriptor | undefined;
let originalServiceWorker: PropertyDescriptor | undefined;

function installPushGlobals(
  serviceWorker: unknown = { ready: Promise.resolve(undefined) },
  permission: NotificationPermission = "granted",
) {
  const notificationConstructor = vi.fn();
  Object.defineProperty(notificationConstructor, "permission", {
    configurable: true,
    value: permission,
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: notificationConstructor,
  });
  Object.defineProperty(globalThis, "PushManager", {
    configurable: true,
    value: function PushManager() {},
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: serviceWorker,
  });
}

function restoreDescriptor(target: object, key: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}

beforeEach(() => {
  originalNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  originalPushManager = Object.getOwnPropertyDescriptor(globalThis, "PushManager");
  originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  restoreDescriptor(globalThis, "Notification", originalNotification);
  restoreDescriptor(globalThis, "PushManager", originalPushManager);
  restoreDescriptor(navigator, "serviceWorker", originalServiceWorker);
});

describe("applicationServerKeyBytes", () => {
  it("decodes URL-safe base64 VAPID public keys", () => {
    expect(Array.from(new Uint8Array(applicationServerKeyBytes("AQIDBA")))).toEqual([1, 2, 3, 4]);
  });
});

describe("browserPushNotificationsSupported", () => {
  it("requires both service workers and PushManager", () => {
    expect(browserPushNotificationsSupported()).toBe(false);

    installPushGlobals();

    expect(browserPushNotificationsSupported()).toBe(true);
  });
});

describe("loadBrowserPushNotificationState", () => {
  it("does not treat stale localStorage as enabled state", async () => {
    localStorage.setItem("kodex.pushSubscriptionId", "subscription-1");
    installPushGlobals({
      getRegistration: vi.fn().mockResolvedValue({
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(null),
        },
      }),
      ready: Promise.resolve(undefined),
    });

    await expect(loadBrowserPushNotificationState()).resolves.toEqual({
      configured: false,
      endpoint: null,
      hasBrowserSubscription: false,
      permission: "granted",
      subscribed: false,
      supported: true,
    });
    expect(localStorage.getItem("kodex.pushSubscriptionId")).toBeNull();
    expect(mockedGetCurrentPushSubscriptionStatus).not.toHaveBeenCalled();
  });

  it("reports a browser subscription as unsubscribed when the gateway endpoint is disabled", async () => {
    const subscription = { endpoint: "https://push.example/sub" } as PushSubscription;
    installPushGlobals({
      getRegistration: vi.fn().mockResolvedValue({
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(subscription),
        },
      }),
      ready: Promise.resolve(undefined),
    });
    mockedGetCurrentPushSubscriptionStatus.mockResolvedValue({
      configured: true,
      subscribed: false,
      subscription: null,
    });

    await expect(loadBrowserPushNotificationState()).resolves.toEqual({
      configured: true,
      endpoint: subscription.endpoint,
      hasBrowserSubscription: true,
      permission: "granted",
      subscribed: false,
      supported: true,
    });
    expect(mockedGetCurrentPushSubscriptionStatus).toHaveBeenCalledWith(subscription.endpoint);
  });

  it("converges on gateway state after a second tab refetches", async () => {
    const subscription = { endpoint: "https://push.example/sub" } as PushSubscription;
    installPushGlobals({
      getRegistration: vi.fn().mockResolvedValue({
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(subscription),
        },
      }),
      ready: Promise.resolve(undefined),
    });
    mockedGetCurrentPushSubscriptionStatus
      .mockResolvedValueOnce({
        configured: true,
        subscribed: true,
        subscription: null,
      })
      .mockResolvedValueOnce({
        configured: true,
        subscribed: false,
        subscription: null,
      });

    await expect(loadBrowserPushNotificationState()).resolves.toMatchObject({ subscribed: true });
    await expect(loadBrowserPushNotificationState()).resolves.toMatchObject({ subscribed: false });
    expect(mockedGetCurrentPushSubscriptionStatus).toHaveBeenCalledTimes(2);
  });
});

describe("enableBrowserPushNotifications", () => {
  it("returns null when push is unsupported", async () => {
    await expect(enableBrowserPushNotifications("AQIDBA")).resolves.toBeNull();
    expect(mockedRegisterServiceWorker).not.toHaveBeenCalled();
  });

  it("returns null when the registered service worker has no push manager", async () => {
    installPushGlobals();
    mockedRegisterServiceWorker.mockResolvedValue({
      registered: true,
      registration: {} as ServiceWorkerRegistration,
    });

    await expect(enableBrowserPushNotifications("AQIDBA")).resolves.toBeNull();
    expect(mockedUpsertPushSubscription).not.toHaveBeenCalled();
  });

  it("subscribes, upserts the browser endpoint, and clears the legacy gateway id", async () => {
    installPushGlobals();
    const subscription = { endpoint: "https://push.example/sub" } as PushSubscription;
    const subscribe = vi.fn().mockResolvedValue(subscription);
    localStorage.setItem("kodex.pushSubscriptionId", "subscription-1");
    mockedRegisterServiceWorker.mockResolvedValue({
      registered: true,
      registration: {
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(null),
          subscribe,
        },
      } as unknown as ServiceWorkerRegistration,
    });
    mockedUpsertPushSubscription.mockResolvedValue({
      subscription: {
        createdAt: "2026-05-15T00:00:00Z",
        enabled: true,
        endpoint: subscription.endpoint,
        id: "subscription-1",
        updatedAt: "2026-05-15T00:00:00Z",
        userAgent: null,
      },
    });

    await expect(enableBrowserPushNotifications("AQIDBA")).resolves.toBe(subscription);

    expect(subscribe).toHaveBeenCalledWith({
      applicationServerKey: applicationServerKeyBytes("AQIDBA"),
      userVisibleOnly: true,
    });
    expect(mockedUpsertPushSubscription).toHaveBeenCalledWith(subscription);
    expect(localStorage.getItem("kodex.pushSubscriptionId")).toBeNull();
  });

  it("re-upserts an existing browser subscription without resubscribing", async () => {
    installPushGlobals();
    const subscription = { endpoint: "https://push.example/sub" } as PushSubscription;
    const subscribe = vi.fn();
    mockedRegisterServiceWorker.mockResolvedValue({
      registered: true,
      registration: {
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(subscription),
          subscribe,
        },
      } as unknown as ServiceWorkerRegistration,
    });
    mockedUpsertPushSubscription.mockResolvedValue({
      subscription: {
        createdAt: "2026-05-15T00:00:00Z",
        enabled: true,
        endpoint: subscription.endpoint,
        id: "subscription-1",
        updatedAt: "2026-05-15T00:00:00Z",
        userAgent: null,
      },
    });

    await expect(enableBrowserPushNotifications("AQIDBA")).resolves.toBe(subscription);

    expect(subscribe).not.toHaveBeenCalled();
    expect(mockedUpsertPushSubscription).toHaveBeenCalledWith(subscription);
  });

  it("does not store a subscription id when browser subscribe fails", async () => {
    installPushGlobals();
    mockedRegisterServiceWorker.mockResolvedValue({
      registered: true,
      registration: {
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(null),
          subscribe: vi.fn().mockRejectedValue(new Error("subscribe failed")),
        },
      } as unknown as ServiceWorkerRegistration,
    });

    await expect(enableBrowserPushNotifications("AQIDBA")).rejects.toThrow("subscribe failed");
    expect(mockedUpsertPushSubscription).not.toHaveBeenCalled();
    expect(localStorage.getItem("kodex.pushSubscriptionId")).toBeNull();
  });
});

describe("disableBrowserPushNotifications", () => {
  it("revokes the current endpoint and unsubscribes the browser subscription", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const subscription = { endpoint: "https://push.example/sub", unsubscribe } as unknown as PushSubscription;
    installPushGlobals({
      getRegistration: vi.fn().mockResolvedValue({
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(subscription),
        },
      }),
      ready: Promise.resolve(undefined),
    });

    await disableBrowserPushNotifications();

    expect(mockedDeleteCurrentPushSubscription).toHaveBeenCalledWith(subscription.endpoint);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("only clears the legacy id when no browser subscription exists", async () => {
    localStorage.setItem("kodex.pushSubscriptionId", "subscription-1");
    installPushGlobals({
      getRegistration: vi.fn().mockResolvedValue({
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(null),
        },
      }),
      ready: Promise.resolve(undefined),
    });

    await disableBrowserPushNotifications();

    expect(mockedDeleteCurrentPushSubscription).not.toHaveBeenCalled();
    expect(localStorage.getItem("kodex.pushSubscriptionId")).toBeNull();
  });
});
