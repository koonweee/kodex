import { mergeThreadSummaryMetadata } from "./summaryMetadata";
import type { QueryClient } from "@tanstack/react-query";

import type { ThreadSummary } from "../api/client";
import { queryKeys } from "../api/queryKeys";

import { mergeThreadReadState, preserveNewerThreadReadState } from "./readState";

export function upsertProjectThread(queryClient: QueryClient, projectId: string, thread: ThreadSummary) {
  queryClient.setQueryData<ThreadSummary[]>(queryKeys.projectThreads(projectId), (current) =>
    upsertThreadInList(current ?? [], thread),
  );
}

export function upsertChatThread(queryClient: QueryClient, thread: ThreadSummary) {
  queryClient.setQueryData<ThreadSummary[]>(queryKeys.chatThreads, (current) => upsertThreadInList(current ?? [], thread));
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
  queryClient.setQueriesData<ThreadSummary[]>({ queryKey: queryKeys.sectionThreadsRoot }, (current) =>
    updateThreadList(current, threadId, patcher),
  );
}

export function removeThreadEverywhere(queryClient: QueryClient, threadId: string) {
  for (const queryKey of [queryKeys.projectThreadsRoot, queryKeys.sectionThreadsRoot, queryKeys.chatThreads]) {
    queryClient.setQueriesData<ThreadSummary[]>({ queryKey }, (current) => removeThreadFromList(current, threadId));
  }
}

export function applyThreadNotificationsState(
  queryClient: QueryClient,
  threadId: string,
  notificationsEnabled: boolean,
) {
  updateThreadEverywhere(queryClient, threadId, (thread) => ({
    ...thread,
    notificationsEnabled,
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
  beforeSnapshot?: ThreadSummary[],
) {
  queryClient.setQueryData<ThreadSummary[]>(queryKeys.projectThreads(projectId), (current) =>
    mergeProjectThreads(current ?? [], loadedThreads, routeSelectedThread, selectedThreadId, beforeSnapshot),
  );
}

export function mergeProjectThreadData(
  current: ThreadSummary[] | undefined,
  loadedThreads: ThreadSummary[],
  routeSelectedThread: ThreadSummary | null,
  selectedThreadId: string | null,
  beforeSnapshot?: ThreadSummary[],
): ThreadSummary[] {
  return mergeProjectThreads(current ?? [], loadedThreads, routeSelectedThread, selectedThreadId, beforeSnapshot);
}

export function mergeChatThreadSnapshot(
  queryClient: QueryClient,
  loadedThreads: ThreadSummary[],
  beforeSnapshot?: ThreadSummary[],
) {
  queryClient.setQueryData<ThreadSummary[]>(queryKeys.chatThreads, (current) =>
    mergeChatThreadData(current, loadedThreads, beforeSnapshot),
  );
}

export function mergeChatThreadData(
  current: ThreadSummary[] | undefined,
  loadedThreads: ThreadSummary[],
  beforeSnapshot?: ThreadSummary[],
): ThreadSummary[] {
  if (!current || current.length === 0) {
    return loadedThreads;
  }
  const currentById = threadsById(current);
  const beforeById = threadsById(beforeSnapshot ?? []);
  const mergedLoadedThreads = loadedThreads.map((loadedThread) => {
    const currentThread = currentById.get(loadedThread.id);
    if (!currentThread) {
      return loadedThread;
    }
    if (currentThread.updatedAt > loadedThread.updatedAt) {
      return mergeThreadNotifications(loadedThread, currentThread, beforeById.get(loadedThread.id), currentThread);
    }
    return mergeNewerReadProjection(loadedThread, currentThread, beforeById.get(loadedThread.id));
  });
  return mergedLoadedThreads.map((thread) => ({
    ...thread,
    projectId: loadedThreads.find((loaded) => loaded.id === thread.id)?.projectId ?? null,
    section: loadedThreads.find((loaded) => loaded.id === thread.id)?.section ?? null,
    sectionEnteredAt: loadedThreads.find((loaded) => loaded.id === thread.id)?.sectionEnteredAt ?? null,
  }));
}

export function findCachedThread(queryClient: QueryClient, threadId: string): ThreadSummary | null {
  for (const [, threads] of [...queryClient.getQueriesData<ThreadSummary[]>({ queryKey: queryKeys.projectThreadsRoot }), ...queryClient.getQueriesData<ThreadSummary[]>({ queryKey: queryKeys.sectionThreadsRoot })]) {
    const thread = threads?.find((item) => item.id === threadId);
    if (thread) {
      return thread;
    }
  }
  return (
    queryClient.getQueryData<ThreadSummary[]>(queryKeys.chatThreads)?.find((thread) => thread.id === threadId) ??
    null
  );
}

function mergeProjectThreads(
  current: ThreadSummary[],
  loadedThreads: ThreadSummary[],
  routeSelectedThread: ThreadSummary | null,
  selectedThreadId: string | null,
  beforeSnapshot?: ThreadSummary[],
): ThreadSummary[] {
  const hydratedThreads = mergeRouteSelectedThreadIntoList(loadedThreads, routeSelectedThread, selectedThreadId);
  const currentById = threadsById(current);
  const beforeById = threadsById(beforeSnapshot ?? []);
  const mergedHydratedThreads = hydratedThreads.map((hydratedThread) => {
    const currentThread = currentById.get(hydratedThread.id);
    if (!currentThread) {
      return hydratedThread;
    }
    if (currentThread.updatedAt > hydratedThread.updatedAt) {
      return mergeThreadNotifications(
        hydratedThread,
        currentThread,
        beforeById.get(hydratedThread.id),
        currentThread,
      );
    }
    return mergeNewerReadProjection(hydratedThread, currentThread, beforeById.get(hydratedThread.id));
  });
  return mergedHydratedThreads.map((thread) => ({
    ...thread,
    projectId: loadedThreads.find((loaded) => loaded.id === thread.id)?.projectId ?? null,
    section: loadedThreads.find((loaded) => loaded.id === thread.id)?.section ?? null,
    sectionEnteredAt: loadedThreads.find((loaded) => loaded.id === thread.id)?.sectionEnteredAt ?? null,
  }));
}

export function appendThreadPage(current: ThreadSummary[] | undefined, page: ThreadSummary[]): ThreadSummary[] {
  const incomingIds = new Set(page.map((thread) => thread.id));
  return [
    ...(current ?? []).filter((thread) => !incomingIds.has(thread.id)),
    ...mergeChatThreadData(current, page, current),
  ];
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
  return threads.map((thread) => (thread.id === routeSelectedThread.id ? preserveNewerThreadReadState(thread, routeSelectedThread) : thread));
}

function mergeNewerReadProjection(
  loadedThread: ThreadSummary,
  currentThread: ThreadSummary,
  beforeThread?: ThreadSummary,
): ThreadSummary {
  return {
    ...preserveNewerThreadReadState(currentThread, loadedThread),
    notificationsEnabled: mergedThreadNotificationsEnabled(loadedThread, currentThread, beforeThread),
  };
}

function mergeThreadNotifications(
  loadedThread: ThreadSummary,
  currentThread: ThreadSummary,
  beforeThread: ThreadSummary | undefined,
  baseThread: ThreadSummary,
): ThreadSummary {
  return {
    ...mergeThreadReadState(preserveNewerThreadReadState(currentThread, baseThread), loadedThread),
    notificationsEnabled: mergedThreadNotificationsEnabled(loadedThread, currentThread, beforeThread),
  };
}

function mergedThreadNotificationsEnabled(
  loadedThread: ThreadSummary,
  currentThread: ThreadSummary,
  beforeThread?: ThreadSummary,
): boolean {
  return beforeThread && beforeThread.notificationsEnabled !== currentThread.notificationsEnabled
    ? currentThread.notificationsEnabled
    : loadedThread.notificationsEnabled;
}

function upsertThreadInList(current: ThreadSummary[], thread: ThreadSummary): ThreadSummary[] {
  const index = current.findIndex((item) => item.id === thread.id);
  if (index === -1) {
    return [thread, ...current];
  }
  return current.map((item) => (item.id === thread.id ? preserveNewerThreadReadState(item, thread) : item));
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
    const patched = patcher(thread);
    if (patched !== thread) {
      changed = true;
    }
    return patched === thread ? thread : mergeThreadSummaryMetadata(thread, patched);
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
