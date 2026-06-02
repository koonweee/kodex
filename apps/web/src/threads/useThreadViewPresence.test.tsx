import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useThreadViewPresence } from "./useThreadViewPresence";

const HEARTBEAT_MS = 5_000;

let visibilityState = "visible";
let fetchMock: ReturnType<typeof vi.fn>;
let originalSessionStorage: PropertyDescriptor | undefined;

describe("useThreadViewPresence", () => {
  beforeEach(() => {
    originalSessionStorage = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    vi.useFakeTimers();
    visibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.clone().json().catch(() => ({}));
      return new Response(
        JSON.stringify({
          foregroundViewerCount: body.visible ? 1 : 0,
          threadId: "thread-1",
          viewed: Boolean(body.visible),
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    if (originalSessionStorage) {
      Object.defineProperty(window, "sessionStorage", originalSessionStorage);
    }
    sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends an immediate visible heartbeat and repeats while visible", async () => {
    renderHook(() => useThreadViewPresence({ enabled: true, heartbeatMs: HEARTBEAT_MS, threadId: "thread-1" }));

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(lastPresenceRequest()).resolves.toMatchObject({ visible: true });

    await act(async () => {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(lastPresenceRequest()).resolves.toMatchObject({ visible: true });
  });

  it("does not heartbeat while hidden and clears when visibility changes to hidden", async () => {
    const { unmount } = renderHook(() =>
      useThreadViewPresence({ enabled: true, heartbeatMs: HEARTBEAT_MS, threadId: "thread-1" }),
    );

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    visibilityState = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(lastPresenceRequest()).resolves.toMatchObject({ visible: false });

    await act(async () => {
      vi.advanceTimersByTime(HEARTBEAT_MS * 2);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("does not send a visible heartbeat when initially hidden", async () => {
    visibilityState = "hidden";
    renderHook(() => useThreadViewPresence({ enabled: true, heartbeatMs: HEARTBEAT_MS, threadId: "thread-1" }));

    await flushEffects();
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(HEARTBEAT_MS * 2);
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the previous thread when selection changes", async () => {
    const { rerender } = renderHook(
      ({ threadId }: { threadId: string }) =>
        useThreadViewPresence({ enabled: true, heartbeatMs: HEARTBEAT_MS, threadId }),
      { initialProps: { threadId: "thread-1" } },
    );

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ threadId: "thread-2" });

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requests = await presenceRequests();
    expect(requests.at(-2)).toMatchObject({ path: "/v1/threads/thread-1/view-presence", visible: false });
    expect(requests.at(-1)).toMatchObject({ path: "/v1/threads/thread-2/view-presence", visible: true });
  });

  it("uses sendBeacon for pagehide cleanup when available", async () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon,
    });
    renderHook(() => useThreadViewPresence({ enabled: true, heartbeatMs: HEARTBEAT_MS, threadId: "thread-1" }));

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, body] = (sendBeacon.mock.calls as unknown as Array<[string, BodyInit]>)[0] ?? ["", ""];
    expect(new URL(String(url), window.location.origin).pathname).toBe("/v1/threads/thread-1/view-presence");
    expect(body).toEqual(expect.any(Blob));
  });

  it("falls back to an in-memory client id when sessionStorage is unavailable", async () => {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });

    renderHook(() => useThreadViewPresence({ enabled: true, heartbeatMs: HEARTBEAT_MS, threadId: "thread-1" }));

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = await lastPresenceRequest();
    expect(typeof request.clientId).toBe("string");
    expect((request.clientId as string).length).toBeGreaterThan(0);
  });
});

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}


async function lastPresenceRequest(): Promise<Record<string, unknown>> {
  const requests = await presenceRequests();
  return requests.at(-1) ?? {};
}

async function presenceRequests(): Promise<Array<Record<string, unknown> & { path: string }>> {
  return Promise.all(
    fetchMock.mock.calls.map(async ([input, init]) => {
      const request = input instanceof Request ? input : new Request(input as RequestInfo | URL, init as RequestInit);
      return {
        ...((await request.clone().json().catch(() => ({}))) as Record<string, unknown>),
        path: new URL(request.url, window.location.origin).pathname,
      };
    }),
  );
}
