import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { listThreadSubagents, type EventEnvelope, type ThreadSubagentListResponse, type ThreadSubagentSummary } from "../api/client";
import { createKodexQueryClient } from "../api/queryClient";
import { applySubagentsEvent, refreshThreadSubagents } from "./subagentsCache";
import { useThreadSubagents } from "./useThreadSubagents";

vi.mock("../api/client", () => ({ listThreadSubagents: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const child: ThreadSubagentSummary = {
  id: "child", parentThreadId: "ancestor", name: null, preview: "Native child", agentNickname: "Scout",
  status: "idle", updatedAt: 10, canAcceptDirectInput: true,
};
const unloaded: ThreadSubagentSummary = {
  ...child, id: "persisted-grandchild", parentThreadId: "child", agentNickname: null,
  status: "notLoaded", canAcceptDirectInput: null,
};
const readOnly: ThreadSubagentSummary = { ...child, id: "internal-child", canAcceptDirectInput: false };
const marker: EventEnvelope = { id: "changed", seq: 10, kind: "thread.subagents_changed", payload: { changedThreadId: null }, receivedAt: "2026-10-04T00:00:00Z" };
const page = (subagents: ThreadSubagentSummary[], nextCursor: string | null = null): ThreadSubagentListResponse => ({ subagents, nextCursor });

function mountClient() {
  const client = createKodexQueryClient();
  const hook = renderHook(() => useThreadSubagents("ancestor"), {
    wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  return { client, hook };
}

it("keeps native page order and immediate parents, including unloaded descendants with unknown capability", async () => {
  vi.mocked(listThreadSubagents).mockImplementation(async (_ancestor, options) => options?.cursor === "opaque/+next="
    ? page([readOnly]) : page([unloaded, child], "opaque/+next="));
  const { hook } = mountClient();
  await waitFor(() => expect(hook.result.current.subagents).toEqual([unloaded, child]));
  expect(hook.result.current.selectedId).toBe(unloaded.id);
  expect(hook.result.current.hasMore).toBe(true);
  act(() => hook.result.current.loadMore());
  await waitFor(() => expect(hook.result.current.subagents).toEqual([unloaded, child, readOnly]));
  expect(listThreadSubagents).toHaveBeenLastCalledWith("ancestor", { cursor: "opaque/+next=", signal: expect.any(AbortSignal) });
  expect(hook.result.current.hasMore).toBe(false);
});

it("makes two clients converge from native reads while canceling a pre-recovery initial reply", async () => {
  let native = page([child]);
  let releaseOld!: (value: ThreadSubagentListResponse) => void;
  let staleSignal: AbortSignal | undefined;
  vi.mocked(listThreadSubagents)
    .mockImplementationOnce(async () => native)
    .mockImplementationOnce((_ancestor, options) => {
      staleSignal = options?.signal;
      return new Promise((resolve) => { releaseOld = resolve; });
    }).mockImplementation(async () => native);
  const first = mountClient();
  await waitFor(() => expect(first.hook.result.current.subagents).toEqual([child]));
  const second = mountClient();
  await waitFor(() => expect(listThreadSubagents).toHaveBeenCalledTimes(2));
  native = page([unloaded, readOnly]);
  act(() => applySubagentsEvent(first.client, marker));
  await waitFor(() => expect(first.hook.result.current.subagents).toEqual([unloaded, readOnly]));
  expect(second.hook.result.current.subagents).toEqual([]);
  await act(async () => { await refreshThreadSubagents(second.client); });
  await waitFor(() => expect(second.hook.result.current.subagents).toEqual([unloaded, readOnly]));
  expect(staleSignal?.aborted).toBe(true);
  await act(async () => releaseOld(page([child])));
  expect(second.hook.result.current.subagents).toEqual([unloaded, readOnly]);

  native = page([unloaded]);
  act(() => applySubagentsEvent(first.client, { ...marker, seq: 1, payload: { subagent: child } }));
  await waitFor(() => expect(first.hook.result.current.subagents).toEqual([unloaded]));
  // Obsolete row-carrying events are not a source of discovery rows.
  act(() => applySubagentsEvent(first.client, { ...marker, kind: "thread.subagent_started", payload: { subagent: child } }));
  expect(first.hook.result.current.subagents).toEqual([unloaded]);
});

it("refills loaded pages through fresh native cursors and removes absent old descendants", async () => {
  let changed = false;
  vi.mocked(listThreadSubagents).mockImplementation(async (_ancestor, options) => {
    if (!changed) return options?.cursor ? page([unloaded]) : page([child], "old-cursor");
    return options?.cursor === "fresh-cursor" ? page([readOnly]) : page([unloaded], "fresh-cursor");
  });
  const { client, hook } = mountClient();
  await waitFor(() => expect(hook.result.current.hasMore).toBe(true));
  act(() => hook.result.current.loadMore());
  await waitFor(() => expect(hook.result.current.subagents).toEqual([child, unloaded]));
  changed = true;
  act(() => applySubagentsEvent(client, marker));
  await waitFor(() => expect(hook.result.current.subagents).toEqual([unloaded, readOnly]));
  expect(listThreadSubagents).toHaveBeenLastCalledWith("ancestor", { cursor: "fresh-cursor", signal: expect.any(AbortSignal) });
});
