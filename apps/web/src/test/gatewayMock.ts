import { vi } from "vitest";

type RouteHandler = (request: Request) => unknown | Promise<unknown>;

export type GatewayRouteMap = Record<string, unknown | RouteHandler>;

export function mockGateway(routes: GatewayRouteMap) {
  // An explicit aggregate fixture, independent of the loaded sidebar page.
  routes = { "GET /v1/threads/unread-badge": { count: 0, readRevision: 0 }, ...routes };
  const calls: Request[] = [];
  let nextQueueIndex = 0;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    calls.push(request.clone());

    const handler = routes[key];
    if (handler === undefined) {
      const sidebar = await fallbackSidebarThreads(routes, request);
      if (sidebar) return jsonResponse(sidebar, 200);
      const queuedInput = await fallbackQueuedInput(request, () => {
        nextQueueIndex += 1;
        return `queue-${nextQueueIndex}`;
      });
      if (queuedInput) {
        return jsonResponse(queuedInput, 200);
      }
      const threadInput = await fallbackThreadInput(request);
      if (threadInput) {
        return jsonResponse(threadInput, 200);
      }
      const subagents = fallbackThreadSubagents(request);
      if (subagents) {
        return jsonResponse(subagents, 200);
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
    if (
      (request.method === "DELETE" && /^\/v1\/projects\/[^/]+$/.test(url.pathname)) ||
      (request.method === "POST" && /^\/v1\/projects\/[^/]+\/move$/.test(url.pathname)) ||
      (request.method === "POST" && /^\/v1\/threads\/[^/]+\/section$/.test(url.pathname)) ||
      (request.method === "DELETE" && /^\/v1\/thread-sections\/[^/]+$/.test(url.pathname))
    ) {
      return new Response(null, { status: 204 });
    }
    if (request.method === "PATCH" && /^\/v1\/threads\/[^/]+\/settings$/.test(url.pathname)) {
      return jsonResponse({}, 202);
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

async function fallbackSidebarThreads(routes: GatewayRouteMap, request: Request) {
  if (request.method !== "GET" || new URL(request.url).pathname !== "/v1/sidebar/threads" || !("GET /v1/projects" in routes)) return null;
  async function readRoute(path: string) {
    const url = new URL(path, "http://localhost");
    const route = routes[`GET ${url.pathname}`];
    const body = typeof route === "function" ? await route(new Request(url)) : route;
    return body as { projects?: Array<{ id: string }>; sections?: Array<{ id: string }>; threads?: Array<{ projectId?: string | null; section?: { id: string } | null }> } | undefined;
  }
  const projects = (await readRoute("/v1/projects"))?.projects ?? [];
  const projectThreads = Object.fromEntries(await Promise.all(projects.map(async (project) => {
    const response = await readRoute(`/v1/threads?projectId=${encodeURIComponent(project.id)}`);
    return [project.id, { ...response, threads: (response?.threads ?? []).filter((thread) => thread.projectId === project.id && !thread.section) }];
  })));
  const sections = (await readRoute("/v1/thread-sections"))?.sections ?? [];
  const sectionThreads = Object.fromEntries(await Promise.all(sections.map(async (section) => [section.id, await readRoute(`/v1/thread-sections/${section.id}/threads`) ?? { threads: [] }])));
  return {
    projects,
    projectThreads,
    sections, sectionThreads,
    chatThreads: await readRoute("/v1/chats/threads") ?? { threads: [] },
  };
}

async function fallbackThreadInput(request: Request) {
  const url = new URL(request.url);
  const inputMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)\/input$/);
  if (request.method !== "POST" || !inputMatch) {
    return null;
  }
  return {
    payload: {},
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
  if (request.method === "DELETE") {
    return { id: queueId, threadId };
  }
  if (request.method === "POST" && action === "steer") {
    return {
      queuedInput: {
        id: queueId,
        threadId,
        input: [{ type: "text", text: "Pending steer" }],
        options: {},
        status: "pendingCommit",
        priority: "normal",
        attemptCount: 1,
        lastError: null,
        acceptedTurnId: "turn-1",
        acceptedAt: "2026-05-05T00:00:01Z",
        acceptedEventSeq: null,
        createdAt: "2026-05-05T00:00:00Z",
        updatedAt: "2026-05-05T00:00:01Z",
      },
    };
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

function fallbackThreadSubagents(request: Request) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/v1\/threads\/([^/]+)\/subagents$/);
  if (request.method !== "GET" || !match) {
    return null;
  }
  return { subagents: [], nextCursor: null };
}

async function fallbackThreadDetail(routes: GatewayRouteMap, request: Request) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/v1\/threads\/([^/]+)(\/attach)?$/);
  if (!match || request.method !== (match[2] ? "POST" : "GET")) {
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
    timeline: {
      viewRevision: 1,
      activeTurnId: null,
      liveState: thread.status === "active" ? "streaming" : "idle",
      pendingApprovalRequests: [],
      pendingUserInputRequests: [],
      rows: [],
      items: [],
      turns: [],
    },
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
