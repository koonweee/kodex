import { vi } from "vitest";

type RouteHandler = (request: Request) => unknown | Promise<unknown>;

export type GatewayRouteMap = Record<string, unknown | RouteHandler>;

export function mockGateway(routes: GatewayRouteMap) {
  const calls: Request[] = [];
  let nextQueueIndex = 0;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    calls.push(request.clone());

    const handler = routes[key];
    if (handler === undefined) {
      const queuedInput = await fallbackQueuedInput(request, () => {
        nextQueueIndex += 1;
        return `queue-${nextQueueIndex}`;
      });
      if (queuedInput) {
        return jsonResponse(queuedInput, 200);
      }
      const threadDetail = await fallbackThreadDetail(routes, request);
      if (threadDetail) {
        return jsonResponse(threadDetail, 200);
      }
      return jsonResponse({ code: "not_found", message: `Unhandled route: ${key}`, retryable: false }, 404);
    }

    const body = typeof handler === "function" ? await handler(request.clone()) : handler;
    if (body instanceof Response) {
      return body;
    }
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

async function fallbackQueuedInput(request: Request, nextQueueId: () => string) {
  const url = new URL(request.url);
  const listMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)\/queued-inputs$/);
  if (request.method === "GET" && listMatch) {
    return { queuedInputs: [] };
  }
  if (request.method === "POST" && listMatch) {
    const threadId = decodeURIComponent(listMatch[1]);
    const body = (await request.clone().json()) as { input?: unknown[] };
    return {
      queuedInput: {
        id: nextQueueId(),
        threadId,
        input: body.input ?? [],
        options: {},
        status: "queued",
        priority: "normal",
        attemptCount: 0,
        lastError: null,
        createdAt: "2026-05-05T00:00:00Z",
        updatedAt: "2026-05-05T00:00:00Z",
      },
    };
  }

  const actionMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)\/queued-inputs\/([^/]+)(?:\/(retry|steer))?$/);
  if (!actionMatch) {
    return null;
  }
  const threadId = decodeURIComponent(actionMatch[1]);
  const queueId = decodeURIComponent(actionMatch[2]);
  const action = actionMatch[3];
  if (request.method === "DELETE" || (request.method === "POST" && action === "steer")) {
    return { id: queueId, threadId };
  }
  if (request.method === "POST" && action === "retry") {
    return {
      queuedInput: {
        id: queueId,
        threadId,
        input: [{ type: "text", text: "Retry later" }],
        options: {},
        status: "queued",
        priority: "normal",
        attemptCount: 1,
        lastError: null,
        createdAt: "2026-05-05T00:00:00Z",
        updatedAt: "2026-05-05T00:00:00Z",
      },
    };
  }
  return null;
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

  const turns: Array<{ id: string; status: string; items: unknown[]; rawPayload: unknown }> = [];
  if (thread.status === "active") {
    const activeTurn = [...turns].reverse().find((turn) => turn.items.length > 0);
    if (activeTurn) {
      activeTurn.status = "running";
    }
  }

  return {
    thread,
    turns,
    liveState: thread.status === "active" ? "streaming" : "idle",
    rawPayload: {},
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
