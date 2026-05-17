import type { ThreadSummary } from "../api/client";
import { threadDisplayTitle } from "../threads/helpers";
import type { NotificationIntent } from "./notificationTypes";

const NOTIFICATION_TITLE_MAX_CHARS = 48;

export function unreadAgentMessageBadgeCount(threadGroups: Array<readonly ThreadSummary[]>): number {
  return unreadAgentMessageThreads(threadGroups).length;
}

export function unreadAgentMessageThreads(threadGroups: Array<readonly ThreadSummary[]>): ThreadSummary[] {
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

export function unreadAgentMessageIntent(
  thread: ThreadSummary,
  badgeCount: number,
): NotificationIntent {
  const title = truncateNotificationTitle(threadDisplayTitle(thread));
  return {
    badgeCount: Math.max(1, badgeCount),
    body: "Agent has a new message.",
    kind: "unreadAgentMessage",
    route: `/threads/${encodeURIComponent(thread.id)}`,
    tag: `kodex-unread-agent-message:${thread.id}`,
    threadId: thread.id,
    title,
  };
}

function truncateNotificationTitle(title: string): string {
  if (Array.from(title).length <= NOTIFICATION_TITLE_MAX_CHARS) {
    return title;
  }
  return `${Array.from(title).slice(0, NOTIFICATION_TITLE_MAX_CHARS).join("").trimEnd()}...`;
}
