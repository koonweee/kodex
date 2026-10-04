import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { setKodexAppBadge } from "./browserBadge";
import { unreadBadgeOptions } from "./unreadBadge";

export function useKodexNotifications() {
  const client = useQueryClient();
  const { data } = useQuery(unreadBadgeOptions(client));
  useEffect(() => {
    if (data) void setKodexAppBadge(data.count);
  }, [data]);
}
