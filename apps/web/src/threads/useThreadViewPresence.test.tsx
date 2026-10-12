import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useThreadViewPresence } from "./useThreadViewPresence";
import { renderHookWithGateway as renderHook } from "../test/GatewayTestProvider";
import { GatewayClientProvider } from "../api/GatewayClientContext";
import type { GatewayClient } from "../api/gatewayClient";

const HEARTBEAT_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

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
      await request.clone().json().catch(() => ({}));
      return new Response(null, { status: 204 });
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
    renderHook(() => useThreadViewPresence({ enabled: true, heartbeatMs: HEARTBEAT_MS, threadIds: ["thread-1"] }));

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(lastPresenceRequest()).resolves.toMatchObject({ visibleThreadIds: ["thread-1"] });

    await act(async () => {
      vi.advanceTimersByTime(HEARTBEAT_MS);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(lastPresenceRequest()).resolves.toMatchObject({ visibleThreadIds: ["thread-1"] });
  });

  it("serializes ordinary snapshots and reserves beacon delivery for lifecycle exit", async () => {
    const replace = vi.fn(async () => undefined);
    const beacon = vi.fn(() => true);
    const client = {
      replaceThreadViewPresence: replace,
      sendThreadViewPresenceSnapshotBeacon: beacon,
    } as unknown as GatewayClient;

    render(
      <GatewayClientProvider client={client}>
        <PresenceProbe threadIds={["thread-1"]} />
      </GatewayClientProvider>,
    );
    await flushEffects();
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ visibleThreadIds: ["thread-1"] }));
    expect(beacon).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(beacon).toHaveBeenCalledWith(expect.objectContaining({ visibleThreadIds: [] }));
  });

  it("uses a ten second heartbeat by default", async () => {
    renderHook(() => useThreadViewPresence({ enabled: true, threadIds: ["thread-1"] }));

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_HEARTBEAT_MS - 501);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(lastPresenceRequest()).resolves.toMatchObject({ visibleThreadIds: ["thread-1"] });
  });

  it("does not heartbeat while hidden and clears when visibility changes to hidden", async () => {
    const { unmount } = renderHook(() =>
      useThreadViewPresence({ enabled: true, heartbeatMs: HEARTBEAT_MS, threadIds: ["thread-1"] }),
    );

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    visibilityState = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(lastPresenceRequest()).resolves.toMatchObject({ visibleThreadIds: [] });

    await act(async () => {
      vi.advanceTimersByTime(HEARTBEAT_MS * 2);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("does not send a visible heartbeat when initially hidden", async () => {
    visibilityState = "hidden";
    renderHook(() => useThreadViewPresence({ enabled: true, heartbeatMs: HEARTBEAT_MS, threadIds: ["thread-1"] }));

    await flushEffects();
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(HEARTBEAT_MS * 2);
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces visible threads when the visible set changes", async () => {
    const { rerender } = renderHook(
      ({ threadIds }: { threadIds: string[] }) =>
        useThreadViewPresence({ enabled: true, heartbeatMs: HEARTBEAT_MS, threadIds }),
      { initialProps: { threadIds: ["thread-1"] } },
    );

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ threadIds: ["thread-1", "thread-2"] });

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requests = await presenceRequests();
    expect(requests.at(-1)).toMatchObject({
      path: "/v1/thread-view-presence",
      visibleThreadIds: ["thread-1", "thread-2"],
    });
  });

  it("uses a keepalive POST for pagehide cleanup", async () => {
    renderHook(() => useThreadViewPresence({ enabled: true, heartbeatMs: HEARTBEAT_MS, threadIds: ["thread-1"] }));

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [input, init] = fetchMock.mock.calls[1];
    const request = input instanceof Request ? input : new Request(input as RequestInfo | URL, init as RequestInit);
    expect(request.method).toBe("POST");
    expect(request.keepalive).toBe(true);
    expect(new URL(request.url, window.location.origin).pathname).toBe("/v1/thread-view-presence");
    await expect(request.clone().json()).resolves.toMatchObject({ visibleThreadIds: [] });
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

    renderHook(() => useThreadViewPresence({ enabled: true, heartbeatMs: HEARTBEAT_MS, threadIds: ["thread-1"] }));

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = await lastPresenceRequest();
    expect(typeof request.clientId).toBe("string");
    expect((request.clientId as string).length).toBeGreaterThan(0);
  });

  it("reports all visible thread ids in one snapshot", async () => {
    renderHook(() =>
      useThreadViewPresence({
        enabled: true,
        heartbeatMs: HEARTBEAT_MS,
        threadIds: ["thread-2", "thread-1", "thread-1"],
      }),
    );

    await flushEffects();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(lastPresenceRequest()).resolves.toMatchObject({
      path: "/v1/thread-view-presence",
      visibleThreadIds: ["thread-1", "thread-2"],
    });
  });

  it("clears the old executor and reports through the new executor when its client changes", async () => {
    const first = {
      replaceThreadViewPresence: vi.fn(async () => undefined),
      sendThreadViewPresenceSnapshotBeacon: vi.fn(() => false),
    } as unknown as GatewayClient;
    const second = {
      replaceThreadViewPresence: vi.fn(async () => undefined),
      sendThreadViewPresenceSnapshotBeacon: vi.fn(() => false),
    } as unknown as GatewayClient;
    function Probe({ client }: { client: GatewayClient }) {
      return <GatewayClientProvider client={client}><Presence /></GatewayClientProvider>;
    }
    function Presence() {
      useThreadViewPresence({ enabled: true, heartbeatMs: HEARTBEAT_MS, threadIds: ["shared-thread"] });
      return null;
    }
    const view = render(<Probe client={first} />);
    await flushEffects();
    expect(first.replaceThreadViewPresence).toHaveBeenCalledWith(expect.objectContaining({ visibleThreadIds: ["shared-thread"] }));

    view.rerender(<Probe client={second} />);
    await flushEffects();

    expect(first.sendThreadViewPresenceSnapshotBeacon).toHaveBeenCalledWith(expect.objectContaining({ visibleThreadIds: [] }));
    expect(second.replaceThreadViewPresence).toHaveBeenCalledWith(expect.objectContaining({ visibleThreadIds: ["shared-thread"] }));
  });
});

function PresenceProbe({ threadIds }: { threadIds: string[] }) {
  useThreadViewPresence({ enabled: true, heartbeatMs: HEARTBEAT_MS, threadIds });
  return null;
}

async function flushEffects() {
  await act(async () => {
    vi.advanceTimersByTime(500);
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
