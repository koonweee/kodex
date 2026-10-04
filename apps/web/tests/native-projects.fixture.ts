import type { BrowserContext, Page, Route } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";

import type { Capabilities, CreateProjectRequest, EventEnvelope, Project, ThreadSummary, ThreadTimelineSnapshotItem, ThreadViewResponse, UpdateProjectRequest } from "../src/api/client";

export const executionCwd = "/execution/original-chat";
export const preservedHistory = "History remains intact after changing project membership.";

export async function nativeProjectsFixture(context: BrowserContext) {
  const project = (id: string, name: string, position: number): Project => ({
    id, name, position, roots: [{ path: `/projects/${id}` }], metadata: { owner: "another-native-client" },
    createdAt: 1791072000, updatedAt: 1791072000, recencyAt: null,
  });
  const state = {
    projects: [project("alpha", "Alpha", 0), project("beta", "Beta", 1)],
    threads: [thread("history", "History chat"), thread("unlisted", "Unlisted history")],
  };
  const clients = new Map<Page, string>();
  const streams = new Map<ServerResponse, string>();
  const connections = new Map<string, number>();
  const requests: Array<{ client: string; key: string; body: unknown }> = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const expectedCreateErrors: string[] = [];
  const held = new Map<string, () => Promise<void>>();
  const aborted = new Map<string, () => boolean>();
  const holds = new Set<string>();
  const createIntents = new Map<string, string>();
  let failFirstCreate = false;
  let seq = 0;
  const capabilities: Capabilities = {
    gateway: { instanceId: "native-project-fixture", version: "test", sse: true, approvals: true, terminals: { enabled: true }, gatewayAuth: false, trustedNetworkOnly: true },
    appServer: { ready: true, experimentalApi: true, schemaVersion: "0.160.0", detectedVersion: "0.160.0", detectedVersionMatchesSchema: true },
  };
  // Keep native notifications independent of refills caused by reconnects.
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/v1/thread-view-presence" && ["POST", "OPTIONS"].includes(request.method ?? "")) {
      response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" });
      response.end();
      return;
    }
    if (url.pathname !== "/v1/events" || request.method !== "GET") {
      unexpected.push(`${request.method} ${url.pathname}`);
      response.writeHead(404);
      response.end();
      return;
    }
    const client = url.searchParams.get("client") ?? "";
    response.writeHead(200, { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*" });
    response.flushHeaders();
    streams.set(response, client);
    connections.set(client, (connections.get(client) ?? 0) + 1);
    response.on("close", () => streams.delete(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local SSE address");

  function emit(kind: string, payload: unknown, client?: string) {
    seq += 1;
    const event: EventEnvelope = { id: String(seq), seq, kind, payload, receivedAt: "2026-10-04T00:00:00Z" };
    for (const [stream, id] of streams) {
      if (!client || client === id) stream.write(`id: ${seq}\nevent: ${kind}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }
  function snapshot() {
    const visibleThreads = state.threads.filter((entry) => entry.id !== "unlisted");
    return {
      projects: state.projects,
      projectThreads: Object.fromEntries(state.projects.map((entry) => [entry.id, { threads: visibleThreads.filter((member) => member.projectId === entry.id) }])),
      chatThreads: { threads: visibleThreads.filter((entry) => entry.projectId === null) },
      pinnedThreads: { threads: [] },
    };
  }
  async function respond(route: Route, body: unknown, status = 200, holdKey?: string) {
    const captured = structuredClone(body);
    const send = async () => {
      try { await route.fulfill({ status, json: captured }); }
      catch (error) {
        if (route.request().failure()?.errorText !== "net::ERR_ABORTED") throw error;
      }
    };
    if (holdKey && holds.delete(holdKey)) {
      held.set(holdKey, send);
      aborted.set(holdKey, () => route.request().failure()?.errorText === "net::ERR_ABORTED");
    }
    else await send();
  }
  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    const client = clients.get(request.frame().page()) ?? "";
    const body = request.postData() ? request.postDataJSON() as unknown : null;
    requests.push({ client, key, body });
    if (key === "GET /v1/events") {
      url.searchParams.set("client", client);
      await route.continue({ url: `http://127.0.0.1:${address.port}${url.pathname}${url.search}` });
      return;
    }
    const fixed: Record<string, unknown> = {
      "GET /v1/capabilities": capabilities,
      "GET /v1/account": { account: null, requiresOpenaiAuth: false, rawPayload: {} },
      "GET /v1/account/rate-limits": { rateLimits: null, rawPayload: {} },
      "GET /v1/approvals": { runtimeId: "native-project-runtime", revision: 0, approvals: [] },
      "GET /v1/models": { models: [], rawPayload: {} },
      "GET /v1/composer-settings": {},
      "GET /v1/permission-profiles": { profiles: [] },
      "PUT /v1/thread-view-presence": { ok: true },
      "POST /v1/thread-view-presence": { ok: true },
      "GET /v1/projects": { projects: state.projects },
      "GET /v1/threads/pinned": { threads: [] },
    };
    if (key in fixed) return respond(route, fixed[key]);
    if (key === "GET /v1/sidebar/threads") return respond(route, snapshot(), 200, `${client}:sidebar`);
    if (key === "POST /v1/projects") {
      const input = body as CreateProjectRequest;
      let created = state.projects.find((entry) => entry.id === createIntents.get(input.idempotencyKey));
      if (!created) {
        created = { ...project(`created-${createIntents.size + 1}`, input.name, state.projects.length), roots: input.roots, metadata: input.metadata ?? {} };
        state.projects.push(created);
        createIntents.set(input.idempotencyKey, created.id);
        emit("project.changed", { projectId: created.id, changeType: "created" });
      }
      if (failFirstCreate) {
        failFirstCreate = false;
        return respond(route, { code: "unavailable", message: "Create reply lost; retry this intent.", retryable: true }, 503);
      }
      return respond(route, created, 201);
    }
    const projectMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)(\/move)?$/);
    if (projectMatch) {
      const id = decodeURIComponent(projectMatch[1]);
      const target = state.projects.find((entry) => entry.id === id);
      if (target && !projectMatch[2] && request.method() === "GET") return respond(route, target);
      if (target && !projectMatch[2] && request.method() === "PATCH") {
        Object.assign(target, body as UpdateProjectRequest, { updatedAt: target.updatedAt + 1 });
        emit("project.changed", { projectId: id, changeType: "updated" });
        return respond(route, target);
      }
      if (target && request.method() === "POST" && projectMatch[2]) {
        const { beforeProjectId } = body as { beforeProjectId: string | null };
        const ordered = state.projects.filter((entry) => entry.id !== id);
        const before = beforeProjectId ? ordered.findIndex((entry) => entry.id === beforeProjectId) : ordered.length;
        ordered.splice(before, 0, target);
        state.projects = ordered.map((entry, position) => ({ ...entry, position }));
        emit("project.changed", { projectId: id, changeType: "updated" });
        return route.fulfill({ status: 204 });
      }
      if (target && !projectMatch[2] && request.method() === "DELETE") {
        state.projects = state.projects.filter((entry) => entry.id !== id);
        state.threads = state.threads.map((entry) => entry.projectId === id ? { ...entry, projectId: null } : entry);
        // Archived membership has no per-thread deletion notification in native 0.160.
        emit("project.changed", { projectId: id, changeType: "deleted" });
        return route.fulfill({ status: 204 });
      }
    }
    const threadMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)(?:\/(.+))?$/);
    if (threadMatch) {
      const target = state.threads.find((entry) => entry.id === threadMatch[1]);
      const action = threadMatch[2];
      if (target && !action && request.method() === "GET") return respond(route, detail(target), 200, `${client}:detail`);
      if (target && action === "project" && request.method() === "PATCH") {
        target.projectId = (body as { projectId: string | null }).projectId;
        emit("thread.project_updated", { threadId: target.id, projectId: target.projectId });
        return respond(route, { thread: target, rawPayload: {} });
      }
      if (target && action === "attach" && request.method() === "POST") return respond(route, { disposition: "resumed", thread: target });
      if (target && action === "app-surface" && request.method() === "GET") return respond(route, { session: null });
      if (target && action === "settings" && request.method() === "GET") return respond(route, { model: "gpt-5.4", effort: "medium", serviceTier: null, activePermissionProfile: null });
      if (target && action === "queued-inputs" && request.method() === "GET") return respond(route, { queuedInputs: [] });
      if (target && action === "subagents" && request.method() === "GET") return respond(route, { subagents: [] });
    }
    unexpected.push(key);
    return respond(route, { code: "not_found", message: key, retryable: false }, 404);
  };
  await context.route("**/v1/**", handle);

  return {
    state, requests, unexpected, errors, expectedCreateErrors, held, connections, emit,
    wasAborted(client: string, kind: "sidebar" | "detail") { return aborted.get(`${client}:${kind}`)?.() ?? false; },
    failNextCreateReply() { failFirstCreate = true; },
    holdNext(client: string, kind: "sidebar" | "detail") { holds.add(`${client}:${kind}`); },
    async release(client: string, kind: "sidebar" | "detail") {
      const key = `${client}:${kind}`;
      const send = held.get(key);
      if (!send) throw new Error(`No held request: ${key}`);
      held.delete(key);
      await send();
    },
    connected(client: string) { return [...streams.values()].includes(client); },
    disconnect(client: string) { for (const [stream, id] of streams) if (client === id) stream.end(); },
    async page(client: string, path: string) {
      const page = await context.newPage();
      clients.set(page, client);
      // Chromium can send pagehide beacons after Playwright detaches routing.
      // Keep the real beacon transport, but confine it to this disposable server.
      await page.addInitScript((origin) => {
        const sendBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = (url, data) => {
          const target = new URL(String(url), window.location.href);
          return sendBeacon(target.pathname === "/v1/thread-view-presence" ? `${origin}${target.pathname}` : url, data);
        };
      }, `http://127.0.0.1:${address.port}`);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        if (message.text() === "Failed to load resource: the server responded with a status of 503 (Service Unavailable)" && new URL(message.location().url).pathname === "/v1/projects") {
          expectedCreateErrors.push(message.text());
        } else errors.push(message.text());
      });
      await page.goto(path);
      return page;
    },
    async close() {
      const releases = await Promise.allSettled([...held.values()].map((send) => send()));
      held.clear();
      // Keep interception in place through page teardown so reconnects/presence
      // cleanup cannot escape the mock and reach a developer gateway.
      await Promise.all([...clients.keys()].map((page) => page.close()));
      // The test-owned context disposes this route. Unrouting here could let a
      // still-dispatching pagehide beacon escape after page.close has resolved.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const result of releases) if (result.status === "rejected") throw result.reason;
    },
  };
}

function thread(id: string, name: string): ThreadSummary {
  return { id, name, projectId: "alpha", cwd: executionCwd, createdAt: 0, updatedAt: 0, status: "idle", rawPayload: {}, notificationsEnabled: true, seenCompletedAgentTurnSeq: 0, unreadCompletedAgentTurn: false };
}

function detail(thread: ThreadSummary): ThreadViewResponse {
  const payload = { id: "answer", type: "agentMessage", text: preservedHistory, phase: "final_answer" };
  const item: ThreadTimelineSnapshotItem = {
    id: `${thread.id}-history`, threadId: thread.id, turnId: "turn-1", itemId: "answer", itemType: "agentMessage", status: "completed",
    codexMethod: "item/completed", displayOrder: 1, timestampMs: 1,
    payload: {
      item: payload, itemId: "answer", turnId: "turn-1", source: "appServerSnapshot",
      itemSnapshot: { id: "answer", itemType: "agentMessage" },
    },
  };
  return { thread, liveState: "idle", timeline: {
    viewRevision: 1, liveState: "idle", activeTurnId: null, pendingApprovalRequests: [], pendingUserInputRequests: [],
    turns: [{ id: "turn-1", status: "completed" }],
    rows: [{ id: "answer", kind: "assistant_message", turnId: "turn-1", status: "completed", displayOrder: 1, item, items: [], fileChanges: [], collapsedRows: [] }],
  } };
}
