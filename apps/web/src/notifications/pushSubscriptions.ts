import {
  deleteCurrentPushSubscription,
  getCurrentPushSubscriptionStatus,
  upsertPushSubscription,
  type CurrentPushSubscriptionStatusResponse,
} from "../api/client";
import { getServiceWorkerRegistration, pwaGatewayIsSameOrigin } from "../pwa/registerServiceWorker";
import { notificationPermission } from "./browserNotifications";
import type { BrowserNotificationPermission } from "./notificationTypes";

export type BrowserPushSubscriptionTransport = {
  current: (endpoint: string, signal?: AbortSignal) => Promise<Pick<CurrentPushSubscriptionStatusResponse, "configured" | "subscribed">>;
  upsert: (subscription: PushSubscription) => Promise<unknown>;
  disable: (endpoint: string) => Promise<unknown>;
};
const defaultTransport: BrowserPushSubscriptionTransport = {
  current: getCurrentPushSubscriptionStatus,
  upsert: upsertPushSubscription,
  disable: deleteCurrentPushSubscription,
};

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
    pwaGatewayIsSameOrigin() &&
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

export async function loadBrowserPushNotificationState(signal?: AbortSignal, transport: BrowserPushSubscriptionTransport = defaultTransport): Promise<BrowserPushNotificationState> {
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

  const status = await transport.current(endpoint, signal);
  return {
    configured: status.configured,
    endpoint,
    hasBrowserSubscription: true,
    permission,
    subscribed: status.subscribed,
    supported,
  };
}

export async function enableBrowserPushNotifications(vapidPublicKey: string, transport: BrowserPushSubscriptionTransport = defaultTransport): Promise<PushSubscription> {
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
  await transport.upsert(subscription);
  return subscription;
}

export async function disableBrowserPushNotifications(transport: BrowserPushSubscriptionTransport = defaultTransport): Promise<void> {
  const subscription = await currentBrowserPushSubscription();
  const endpoint = subscription?.endpoint ?? null;
  if (endpoint) {
    await transport.disable(endpoint);
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
