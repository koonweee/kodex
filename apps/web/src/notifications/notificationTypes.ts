export type KodexNotificationKind = "unreadAgentMessage";

export type KodexNotificationPayload = {
  badgeCount?: number;
  body?: string;
  kind: KodexNotificationKind;
  route?: string;
  threadId?: string;
  title?: string;
};

export type NotificationIntent = {
  badgeCount: number;
  body: string;
  kind: KodexNotificationKind;
  route: string;
  tag: string;
  threadId: string;
  title: string;
};

export type BrowserNotificationPermission = "default" | "denied" | "granted" | "unsupported";
