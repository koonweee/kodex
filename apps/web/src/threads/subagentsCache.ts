import type { QueryClient } from "@tanstack/react-query";

import type { EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { asRecord } from "../shared/values";

export async function refreshThreadSubagents(queryClient: QueryClient) {
  await queryClient.cancelQueries({ queryKey: queryKeys.threadSubagentsRoot });
  await queryClient.invalidateQueries({ queryKey: queryKeys.threadSubagentsRoot });
}

export function applySubagentsEvent(queryClient: QueryClient, event: EventEnvelope) {
  if (event.kind === "thread.subagents_changed") void refreshThreadSubagents(queryClient);
}

export function subagentsEventInvalidatesThread(event: EventEnvelope, threadId: string): boolean {
  return event.kind === "thread.subagents_changed" && asRecord(event.payload).changedThreadId === threadId;
}
