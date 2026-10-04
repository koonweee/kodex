import type { QueryClient } from "@tanstack/react-query";

import type { EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { asRecord, stringValue } from "../shared/values";

export async function refreshQueuedInputs(queryClient: QueryClient, threadId?: string) {
  const queryKey = threadId ? queryKeys.queuedInputs(threadId) : queryKeys.queuedInputsRoot;
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey });
}

export function applyQueueEvent(queryClient: QueryClient, event: EventEnvelope) {
  if (event.kind !== "turn_queue.changed" && event.kind !== "turn_queue.transfer_changed") return;
  const threadId = event.threadId ?? stringValue(asRecord(event.payload).threadId);
  if (threadId) void refreshQueuedInputs(queryClient, threadId);
}
