type KodexNotificationKind = "test" | "unreadAgentMessage";

export const KODEX_NOTIFICATION_CLICK = "KODEX_NOTIFICATION_CLICK";

export type KodexNotificationClickMessage = {
  route: string;
  type: typeof KODEX_NOTIFICATION_CLICK;
};

export type KodexNotificationPayload = {
  body?: string;
  kind: KodexNotificationKind;
  route?: string;
  threadId?: string;
  title?: string;
};

export type BrowserNotificationPermission = "default" | "denied" | "granted" | "unsupported";

export function notificationClickRoute(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const message = data as Partial<KodexNotificationClickMessage>;
  return message.type === KODEX_NOTIFICATION_CLICK && typeof message.route === "string" && message.route.startsWith("/")
    ? message.route
    : null;
}
