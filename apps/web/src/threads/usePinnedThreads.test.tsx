import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getSidebarThreads, listPinnedThreads, type SidebarThreadsResponse, type ThreadSummary } from "../api/client";
import { refreshProjectState } from "../projects/cache";
import { useSidebarThreadsSnapshot } from "../threads/useSidebarThreadsSnapshot";
import { usePinnedThreads } from "./usePinnedThreads";
import { applyThreadPinsEvent } from "./pinnedCache";

vi.mock("../api/client", () => ({ getSidebarThreads: vi.fn(), listPinnedThreads: vi.fn(), setThreadPinned: vi.fn() }));
const thread: ThreadSummary = { parentThreadId: null, canAcceptDirectInput: null, id: "first", name: "First", pinned: true, projectId: null, cwd: "/repo", createdAt: 1, updatedAt: 1, status: "idle", notificationsEnabled: true, latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: false, unreadCompletedAgentTurn: false, rawPayload: {} };
const tail = { ...thread, id: "tail", name: "Tail" };
const snapshot: SidebarThreadsResponse = { projects: [], projectThreads: {}, chatThreads: { threads: [] }, pinnedThreads: { threads: [thread], nextCursor: "more" } };
afterEach(() => vi.clearAllMocks());

it("drops loaded tail rows and resets pagination on an unchanged authoritative first-page refill", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(getSidebarThreads).mockResolvedValue(snapshot);
  vi.mocked(listPinnedThreads).mockResolvedValue({ threads: [tail], nextCursor: null, rawPayload: {} });
  const { result } = renderHook(() => {
    const sidebar = useSidebarThreadsSnapshot({ queryClient: client, routeSelectedThreadRef: { current: null }, selectedThreadIdRef: { current: null }, onChatThreadsCursorChange: vi.fn(), onProjectThreadCursorsChange: vi.fn() });
    return usePinnedThreads(sidebar.sidebarThreadsQuery.data, { snapshotUpdatedAt: sidebar.sidebarThreadsQuery.dataUpdatedAt, onChanged: vi.fn(), onError: vi.fn() });
  }, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  await waitFor(() => expect(result.current.hasMore).toBe(true));
  await act(async () => { await result.current.loadMore(); });
  await waitFor(() => expect(result.current.threads.map((row) => row.id)).toEqual([thread.id, tail.id]));
  expect(result.current.hasMore).toBe(false);
  await act(async () => { await refreshProjectState(client); });
  await waitFor(() => expect(result.current.threads.map((row) => row.id)).toEqual([thread.id]));
  expect(result.current.hasMore).toBe(true);

  let release!: (value: Awaited<ReturnType<typeof listPinnedThreads>>) => void;
  let pageSignal: AbortSignal | undefined;
  vi.mocked(listPinnedThreads).mockImplementationOnce(async (options) => { pageSignal = options?.signal; return new Promise((resolve) => { release = resolve; }); });
  let pendingPage!: Promise<void>;
  act(() => { pendingPage = result.current.loadMore(); });
  await waitFor(() => expect(release).toBeDefined());
  await act(async () => { applyThreadPinsEvent(client, { id: "section-change", seq: 1, kind: "thread.pins_updated", payload: {}, receivedAt: "2026-10-04T00:00:00Z" }); });
  await waitFor(() => expect(pageSignal?.aborted).toBe(true));
  await act(async () => { release({ threads: [tail], nextCursor: null, rawPayload: {} }); await pendingPage; });
  expect(result.current.threads.map((row) => row.id)).toEqual([thread.id]);
  expect(result.current.hasMore).toBe(true);
});
