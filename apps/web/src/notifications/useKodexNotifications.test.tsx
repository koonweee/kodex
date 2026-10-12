import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createKodexQueryClient, queryClient as federatorQueryClient } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import { notificationQueryClient, refreshUnreadBadge } from "./unreadBadge";
import { useKodexNotifications } from "./useKodexNotifications";

const getUnreadBadge = vi.hoisted(() => vi.fn());
vi.mock("../api/client", async (actual) => ({ ...await actual<typeof import("../api/client")>(), getUnreadBadge }));

const originalSet = navigator.setAppBadge;
const originalClear = navigator.clearAppBadge;
afterEach(() => {
  vi.restoreAllMocks(); getUnreadBadge.mockReset();
  document.head.querySelector('meta[name="kodex-federator"]')?.remove();
  federatorQueryClient.clear();
  Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: originalSet });
  Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: originalClear });
});

describe("authoritative unread badge", () => {
  it("keeps federator notification state in one cache across executor runtime swaps and recovery", async () => {
    const marker = document.createElement("meta");
    marker.name = "kodex-federator";
    marker.content = "true";
    document.head.append(marker);
    const firstRuntime = createKodexQueryClient();
    const secondRuntime = createKodexQueryClient();
    expect(notificationQueryClient(firstRuntime)).toBe(federatorQueryClient);
    expect(notificationQueryClient(secondRuntime)).toBe(federatorQueryClient);
    federatorQueryClient.setQueryData(["notifications", "status"], { configured: true });
    getUnreadBadge.mockResolvedValue({ count: 2, readRevision: 1 });

    const first = renderHook(() => useKodexNotifications(), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={firstRuntime}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(federatorQueryClient.getQueryData(queryKeys.unreadBadge)).toEqual({ count: 2, readRevision: 1 }));
    first.unmount();
    renderHook(() => useKodexNotifications(), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={secondRuntime}>{children}</QueryClientProvider>,
    });
    expect(federatorQueryClient.getQueryData(["notifications", "status"])).toEqual({ configured: true });

    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(federatorQueryClient.getQueryState(["notifications", "status"])?.isInvalidated).toBe(true));
  });

  it("waits for the shared aggregate instead of clearing from empty or paginated sidebar data", async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: setAppBadge });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: clearAppBadge });
    let release!: (value: { count: number; readRevision: number }) => void;
    getUnreadBadge.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const client = createKodexQueryClient();
    renderHook(() => useKodexNotifications(), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    expect(clearAppBadge).not.toHaveBeenCalled();
    expect(setAppBadge).not.toHaveBeenCalled();
    await act(async () => release({ count: 37, readRevision: 20 }));
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(37));
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it("cancels a delayed badge read and keeps the last known aggregate when native inventory is unavailable", async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: setAppBadge });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: clearAppBadge });
    const client = createKodexQueryClient();
    getUnreadBadge.mockResolvedValueOnce({ count: 3, readRevision: 20 });
    renderHook(() => useKodexNotifications(), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(3));
    let releaseOld!: (value: { count: number; readRevision: number }) => void;
    let oldSignal!: AbortSignal;
    getUnreadBadge.mockImplementationOnce((signal: AbortSignal) => {
      oldSignal = signal;
      return new Promise((resolve) => { releaseOld = resolve; });
    });
    void refreshUnreadBadge(client);
    await waitFor(() => expect(getUnreadBadge).toHaveBeenCalledTimes(2));
    getUnreadBadge.mockResolvedValueOnce({ count: 0, readRevision: 22 });
    await act(async () => { await refreshUnreadBadge(client); });
    expect(oldSignal.aborted).toBe(true);
    await waitFor(() => expect(clearAppBadge).toHaveBeenCalledTimes(1));
    await act(async () => releaseOld({ count: 7, readRevision: 21 }));
    expect(client.getQueryData(queryKeys.unreadBadge)).toEqual({ count: 0, readRevision: 22 });
    expect(setAppBadge).toHaveBeenCalledTimes(1);

    getUnreadBadge.mockRejectedValueOnce(new Error("Native inventory temporarily unknown"));
    await act(async () => { await refreshUnreadBadge(client); });
    expect(client.getQueryData(queryKeys.unreadBadge)).toEqual({ count: 0, readRevision: 22 });
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    // A lower revision from a delayed/native replica never replaces the tuple.
    getUnreadBadge.mockResolvedValueOnce({ count: 8, readRevision: 19 });
    await act(async () => { await refreshUnreadBadge(client); });
    expect(client.getQueryData(queryKeys.unreadBadge)).toEqual({ count: 0, readRevision: 22 });
    expect(setAppBadge).toHaveBeenCalledTimes(1);
  });
});
