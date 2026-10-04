import { isCancelledError, useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { listSectionThreads, moveThreadToSection, type SidebarThreadsResponse, type ThreadSummary } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { refreshProjectState } from "../projects/cache";
import { appendThreadPage, mergeChatThreadData } from "../threads/cache";

export function useThreadSections(snapshot: SidebarThreadsResponse | undefined, {
  onChanged,
  onError,
  snapshotUpdatedAt,
}: { onChanged: () => void; onError: (error: unknown) => void; snapshotUpdatedAt: number }) {
  const queryClient = useQueryClient();
  const sections = snapshot?.sections ?? [];
  const [cursors, setCursors] = useState<Record<string, string | null>>({});
  const [paginationStates, setPaginationStates] = useState<Record<string, "idle" | "loading" | "error">>({});
  const loadingCursors = useRef<Record<string, string>>({});
  useEffect(() => {
    setCursors(Object.fromEntries(Object.entries(snapshot?.sectionThreads ?? {}).map(([id, page]) => [id, page.nextCursor ?? null])));
    setPaginationStates({});
  }, [snapshot, snapshotUpdatedAt]);
  const queries = useQueries({ queries: sections.map((section) => ({
    queryKey: queryKeys.sectionThreads(section.id),
    staleTime: Infinity,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const key = queryKeys.sectionThreads(section.id);
      const cached = queryClient.getQueryData<ThreadSummary[]>(key);
      if (cached && !queryClient.getQueryState(key)?.isInvalidated) return cached;
      const response = await listSectionThreads(section.id, { signal });
      signal.throwIfAborted();
      setCursors((current) => ({ ...current, [section.id]: response.nextCursor ?? null }));
      return mergeChatThreadData(queryClient.getQueryData<ThreadSummary[]>(key), response.threads, cached);
    },
  })) });
  const threadsBySectionId = Object.fromEntries(sections.map((section, index) => [section.id, queries[index]?.data ?? []]));
  const move = useMutation({
    mutationFn: ({ threadId, sectionId, beforeThreadId }: { threadId: string; sectionId: string | null; beforeThreadId?: string | null }) =>
      moveThreadToSection(threadId, sectionId, beforeThreadId),
    onSuccess: () => { onChanged(); return refreshProjectState(queryClient); },
    onError,
  });
  async function loadMore(sectionId: string) {
    const cursor = cursors[sectionId];
    if (!cursor || loadingCursors.current[sectionId] === cursor) return;
    loadingCursors.current[sectionId] = cursor;
    setPaginationStates((current) => ({ ...current, [sectionId]: "loading" }));
    try {
      const response = await queryClient.fetchQuery({
        queryKey: [...queryKeys.threadPages, "section", sectionId, cursor],
        queryFn: ({ signal }) => listSectionThreads(sectionId, { cursor, signal }),
        staleTime: 0,
      });
      queryClient.setQueryData<ThreadSummary[]>(queryKeys.sectionThreads(sectionId), (current) => appendThreadPage(current, response.threads));
      setCursors((current) => ({ ...current, [sectionId]: response.nextCursor ?? null }));
      setPaginationStates((current) => ({ ...current, [sectionId]: "idle" }));
    } catch (error) {
      setPaginationStates((current) => ({ ...current, [sectionId]: isCancelledError(error) ? "idle" : "error" }));
      if (!isCancelledError(error)) onError(error);
    } finally {
      if (loadingCursors.current[sectionId] === cursor) delete loadingCursors.current[sectionId];
    }
  }
  const moveThread = useCallback((threadId: string, sectionId: string | null, beforeThreadId?: string | null) => move.mutate({ threadId, sectionId, beforeThreadId }), [move.mutate]);
  return {
    sections,
    threadsBySectionId,
    threads: Object.values(threadsBySectionId).flat(),
    hasMoreById: Object.fromEntries(Object.entries(cursors).map(([id, cursor]) => [id, cursor !== null])),
    paginationStates,
    loadMore,
    isMoving: move.isPending,
    moveThread,
  };
}
