import { isCancelledError, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { listPinnedThreads, setThreadPinned, type SidebarThreadsResponse, type ThreadSummary } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { refreshProjectState } from "../projects/cache";
import { appendThreadPage, mergeChatThreadData } from "./cache";

export function usePinnedThreads(snapshot: SidebarThreadsResponse | undefined, {
  onChanged, onError, snapshotUpdatedAt,
}: { onChanged: () => void; onError: (error: unknown) => void; snapshotUpdatedAt: number }) {
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [paginationState, setPaginationState] = useState<"idle" | "loading" | "error">("idle");
  const loadingCursor = useRef<string | null>(null);
  useEffect(() => {
    setCursor(snapshot?.pinnedThreads.nextCursor ?? null);
    setPaginationState("idle");
  }, [snapshot, snapshotUpdatedAt]);
  const query = useQuery({
    queryKey: queryKeys.pinnedThreads,
    enabled: snapshot !== undefined,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const cached = queryClient.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads);
      if (cached && !queryClient.getQueryState(queryKeys.pinnedThreads)?.isInvalidated) return cached;
      const response = await listPinnedThreads({ signal });
      signal.throwIfAborted();
      setCursor(response.nextCursor ?? null);
      return mergeChatThreadData(queryClient.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads), response.threads, cached);
    },
  });
  const pin = useMutation({
    mutationFn: ({ threadId, pinned, beforeThreadId }: { threadId: string; pinned: boolean; beforeThreadId?: string | null }) =>
      setThreadPinned(threadId, pinned, beforeThreadId),
    onSuccess: () => { onChanged(); return refreshProjectState(queryClient); },
    onError,
  });
  async function loadMore() {
    if (!cursor || loadingCursor.current === cursor) return;
    const requestedCursor = cursor;
    loadingCursor.current = requestedCursor;
    setPaginationState("loading");
    try {
      const response = await queryClient.fetchQuery({
        queryKey: [...queryKeys.threadPages, "pinned", requestedCursor],
        queryFn: ({ signal }) => listPinnedThreads({ cursor: requestedCursor, signal }),
        staleTime: 0,
      });
      queryClient.setQueryData<ThreadSummary[]>(queryKeys.pinnedThreads, (current) => appendThreadPage(current, response.threads));
      setCursor(response.nextCursor ?? null);
      setPaginationState("idle");
    } catch (error) {
      setPaginationState(isCancelledError(error) ? "idle" : "error");
      if (!isCancelledError(error)) onError(error);
    } finally {
      if (loadingCursor.current === requestedCursor) loadingCursor.current = null;
    }
  }
  const setPinned = useCallback((threadId: string, pinned: boolean, beforeThreadId?: string | null) => pin.mutate({ threadId, pinned, beforeThreadId }), [pin.mutate]);
  const movePinnedThread = useCallback((threadId: string, beforeThreadId: string | null) => pin.mutate({ threadId, pinned: true, beforeThreadId }), [pin.mutate]);
  return { threads: query.data ?? [], hasMore: cursor !== null, paginationState, loadMore, pinPending: pin.isPending, setPinned, movePinnedThread };
}
