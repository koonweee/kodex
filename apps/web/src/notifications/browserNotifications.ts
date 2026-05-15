import type { BrowserNotificationPermission, NotificationIntent } from "./notificationTypes";

export function notificationPermission(): BrowserNotificationPermission {
  if (typeof Notification === "undefined") {
    return "unsupported";
  }
  return Notification.permission;
}

export async function requestKodexNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (typeof Notification === "undefined" || typeof Notification.requestPermission !== "function") {
    return "unsupported";
  }
  return Notification.requestPermission();
}

export function showForegroundNotification(intent: NotificationIntent): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return false;
  }
  new Notification(intent.title, {
    body: intent.body,
    data: {
      kind: intent.kind,
      route: intent.route,
      threadId: intent.threadId,
    },
    tag: intent.tag,
  });
  return true;
}
