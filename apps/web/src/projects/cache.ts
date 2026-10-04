import type { QueryClient } from "@tanstack/react-query";

import type { EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";

export async function refreshProjectState(queryClient: QueryClient) {
  await Promise.all([
    queryKeys.sidebarThreads,
    queryKeys.projects,
    queryKeys.threadPages,
    queryKeys.projectThreadsRoot,
    queryKeys.chatThreads,
    queryKeys.sectionThreadsRoot,
  ].map((queryKey) => queryClient.cancelQueries({ queryKey })));
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarThreads }, { cancelRefetch: false }),
  ]);
}

export function applyProjectEvent(queryClient: QueryClient, event: EventEnvelope) {
  if (event.kind === "project.changed" || event.kind === "thread.project_updated") {
    void refreshProjectState(queryClient);
  }
}

export function projectEventInvalidatesThread(event: EventEnvelope, threadId: string): boolean {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return false;
  const payload = event.payload as Record<string, unknown>;
  return (event.kind === "thread.project_updated" && payload.threadId === threadId) ||
    (event.kind === "project.changed" && payload.changeType === "deleted");
}
