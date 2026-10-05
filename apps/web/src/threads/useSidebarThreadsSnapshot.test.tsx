import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getSidebarThreads, type SidebarThreadsResponse, type SidebarThreadSummary, type ThreadSummary } from "../api/client";
import { applyProjectEvent, refreshProjectState } from "../projects/cache";
import { queryKeys } from "../api/queryKeys";
import { useSidebarThreadsSnapshot } from "./useSidebarThreadsSnapshot";

vi.mock("../api/client", () => ({ getSidebarThreads: vi.fn() }));

const project = { id: "native-project", name: "Native", roots: [{ path: "/shared" }], metadata: {}, position: 0, createdAt: 1, updatedAt: 1, recencyAt: null };
const thread: SidebarThreadSummary = { parentThreadId: null, canAcceptDirectInput: null, id: "native-chat", projectId: project.id, cwd: "/shared", name: "Native chat", status: "idle", createdAt: 1, updatedAt: 1, notificationsEnabled: true, pinned: false, latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: false, unreadCompletedAgentTurn: false };
function snapshot(assigned: boolean, deleted = false): SidebarThreadsResponse {
  return {
    projects: deleted ? [] : [project],
    projectThreads: deleted ? {} : { [project.id]: { threads: assigned ? [thread] : [] } },
    chatThreads: { threads: assigned ? [] : [{ ...thread, projectId: null }] },
    pinnedThreads: { threads: [] },
  };
}

function mountClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hook = renderHook(() => useSidebarThreadsSnapshot({
    queryClient: client,
    routeSelectedThreadRef: { current: null },
    selectedThreadIdRef: { current: null },
    onChatThreadsCursorChange: vi.fn(),
    onProjectThreadCursorsChange: vi.fn(),
  }), {
    wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  return { client, ...hook };
}

afterEach(() => vi.clearAllMocks());

describe("native sidebar membership snapshots", () => {
  it("preserves the last good snapshot after a second client's failed reconnect and converges on explicit retry", async () => {
    let latest = snapshot(true);
    let failing = false;
    vi.mocked(getSidebarThreads).mockImplementation(async () => {
      if (failing) throw new Error("database is locked");
      return latest;
    });
    const first = mountClient();
    const second = mountClient();
    await waitFor(() => {
      expect(first.result.current.sidebarSnapshotReady).toBe(true);
      expect(second.result.current.sidebarSnapshotReady).toBe(true);
    });
    latest = snapshot(false);
    await act(async () => { await refreshProjectState(first.client); });
    expect(first.client.getQueryData(queryKeys.projectThreads(project.id))).toEqual([]);
    expect(second.result.current.sidebarThreadsQuery.isError).toBe(false);
    failing = true;
    await act(async () => { await refreshProjectState(second.client); });
    await waitFor(() => expect(second.result.current.sidebarThreadsQuery.isError).toBe(true));
    expect(second.result.current.sidebarSnapshotReady).toBe(true);
    expect(second.client.getQueryData(queryKeys.projects)).toEqual([project]);
    expect(second.client.getQueryData<ThreadSummary[]>(queryKeys.projectThreads(project.id))?.map((row) => row.id)).toEqual([thread.id]);
    failing = false;
    await act(async () => { await second.result.current.sidebarThreadsQuery.refetch(); });
    await waitFor(() => expect(second.result.current.sidebarThreadsQuery.isError).toBe(false));
    expect(second.client.getQueryData(queryKeys.projectThreads(project.id))).toEqual(first.client.getQueryData(queryKeys.projectThreads(project.id)));
    expect(second.client.getQueryData(queryKeys.chatThreads)).toEqual(first.client.getQueryData(queryKeys.chatThreads));
  });

  it("replaces native pinned order and membership in two clients after cancelling an older snapshot", async () => {
    const secondThread = { ...thread, id: "second-chat", name: "Second chat", pinned: true };
    const pinnedSnapshot = (rows: SidebarThreadSummary[]): SidebarThreadsResponse => ({
      ...snapshot(false),
      pinnedThreads: { threads: rows },
    });
    const oldSnapshot = pinnedSnapshot([{ ...thread, pinned: true }, secondThread]);
    let latest = oldSnapshot;
    let calls = 0;
    let releaseOld!: (value: SidebarThreadsResponse) => void;
    let oldSignal: AbortSignal | undefined;
    vi.mocked(getSidebarThreads).mockImplementation(async (signal) => {
      calls += 1;
      if (calls === 2) {
        oldSignal = signal;
        return new Promise((resolve) => { releaseOld = resolve; });
      }
      return latest;
    });
    const first = mountClient();
    await waitFor(() => expect(first.result.current.sidebarSnapshotReady).toBe(true));
    expect(first.client.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads)?.map((row) => row.id))
      .toEqual([thread.id, secondThread.id]);
    const second = mountClient();
    await waitFor(() => expect(releaseOld).toBeDefined());
    latest = pinnedSnapshot([secondThread]);
    await act(async () => {
      await Promise.all([refreshProjectState(first.client), refreshProjectState(second.client)]);
    });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => { releaseOld(oldSnapshot); });
    for (const browser of [first, second]) {
      expect(browser.client.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads)?.map((row) => row.id))
        .toEqual([secondThread.id]);
    }
  });
  it("removes old memberships in both clients after an assignment change or missed delete", async () => {
    let latest = snapshot(true);
    vi.mocked(getSidebarThreads).mockImplementation(async () => latest);
    const first = mountClient();
    const second = mountClient();
    await waitFor(() => {
      expect(first.result.current.sidebarSnapshotReady).toBe(true);
      expect(second.result.current.sidebarSnapshotReady).toBe(true);
    });
    expect(second.client.getQueryData(queryKeys.projectThreads(project.id))).toHaveLength(1);

    latest = snapshot(false);
    await act(async () => { await first.client.invalidateQueries({ queryKey: queryKeys.sidebarThreads }); });
    expect(first.client.getQueryData(queryKeys.projectThreads(project.id))).toEqual([]);
    expect(first.client.getQueryData<ThreadSummary[]>(queryKeys.chatThreads)?.[0].projectId).toBeNull();
    expect(second.client.getQueryData(queryKeys.projectThreads(project.id))).toHaveLength(1);

    latest = snapshot(false, true);
    await act(async () => { await second.client.invalidateQueries({ queryKey: queryKeys.sidebarThreads }); });
    expect(second.client.getQueryData(queryKeys.projects)).toEqual([]);
    expect(second.client.getQueryData(queryKeys.projectThreads(project.id))).toEqual([]);
    expect(second.client.getQueryData<ThreadSummary[]>(queryKeys.chatThreads)?.map((row) => row.id)).toEqual([thread.id]);
  });
  it("cancels a second client's pre-subscription snapshot before accepting assignment recovery", async () => {
    let latest = snapshot(true);
    let calls = 0;
    let releaseOld!: (value: SidebarThreadsResponse) => void;
    let oldSignal: AbortSignal | undefined;
    vi.mocked(getSidebarThreads).mockImplementation(async (signal) => {
      calls += 1;
      if (calls === 2) {
        oldSignal = signal;
        return new Promise((resolve) => { releaseOld = resolve; });
      }
      return latest;
    });
    const first = mountClient();
    await waitFor(() => expect(first.result.current.sidebarSnapshotReady).toBe(true));
    const second = mountClient();
    await waitFor(() => expect(releaseOld).toBeDefined());
    latest = snapshot(false);
    await act(async () => {
      await refreshProjectState(first.client);
      applyProjectEvent(second.client, { id: "1", seq: 1, kind: "thread.project_updated", payload: { threadId: thread.id, projectId: null }, receivedAt: "2026-10-04T00:00:00Z" });
    });
    await waitFor(() => expect(second.result.current.sidebarSnapshotReady).toBe(true));
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => { releaseOld(snapshot(true)); });
    for (const browser of [first, second]) {
      expect(browser.client.getQueryData(queryKeys.projectThreads(project.id))).toEqual([]);
      expect(browser.client.getQueryData<ThreadSummary[]>(queryKeys.chatThreads)?.[0].projectId).toBeNull();
    }
  });

});
