import type { QueryClient } from "@tanstack/react-query";

import type { AccountLoginCompleted, EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";

// Recovery needs a read begun after subscription/foreground validation. Ordinary
// refills share in-flight reads; account changes drop the previous account's data.
export async function refreshAccountQueries(queryClient: QueryClient, { reset = false, cancelInFlight = false } = {}) {
  if (reset) {
    for (const mutation of queryClient.getMutationCache().findAll({ mutationKey: queryKeys.resetCredit })) {
      queryClient.getMutationCache().remove(mutation);
    }
  }
  const keys = [queryKeys.account, queryKeys.models];
  if (cancelInFlight) {
    await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
  }
  await Promise.all(keys.map((queryKey) => reset
    ? queryClient.resetQueries({ queryKey })
    : queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false })));
}

export function applyAccountEvent(queryClient: QueryClient, event: EventEnvelope) {
  if (event.kind === "account.rate_limits_updated" && !event.codexMethod) {
    void refreshUsageQueries(queryClient);
  } else if (event.kind === "account.updated") {
    void refreshAccountQueries(queryClient, { reset: true });
  } else if (event.kind === "account.login_completed") {
    const completion = loginCompletionFromEvent(event);
    if (!completion) {
      return;
    }
    if (completion.loginId) {
      // A native completion can precede the HTTP start response. Query-cache GC
      // bounds this per-attempt result; no credentials or codes are stored here.
      queryClient.setQueryData(queryKeys.accountLoginCompletion(completion.loginId), completion);
    }
    void refreshAccountQueries(queryClient);
  }
}

export async function refreshUsageQueries(queryClient: QueryClient) {
  await queryClient.cancelQueries({ queryKey: queryKeys.rateLimits });
  await queryClient.invalidateQueries({ queryKey: queryKeys.rateLimits });
}

function loginCompletionFromEvent(event: EventEnvelope): AccountLoginCompleted | null {
  if (typeof event.payload !== "object" || event.payload === null) {
    return null;
  }
  const payload = event.payload as Partial<AccountLoginCompleted>;
  if (typeof payload.success !== "boolean"
    || (payload.loginId != null && typeof payload.loginId !== "string")
    || (payload.error != null && typeof payload.error !== "string")) {
    return null;
  }
  return { success: payload.success, loginId: payload.loginId ?? null, error: payload.error ?? null };
}
