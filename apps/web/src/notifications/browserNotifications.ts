import type { BrowserNotificationPermission } from "./notificationTypes";

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
