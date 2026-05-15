import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deletePushSubscription, upsertPushSubscription } from "../api/client";
import { registerKodexServiceWorker } from "../pwa/registerServiceWorker";
import {
  applicationServerKeyBytes,
  browserPushNotificationsSupported,
  disableBrowserPushNotifications,
  enableBrowserPushNotifications,
} from "./pushSubscriptions";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  deletePushSubscription: vi.fn(),
  upsertPushSubscription: vi.fn(),
}));

vi.mock("../pwa/registerServiceWorker", () => ({
  registerKodexServiceWorker: vi.fn(),
}));

const mockedRegisterServiceWorker = vi.mocked(registerKodexServiceWorker);
const mockedUpsertPushSubscription = vi.mocked(upsertPushSubscription);
const mockedDeletePushSubscription = vi.mocked(deletePushSubscription);

let originalPushManager: PropertyDescriptor | undefined;
let originalServiceWorker: PropertyDescriptor | undefined;

function installPushGlobals(serviceWorker: unknown = { ready: Promise.resolve(undefined) }) {
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
  originalPushManager = Object.getOwnPropertyDescriptor(globalThis, "PushManager");
  originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
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

  it("subscribes and stores the gateway subscription id", async () => {
    installPushGlobals();
    const subscription = { endpoint: "https://push.example/sub" } as PushSubscription;
    const subscribe = vi.fn().mockResolvedValue(subscription);
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

    await expect(enableBrowserPushNotifications("AQIDBA")).resolves.toBe("subscription-1");

    expect(subscribe).toHaveBeenCalledWith({
      applicationServerKey: applicationServerKeyBytes("AQIDBA"),
      userVisibleOnly: true,
    });
    expect(mockedUpsertPushSubscription).toHaveBeenCalledWith(subscription);
    expect(localStorage.getItem("kodex.pushSubscriptionId")).toBe("subscription-1");
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
  it("unsubscribes without calling the gateway when no local subscription id exists", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    installPushGlobals({
      ready: Promise.resolve({
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue({ unsubscribe }),
        },
      }),
    });

    await disableBrowserPushNotifications();

    expect(unsubscribe).toHaveBeenCalled();
    expect(mockedDeletePushSubscription).not.toHaveBeenCalled();
  });
});
