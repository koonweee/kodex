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
      const threadDetail = await fallbackThreadDetail(routes, request);
      if (threadDetail) {
        return jsonResponse(threadDetail, 200);
      }
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

async function fallbackThreadDetail(routes: GatewayRouteMap, request: Request) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/v1\/threads\/([^/]+)$/);
  if (request.method !== "GET" || !match) {
    return null;
  }

  const threadId = decodeURIComponent(match[1]);
  const threadsRoute = routes["GET /v1/threads"];
  const threadsBody =
    typeof threadsRoute === "function"
      ? await threadsRoute(new Request("http://localhost/v1/threads"))
      : threadsRoute;
  const thread = (threadsBody as { threads?: Array<Record<string, unknown>> } | undefined)?.threads?.find(
    (candidate) => candidate.id === threadId,
  );
  if (!thread) {
    return null;
  }

  const eventsRoute = routes["GET /v1/events"];
  const eventsBody =
    typeof eventsRoute === "function"
      ? await eventsRoute(new Request(`http://localhost/v1/events?threadId=${threadId}`))
      : eventsRoute;
  const events = Array.isArray((eventsBody as { events?: unknown[] } | undefined)?.events)
    ? ((eventsBody as { events: Array<Record<string, unknown>> }).events)
    : [];

  return {
    thread,
    turns: turnsFromEvents(events, threadId),
    liveState: thread.status === "active" ? "streaming" : "idle",
    rawPayload: {},
  };
}

function turnsFromEvents(events: Array<Record<string, unknown>>, threadId: string) {
  const turns = new Map<string, { id: string; status: string; items: unknown[]; rawPayload: unknown }>();
  for (const event of events) {
    if (event.threadId !== threadId || !event.turnId || !event.itemId) {
      continue;
    }
    const turnId = String(event.turnId);
    const turn = turns.get(turnId) ?? { id: turnId, status: "completed", items: [], rawPayload: {} };
    const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
    const rawPayload =
      payload.item && typeof payload.item === "object"
        ? payload.item
        : { id: event.itemId, type: itemTypeFromEvent(event), text: payload.delta, ...payload };
    turn.items.push({
      id: String(event.itemId),
      itemType: String((rawPayload as Record<string, unknown>).type ?? itemTypeFromEvent(event)),
      rawPayload,
    });
    turns.set(turnId, turn);
  }
  return [...turns.values()];
}

function itemTypeFromEvent(event: Record<string, unknown>) {
  const method = String(event.codexMethod ?? "").toLowerCase();
  if (method.includes("agentmessage")) {
    return "agentMessage";
  }
  if (method.includes("user")) {
    return "userMessage";
  }
  if (method.includes("command")) {
    return "commandExecution";
  }
  return "agentMessage";
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
