import type { Client } from "openapi-fetch";

import type { components, paths } from "./generated/schema";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type GatewayClientDependencies = {
  api: Client<paths>;
  compatibilityRequired: () => boolean;
  requestUrl: (route: string) => string;
  resolveRoute: (route: string) => string;
  transportFetch: FetchLike;
};

type GatewayErrorBody = Partial<components["schemas"]["ApiErrorBody"]>;

export class GatewayRequestError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string) {
    super(message);
    this.name = "GatewayRequestError";
  }
}

export async function unwrap<T>(request: Promise<{ data?: T; error?: unknown; response?: Response }>): Promise<T> {
  const { data, error, response } = await request;
  if (error || data === undefined) {
    throw new GatewayRequestError(gatewayErrorMessage(error), response?.status, isGatewayErrorBody(error) ? error.code : undefined);
  }
  return data;
}

export async function unwrapNoContent(request: Promise<{ error?: unknown; response?: Response }>): Promise<void> {
  const { error, response } = await request;
  if (error) {
    throw new GatewayRequestError(gatewayErrorMessage(error), response?.status, isGatewayErrorBody(error) ? error.code : undefined);
  }
}

function gatewayErrorMessage(error: unknown): string {
  if (isGatewayErrorBody(error) && typeof error.message === "string") {
    return error.message;
  }
  return "Gateway request failed";
}

export async function responseErrorMessage(response: Response): Promise<string> {
  try {
    return gatewayErrorMessage((await response.clone().json()) as unknown);
  } catch {
    return "Gateway request failed";
  }
}

function isGatewayErrorBody(error: unknown): error is GatewayErrorBody {
  return typeof error === "object" && error !== null && "message" in error;
}
