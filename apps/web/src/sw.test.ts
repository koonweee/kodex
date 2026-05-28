import { afterEach, describe, expect, it, vi } from "vitest";

const originalSelf = globalThis.self;

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "self", { configurable: true, value: originalSelf });
});

describe("service worker push handling", () => {
  it("shows unread agent message push notifications even when a same-thread client is visible", async () => {
    const { listeners, matchAll, setAppBadge, showNotification } = await installServiceWorker({
      clients: [{ url: "https://kodex.test/threads/thread-1", focus: vi.fn(), navigate: vi.fn() }],
    });
    const waitUntilPromises: Array<Promise<unknown>> = [];
    listeners.get("push")?.({
      data: {
        json: () => ({
          badgeCount: 3,
          body: "Agent has a new message.",
          kind: "unreadAgentMessage",
          route: "/threads/thread-1",
          threadId: "thread-1",
          title: "Thread one",
        }),
      },
      waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
    });
    await Promise.all(waitUntilPromises);

    expect(matchAll).not.toHaveBeenCalled();
    expect(setAppBadge).toHaveBeenCalledWith(3);
    expect(showNotification).toHaveBeenCalledWith(
      "Thread one",
      expect.objectContaining({
        body: "Agent has a new message.",
        tag: "kodex-unread-agent-message:thread-1",
      }),
    );
  });

  it("shows test notification payloads with a stable route and tag", async () => {
    const { listeners, showNotification } = await installServiceWorker();
    const waitUntilPromises: Array<Promise<unknown>> = [];

    listeners.get("push")?.({
      data: {
        json: () => ({
          body: "Push notifications are working.",
          kind: "test",
          route: "/",
          title: "Kodex test notification",
        }),
      },
      waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
    });
    await Promise.all(waitUntilPromises);

    expect(showNotification).toHaveBeenCalledWith(
      "Kodex test notification",
      expect.objectContaining({
        body: "Push notifications are working.",
        data: expect.objectContaining({ kind: "test", route: "/" }),
        tag: "kodex-test-notification",
      }),
    );
  });

  it("keeps notification clicks origin-bound and handles the root route", async () => {
    const openWindow = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const { listeners } = await installServiceWorker({ openWindow });
    const waitUntilPromises: Array<Promise<unknown>> = [];

    listeners.get("notificationclick")?.({
      notification: {
        close,
        data: { kind: "test", route: "/" },
      },
      waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
    });
    await Promise.all(waitUntilPromises);

    expect(close).toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith("https://kodex.test/");

    openWindow.mockClear();
    listeners.get("notificationclick")?.({
      notification: {
        close: vi.fn(),
        data: { kind: "test", route: "//example.com/outside" },
      },
      waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
    });
    await Promise.all(waitUntilPromises);

    expect(openWindow).toHaveBeenCalledWith("https://kodex.test/");
  });
});

async function installServiceWorker({
  clients = [],
  openWindow = vi.fn().mockResolvedValue(undefined),
}: {
  clients?: Array<{ focus?: () => Promise<unknown> | unknown; navigate?: (url: string) => Promise<unknown> | unknown; url: string }>;
  openWindow?: (url?: string | URL) => Promise<unknown>;
} = {}) {
  vi.doMock("workbox-precaching", () => ({
    cleanupOutdatedCaches: vi.fn(),
    precacheAndRoute: vi.fn(),
  }));

  const listeners = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const setAppBadge = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue(clients);
  const fakeSelf = {
    __WB_MANIFEST: [],
    addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    }),
    clients: {
      matchAll,
      openWindow,
    },
    location: {
      origin: "https://kodex.test",
    },
    registration: {
      setAppBadge,
      showNotification,
    },
  };
  Object.defineProperty(globalThis, "self", { configurable: true, value: fakeSelf });

  await import("./sw");
  return { listeners, matchAll, openWindow, setAppBadge, showNotification };
}
