import { afterEach, describe, expect, it, vi } from "vitest";

const originalSelf = globalThis.self;

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(globalThis, "self", { configurable: true, value: originalSelf });
});

describe("service worker push handling", () => {
  it("activates waiting workers only when requested", async () => {
    const { claim, listeners, skipWaiting } = await installServiceWorker();
    const waitUntilPromises: Array<Promise<unknown>> = [];

    listeners.get("message")?.({ data: { type: "IGNORED" } });
    expect(skipWaiting).not.toHaveBeenCalled();

    listeners.get("message")?.({ data: { type: "SKIP_WAITING" } });
    expect(skipWaiting).toHaveBeenCalledTimes(1);

    listeners.get("activate")?.({
      waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
    });
    await Promise.all(waitUntilPromises);

    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("shows unread agent message push notifications even when a same-thread client is visible", async () => {
    const { listeners, matchAll, setAppBadge, showNotification } = await installServiceWorker({
      clients: [{ url: "https://kodex.test/threads/thread-1", focus: vi.fn(), navigate: vi.fn() }],
    });
    const waitUntilPromises: Array<Promise<unknown>> = [];
    listeners.get("push")?.({
      data: {
        json: () => ({
          badgeCount: 999,
          readRevision: 1,
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
    expect(setAppBadge).toHaveBeenCalledWith(0);
    expect(showNotification).toHaveBeenCalledWith(
      "Thread one",
      expect.objectContaining({
        body: "Agent has a new message.",
        tag: "kodex-unread-agent-message:thread-1",
      }),
    );
  });

  it("does not let an old push read overwrite a later authoritative badge refresh", async () => {
    let releaseOld!: (response: Response) => void;
    const fetchBadge = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseOld = resolve; }))
      .mockResolvedValueOnce(Response.json({ count: 0, readRevision: 2 }));
    const { listeners, setAppBadge, showNotification } = await installServiceWorker({ fetchBadge });
    const pending: Array<Promise<unknown>> = [];
    listeners.get("push")?.({
      data: { json: () => ({ kind: "unreadAgentMessage", title: "Seen answer", badgeCount: 8, readRevision: 100 }) },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    listeners.get("message")?.({
      data: { type: "REFRESH_BADGE" },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    await pending[1];
    expect(fetchBadge.mock.calls[0][1].signal.aborted).toBe(true);
    expect(setAppBadge).toHaveBeenCalledWith(0);
    // A replaced instance can have a lower revision; request freshness owns
    // worker ordering, with no persisted revision watermark across instances.
    releaseOld(Response.json({ count: 8, readRevision: 100 }));
    await Promise.all(pending);
    expect(setAppBadge).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledWith("Seen answer", expect.any(Object));
  });

  it("still shows Push when the badge inventory is unknown and preserves the current badge", async () => {
    const { listeners, setAppBadge, showNotification } = await installServiceWorker({
      fetchBadge: vi.fn().mockResolvedValue(new Response("unknown", { status: 409 })),
    });
    const pending: Array<Promise<unknown>> = [];
    listeners.get("push")?.({
      data: { json: () => ({ kind: "unreadAgentMessage", title: "Answer", badgeCount: null, readRevision: null }) },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    await Promise.all(pending);
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(showNotification).toHaveBeenCalledWith("Answer", expect.any(Object));
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

  it.each([
    ["the requested chat", "/?threadId=thread-1#answer", "https://kodex.test/?threadId=thread-1#answer"],
    ["the app root for a foreign route", "//outside.test/chat", "https://kodex.test/"],
  ])("reuses an existing Kodex window for %s and focuses it after navigation", async (_case, route, destination) => {
    let releaseNavigation!: () => void;
    const navigate = vi.fn(() => new Promise<void>((resolve) => { releaseNavigation = resolve; }));
    const focus = vi.fn().mockResolvedValue(undefined);
    const foreignNavigate = vi.fn();
    const foreignFocus = vi.fn();
    const close = vi.fn();
    const { listeners, matchAll, openWindow } = await installServiceWorker({
      clients: [
        { url: "https://outside.test/", navigate: foreignNavigate, focus: foreignFocus },
        { url: "https://kodex.test/?threadId=another-chat", navigate, focus },
      ],
    });
    const pending: Array<Promise<unknown>> = [];

    // This invokes the real worker handler with mocked platform clients; it
    // does not simulate a trusted browser/OS notification click.
    listeners.get("notificationclick")?.({
      notification: { close, data: { kind: "unreadAgentMessage", route, threadId: "thread-1" } },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(destination));
    expect(close).toHaveBeenCalledOnce();
    expect(matchAll).toHaveBeenCalledWith({ includeUncontrolled: true, type: "window" });
    expect(focus).not.toHaveBeenCalled();
    expect(foreignNavigate).not.toHaveBeenCalled();
    expect(foreignFocus).not.toHaveBeenCalled();

    releaseNavigation();
    await Promise.all(pending);
    expect(navigate).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(openWindow).not.toHaveBeenCalled();
  });
});

async function installServiceWorker({
  clients = [],
  openWindow = vi.fn().mockResolvedValue(undefined),
  fetchBadge = vi.fn().mockResolvedValue(Response.json({ count: 0, readRevision: 20 })),
}: {
  fetchBadge?: ReturnType<typeof vi.fn>;
  clients?: Array<{ focus?: () => Promise<unknown> | unknown; navigate?: (url: string) => Promise<unknown> | unknown; url: string }>;
  openWindow?: (url?: string | URL) => Promise<unknown>;
} = {}) {
  vi.doMock("workbox-precaching", () => ({
    cleanupOutdatedCaches: vi.fn(),
    precacheAndRoute: vi.fn(),
  }));

  vi.stubGlobal("fetch", fetchBadge);
  const listeners = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const setAppBadge = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue(clients);
  const claim = vi.fn().mockResolvedValue(undefined);
  const skipWaiting = vi.fn();
  const fakeSelf = {
    __WB_MANIFEST: [],
    addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    }),
    clients: {
      claim,
      matchAll,
      openWindow,
    },
    location: {
      origin: "https://kodex.test",
    },
    navigator: { setAppBadge },
    registration: { showNotification },
    skipWaiting,
  };
  Object.defineProperty(globalThis, "self", { configurable: true, value: fakeSelf });

  await import("./sw");
  return { claim, listeners, matchAll, openWindow, setAppBadge, showNotification, skipWaiting };
}
