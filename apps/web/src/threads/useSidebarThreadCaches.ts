import type { QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { EventEnvelope, ThreadSummary } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { recordCacheInvalidation } from "../events/liveDiagnostics";
import {
  applyThreadNotificationsState as applyThreadNotificationsStateToCache,
  applyThreadPinState as applyThreadPinStateToCache,
  mergeSelectedThreadDetailIntoSidebarSummary,
  removeThreadEverywhere,
  replaceThreadEverywhere,
  updateThreadEverywhere,
  upsertChatThread,
  upsertPinnedThread,
  upsertProjectThread,
} from "./cache";
import { threadHasDisplayTitle, type ThreadsByProjectId } from "./helpers";
import { sidebarLiveCacheRoute, type SidebarThreadLocation } from "./liveCacheRouting";
import { findKnownThread as findKnownThreadInCaches, withThreadNotificationsEnabled, withThreadPinnedAt } from "./selection";
import type { ThreadUpsert } from "./events";

type CurrentRef<T> = { current: T };

export function useSidebarThreadCaches({
  chatThreadsRef,
  onPinnedStateTrusted,
  pinnedThreadsRef,
  queryClient,
  routeSelectedThreadRef,
  selectedThreadIdRef,
  setPendingTitleThreadIds,
  setRouteSelectedThreadState,
  threadsByProjectIdRef,
}: {
  chatThreadsRef: CurrentRef<ThreadSummary[]>;
  onPinnedStateTrusted: () => void;
  pinnedThreadsRef: CurrentRef<ThreadSummary[]>;
  queryClient: QueryClient;
  routeSelectedThreadRef: CurrentRef<ThreadSummary | null>;
  selectedThreadIdRef: CurrentRef<string | null>;
  setPendingTitleThreadIds: (updater: (current: Set<string>) => Set<string>) => void;
  setRouteSelectedThreadState: (thread: ThreadSummary | null) => void;
  threadsByProjectIdRef: CurrentRef<ThreadsByProjectId>;
}) {
  const patchThreadEverywhere = useCallback((threadId: string, patcher: (thread: ThreadSummary) => ThreadSummary) => {
    updateThreadEverywhere(queryClient, threadId, patcher);
    if (routeSelectedThreadRef.current?.id === threadId) {
      setRouteSelectedThreadState(patcher(routeSelectedThreadRef.current));
    }
  }, [queryClient, routeSelectedThreadRef, setRouteSelectedThreadState]);

  const replaceThread = useCallback((thread: ThreadSummary) => {
    if (thread.id === selectedThreadIdRef.current) {
      setRouteSelectedThreadState(thread);
    }
    const cachedThread = findKnownThreadInCaches(
      thread.id,
      threadsByProjectIdRef.current,
      chatThreadsRef.current,
      pinnedThreadsRef.current,
      routeSelectedThreadRef.current,
    );
    const sidebarThread = cachedThread ? mergeSelectedThreadDetailIntoSidebarSummary(cachedThread, thread) : thread;
    replaceThreadEverywhere(queryClient, thread);
    if (sidebarThread.pinnedAt) {
      upsertPinnedThread(queryClient, sidebarThread);
    } else {
      removeThreadEverywhere(queryClient, thread.id, { pinnedOnly: true });
    }
    if (threadHasDisplayTitle(thread)) {
      setPendingTitleThreadIds((current) => {
        if (!current.has(thread.id)) {
          return current;
        }
        const next = new Set(current);
        next.delete(thread.id);
        return next;
      });
    }
  }, [
    chatThreadsRef,
    pinnedThreadsRef,
    queryClient,
    routeSelectedThreadRef,
    selectedThreadIdRef,
    setPendingTitleThreadIds,
    setRouteSelectedThreadState,
    threadsByProjectIdRef,
  ]);

  const applyThreadUpsert = useCallback((update: ThreadUpsert) => {
    if (update.scope === "project") {
      upsertProjectThread(queryClient, update.projectId, update.thread);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectThreads(update.projectId) });
    } else {
      upsertChatThread(queryClient, update.thread);
      void queryClient.invalidateQueries({ queryKey: queryKeys.chatThreads });
    }

    if (update.thread.pinnedAt) {
      upsertPinnedThread(queryClient, update.thread);
    } else {
      removeThreadEverywhere(queryClient, update.thread.id, { pinnedOnly: true });
    }

    if (threadHasDisplayTitle(update.thread)) {
      setPendingTitleThreadIds((current) => {
        if (!current.has(update.thread.id)) {
          return current;
        }
        const next = new Set(current);
        next.delete(update.thread.id);
        return next;
      });
    }
  }, [queryClient, setPendingTitleThreadIds]);

  const findThreadSidebarLocation = useCallback((threadId: string): SidebarThreadLocation | null => {
    for (const [projectId, threads] of Object.entries(threadsByProjectIdRef.current)) {
      const thread = threads.find((item) => item.id === threadId);
      if (thread) {
        return { scope: "project", projectId, thread };
      }
    }
    const chatThread = chatThreadsRef.current.find((thread) => thread.id === threadId);
    return chatThread ? { scope: "chat", thread: chatThread } : null;
  }, [chatThreadsRef, threadsByProjectIdRef]);

  const refreshSidebarThreadsForLiveEvent = useCallback((event: EventEnvelope) => {
    const route = sidebarLiveCacheRoute(event, event.threadId ? findThreadSidebarLocation(event.threadId) : null);
    if (route.kind === "ignore") {
      return;
    }
    if (route.location.scope === "project") {
      recordCacheInvalidation("projectThreads");
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectThreads(route.location.projectId) });
    } else {
      recordCacheInvalidation("chatThreads");
      void queryClient.invalidateQueries({ queryKey: queryKeys.chatThreads });
    }
  }, [findThreadSidebarLocation, queryClient]);

  const applyThreadPinState = useCallback((threadId: string, pinnedAt: string | null) => {
    onPinnedStateTrusted();
    const knownThread = findKnownThreadInCaches(
      threadId,
      threadsByProjectIdRef.current,
      chatThreadsRef.current,
      pinnedThreadsRef.current,
      routeSelectedThreadRef.current,
    );
    setRouteSelectedThreadState(
      routeSelectedThreadRef.current?.id === threadId
        ? withThreadPinnedAt(routeSelectedThreadRef.current, pinnedAt)
        : routeSelectedThreadRef.current,
    );
    applyThreadPinStateToCache(queryClient, threadId, pinnedAt, knownThread);
    if (pinnedAt && !knownThread) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pinnedThreads });
    }
  }, [
    chatThreadsRef,
    onPinnedStateTrusted,
    pinnedThreadsRef,
    queryClient,
    routeSelectedThreadRef,
    setRouteSelectedThreadState,
    threadsByProjectIdRef,
  ]);

  const applyThreadNotificationsState = useCallback((threadId: string, notificationsEnabled: boolean) => {
    setRouteSelectedThreadState(
      routeSelectedThreadRef.current?.id === threadId
        ? withThreadNotificationsEnabled(routeSelectedThreadRef.current, notificationsEnabled)
        : routeSelectedThreadRef.current,
    );
    applyThreadNotificationsStateToCache(queryClient, threadId, notificationsEnabled);
  }, [queryClient, routeSelectedThreadRef, setRouteSelectedThreadState]);

  return {
    applyThreadNotificationsState,
    applyThreadPinState,
    applyThreadUpsert,
    findThreadSidebarLocation,
    patchThreadEverywhere,
    refreshSidebarThreadsForLiveEvent,
    replaceThread,
  };
}
