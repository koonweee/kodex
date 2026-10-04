import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import { getRateLimits, type RateLimitSnapshot } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { usageLimitSnapshotFromResponse } from "./rateLimits";

export function useUsageLimits() {
  const queryClient = useQueryClient();
  const liveSnapshotRevision = useRef(0);
  const query = useQuery({
    queryKey: queryKeys.rateLimits,
    queryFn: async ({ signal }) => {
      const revisionAtStart = liveSnapshotRevision.current;
      const snapshot = usageLimitSnapshotFromResponse(await getRateLimits(signal));
      return liveSnapshotRevision.current !== revisionAtStart
        ? queryClient.getQueryData<RateLimitSnapshot | null>(queryKeys.rateLimits) ?? snapshot
        : snapshot;
    },
  });
  const applyUsageLimitSnapshot = useCallback((snapshot: RateLimitSnapshot) => {
    liveSnapshotRevision.current += 1;
    queryClient.setQueryData(queryKeys.rateLimits, snapshot);
  }, [queryClient]);
  return { usageLimitSnapshot: query.data ?? null, applyUsageLimitSnapshot };
}
