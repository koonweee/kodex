import type { ThreadSummary } from "../api/client";

export function unreadAgentMessageBadgeCount(threadGroups: Array<readonly ThreadSummary[]>): number {
  return unreadAgentMessageThreads(threadGroups).length;
}

function unreadAgentMessageThreads(threadGroups: Array<readonly ThreadSummary[]>): ThreadSummary[] {
  const unreadById = new Map<string, ThreadSummary>();
  for (const group of threadGroups) {
    for (const thread of group) {
      if (thread.unreadCompletedAgentTurn === true) {
        unreadById.set(thread.id, thread);
      }
    }
  }
  return Array.from(unreadById.values());
}
