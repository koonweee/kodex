import { deletePushSubscription, upsertPushSubscription } from "../api/client";
import { registerKodexServiceWorker } from "../pwa/registerServiceWorker";

const PUSH_SUBSCRIPTION_ID_KEY = "kodex.pushSubscriptionId";

export function browserPushNotificationsSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof PushManager !== "undefined"
  );
}

export function browserPushNotificationsEnabled(): boolean {
  if (typeof localStorage === "undefined") {
    return false;
  }
  try {
    return Boolean(localStorage.getItem(PUSH_SUBSCRIPTION_ID_KEY));
  } catch {
    return false;
  }
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

export async function enableBrowserPushNotifications(vapidPublicKey: string): Promise<string | null> {
  if (!browserPushNotificationsSupported()) {
    return null;
  }
  const registrationResult = await registerKodexServiceWorker();
  if (!registrationResult.registered) {
    return null;
  }
  const pushManager = registrationResult.registration.pushManager;
  if (!pushManager) {
    return null;
  }
  const subscription =
    (await pushManager.getSubscription()) ??
    (await pushManager.subscribe({
      applicationServerKey: applicationServerKeyBytes(vapidPublicKey),
      userVisibleOnly: true,
    }));
  const response = await upsertPushSubscription(subscription);
  const subscriptionId = response.subscription?.id ?? null;
  if (subscriptionId) {
    localStorage.setItem(PUSH_SUBSCRIPTION_ID_KEY, subscriptionId);
  }
  return subscriptionId;
}

export async function disableBrowserPushNotifications(): Promise<void> {
  const registration = await navigator.serviceWorker?.ready;
  const subscription = await registration?.pushManager?.getSubscription();
  await subscription?.unsubscribe();
  const subscriptionId = localStorage.getItem(PUSH_SUBSCRIPTION_ID_KEY);
  if (subscriptionId) {
    await deletePushSubscription(subscriptionId);
    localStorage.removeItem(PUSH_SUBSCRIPTION_ID_KEY);
  }
}
