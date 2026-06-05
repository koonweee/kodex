/// <reference lib="webworker" />

import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

import type { KodexNotificationPayload } from "./notifications/notificationTypes";

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<unknown> };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if ((event.data as { type?: unknown } | undefined)?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("push", (event) => {
  event.waitUntil(showPushNotification(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const route = notificationRoute(event.notification.data);
  event.waitUntil(focusOrOpenKodex(route));
});

async function showPushNotification(event: PushEvent) {
  const payload = parsePushPayload(event.data);
  if (!payload || (payload.kind !== "unreadAgentMessage" && payload.kind !== "test")) {
    return;
  }

  await setWorkerBadge(payload.badgeCount ?? 1);
  await self.registration.showNotification(payload.title || "Kodex", {
    badge: "/kodex-badge.png",
    body: payload.body || notificationBody(payload.kind),
    data: payload,
    icon: "/icon-192.png",
    tag: notificationTag(payload),
  });
}

function parsePushPayload(data: PushMessageData | null): KodexNotificationPayload | null {
  if (!data) {
    return null;
  }
  try {
    const value = data.json() as KodexNotificationPayload;
    return value && typeof value.kind === "string" ? value : null;
  } catch {
    return null;
  }
}

function notificationRoute(data: unknown): string {
  const route = data && typeof data === "object" && "route" in data ? (data as { route?: unknown }).route : null;
  if (typeof route !== "string" || !route.startsWith("/")) {
    return "/";
  }
  const url = new URL(route, self.location.origin);
  if (url.origin !== self.location.origin) {
    return "/";
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

async function focusOrOpenKodex(route: string) {
  const url = new URL(route, self.location.origin).href;
  const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of windows) {
    if (!("focus" in client)) {
      continue;
    }
    const windowClient = client as WindowClient;
    if (new URL(windowClient.url).origin !== self.location.origin) {
      continue;
    }
    if ("navigate" in windowClient) {
      await windowClient.navigate(url);
    }
    return windowClient.focus();
  }
  return self.clients.openWindow(url);
}

async function setWorkerBadge(count: number) {
  const registration = self.registration as ServiceWorkerRegistration & {
    setAppBadge?: (contents?: number) => Promise<void>;
  };
  if (!registration.setAppBadge) {
    return;
  }
  try {
    await registration.setAppBadge(count);
  } catch {
    // Badging support varies; notifications should still display.
  }
}

function notificationBody(kind: KodexNotificationPayload["kind"]): string {
  return kind === "test" ? "Push notifications are working." : "Agent has a new message.";
}

function notificationTag(payload: KodexNotificationPayload): string {
  if (payload.kind === "test") {
    return "kodex-test-notification";
  }
  return payload.threadId ? `kodex-unread-agent-message:${payload.threadId}` : "kodex-unread-agent-message";
}
