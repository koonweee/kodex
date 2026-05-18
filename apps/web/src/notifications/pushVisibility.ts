import type { KodexNotificationPayload } from "./notificationTypes";

type ClientLike = {
  url?: string;
};

export function pushNotificationThreadVisible(
  payload: KodexNotificationPayload,
  clients: readonly ClientLike[],
  origin: string,
): boolean {
  if (payload.kind !== "unreadAgentMessage" || !payload.threadId) {
    return false;
  }
  const threadId = payload.threadId;
  return clients.some((client) => clientShowsThread(client, threadId, origin));
}

function clientShowsThread(client: ClientLike, threadId: string, origin: string): boolean {
  if (!client.url) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(client.url);
  } catch {
    return false;
  }
  if (url.origin !== origin) {
    return false;
  }
  const routeThreadId = threadIdFromPath(url.pathname);
  return routeThreadId === threadId;
}

function threadIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/threads\/([^/]+)$/);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
