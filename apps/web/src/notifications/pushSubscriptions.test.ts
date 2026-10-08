import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

import {
  deleteCurrentPushSubscription,
  getCurrentPushSubscriptionStatus,
  upsertPushSubscription,
} from "../api/client";
import { getServiceWorkerRegistration } from "../pwa/registerServiceWorker";
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

vi.mock("../pwa/registerServiceWorker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pwa/registerServiceWorker")>()),
  getServiceWorkerRegistration: vi.fn(),
}));

const mockedGetServiceWorkerRegistration = vi.mocked(getServiceWorkerRegistration);
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
  vi.unstubAllEnvs();
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
  it("disables push when the configured API uses a separate origin", async () => {
    const getRegistration = vi.fn();
    installPushGlobals({ getRegistration });
    vi.stubEnv("VITE_KODEX_API_BASE_URL", "https://another-gateway.example");

    expect(browserPushNotificationsSupported()).toBe(false);
    await expect(loadBrowserPushNotificationState()).resolves.toMatchObject({ supported: false, subscribed: false });
    await expect(enableBrowserPushNotifications("AQIDBA")).rejects.toThrow(/not supported/i);
    expect(getRegistration).not.toHaveBeenCalled();
    expect(mockedGetServiceWorkerRegistration).not.toHaveBeenCalled();
    expect(mockedUpsertPushSubscription).not.toHaveBeenCalled();
  });

  it("requires both service workers and PushManager", () => {
    expect(browserPushNotificationsSupported()).toBe(false);

    installPushGlobals();

    expect(browserPushNotificationsSupported()).toBe(true);
  });
});

describe("loadBrowserPushNotificationState", () => {
  it("settles without waiting for a worker that has never registered", async () => {
    installPushGlobals({
      getRegistration: vi.fn().mockResolvedValue(undefined),
      ready: new Promise(() => {}),
    });
    const settled = vi.fn();
    void loadBrowserPushNotificationState().then(settled);

    await waitFor(() => expect(settled).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: null,
      hasBrowserSubscription: false,
      subscribed: false,
    })));
    expect(mockedGetCurrentPushSubscriptionStatus).not.toHaveBeenCalled();
  });

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
    expect(localStorage.getItem("kodex.pushSubscriptionId")).toBe("subscription-1");
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
    expect(mockedGetCurrentPushSubscriptionStatus).toHaveBeenCalledWith(subscription.endpoint, undefined);
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
  it("reports an error when push is unsupported", async () => {
    await expect(enableBrowserPushNotifications("AQIDBA")).rejects.toThrow(/not supported/i);
    expect(mockedGetServiceWorkerRegistration).not.toHaveBeenCalled();
  });

  it("reports an error when the registered service worker has no push manager", async () => {
    installPushGlobals();
    mockedGetServiceWorkerRegistration.mockResolvedValue({} as ServiceWorkerRegistration);

    await expect(enableBrowserPushNotifications("AQIDBA")).rejects.toThrow(/not supported/i);
    expect(mockedUpsertPushSubscription).not.toHaveBeenCalled();
  });

  it("preserves the shared service worker registration failure", async () => {
    installPushGlobals();
    mockedGetServiceWorkerRegistration.mockRejectedValue(new Error("registration failed"));

    await expect(enableBrowserPushNotifications("AQIDBA")).rejects.toThrow("registration failed");
    expect(mockedUpsertPushSubscription).not.toHaveBeenCalled();
  });

  it("subscribes and upserts the browser endpoint", async () => {
    installPushGlobals();
    const subscription = { endpoint: "https://push.example/sub" } as PushSubscription;
    const subscribe = vi.fn().mockResolvedValue(subscription);
    mockedGetServiceWorkerRegistration.mockResolvedValue({
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe,
      },
    } as unknown as ServiceWorkerRegistration);
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
    expect(mockedGetServiceWorkerRegistration).toHaveBeenCalledTimes(1);
  });

  it("re-upserts an existing browser subscription without resubscribing", async () => {
    installPushGlobals();
    const subscription = { endpoint: "https://push.example/sub" } as PushSubscription;
    const subscribe = vi.fn();
    mockedGetServiceWorkerRegistration.mockResolvedValue({
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(subscription),
        subscribe,
      },
    } as unknown as ServiceWorkerRegistration);
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

  it("does not upsert an endpoint when browser subscribe fails", async () => {
    installPushGlobals();
    mockedGetServiceWorkerRegistration.mockResolvedValue({
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockRejectedValue(new Error("subscribe failed")),
      },
    } as unknown as ServiceWorkerRegistration);

    await expect(enableBrowserPushNotifications("AQIDBA")).rejects.toThrow("subscribe failed");
    expect(mockedUpsertPushSubscription).not.toHaveBeenCalled();
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

  it("does not revoke an endpoint when no browser subscription exists", async () => {
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
  });
});


describe('injected Push subscription transport', () => {
  it('reads, enables and disables through the supplied transport in shared browser order', async () => {
    const events: string[] = [];
    const subscription = { endpoint: 'https://push.example/native', unsubscribe: vi.fn(async () => { events.push('unsubscribe'); return true; }) } as unknown as PushSubscription;
    const registration = { pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) } };
    installPushGlobals({ getRegistration: vi.fn().mockResolvedValue(registration) });
    mockedGetServiceWorkerRegistration.mockResolvedValue(registration as unknown as ServiceWorkerRegistration);
    const transport = {
      current: vi.fn(async () => ({ configured: true, subscribed: true })),
      upsert: vi.fn(async () => { events.push('upsert'); }),
      disable: vi.fn(async () => { events.push('disable'); }),
    };
    await expect(loadBrowserPushNotificationState(undefined, transport)).resolves.toMatchObject({ subscribed: true, endpoint: subscription.endpoint });
    await enableBrowserPushNotifications('AQIDBA', transport);
    await disableBrowserPushNotifications(transport);
    expect(transport.current).toHaveBeenCalledWith(subscription.endpoint, undefined);
    expect(transport.upsert).toHaveBeenCalledWith(subscription);
    expect(transport.disable).toHaveBeenCalledWith(subscription.endpoint);
    expect(events).toEqual(['upsert', 'disable', 'unsubscribe']);
    expect(mockedGetCurrentPushSubscriptionStatus).not.toHaveBeenCalled();
    expect(mockedUpsertPushSubscription).not.toHaveBeenCalled();
    expect(mockedDeleteCurrentPushSubscription).not.toHaveBeenCalled();
  });
});
