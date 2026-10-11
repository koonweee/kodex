import createClient from "openapi-fetch";

import { compatibleFetch } from "./compatibility";
import type { components, paths } from "./generated/federation";
import { unwrap, unwrapNoContent } from "./gatewayClientShared";

export type ExecutorRegistryEvent = components["schemas"]["ExecutorRegistryEvent"];
export type FederatorClientOptions = {
  baseUrl?: string;
};

export function createFederatorClient({
  baseUrl = getApiBaseUrl(),
}: FederatorClientOptions = {}) {
  const api = createClient<paths>({ baseUrl, fetch: (request) => compatibleFetch(request) });

  return {
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
  };
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
