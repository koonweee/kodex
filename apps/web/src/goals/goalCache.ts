import type { QueryClient } from "@tanstack/react-query";

import type { EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { asRecord, stringValue } from "../shared/values";

export async function refreshThreadGoals(queryClient: QueryClient, threadId?: string) {
  const queryKey = threadId ? queryKeys.threadGoal(threadId) : queryKeys.threadGoalsRoot;
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey });
}

export function applyThreadGoalEvent(queryClient: QueryClient, event: EventEnvelope) {
  if (event.kind !== "thread.goal_changed" && event.kind !== "thread_view.patch") return;
  const payload = asRecord(event.payload);
  const threadId = event.threadId ?? stringValue(payload.threadId);
  if (!threadId) return;
  if (event.kind === "thread_view.patch") {
    const goal = queryClient.getQueryState(queryKeys.threadGoal(threadId));
    // A new native chat may not be materialized until its first turn begins.
    if (payload.scope !== "lifecycle" || !stringValue(payload.activeTurnId) || !goal || goal.data !== undefined) return;
  }
  void refreshThreadGoals(queryClient, threadId);
}
