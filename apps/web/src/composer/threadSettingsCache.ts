import type { QueryClient } from "@tanstack/react-query";

import type { EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { asRecord, stringValue } from "../shared/values";

export async function refreshThreadSettings(queryClient: QueryClient, threadId?: string) {
  const queryKey = threadId ? queryKeys.threadSettings(threadId) : queryKeys.threadSettingsRoot;
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey });
}

export function applyThreadSettingsEvent(queryClient: QueryClient, event: EventEnvelope) {
  if (event.kind !== "thread.settings_updated" && event.kind !== "thread_view.patch") return;
  const payload = asRecord(event.payload);
  const threadId = event.threadId ?? stringValue(payload.threadId);
  if (!threadId) return;
  if (event.kind === "thread_view.patch") {
    const settings = queryClient.getQueryState(queryKeys.threadSettings(threadId));
    // A fresh native chat may not have readable settings until its first turn is persisted.
    if (payload.scope !== "lifecycle" || !stringValue(payload.activeTurnId) || !settings || settings.data !== undefined) return;
  }
  void refreshThreadSettings(queryClient, threadId);
}
