import { useCallback, useEffect, useMemo, useRef } from "react";

import type { EventEnvelope, ThreadSummary } from "../api/client";
import { completedAgentTurnEvent } from "../threads/events";
import type { ThreadsByProjectId } from "../threads/helpers";
import { showForegroundNotification } from "./browserNotifications";
import { setKodexAppBadge } from "./browserBadge";
import { unreadAgentMessageBadgeCount, unreadAgentMessageIntent } from "./unreadAgentMessages";

type UseKodexNotificationsParams = {
  chatThreads: ThreadSummary[];
  pinnedThreads: ThreadSummary[];
  routeSelectedThread: ThreadSummary | null;
  selectedThreadId: string | null;
  threadsByProjectId: ThreadsByProjectId;
};

export function useKodexNotifications({
  chatThreads,
  pinnedThreads,
  routeSelectedThread,
  selectedThreadId,
  threadsByProjectId,
}: UseKodexNotificationsParams) {
  const selectedThreadIdRef = useRef<string | null>(selectedThreadId);
  const threadGroups = useMemo(() => {
    const groups = [...Object.values(threadsByProjectId), chatThreads, pinnedThreads];
    return routeSelectedThread ? [...groups, [routeSelectedThread]] : groups;
  }, [chatThreads, pinnedThreads, routeSelectedThread, threadsByProjectId]);
  const threadGroupsRef = useRef(threadGroups);

  selectedThreadIdRef.current = selectedThreadId;
  threadGroupsRef.current = threadGroups;

  useEffect(() => {
    void setKodexAppBadge(unreadAgentMessageBadgeCount(threadGroups));
  }, [threadGroups]);

  const applyNotificationEvent = useCallback((event: EventEnvelope) => {
    const completedTurn = completedAgentTurnEvent(event);
    if (!completedTurn || completedTurn.threadId === selectedThreadIdRef.current) {
      return;
    }
    const thread = threadGroupsRef.current.flat().find((candidate) => candidate.id === completedTurn.threadId);
    if (!thread) {
      return;
    }
    const nextBadgeCount = Math.max(1, unreadAgentMessageBadgeCount(threadGroupsRef.current));
    showForegroundNotification(unreadAgentMessageIntent(thread, nextBadgeCount));
  }, []);

  return { applyNotificationEvent };
}
