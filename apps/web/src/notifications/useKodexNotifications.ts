import { useEffect, useMemo } from "react";

import type { ThreadSummary } from "../api/client";
import type { ThreadsByProjectId } from "../threads/helpers";
import { setKodexAppBadge } from "./browserBadge";
import { unreadAgentMessageBadgeCount } from "./unreadAgentMessages";

type UseKodexNotificationsParams = {
  chatThreads: ThreadSummary[];
  sectionThreads: ThreadSummary[];
  routeSelectedThread: ThreadSummary | null;
  threadsByProjectId: ThreadsByProjectId;
};

export function useKodexNotifications({
  chatThreads,
  sectionThreads,
  routeSelectedThread,
  threadsByProjectId,
}: UseKodexNotificationsParams) {
  const threadGroups = useMemo(() => {
    const groups = [...Object.values(threadsByProjectId), chatThreads, sectionThreads];
    return routeSelectedThread ? [...groups, [routeSelectedThread]] : groups;
  }, [chatThreads, sectionThreads, routeSelectedThread, threadsByProjectId]);

  useEffect(() => {
    void setKodexAppBadge(unreadAgentMessageBadgeCount(threadGroups));
  }, [threadGroups]);
}
