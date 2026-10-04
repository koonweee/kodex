import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getSidebarThreads, listSectionThreads, type SidebarThreadsResponse, type ThreadSummary } from "../api/client";
import { refreshProjectState } from "../projects/cache";
import { useSidebarThreadsSnapshot } from "../threads/useSidebarThreadsSnapshot";
import { useThreadSections } from "./useThreadSections";
import { applyThreadSectionsEvent } from "./cache";

vi.mock("../api/client", () => ({ getSidebarThreads: vi.fn(), listSectionThreads: vi.fn(), moveThreadToSection: vi.fn() }));
const section = { id: "native-section", name: "Research" };
const thread: ThreadSummary = { parentThreadId: null, canAcceptDirectInput: null, id: "first", name: "First", section, projectId: null, cwd: "/repo", createdAt: 1, updatedAt: 1, status: "idle", notificationsEnabled: true, latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: false, unreadCompletedAgentTurn: false, rawPayload: {} };
const tail = { ...thread, id: "tail", name: "Tail" };
const snapshot: SidebarThreadsResponse = { projects: [], projectThreads: {}, chatThreads: { threads: [] }, sections: [section], sectionThreads: { [section.id]: { threads: [thread], nextCursor: "more" } } };
afterEach(() => vi.clearAllMocks());

it("drops loaded tail rows and resets pagination on an unchanged authoritative first-page refill", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(getSidebarThreads).mockResolvedValue(snapshot);
  vi.mocked(listSectionThreads).mockResolvedValue({ threads: [tail], nextCursor: null, rawPayload: {} });
  const { result } = renderHook(() => {
    const sidebar = useSidebarThreadsSnapshot({ queryClient: client, routeSelectedThreadRef: { current: null }, selectedThreadIdRef: { current: null }, onChatThreadsCursorChange: vi.fn(), onProjectThreadCursorsChange: vi.fn() });
    return useThreadSections(sidebar.sidebarThreadsQuery.data, { snapshotUpdatedAt: sidebar.sidebarThreadsQuery.dataUpdatedAt, onChanged: vi.fn(), onError: vi.fn() });
  }, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  await waitFor(() => expect(result.current.hasMoreById[section.id]).toBe(true));
  await act(async () => { await result.current.loadMore(section.id); });
  await waitFor(() => expect(result.current.threads.map((row) => row.id)).toEqual([thread.id, tail.id]));
  expect(result.current.hasMoreById[section.id]).toBe(false);
  await act(async () => { await refreshProjectState(client); });
  await waitFor(() => expect(result.current.threads.map((row) => row.id)).toEqual([thread.id]));
  expect(result.current.hasMoreById[section.id]).toBe(true);

  let release!: (value: Awaited<ReturnType<typeof listSectionThreads>>) => void;
  let pageSignal: AbortSignal | undefined;
  vi.mocked(listSectionThreads).mockImplementationOnce(async (_id, options) => { pageSignal = options?.signal; return new Promise((resolve) => { release = resolve; }); });
  let pendingPage!: Promise<void>;
  act(() => { pendingPage = result.current.loadMore(section.id); });
  await waitFor(() => expect(release).toBeDefined());
  await act(async () => { applyThreadSectionsEvent(client, { id: "section-change", seq: 1, kind: "thread.sections_updated", payload: {}, receivedAt: "2026-10-04T00:00:00Z" }); });
  await waitFor(() => expect(pageSignal?.aborted).toBe(true));
  await act(async () => { release({ threads: [tail], nextCursor: null, rawPayload: {} }); await pendingPage; });
  expect(result.current.threads.map((row) => row.id)).toEqual([thread.id]);
  expect(result.current.hasMoreById[section.id]).toBe(true);
});
