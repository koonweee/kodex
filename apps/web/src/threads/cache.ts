import type { QueryClient } from "@tanstack/react-query";

import type { ThreadRead, ThreadSummary } from "../api/client";
import { queryKeys } from "../api/queryKeys";

export function upsertProjectThread(queryClient: QueryClient, projectId: string, thread: ThreadSummary) {
  queryClient.setQueryData<ThreadSummary[]>(queryKeys.projectThreads(projectId), (current) =>
    upsertThreadInList(current ?? [], thread),
  );
}

export function upsertChatThread(queryClient: QueryClient, thread: ThreadSummary) {
  queryClient.setQueryData<ThreadSummary[]>(queryKeys.chatThreads, (current) => upsertThreadInList(current ?? [], thread));
}

export function upsertPinnedThread(queryClient: QueryClient, thread: ThreadSummary) {
  if (!thread.pinnedAt) {
    removeThreadEverywhere(queryClient, thread.id, { pinnedOnly: true });
    return;
  }
  clearPinnedThreadTombstone(queryClient, thread.id);
  queryClient.setQueryData<ThreadSummary[]>(queryKeys.pinnedThreads, (current) => upsertThreadInList(current ?? [], thread));
}

export function updateThreadEverywhere(
  queryClient: QueryClient,
  threadId: string,
  patcher: (thread: ThreadSummary) => ThreadSummary,
) {
  queryClient.setQueriesData<ThreadSummary[]>({ queryKey: queryKeys.projectThreadsRoot }, (current) =>
    updateThreadList(current, threadId, patcher),
  );
  queryClient.setQueryData<ThreadSummary[]>(queryKeys.chatThreads, (current) =>
    updateThreadList(current, threadId, patcher),
  );
  queryClient.setQueryData<ThreadSummary[]>(queryKeys.pinnedThreads, (current) =>
    updateThreadList(current, threadId, patcher),
  );
}

export function removeThreadEverywhere(
  queryClient: QueryClient,
  threadId: string,
  options: { pinnedOnly?: boolean } = {},
) {
  if (!options.pinnedOnly) {
    queryClient.setQueriesData<ThreadSummary[]>({ queryKey: queryKeys.projectThreadsRoot }, (current) =>
      removeThreadFromList(current, threadId),
    );
    queryClient.setQueryData<ThreadSummary[]>(queryKeys.chatThreads, (current) => removeThreadFromList(current, threadId));
  }
  queryClient.setQueryData<ThreadSummary[]>(queryKeys.pinnedThreads, (current) => removeThreadFromList(current, threadId));
}

export function applyThreadPinState(
  queryClient: QueryClient,
  threadId: string,
  pinnedAt: string | null,
  knownThread?: ThreadSummary | null,
) {
  updateThreadEverywhere(queryClient, threadId, (thread) => ({ ...thread, pinnedAt }));
  if (!pinnedAt) {
    addPinnedThreadTombstone(queryClient, threadId);
    removeThreadEverywhere(queryClient, threadId, { pinnedOnly: true });
    return;
  }

  clearPinnedThreadTombstone(queryClient, threadId);
  const thread = knownThread ?? findCachedThread(queryClient, threadId);
  if (thread) {
    upsertPinnedThread(queryClient, { ...thread, pinnedAt });
  }
}

export function applyThreadReadState(queryClient: QueryClient, threadId: string, readState: ThreadRead) {
  updateThreadEverywhere(queryClient, threadId, (thread) => ({
    ...thread,
    seenCompletedAgentTurnSeq: readState.seenCompletedAgentTurnSeq,
    unreadCompletedAgentTurn: false,
  }));
}

export function replaceThreadEverywhere(queryClient: QueryClient, thread: ThreadSummary) {
  updateThreadEverywhere(queryClient, thread.id, (current) => mergeSelectedThreadDetailIntoSidebarSummary(current, thread));
}

export function mergeSelectedThreadDetailIntoSidebarSummary(
  currentThread: ThreadSummary,
  detailThread: ThreadSummary,
): ThreadSummary {
  const merged = mergeNewerReadProjection(detailThread, currentThread);
  return {
    ...merged,
    createdAt: currentThread.createdAt,
    updatedAt: Math.max(currentThread.updatedAt, detailThread.updatedAt),
  };
}

export function mergeProjectThreadSnapshot(
  queryClient: QueryClient,
  projectId: string,
  loadedThreads: ThreadSummary[],
  routeSelectedThread: ThreadSummary | null,
  selectedThreadId: string | null,
) {
  queryClient.setQueryData<ThreadSummary[]>(queryKeys.projectThreads(projectId), (current) =>
    mergeProjectThreads(current ?? [], loadedThreads, routeSelectedThread, selectedThreadId),
  );
}

export function mergeProjectThreadData(
  current: ThreadSummary[] | undefined,
  loadedThreads: ThreadSummary[],
  routeSelectedThread: ThreadSummary | null,
  selectedThreadId: string | null,
): ThreadSummary[] {
  return mergeProjectThreads(current ?? [], loadedThreads, routeSelectedThread, selectedThreadId);
}

export function mergeChatThreadSnapshot(queryClient: QueryClient, loadedThreads: ThreadSummary[]) {
  queryClient.setQueryData<ThreadSummary[]>(queryKeys.chatThreads, (current) =>
    mergeChatThreadData(current, loadedThreads),
  );
}

export function mergeChatThreadData(
  current: ThreadSummary[] | undefined,
  loadedThreads: ThreadSummary[],
): ThreadSummary[] {
  if (!current || current.length === 0) {
    return loadedThreads;
  }
  const currentById = threadsById(current);
  const loadedIds = new Set(loadedThreads.map((thread) => thread.id));
  const mergedLoadedThreads = loadedThreads.map((loadedThread) => {
    const currentThread = currentById.get(loadedThread.id);
    if (!currentThread) {
      return loadedThread;
    }
    if (currentThread.updatedAt > loadedThread.updatedAt) {
      return currentThread;
    }
    return mergeNewerReadProjection(loadedThread, currentThread);
  });
  return [...current.filter((thread) => !loadedIds.has(thread.id)), ...mergedLoadedThreads];
}

export function setPinnedThreadSnapshot(queryClient: QueryClient, loadedThreads: ThreadSummary[]) {
  queryClient.setQueryData<ThreadSummary[]>(queryKeys.pinnedThreads, loadedThreads);
}

export function mergePinnedThreadData(
  beforeSnapshot: ThreadSummary[] | undefined,
  current: ThreadSummary[] | undefined,
  loadedThreads: ThreadSummary[],
  deletedIds: string[] = [],
): ThreadSummary[] {
  const deletedIdSet = new Set(deletedIds);
  const filteredLoadedThreads = loadedThreads.filter((thread) => !deletedIdSet.has(thread.id));
  if (!current) {
    return filteredLoadedThreads;
  }

  const beforeById = threadsById(beforeSnapshot ?? []);
  const currentById = threadsById(current);
  const loadedIds = new Set(filteredLoadedThreads.map((thread) => thread.id));
  const merged: ThreadSummary[] = [];

  for (const loadedThread of filteredLoadedThreads) {
    const currentThread = currentById.get(loadedThread.id);
    const beforeThread = beforeById.get(loadedThread.id);
    if (beforeThread && !currentThread) {
      continue;
    }
    merged.push(currentThread && threadChangedDuringSnapshot(beforeThread, currentThread) ? currentThread : loadedThread);
  }

  for (const currentThread of current) {
    if (!loadedIds.has(currentThread.id) && threadChangedDuringSnapshot(beforeById.get(currentThread.id), currentThread)) {
      merged.push(currentThread);
    }
  }

  return merged;
}

export function pinnedTombstonesAddedDuringSnapshot(
  beforeSnapshot: string[] | undefined,
  current: string[] | undefined,
): string[] {
  const beforeIds = new Set(beforeSnapshot ?? []);
  return (current ?? []).filter((threadId) => !beforeIds.has(threadId));
}

export function setProjectThreadSnapshot(queryClient: QueryClient, projectId: string, loadedThreads: ThreadSummary[]) {
  queryClient.setQueryData<ThreadSummary[]>(queryKeys.projectThreads(projectId), loadedThreads);
}

export function findCachedThread(queryClient: QueryClient, threadId: string): ThreadSummary | null {
  for (const [, threads] of queryClient.getQueriesData<ThreadSummary[]>({ queryKey: queryKeys.projectThreadsRoot })) {
    const thread = threads?.find((item) => item.id === threadId);
    if (thread) {
      return thread;
    }
  }
  return (
    queryClient.getQueryData<ThreadSummary[]>(queryKeys.chatThreads)?.find((thread) => thread.id === threadId) ??
    queryClient.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads)?.find((thread) => thread.id === threadId) ??
    null
  );
}

function mergeProjectThreads(
  current: ThreadSummary[],
  loadedThreads: ThreadSummary[],
  routeSelectedThread: ThreadSummary | null,
  selectedThreadId: string | null,
): ThreadSummary[] {
  const hydratedThreads = mergeRouteSelectedThreadIntoList(loadedThreads, routeSelectedThread, selectedThreadId);
  const currentById = threadsById(current);
  const mergedHydratedThreads = hydratedThreads.map((hydratedThread) => {
    const currentThread = currentById.get(hydratedThread.id);
    if (!currentThread) {
      return hydratedThread;
    }
    if (currentThread.updatedAt > hydratedThread.updatedAt) {
      return currentThread;
    }
    return mergeNewerReadProjection(hydratedThread, currentThread);
  });
  const hydratedIds = new Set(hydratedThreads.map((thread) => thread.id));
  return [...current.filter((thread) => !hydratedIds.has(thread.id)), ...mergedHydratedThreads];
}

function mergeRouteSelectedThreadIntoList(
  threads: ThreadSummary[],
  routeSelectedThread: ThreadSummary | null,
  selectedThreadId: string | null,
): ThreadSummary[] {
  if (
    !routeSelectedThread ||
    routeSelectedThread.id !== selectedThreadId ||
    !threads.some((thread) => thread.id === routeSelectedThread.id)
  ) {
    return threads;
  }
  return threads.map((thread) => (thread.id === routeSelectedThread.id ? routeSelectedThread : thread));
}

function mergeNewerReadProjection(loadedThread: ThreadSummary, currentThread: ThreadSummary): ThreadSummary {
  const loadedLastCompleted = loadedThread.lastCompletedAgentTurnSeq ?? 0;
  const currentLastCompleted = currentThread.lastCompletedAgentTurnSeq ?? 0;
  const loadedSeen = loadedThread.seenCompletedAgentTurnSeq ?? 0;
  const currentSeen = currentThread.seenCompletedAgentTurnSeq ?? 0;
  if (currentLastCompleted <= loadedLastCompleted && currentSeen <= loadedSeen) {
    return loadedThread;
  }

  const lastCompletedAgentTurnSeq = Math.max(loadedLastCompleted, currentLastCompleted);
  const seenCompletedAgentTurnSeq = Math.max(loadedSeen, currentSeen);
  return {
    ...loadedThread,
    lastCompletedAgentTurnSeq,
    seenCompletedAgentTurnSeq,
    status: currentThread.status,
    unreadCompletedAgentTurn: lastCompletedAgentTurnSeq > seenCompletedAgentTurnSeq,
  };
}

function upsertThreadInList(current: ThreadSummary[], thread: ThreadSummary): ThreadSummary[] {
  const index = current.findIndex((item) => item.id === thread.id);
  if (index === -1) {
    return [thread, ...current];
  }
  return current.map((item) => (item.id === thread.id ? thread : item));
}

function updateThreadList(
  current: ThreadSummary[] | undefined,
  threadId: string,
  patcher: (thread: ThreadSummary) => ThreadSummary,
): ThreadSummary[] | undefined {
  if (!current) {
    return current;
  }
  let changed = false;
  const next = current.map((thread) => {
    if (thread.id !== threadId) {
      return thread;
    }
    changed = true;
    return patcher(thread);
  });
  return changed ? next : current;
}

function removeThreadFromList(current: ThreadSummary[] | undefined, threadId: string): ThreadSummary[] | undefined {
  if (!current) {
    return current;
  }
  const next = current.filter((thread) => thread.id !== threadId);
  return next.length === current.length ? current : next;
}

function threadsById(threads: ThreadSummary[]): Map<string, ThreadSummary> {
  return new Map(threads.map((thread) => [thread.id, thread]));
}

function threadChangedDuringSnapshot(before: ThreadSummary | undefined, current: ThreadSummary): boolean {
  return !before || before.pinnedAt !== current.pinnedAt || before.updatedAt !== current.updatedAt || before.name !== current.name;
}

function addPinnedThreadTombstone(queryClient: QueryClient, threadId: string) {
  queryClient.setQueryData<string[]>(queryKeys.pinnedThreadTombstones, (current) =>
    current?.includes(threadId) ? current : [...(current ?? []), threadId],
  );
}

function clearPinnedThreadTombstone(queryClient: QueryClient, threadId: string) {
  queryClient.setQueryData<string[]>(queryKeys.pinnedThreadTombstones, (current) =>
    current?.filter((id) => id !== threadId) ?? [],
  );
}
