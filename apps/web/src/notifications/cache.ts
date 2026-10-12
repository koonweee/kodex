import type { QueryClient } from "@tanstack/react-query";

import { notificationQueryClient } from "./unreadBadge";

export async function refreshNotificationQueries(queryClient: QueryClient) {
  queryClient = notificationQueryClient(queryClient);
  const queryKey = ["notifications"];
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
}
