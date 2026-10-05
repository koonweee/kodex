import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearThreadGoal, getThreadGoal, updateThreadGoal, type ThreadGoal } from "../api/client";
import { createKodexQueryClient } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import { refreshThreadGoals } from "./goalCache";
import { useThreadGoal } from "./useThreadGoal";

vi.mock("../api/client", async (importActual) => ({
  ...(await importActual<typeof import("../api/client")>()),
  getThreadGoal: vi.fn(), updateThreadGoal: vi.fn(), clearThreadGoal: vi.fn(),
}));

const fixture: ThreadGoal = {
  threadId: "thread-1", objective: "Finish the dashboard", status: "active",
  tokenBudget: null, tokensUsed: 10, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2,
};

function setup() {
  const client = createKodexQueryClient();
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, wrapper };
}

describe("useThreadGoal", () => {
  beforeEach(() => {
    vi.mocked(getThreadGoal).mockReset().mockResolvedValue({ goal: fixture });
    vi.mocked(updateThreadGoal).mockReset().mockResolvedValue({ goal: fixture });
    vi.mocked(clearThreadGoal).mockReset().mockResolvedValue({ cleared: true });
  });

  it("does not read nonexistent draft chats", () => {
    const { wrapper } = setup();
    const result = renderHook(() => useThreadGoal(null), { wrapper });
    expect(getThreadGoal).not.toHaveBeenCalled();
    expect(result.result.current.ready).toBe(false);
    expect(result.result.current.goal).toBeNull();
  });

  it("loads and updates a goal with a sparse native request then refills", async () => {
    const { client, wrapper } = setup();
    const result = renderHook(() => useThreadGoal("thread-1"), { wrapper });
    await waitFor(() => expect(result.result.current.goal).toEqual(fixture));
    const paused = { ...fixture, status: "paused" as const };
    vi.mocked(getThreadGoal).mockResolvedValue({ goal: paused });
    await act(async () => { await result.result.current.update({ status: "paused" }); });
    expect(updateThreadGoal).toHaveBeenCalledWith("thread-1", { status: "paused" });
    expect(client.getQueryData(queryKeys.threadGoal("thread-1"))).toEqual({ goal: paused });
  });

  it("refills after clear and a rejected write without assuming success", async () => {
    const { wrapper } = setup();
    const result = renderHook(() => useThreadGoal("thread-1"), { wrapper });
    await waitFor(() => expect(result.result.current.goal).toEqual(fixture));
    vi.mocked(getThreadGoal).mockResolvedValue({ goal: null });
    await act(async () => { await result.result.current.clear(); });
    expect(clearThreadGoal).toHaveBeenCalledWith("thread-1");
    await waitFor(() => expect(result.result.current.goal).toBeNull());
    vi.mocked(updateThreadGoal).mockRejectedValue(new Error("Rejected"));
    await act(async () => { await expect(result.result.current.update({ objective: "New" })).rejects.toThrow("Rejected"); });
    await waitFor(() => expect(result.result.current.error).toBe("Rejected"));
    expect(result.result.current.goal).toBeNull();
  });

  it("does not project an old chat mutation failure into a newly selected chat", async () => {
    const { wrapper } = setup();
    let rejectUpdate!: (error: Error) => void;
    vi.mocked(updateThreadGoal).mockReturnValue(new Promise((_resolve, reject) => { rejectUpdate = reject; }));
    const result = renderHook(({ threadId }) => useThreadGoal(threadId), { wrapper, initialProps: { threadId: "thread-1" } });
    await waitFor(() => expect(result.result.current.ready).toBe(true));
    let pendingUpdate!: Promise<unknown>;
    act(() => { pendingUpdate = result.result.current.update({ status: "paused" }).catch(() => undefined); });
    result.rerender({ threadId: "thread-2" });
    await waitFor(() => expect(result.result.current.ready).toBe(true));
    await act(async () => { rejectUpdate(new Error("Old chat failure")); await pendingUpdate; });
    expect(result.result.current.error).toBeNull();
  });

  it("refills the written chat when the selected chat changes during a mutation", async () => {
    const { client, wrapper } = setup();
    let resolveUpdate!: (value: { goal: ThreadGoal }) => void;
    vi.mocked(updateThreadGoal).mockReturnValue(new Promise((resolve) => { resolveUpdate = resolve; }));
    const result = renderHook(({ threadId }) => useThreadGoal(threadId), { wrapper, initialProps: { threadId: "thread-1" } });
    await waitFor(() => expect(result.result.current.ready).toBe(true));
    let pendingUpdate!: Promise<unknown>;
    act(() => { pendingUpdate = result.result.current.update({ status: "paused" }); });
    result.rerender({ threadId: "thread-2" });
    await waitFor(() => expect(client.getQueryState(queryKeys.threadGoal("thread-2"))?.status).toBe("success"));
    await act(async () => { resolveUpdate({ goal: { ...fixture, status: "paused" } }); await pendingUpdate; });
    expect(client.getQueryState(queryKeys.threadGoal("thread-1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.threadGoal("thread-2"))?.isInvalidated).toBe(false);
  });

  it("converges another client through authoritative refills while preserving per-client caches", async () => {
    const first = setup();
    const second = setup();
    const a = renderHook(() => useThreadGoal("thread-1"), { wrapper: first.wrapper });
    const b = renderHook(() => useThreadGoal("thread-1"), { wrapper: second.wrapper });
    await waitFor(() => expect(a.result.current.goal).toEqual(fixture));
    await waitFor(() => expect(b.result.current.goal).toEqual(fixture));
    vi.mocked(getThreadGoal).mockResolvedValue({ goal: { ...fixture, status: "paused" } });
    await act(async () => { await a.result.current.update({ status: "paused" }); });
    expect(b.result.current.goal?.status).toBe("active");
    await act(async () => { await refreshThreadGoals(second.client, "thread-1"); });
    await waitFor(() => expect(b.result.current.goal?.status).toBe("paused"));
  });
});
