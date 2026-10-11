import createClient from "openapi-fetch";

import { compatibleFetch } from "./compatibility";
import type { paths } from "./generated/schema";

export type ExecutorConnection = {
  readonly executorId: string;
  readonly instanceId: string;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const EXPECTED_INSTANCE_HEADER = "x-kodex-expected-instance";

export function executorApiUrl(
  connection: ExecutorConnection,
  route: string,
  baseUrl = browserOrigin(),
): string {
  validateConnection(connection);
  if (!route.startsWith("/v1/")) {
    throw new Error("Executor requests require an unqualified /v1 route.");
  }
  if (route.startsWith("/v1/executors/")) {
    throw new Error("Executor request route is already qualified.");
  }
  const url = new URL(route, baseUrl);
  url.pathname = `/v1/executors/${encodeURIComponent(connection.executorId)}${url.pathname.slice(3)}`;
  return url.toString();
}

export function executorWebSocketUrl(
  connection: ExecutorConnection,
  route: string,
  baseUrl = browserOrigin(),
): string {
  const url = new URL(executorApiUrl(connection, route, baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function createExecutorFetch(
  connection: ExecutorConnection,
  upstream: FetchLike,
  baseUrl?: string,
): FetchLike {
  const binding = snapshotConnection(connection);
  const federatorOrigin = new URL(baseUrl ?? browserOrigin()).origin;
  return async (input, init) => {
    const request = new Request(input, init);
    const original = new URL(request.url);
    if (original.origin !== federatorOrigin) {
      throw new Error("Executor requests must use the configured federator origin.");
    }
    const qualified = executorApiUrl(binding, `${original.pathname}${original.search}`, federatorOrigin);
    const scoped = new Request(qualified, request);
    scoped.headers.set(EXPECTED_INSTANCE_HEADER, binding.instanceId);
    return upstream(scoped);
  };
}

export function createExecutorOpenApiClient(
  connection: ExecutorConnection,
  {
    baseUrl = browserOrigin(),
    fetch = compatibleFetch,
  }: { baseUrl?: string; fetch?: FetchLike } = {},
) {
  const binding = snapshotConnection(connection);
  const federatorOrigin = new URL(baseUrl).origin;
  return createClient<paths>({
    baseUrl: federatorOrigin,
    fetch: createExecutorFetch(binding, fetch, federatorOrigin),
  });
}

export function snapshotConnection(connection: ExecutorConnection): ExecutorConnection {
  validateConnection(connection);
  return Object.freeze({
    executorId: connection.executorId,
    instanceId: connection.instanceId,
  });
}

function validateConnection(connection: ExecutorConnection) {
  if (!connection.executorId.trim() || !connection.instanceId.trim()) {
    throw new Error("Executor connection requires registry and instance identities.");
  }
}

function browserOrigin(): string {
  if (typeof window === "undefined") {
    throw new Error("Executor URL construction requires an explicit base URL outside the browser.");
  }
  return window.location.origin;
}
