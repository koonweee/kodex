/// <reference lib="webworker" />

import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

import type { UnreadBadgeResponse } from "./api/client";
import type { KodexNotificationPayload } from "./notifications/notificationTypes";

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<unknown> };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const type = (event.data as { type?: unknown } | undefined)?.type;
  if (type === "SKIP_WAITING") self.skipWaiting();
  if (type === "REFRESH_BADGE") event.waitUntil(refreshWorkerBadge());
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

  const notification = self.registration.showNotification(payload.title || "Kodex", {
    badge: "/kodex-badge.png",
    body: payload.body || notificationBody(payload.kind),
    data: payload,
    icon: "/icon-192.png",
    tag: notificationTag(payload),
  });
  await Promise.all([notification, payload.kind === "unreadAgentMessage" ? refreshWorkerBadge() : undefined]);
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

let badgeRequest: AbortController | null = null;

async function refreshWorkerBadge() {
  badgeRequest?.abort();
  const controller = new AbortController();
  badgeRequest = controller;
  try {
    const response = await fetch(new URL("/v1/threads/unread-badge", self.location.origin), {
      signal: controller.signal, cache: "no-store",
    });
    if (!response.ok) return;
    const snapshot = await response.json() as UnreadBadgeResponse;
    if (controller.signal.aborted || badgeRequest !== controller ||
      !Number.isSafeInteger(snapshot.count) || snapshot.count < 0 || !Number.isSafeInteger(snapshot.readRevision)) return;
    const navigator = self.navigator as WorkerNavigator & { setAppBadge?: (count: number) => Promise<void> };
    await navigator.setAppBadge?.(snapshot.count);
  } catch {
    // Unknown inventory or a replaced request preserves the badge. Push itself
    // still displays; old payload counts are never an unread authority.
  } finally {
    if (badgeRequest === controller) badgeRequest = null;
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
