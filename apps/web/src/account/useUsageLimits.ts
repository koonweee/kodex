import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { getRateLimits, type RateLimitSnapshot, type RateLimitsResponse } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { usageLimitSnapshotFromResponse } from "./rateLimits";

export function useUsageLimits() {
  const queryClient = useQueryClient();
  const query = useQuery(usageQueryOptions(queryClient));
  const applyUsageLimitSnapshot = useCallback((snapshot: RateLimitSnapshot) => {
    queryClient.setQueryData<RateLimitsResponse>(queryKeys.rateLimits, (current) => {
      const previous = current ? usageLimitSnapshotFromResponse(current) : null;
      return { ...current, rawPayload: current?.rawPayload ?? {}, rateLimits: mergeUsageUpdate(previous, snapshot) };
    });
  }, [queryClient]);
  return { usageLimitSnapshot: query.data ? usageLimitSnapshotFromResponse(query.data) : null, applyUsageLimitSnapshot };
}

export function usageQueryOptions(queryClient: QueryClient) {
  return queryOptions({
    queryKey: queryKeys.rateLimits,
    queryFn: async ({ signal }) => {
      const before = queryClient.getQueryData<RateLimitsResponse>(queryKeys.rateLimits);
      const response = await getRateLimits(signal);
      const current = queryClient.getQueryData<RateLimitsResponse>(queryKeys.rateLimits);
      // Retain newer live windows while completing the full metadata read.
      // Reset/account invalidations cancel this read separately through signal.
      if (current && current !== before) {
        return { ...response, rateLimits: mergeUsageUpdate(usageLimitSnapshotFromResponse(response), usageLimitSnapshotFromResponse(current) ?? {}) };
      }
      return response;
    },
  });
}

function mergeUsageUpdate(previous: RateLimitSnapshot | null, update: RateLimitSnapshot): RateLimitSnapshot {
  const available = Object.fromEntries(Object.entries(update).filter(([, value]) => value != null));
  const merged = { ...previous, ...available };
  for (const key of ["primary", "secondary"] as const) {
    const window = update[key];
    if (window) merged[key] = {
      ...window,
      resetsAt: window.resetsAt ?? previous?.[key]?.resetsAt,
      windowDurationMins: window.windowDurationMins ?? previous?.[key]?.windowDurationMins,
    };
  }
  if (update.credits) {
    merged.credits = { ...update.credits, balance: update.credits.balance ?? previous?.credits?.balance };
  }
  return merged;
}
