import { vi } from "vitest";

type RouteHandler = (request: Request) => unknown | Promise<unknown>;

export type GatewayRouteMap = Record<string, unknown | RouteHandler>;

export function mockGateway(routes: GatewayRouteMap) {
  const calls: Request[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    calls.push(request.clone());

    const handler = routes[key];
    if (handler === undefined) {
      return jsonResponse({ code: "not_found", message: `Unhandled route: ${key}`, retryable: false }, 404);
    }

    const body = typeof handler === "function" ? await handler(request.clone()) : handler;
    return jsonResponse(body, request.method === "POST" && key === "POST /v1/projects" ? 201 : 200);
  });

  return {
    calls,
    callsFor(method: string, pathname: string) {
      return calls.filter((request) => {
        const url = new URL(request.url);
        return request.method === method && url.pathname === pathname;
      });
    },
  };
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function requestJson(request: Request) {
  return request.clone().json();
}
