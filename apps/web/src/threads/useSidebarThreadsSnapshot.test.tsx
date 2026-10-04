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
const thread: SidebarThreadSummary = { parentThreadId: null, canAcceptDirectInput: null, id: "native-chat", projectId: project.id, cwd: "/shared", name: "Native chat", status: "idle", createdAt: 1, updatedAt: 1, notificationsEnabled: true, seenCompletedAgentTurnSeq: 0, unreadCompletedAgentTurn: false };
function snapshot(assigned: boolean, deleted = false): SidebarThreadsResponse {
  return {
    projects: deleted ? [] : [project],
    projectThreads: deleted ? {} : { [project.id]: { threads: assigned ? [thread] : [] } },
    chatThreads: { threads: assigned ? [] : [{ ...thread, projectId: null }] },
    sections: [], sectionThreads: {},
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
  it("replaces native section order and membership in two clients after cancelling an older snapshot", async () => {
    const section = { id: "native-section", name: "Research" };
    const secondThread = { ...thread, id: "second-chat", name: "Second chat", section };
    const sectionSnapshot = (rows: SidebarThreadSummary[]): SidebarThreadsResponse => ({
      ...snapshot(false),
      sections: [section],
      sectionThreads: { [section.id]: { threads: rows } },
    });
    const oldSnapshot = sectionSnapshot([{ ...thread, section }, secondThread]);
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
    expect(first.client.getQueryData<ThreadSummary[]>(["threads", "section", section.id])?.map((row) => row.id))
      .toEqual([thread.id, secondThread.id]);
    const second = mountClient();
    await waitFor(() => expect(releaseOld).toBeDefined());
    latest = sectionSnapshot([secondThread]);
    await act(async () => {
      await Promise.all([refreshProjectState(first.client), refreshProjectState(second.client)]);
    });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => { releaseOld(oldSnapshot); });
    for (const browser of [first, second]) {
      expect(browser.client.getQueryData<ThreadSummary[]>(["threads", "section", section.id])?.map((row) => row.id))
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
