type KodexNotificationKind = "test" | "unreadAgentMessage";

export type KodexNotificationPayload = {
  body?: string;
  kind: KodexNotificationKind;
  executorId?: string;
  route?: string;
  threadId?: string;
  title?: string;
};

export type BrowserNotificationPermission = "default" | "denied" | "granted" | "unsupported";
