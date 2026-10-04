import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { listThreadSubagents } from "../api/client";
import { queryKeys } from "../api/queryKeys";

export function useThreadSubagents(ancestorThreadId: string | null) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: queryKeys.threadSubagents(ancestorThreadId),
    enabled: ancestorThreadId !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => listThreadSubagents(ancestorThreadId!, { cursor: pageParam, signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const subagents = useMemo(() => query.data?.pages.flatMap((page) => page.subagents) ?? [], [query.data]);
  const selectedSubagent = subagents.find((subagent) => subagent.id === selectedId) ?? subagents[0] ?? null;
  const toggle = useCallback(() => setOpen((current) => !current), []);

  useEffect(() => {
    setOpen(false);
    setSelectedId(null);
  }, [ancestorThreadId]);

  return {
    subagents,
    selectedId: selectedSubagent?.id ?? null,
    select: setSelectedId,
    open,
    toggle,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    error: query.error,
    loadMore: () => { void query.fetchNextPage(); },
    reload: () => { void query.refetch(); },
  };
}
