import {
  deleteCurrentPushSubscription,
  getCurrentPushSubscriptionStatus,
  upsertPushSubscription,
} from "../api/client";
import { getServiceWorkerRegistration } from "../pwa/registerServiceWorker";
import { notificationPermission } from "./browserNotifications";
import type { BrowserNotificationPermission } from "./notificationTypes";

export type BrowserPushNotificationState = {
  configured: boolean;
  endpoint: string | null;
  hasBrowserSubscription: boolean;
  permission: BrowserNotificationPermission;
  subscribed: boolean;
  supported: boolean;
};

export function browserPushNotificationsSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof Notification !== "undefined" &&
    typeof PushManager !== "undefined"
  );
}

export function applicationServerKeyBytes(key: string): ArrayBuffer {
  const normalized = key.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const raw = globalThis.atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes.buffer;
}

export async function loadBrowserPushNotificationState(signal?: AbortSignal): Promise<BrowserPushNotificationState> {
  const supported = browserPushNotificationsSupported();
  const permission = notificationPermission();
  if (!supported || permission !== "granted") {
    return {
      configured: false,
      endpoint: null,
      hasBrowserSubscription: false,
      permission,
      subscribed: false,
      supported,
    };
  }

  const subscription = await currentBrowserPushSubscription();
  signal?.throwIfAborted();
  const endpoint = subscription?.endpoint ?? null;
  if (!endpoint) {
    return {
      configured: false,
      endpoint: null,
      hasBrowserSubscription: false,
      permission,
      subscribed: false,
      supported,
    };
  }

  const status = await getCurrentPushSubscriptionStatus(endpoint, signal);
  return {
    configured: status.configured,
    endpoint,
    hasBrowserSubscription: true,
    permission,
    subscribed: status.subscribed,
    supported,
  };
}

export async function enableBrowserPushNotifications(vapidPublicKey: string): Promise<PushSubscription> {
  if (!browserPushNotificationsSupported()) {
    throw new Error("Push notifications are not supported in this browser.");
  }
  const registration = await getServiceWorkerRegistration();
  const pushManager = registration.pushManager;
  if (!pushManager) {
    throw new Error("Push notifications are not supported in this browser.");
  }
  const subscription =
    (await pushManager.getSubscription()) ??
    (await pushManager.subscribe({
      applicationServerKey: applicationServerKeyBytes(vapidPublicKey),
      userVisibleOnly: true,
    }));
  await upsertPushSubscription(subscription);
  return subscription;
}

export async function disableBrowserPushNotifications(): Promise<void> {
  const subscription = await currentBrowserPushSubscription();
  const endpoint = subscription?.endpoint ?? null;
  if (endpoint) {
    await deleteCurrentPushSubscription(endpoint);
  }
  try {
    await subscription?.unsubscribe();
  } catch {
    // Server-side disable is the important shared state; keep going even if the
    // local browser subscription is already gone or service worker state is stale.
  }
}

async function currentBrowserPushSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager?.getSubscription()) ?? null;
}
