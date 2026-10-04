import { mergeThreadSummaryMetadata } from "./summaryMetadata";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { EventEnvelope, ThreadSummary } from "../api/client";
import { refreshProjectState } from "../projects/cache";
import { queryKeys } from "../api/queryKeys";
import { recordCacheInvalidation } from "../events/liveDiagnostics";
import {
  applyThreadNotificationsState as applyThreadNotificationsStateToCache,
  replaceThreadEverywhere,
  updateThreadEverywhere,
} from "./cache";
import { threadHasDisplayTitle, type ThreadsByProjectId } from "./helpers";
import { sidebarLiveCacheRoute, type SidebarThreadLocation } from "./liveCacheRouting";
import { withThreadNotificationsEnabled } from "./selection";
import type { ThreadUpsert } from "./events";

type CurrentRef<T> = { current: T };

export function useSidebarThreadCaches({
  chatThreadsRef,
  sectionThreadsRef,
  queryClient,
  routeSelectedThreadRef,
  selectedThreadIdRef,
  setPendingTitleThreadIds,
  setRouteSelectedThreadState,
  threadsByProjectIdRef,
}: {
  chatThreadsRef: CurrentRef<ThreadSummary[]>;
  sectionThreadsRef: CurrentRef<ThreadSummary[]>;
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
      setRouteSelectedThreadState(mergeThreadSummaryMetadata(routeSelectedThreadRef.current, patcher(routeSelectedThreadRef.current)));
    }
  }, [queryClient, routeSelectedThreadRef, setRouteSelectedThreadState]);

  const replaceThread = useCallback((thread: ThreadSummary) => {
    if (thread.id === selectedThreadIdRef.current) {
      setRouteSelectedThreadState(thread);
    }
    replaceThreadEverywhere(queryClient, thread);
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
    queryClient,
    selectedThreadIdRef,
    setPendingTitleThreadIds,
    setRouteSelectedThreadState,
  ]);

  const applyThreadUpsert = useCallback((update: ThreadUpsert) => {
    void refreshProjectState(queryClient);
    updateThreadEverywhere(queryClient, update.thread.id, () => update.thread);

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
    const sectionThread = sectionThreadsRef.current.find((thread) => thread.id === threadId);
    if (sectionThread?.section) return { scope: "section", sectionId: sectionThread.section.id, thread: sectionThread };
    const chatThread = chatThreadsRef.current.find((thread) => thread.id === threadId);
    return chatThread ? { scope: "chat", thread: chatThread } : null;
  }, [chatThreadsRef, sectionThreadsRef, threadsByProjectIdRef]);

  const refreshSidebarThreadsForLiveEvent = useCallback((event: EventEnvelope) => {
    const route = sidebarLiveCacheRoute(event, event.threadId ? findThreadSidebarLocation(event.threadId) : null);
    if (route.kind === "ignore") {
      return;
    }
    if (route.location.scope === "project") {
      recordCacheInvalidation("projectThreads");
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectThreads(route.location.projectId) });
    } else if (route.location.scope === "section") {
      void refreshProjectState(queryClient);
    } else {
      recordCacheInvalidation("chatThreads");
      void queryClient.invalidateQueries({ queryKey: queryKeys.chatThreads });
    }
  }, [findThreadSidebarLocation, queryClient]);

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
    applyThreadUpsert,
    findThreadSidebarLocation,
    patchThreadEverywhere,
    refreshSidebarThreadsForLiveEvent,
    replaceThread,
  };
}
