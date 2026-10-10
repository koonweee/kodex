import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";

import { consumeRateLimitResetCredit } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { createClientRequestId } from "../shared/id";
import { refreshUsageQueries } from "./cache";

type Request = Parameters<typeof consumeRateLimitResetCredit>[0];
type Response = Awaited<ReturnType<typeof consumeRateLimitResetCredit>>;

export function useResetCredit() {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationKey: queryKeys.resetCredit,
    mutationFn: consumeRateLimitResetCredit,
    retry: false,
    // An unresolved attempt survives closing/reopening Preferences. Account
    // changes clear this mutation history along with the account queries.
    gcTime: Infinity,
    onSettled: () => refreshUsageQueries(client),
  });
  const states = useMutationState({
    filters: { mutationKey: queryKeys.resetCredit },
    select: (entry) => ({
      status: entry.state.status,
      variables: entry.state.variables as Request | undefined,
      data: entry.state.data as Response | undefined,
      error: entry.state.error,
    }),
  });
  const latest = states.at(-1);

  function useReset(creditId: string) {
    const attempts = client.getMutationCache().findAll({ mutationKey: queryKeys.resetCredit });
    const last = attempts.at(-1);
    if (last?.state.status === "pending") return;
    const unresolved = last?.state.status === "error" ? last.state.variables as Request : null;
    if (unresolved && unresolved.creditId !== creditId) return;
    // Keep just the current attempt; its variables retain an ambiguous retry's
    // identity, without accumulating a browser-owned reset history.
    for (const entry of attempts) client.getMutationCache().remove(entry);
    mutation.mutate(unresolved ?? { creditId, idempotencyKey: createClientRequestId() });
  }

  return {
    isPending: latest?.status === "pending",
    variables: latest?.variables,
    data: latest?.data,
    error: latest?.error,
    useReset,
  };
}
