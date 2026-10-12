import createClient from "openapi-fetch";

import { compatibleFetch } from "./compatibility";
import type { components, paths } from "./generated/federation";
import { unwrap, unwrapNoContent } from "./gatewayClientShared";

export type ExecutorRegistryEvent = components["schemas"]["ExecutorRegistryEvent"];
export type FederatedExecutor = components["schemas"]["ExecutorRecord"];
export type CatalogEvent = components["schemas"]["CatalogEvent"];
export type FederatedCatalog = components["schemas"]["CatalogResponse"];
export type CatalogExecutorSnapshot = components["schemas"]["CatalogExecutorSnapshot"];
export type QualifiedCatalogRef = components["schemas"]["QualifiedCatalogRef"];
export type CatalogOrder = components["schemas"]["CatalogOrderResponse"];
export type RegisterExecutorRequest = components["schemas"]["RegisterExecutorRequest"];
export type UpdateExecutorRequest = components["schemas"]["UpdateExecutorRequest"];
export type FederatorClientOptions = {
  baseUrl?: string;
};

export function createFederatorClient({
  baseUrl = getApiBaseUrl(),
}: FederatorClientOptions = {}) {
  const api = createClient<paths>({ baseUrl, fetch: (request) => compatibleFetch(request) });

  return {
    getHealth: () => unwrap(api.GET("/healthz", { cache: "no-store" })),
    listExecutors: () => unwrap(api.GET("/v1/federation/executors", { cache: "no-store" })),
    registerExecutor: (request: components["schemas"]["RegisterExecutorRequest"]) => (
      unwrap(api.POST("/v1/federation/executors", { body: request }))
    ),
    getExecutor: (executorId: string) => unwrap(api.GET("/v1/federation/executors/{executorId}", {
      params: { path: { executorId } },
      cache: "no-store",
    })),
    updateExecutor: (executorId: string, request: components["schemas"]["UpdateExecutorRequest"]) => (
      unwrap(api.PATCH("/v1/federation/executors/{executorId}", {
        params: { path: { executorId } },
        body: request,
      }))
    ),
    removeExecutor: (executorId: string) => unwrapNoContent(api.DELETE("/v1/federation/executors/{executorId}", {
      params: { path: { executorId } },
    })),
    probeExecutor: (executorId: string) => unwrap(api.POST("/v1/federation/executors/{executorId}/probe", {
      params: { path: { executorId } },
    })),
    getCatalog: () => unwrap(api.GET("/v1/federation/catalog", { cache: "no-store" })),
    refreshCatalog: () => unwrap(api.POST("/v1/federation/catalog")),
    moveCatalogItem: (
      kind: "project" | "pinned",
      request: components["schemas"]["MoveCatalogItemRequest"],
    ) => unwrap(api.POST("/v1/federation/catalog/order/{kind}/move", {
      params: { path: { kind } },
      body: request,
    })),
    getNotificationStatus: (signal?: AbortSignal) => unwrap(api.GET("/v1/notifications/status", { signal, cache: "no-store" })),
    getCurrentPushSubscriptionStatus: (endpoint: string, signal?: AbortSignal) => unwrap(api.GET("/v1/notifications/subscription/current", { params: { query: { endpoint } }, signal, cache: "no-store" })),
    upsertPushSubscription: (
      subscription: PushSubscription,
      userAgent: string | null = typeof navigator === "undefined" ? null : navigator.userAgent,
    ) => {
      const value = subscription.toJSON();
      const endpoint = value.endpoint;
      const auth = value.keys?.auth;
      const p256dh = value.keys?.p256dh;
      if (!endpoint || !auth || !p256dh) throw new Error("Push subscription is missing endpoint or keys");
      return unwrap(api.POST("/v1/notifications/subscriptions", { body: { endpoint, keys: { auth, p256dh }, userAgent } }));
    },
    deleteCurrentPushSubscription: (endpoint: string) => unwrap(api.DELETE("/v1/notifications/subscription/current", { params: { query: { endpoint } } })),
    sendTestNotification: () => unwrap(api.POST("/v1/notifications/test", {})),
  };
}

export function createFederationCatalogSubscription({
  EventSourceCtor = globalThis.EventSource as EventSourceCtor | undefined,
  baseUrl,
  onEvent,
}: {
  EventSourceCtor?: EventSourceCtor;
  baseUrl?: string;
  onEvent: (event: CatalogEvent) => void;
}): () => void {
  if (!EventSourceCtor) return () => undefined;
  const route = "/v1/federation/catalog/events";
  const source = new EventSourceCtor(baseUrl ? new URL(route, baseUrl).toString() : route);
  source.addEventListener("federation.catalog_changed", (message) => {
    try {
      const event = JSON.parse(message.data) as Partial<CatalogEvent>;
      if (typeof event.revision === "number" && typeof event.orderRevision === "number") onEvent(event as CatalogEvent);
    } catch {
      // Reconnect/refetch supplies the authoritative snapshot.
    }
  });
  return () => source.close();
}

export function isFederatedAppShell(): boolean {
  return typeof document !== "undefined"
    && document.head.querySelector<HTMLMetaElement>('meta[name="kodex-federator"]')?.content === "true";
}

export type FederatorClient = ReturnType<typeof createFederatorClient>;

type EventSourceLike = {
  addEventListener: (type: string, listener: (event: MessageEvent<string>) => void) => void;
  close: () => void;
};

type EventSourceCtor = new (url: string) => EventSourceLike;

export function createFederationRegistrySubscription({
  EventSourceCtor = globalThis.EventSource as EventSourceCtor | undefined,
  baseUrl,
  onEvent,
}: {
  EventSourceCtor?: EventSourceCtor;
  baseUrl?: string;
  onEvent: (event: ExecutorRegistryEvent) => void;
}): () => void {
  if (!EventSourceCtor) return () => undefined;
  const route = "/v1/federation/events";
  const source = new EventSourceCtor(baseUrl ? new URL(route, baseUrl).toString() : route);
  source.addEventListener("federation.executors_changed", (message) => {
    const event = parseRegistryEvent(message.data);
    if (event) onEvent(event);
  });
  return () => source.close();
}

function parseRegistryEvent(value: string): ExecutorRegistryEvent | null {
  try {
    const event = JSON.parse(value) as Partial<ExecutorRegistryEvent>;
    if (typeof event.revision !== "number" || !Number.isSafeInteger(event.revision)) return null;
    if (event.executorId !== undefined && event.executorId !== null && typeof event.executorId !== "string") return null;
    if (event.generation !== undefined && event.generation !== null && typeof event.generation !== "number") return null;
    return event as ExecutorRegistryEvent;
  } catch {
    return null;
  }
}

function getApiBaseUrl(): string {
  if (import.meta.env.VITE_KODEX_API_BASE_URL) return import.meta.env.VITE_KODEX_API_BASE_URL;
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}
