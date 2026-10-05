import { useCallback, type RefObject } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";

import { getSidebarThreads, type Project, type SidebarThreadSummary, type ThreadSummary } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import {
  mergeChatThreadData,
  mergeProjectThreadSnapshot,
} from "./cache";

type SidebarThreadsSnapshotArgs = {
  queryClient: QueryClient;
  routeSelectedThreadRef: RefObject<ThreadSummary | null>;
  selectedThreadIdRef: RefObject<string | null>;
  onChatThreadsCursorChange: (cursor: string | null) => void;
  onProjectThreadCursorsChange: (cursors: Record<string, string | null>) => void;
};

export function useSidebarThreadsSnapshot({
  queryClient,
  routeSelectedThreadRef,
  selectedThreadIdRef,
  onChatThreadsCursorChange,
  onProjectThreadCursorsChange,
}: SidebarThreadsSnapshotArgs) {
  const sidebarThreadsQuery = useQuery({
    queryKey: queryKeys.sidebarThreads,
    retry: false,
    queryFn: async ({ signal }) => {
      const beforeChatSnapshot = queryClient.getQueryData<ThreadSummary[]>(queryKeys.chatThreads);
      const beforeProjectSnapshots = new Map(
        queryClient
          .getQueriesData<ThreadSummary[]>({ queryKey: queryKeys.projectThreadsRoot, exact: false })
          .filter(([queryKey]) => queryKey.length === 3)
          .map(([queryKey, data]) => [typeof queryKey[2] === "string" ? queryKey[2] : "", data] as const)
          .filter(([projectId]) => projectId.length > 0),
      );
      const beforePinnedSnapshot = queryClient.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads);
      const snapshot = await getSidebarThreads(signal);
      signal.throwIfAborted();
      queryClient.setQueryData<Project[]>(queryKeys.projects, snapshot.projects);

      const nextProjectCursors: Record<string, string | null> = {};
      for (const projectId of beforeProjectSnapshots.keys()) {
        if (!(projectId in snapshot.projectThreads)) {
          queryClient.setQueryData<ThreadSummary[]>(queryKeys.projectThreads(projectId), []);
        }
      }
      for (const [projectId, response] of Object.entries(snapshot.projectThreads)) {
        mergeProjectThreadSnapshot(
          queryClient,
          projectId,
          response.threads.map(sidebarThreadToThreadSummary),
          routeSelectedThreadRef.current,
          selectedThreadIdRef.current,
          beforeProjectSnapshots.get(projectId),
        );
        nextProjectCursors[projectId] = response.nextCursor ?? null;
      }
      onProjectThreadCursorsChange(nextProjectCursors);

      queryClient.setQueryData<ThreadSummary[]>(queryKeys.chatThreads, (current) =>
        mergeChatThreadData(current, snapshot.chatThreads.threads.map(sidebarThreadToThreadSummary), beforeChatSnapshot),
      );
      onChatThreadsCursorChange(snapshot.chatThreads.nextCursor ?? null);

      queryClient.setQueryData<ThreadSummary[]>(queryKeys.pinnedThreads, (current) =>
        mergeChatThreadData(current, snapshot.pinnedThreads.threads.map(sidebarThreadToThreadSummary), beforePinnedSnapshot),
      );
      return snapshot;
    },
  });
  const sidebarSnapshotReady = sidebarThreadsQuery.data !== undefined;
  const scopedSidebarQueriesEnabled = sidebarSnapshotReady;
  const scopedSidebarSnapshotStaleTime = sidebarSnapshotReady ? Infinity : undefined;
  const cachedSidebarSnapshotData = useCallback(
    <T,>(queryKey: readonly unknown[]): T | null => {
      if (!sidebarSnapshotReady || queryClient.getQueryState(queryKey)?.isInvalidated) {
        return null;
      }
      return queryClient.getQueryData<T>(queryKey) ?? null;
    },
    [queryClient, sidebarSnapshotReady],
  );

  return {
    cachedSidebarSnapshotData,
    scopedSidebarQueriesEnabled,
    scopedSidebarSnapshotStaleTime,
    sidebarSnapshotReady,
    sidebarThreadsQuery,
  };
}

function sidebarThreadToThreadSummary(thread: SidebarThreadSummary): ThreadSummary {
  return {
    ...thread,
    rawPayload: {},
  };
}
