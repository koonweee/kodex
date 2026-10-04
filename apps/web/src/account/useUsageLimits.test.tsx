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
