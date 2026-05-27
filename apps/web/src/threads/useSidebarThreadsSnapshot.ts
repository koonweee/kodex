import { useCallback, type RefObject } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";

import { getSidebarThreads, type Project, type SidebarThreadSummary, type ThreadSummary } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import {
  mergeChatThreadData,
  mergePinnedThreadData,
  mergeProjectThreadSnapshot,
  pinnedTombstonesAddedDuringSnapshot,
} from "./cache";

type SidebarThreadsSnapshotArgs = {
  queryClient: QueryClient;
  routeSelectedThreadRef: RefObject<ThreadSummary | null>;
  selectedThreadIdRef: RefObject<string | null>;
  onChatThreadsCursorChange: (cursor: string | null) => void;
  onPinnedStateTrusted: () => void;
  onProjectThreadCursorsChange: (cursors: Record<string, string | null>) => void;
};

export function useSidebarThreadsSnapshot({
  queryClient,
  routeSelectedThreadRef,
  selectedThreadIdRef,
  onChatThreadsCursorChange,
  onPinnedStateTrusted,
  onProjectThreadCursorsChange,
}: SidebarThreadsSnapshotArgs) {
  const sidebarThreadsQuery = useQuery({
    queryKey: queryKeys.sidebarThreads,
    retry: false,
    queryFn: async () => {
      const beforeChatSnapshot = queryClient.getQueryData<ThreadSummary[]>(queryKeys.chatThreads);
      const beforeProjectSnapshots = new Map(
        queryClient
          .getQueriesData<ThreadSummary[]>({ queryKey: queryKeys.projectThreadsRoot })
          .map(([queryKey, data]) => [typeof queryKey[2] === "string" ? queryKey[2] : "", data] as const)
          .filter(([projectId]) => projectId.length > 0),
      );
      const beforePinnedSnapshot = queryClient.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads);
      const tombstonesBeforeSnapshot = queryClient.getQueryData<string[]>(queryKeys.pinnedThreadTombstones);
      const snapshot = await getSidebarThreads();
      queryClient.setQueryData<Project[]>(queryKeys.projects, snapshot.projects);

      const nextProjectCursors: Record<string, string | null> = {};
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

      const currentPinned = queryClient.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads);
      const tombstones = queryClient.getQueryData<string[]>(queryKeys.pinnedThreadTombstones);
      const tombstonesForSnapshot = pinnedTombstonesAddedDuringSnapshot(tombstonesBeforeSnapshot, tombstones);
      if (tombstones && tombstones.length > 0) {
        queryClient.setQueryData<string[]>(queryKeys.pinnedThreadTombstones, []);
      }
      queryClient.setQueryData<ThreadSummary[]>(
        queryKeys.pinnedThreads,
        mergePinnedThreadData(
          beforePinnedSnapshot,
          currentPinned,
          snapshot.pinnedThreads.threads.map(sidebarThreadToThreadSummary),
          tombstonesForSnapshot,
        ),
      );
      onPinnedStateTrusted();
      return snapshot;
    },
  });
  const sidebarSnapshotReady = sidebarThreadsQuery.data !== undefined;
  const scopedSidebarQueriesEnabled = sidebarSnapshotReady || sidebarThreadsQuery.isError;
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
