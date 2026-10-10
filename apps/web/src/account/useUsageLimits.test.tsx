import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getRateLimits } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { applyAccountEvent, refreshAccountQueries } from "./cache";
import { useUsageLimits } from "./useUsageLimits";

vi.mock("../api/client", () => ({ getRateLimits: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const snapshot = (usedPercent: number) => ({ primary: { usedPercent } });
const response = (usedPercent: number) => ({ rateLimits: snapshot(usedPercent), rawPayload: {} });

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hook = renderHook(useUsageLimits, { wrapper: ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  ) });
  return { ...hook, client };
}

describe("usage limit reads", () => {
  it("keeps reset details from a full read when a live window update overlaps it", async () => {
    let finish!: (value: Awaited<ReturnType<typeof getRateLimits>>) => void;
    vi.mocked(getRateLimits).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { result, client } = setup();
    await waitFor(() => expect(getRateLimits).toHaveBeenCalledTimes(1));
    act(() => result.current.applyUsageLimitSnapshot(snapshot(20)));
    await act(async () => finish({ ...response(90), rateLimitResetCredits: { availableCount: 1, credits: null } }));
    await waitFor(() => expect(client.getQueryData(queryKeys.rateLimits)).toMatchObject({ rateLimitResetCredits: { availableCount: 1 } }));
    expect(result.current.usageLimitSnapshot?.primary?.usedPercent).toBe(20);
  });
  it("preserves credits and reset details through sparse native updates", async () => {
    vi.mocked(getRateLimits).mockResolvedValueOnce({
      ...response(20), rateLimits: { primary: { usedPercent: 20, resetsAt: 2000000000, windowDurationMins: 300 }, credits: { balance: "42", hasCredits: true, unlimited: false } },
      rateLimitResetCredits: { availableCount: 1, credits: null },
    });
    const { result, client } = setup();
    await waitFor(() => expect(result.current.usageLimitSnapshot?.credits?.balance).toBe("42"));
    act(() => result.current.applyUsageLimitSnapshot({ ...snapshot(50), credits: null }));
    await waitFor(() => expect(result.current.usageLimitSnapshot?.primary?.usedPercent).toBe(50));
    expect(result.current.usageLimitSnapshot?.credits?.balance).toBe("42");
    expect(result.current.usageLimitSnapshot?.primary).toMatchObject({ usedPercent: 50, resetsAt: 2000000000, windowDurationMins: 300 });
    act(() => result.current.applyUsageLimitSnapshot({ credits: { balance: null, hasCredits: true, unlimited: false } }));
    expect(result.current.usageLimitSnapshot?.credits?.balance).toBe("42");
    expect(client.getQueryData(queryKeys.rateLimits)).toMatchObject({ rateLimitResetCredits: { availableCount: 1 } });
  });

  it("refills two clients after a reset and recovers a missed reset on reconnect", async () => {
    let used = 100;
    vi.mocked(getRateLimits).mockImplementation(async () => response(used));
    const a = setup();
    const b = setup();
    await waitFor(() => expect(a.result.current.usageLimitSnapshot?.primary?.usedPercent).toBe(100));
    await waitFor(() => expect(b.result.current.usageLimitSnapshot?.primary?.usedPercent).toBe(100));
    const event = { id: "reset", seq: 3, kind: "account.rate_limits_updated", payload: {}, receivedAt: "2026-10-10T00:00:00Z" };
    used = 0;
    act(() => { applyAccountEvent(a.client, event); applyAccountEvent(b.client, event); });
    await waitFor(() => expect(a.result.current.usageLimitSnapshot?.primary?.usedPercent).toBe(0));
    await waitFor(() => expect(b.result.current.usageLimitSnapshot?.primary?.usedPercent).toBe(0));
    used = 10;
    act(() => applyAccountEvent(a.client, event));
    await waitFor(() => expect(a.result.current.usageLimitSnapshot?.primary?.usedPercent).toBe(10));
    expect(b.result.current.usageLimitSnapshot?.primary?.usedPercent).toBe(0);
    await act(async () => { await refreshAccountQueries(b.client, { cancelInFlight: true }); });
    await waitFor(() => expect(b.result.current.usageLimitSnapshot?.primary?.usedPercent).toBe(10));
  });
  it("keeps a live update over a snapshot already in flight, then accepts a later native read", async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    vi.mocked(getRateLimits).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { result, client } = setup();
    await waitFor(() => expect(getRateLimits).toHaveBeenCalledTimes(1));
    act(() => result.current.applyUsageLimitSnapshot(snapshot(20)));
    await act(async () => finish(response(90)));
    await waitFor(() => expect(result.current.usageLimitSnapshot?.primary?.usedPercent).toBe(20));
    vi.mocked(getRateLimits).mockResolvedValueOnce(response(40));
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.rateLimits }); });
    await waitFor(() => expect(result.current.usageLimitSnapshot?.primary?.usedPercent).toBe(40));
  });
  it("clears the prior account's live usage and ignores its pending read after account change", async () => {
    let finishOld!: (value: ReturnType<typeof response>) => void;
    vi.mocked(getRateLimits).mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }));
    const { result, client } = setup();
    await waitFor(() => expect(getRateLimits).toHaveBeenCalledTimes(1));
    act(() => result.current.applyUsageLimitSnapshot(snapshot(20)));
    await waitFor(() => expect(result.current.usageLimitSnapshot?.primary?.usedPercent).toBe(20));
    vi.mocked(getRateLimits).mockResolvedValueOnce(response(70));
    await act(async () => {
      applyAccountEvent(client, {
        id: "account-change", seq: 2, kind: "account.updated", payload: { authMode: "chatgpt" }, receivedAt: "2026-10-04T00:00:00Z",
      });
      await refreshAccountQueries(client);
    });
    await waitFor(() => expect(result.current.usageLimitSnapshot?.primary?.usedPercent).toBe(70));
    await act(async () => finishOld(response(90)));
    expect(result.current.usageLimitSnapshot?.primary?.usedPercent).toBe(70);
  });

});
