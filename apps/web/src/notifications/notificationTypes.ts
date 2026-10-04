type KodexNotificationKind = "test" | "unreadAgentMessage";

export type KodexNotificationPayload = {
  body?: string;
  kind: KodexNotificationKind;
  route?: string;
  threadId?: string;
  title?: string;
};

export type BrowserNotificationPermission = "default" | "denied" | "granted" | "unsupported";
