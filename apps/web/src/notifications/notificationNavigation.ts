import { notificationClickRoute } from "./notificationTypes";

type NotificationRouteListener = (route: string) => void;

const routeListeners = new Set<NotificationRouteListener>();
let installedContainer: ServiceWorkerContainer | null = null;
let pendingRoute: string | null = null;

function handleServiceWorkerMessage(event: MessageEvent<unknown>) {
  const route = notificationClickRoute(event.data);
  if (!route) {
    return;
  }
  if (routeListeners.size === 0) {
    pendingRoute = route;
    return;
  }
  pendingRoute = null;
  for (const listener of routeListeners) {
    listener(route);
  }
}

export function installNotificationNavigation() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) {
    return;
  }
  const container = navigator.serviceWorker;
  if (installedContainer === container) {
    return;
  }
  installedContainer?.removeEventListener("message", handleServiceWorkerMessage);
  installedContainer = container;
  installedContainer.addEventListener("message", handleServiceWorkerMessage);
}

export function subscribeNotificationNavigation(listener: NotificationRouteListener) {
  installNotificationNavigation();
  routeListeners.add(listener);
  if (pendingRoute) {
    const route = pendingRoute;
    pendingRoute = null;
    listener(route);
  }
  return () => {
    routeListeners.delete(listener);
  };
}
