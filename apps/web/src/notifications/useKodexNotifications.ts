import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { setKodexAppBadge } from "./browserBadge";
import { refreshNotificationQueries } from "./cache";
import { notificationQueryClient, refreshUnreadBadge, unreadBadgeOptions } from "./unreadBadge";

export function useKodexNotifications() {
  const client = useQueryClient();
  const notificationClient = notificationQueryClient(client);
  const { data } = useQuery(unreadBadgeOptions(notificationClient), notificationClient);
  useEffect(() => {
    if (data) void setKodexAppBadge(data.count);
  }, [data]);
  useEffect(() => {
    const refresh = () => {
      void refreshUnreadBadge(notificationClient);
      void refreshNotificationQueries(notificationClient);
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("pageshow", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, [notificationClient]);
}
