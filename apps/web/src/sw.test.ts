import { afterEach, describe, expect, it, vi } from "vitest";

const originalSelf = globalThis.self;

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "self", { configurable: true, value: originalSelf });
});

describe("service worker push handling", () => {
  it("shows unread agent message push notifications even when a same-thread client is visible", async () => {
    vi.doMock("workbox-precaching", () => ({
      cleanupOutdatedCaches: vi.fn(),
      precacheAndRoute: vi.fn(),
    }));

    const listeners = new Map<string, (event: unknown) => void>();
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const matchAll = vi.fn().mockResolvedValue([
      { url: "https://kodex.test/threads/thread-1", focus: vi.fn(), navigate: vi.fn() },
    ]);
    const fakeSelf = {
      __WB_MANIFEST: [],
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener);
      }),
      clients: {
        matchAll,
        openWindow: vi.fn(),
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
});
