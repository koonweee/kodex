import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { getUnreadBadge, type EventEnvelope, type UnreadBadgeResponse } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { isFederatedAppShell } from "../api/federatorClient";
import { queryClient as federatorQueryClient } from "../api/queryClient";

export function notificationQueryClient(client: QueryClient) {
  return isFederatedAppShell() ? federatorQueryClient : client;
}

export function unreadBadgeOptions(client: QueryClient) {
  return queryOptions({
    queryKey: queryKeys.unreadBadge,
    retry: false,
    queryFn: async ({ signal }) => {
      const snapshot = await getUnreadBadge(signal);
      signal.throwIfAborted();
      const current = client.getQueryData<UnreadBadgeResponse>(queryKeys.unreadBadge);
      return current && current.readRevision > snapshot.readRevision ? current : snapshot;
    },
  });
}

export async function refreshUnreadBadge(client: QueryClient) {
  client = notificationQueryClient(client);
  await client.cancelQueries({ queryKey: queryKeys.unreadBadge });
  await client.invalidateQueries({ queryKey: queryKeys.unreadBadge }, { cancelRefetch: false });
}

export function applyUnreadBadgeEvent(client: QueryClient, event: EventEnvelope) {
  client = notificationQueryClient(client);
  if (event.kind === "thread.read_updated" || event.kind === "thread.upserted" ||
    (event.kind === "thread.subagents_changed" &&
      ["thread/started", "thread/archived", "thread/unarchived", "thread/deleted"].includes(event.codexMethod ?? ""))) {
    void refreshUnreadBadge(client);
  }
}
