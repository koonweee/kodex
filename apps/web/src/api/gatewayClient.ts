import { compatibleFetch, compatibilityRequired } from "./compatibility";
import createClient from "openapi-fetch";

import { createExecutorFetch, executorApiUrl, snapshotConnection, type ExecutorConnection } from "./executorConnection";
import type { paths } from "./generated/schema";
import { createGatewayFeatures } from "./gatewayClientFeatures";
import { createGatewayQueue } from "./gatewayClientQueue";
import { createGatewayResources } from "./gatewayClientResources";
import { createGatewayThreads } from "./gatewayClientThreads";
import type { FetchLike, GatewayClientDependencies } from "./gatewayClientShared";

export type GatewayClientOptions = {
  baseUrl?: string;
  compatibilityRequired?: () => boolean;
  fetch?: FetchLike;
  routeUrl?: (route: string) => string;
};

export function createGatewayClient({
  baseUrl = getApiBaseUrl(),
  compatibilityRequired: isCompatibilityRequired = compatibilityRequired,
  fetch = compatibleFetch,
  routeUrl,
}: GatewayClientOptions = {}) {
  const requestUrl = (route: string) => (
    baseUrl ? new URL(route, baseUrl).toString() : route
  );
  const dependencies: GatewayClientDependencies = {
    api: createClient<paths>({
      baseUrl,
      fetch: (request) => fetch(request),
    }),
    compatibilityRequired: isCompatibilityRequired,
    requestUrl,
    resolveRoute: routeUrl ?? requestUrl,
    transportFetch: fetch,
  };
  return {
    ...createGatewayResources(dependencies),
    ...createGatewayThreads(dependencies),
    ...createGatewayQueue(dependencies),
    ...createGatewayFeatures(dependencies),
  };
}

export function createExecutorGatewayClient(
  connection: ExecutorConnection,
  options: Omit<GatewayClientOptions, "routeUrl"> = {},
) {
  const binding = snapshotConnection(connection);
  const baseUrl = options.baseUrl ?? getApiBaseUrl();
  if (!baseUrl) {
    throw new Error("Executor gateway clients require a federator base URL.");
  }
  const federatorOrigin = new URL(baseUrl).origin;
  const fetch = createExecutorFetch(binding, options.fetch ?? compatibleFetch, federatorOrigin);
  return createGatewayClient({
    ...options,
    baseUrl: federatorOrigin,
    fetch,
    routeUrl: (route) => executorApiUrl(binding, route, federatorOrigin),
  });
}

function getApiBaseUrl(): string {
  if (import.meta.env.VITE_KODEX_API_BASE_URL) {
    return import.meta.env.VITE_KODEX_API_BASE_URL;
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "";
}
