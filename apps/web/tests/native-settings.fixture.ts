import type { BrowserContext, Page, Route } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";

import type { Capabilities, EventEnvelope, QueuedInput, ThreadSettingsResponse, ThreadSettingsUpdateRequest, ThreadViewPatch, ThreadViewResponse, UserInput } from "../src/api/client";

export async function nativeSettingsFixture(context: BrowserContext) {
  const settings: ThreadSettingsResponse = { model: "gpt-5.4", effort: "medium", serviceTier: null, activePermissionProfile: null };
  const detail: ThreadViewResponse = {
    thread: { id: "settings-chat", name: "Native settings chat", projectId: null, cwd: "/execution/settings", status: "idle", createdAt: 0, updatedAt: 0, notificationsEnabled: true, seenCompletedAgentTurnSeq: 0, unreadCompletedAgentTurn: false },
    liveState: "idle",
    timeline: { activeTurnId: null, liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [], viewRevision: 1 },
  };
  const capabilities: Capabilities = {
    gateway: { instanceId: "native-settings-fixture", version: "test", sse: true, approvals: true, gatewayAuth: false, trustedNetworkOnly: true },
    appServer: { ready: true, experimentalApi: true, schemaVersion: "0.160.0", detectedVersion: "0.160.0", detectedVersionMatchesSchema: true },
  };
  const clients = new Map<Page, string>();
  const streams = new Map<ServerResponse, string>();
  const connections = new Map<string, number>();
  const requests: Array<{ client: string; key: string; body: unknown }> = [];
  const pending: ThreadSettingsUpdateRequest[] = [];
  const queuedInputs: QueuedInput[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const holds = new Set<string>();
  const held = new Map<string, { send: () => Promise<void>; aborted: () => boolean }>();
  let seq = 0;
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
    const event: EventEnvelope = { id: String(seq), seq, kind, threadId: kind === "config.changed" ? null : detail.thread.id, payload, receivedAt: "2026-10-04T00:00:00Z" };
    for (const [stream, id] of streams) {
      if (!client || client === id) stream.write(`id: ${seq}\nevent: ${kind}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }
  function settingsChanged(client?: string) { emit("thread.settings_updated", { threadId: detail.thread.id }, client); }
  async function respond(route: Route, body: unknown, status = 200, holdClient?: string) {
    const captured = structuredClone(body);
    const send = async () => {
      try { await route.fulfill({ status, json: captured }); }
      catch (error) { if (route.request().failure()?.errorText !== "net::ERR_ABORTED") throw error; }
    };
    if (holdClient && holds.delete(holdClient)) {
      held.set(holdClient, { send, aborted: () => route.request().failure()?.errorText === "net::ERR_ABORTED" });
    } else await send();
  }
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    const client = clients.get(request.frame().page()) ?? "";
    const body = request.postData() ? request.postDataJSON() as unknown : null;
    requests.push({ client, key, body });
    if (key === "GET /v1/events") {
      url.searchParams.set("client", client);
      return route.continue({ url: `http://127.0.0.1:${address.port}${url.pathname}${url.search}` });
    }
    const fixed: Record<string, unknown> = {
      "GET /v1/capabilities": capabilities,
      "GET /v1/account": { account: null, requiresOpenaiAuth: false, rawPayload: {} },
      "GET /v1/account/rate-limits": { rateLimits: null, rawPayload: {} },
      "GET /v1/approvals": { runtimeId: "native-settings-runtime", revision: 0, approvals: [] },
      "GET /v1/sidebar/threads": { projects: [], projectThreads: {}, chatThreads: { threads: [detail.thread] }, sections: [], sectionThreads: {} },
      "GET /v1/projects": { projects: [] },
      "GET /v1/models": { models: [{ id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4", description: "Test model", defaultReasoningEffort: "medium", isDefault: true, hidden: false, inputModalities: ["text"], supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deeper reasoning" }], rawPayload: {} }], rawPayload: {} },
      "GET /v1/composer-settings": {},
      "GET /v1/permission-profiles": { profiles: [] },
      "GET /v1/threads/settings-chat": detail,
      "POST /v1/threads/settings-chat/attach": { disposition: "resumed", thread: detail.thread, rawPayload: {} },
      "GET /v1/threads/settings-chat/app-surface": { session: null },
      "GET /v1/threads/settings-chat/subagents": { subagents: [] },
      "GET /v1/threads/settings-chat/queued-inputs": { queuedInputs },
      "PUT /v1/thread-view-presence": { ok: true },
      "POST /v1/thread-view-presence": { ok: true },
    };
    if (key in fixed) return respond(route, fixed[key]);
    if (key === "GET /v1/threads/settings-chat/settings") return respond(route, settings, 200, client);
    if (key === "PATCH /v1/threads/settings-chat/settings") {
      pending.push(body as ThreadSettingsUpdateRequest);
      // Native acknowledges the queued update independently of its application.
      return respond(route, {}, 202);
    }
    if (key === "POST /v1/threads/settings-chat/input") {
      detail.thread.status = "active";
      detail.liveState = "streaming";
      detail.timeline = { ...detail.timeline, activeTurnId: "turn-1", liveState: "streaming", turns: [{ id: "turn-1", status: "inProgress" }], viewRevision: 2 };
      const patch: ThreadViewPatch = { ...detail.timeline, scope: "lifecycle", threadId: detail.thread.id, affectedTurnIds: ["turn-1"] };
      emit("thread_view.patch", patch);
      return respond(route, { disposition: "started", queuedInput: null, rawPayload: {} });
    }
    if (key === "POST /v1/threads/settings-chat/queued-inputs") {
      const queued: QueuedInput = { id: "queued-1", threadId: detail.thread.id, input: (body as { input: UserInput[] }).input, options: {}, priority: "normal", status: "queued", attemptCount: 0, createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z" };
      queuedInputs.push(queued);
      emit("turn_queue.item_upsert", queued);
      return respond(route, { queuedInput: queued });
    }
    unexpected.push(key);
    return respond(route, { code: "not_found", message: key, retryable: false }, 404);
  });
  return {
    settings, requests, pending, connections, unexpected, errors, settingsChanged,
    configChanged(client?: string) { emit("config.changed", {}, client); },
    connected(client: string) { return [...streams.values()].includes(client); },
    disconnect(client: string) { for (const [stream, id] of streams) if (client === id) stream.end(); },
    applyNext(client?: string) {
      const update = pending.shift();
      if (!update) throw new Error("No pending native settings update");
      Object.assign(settings, update);
      settingsChanged(client);
    },
    holdNext(client: string) { holds.add(client); },
    isHeld(client: string) { return held.has(client); },
    wasAborted(client: string) { return held.get(client)?.aborted() ?? false; },
    async release(client: string) {
      const reply = held.get(client);
      if (!reply) throw new Error(`No held settings read for ${client}`);
      held.delete(client);
      await reply.send();
    },
    async page(client: string) {
      const page = await context.newPage();
      clients.set(page, client);
      // Keep late pagehide beacons inside this disposable fixture too.
      await page.addInitScript((origin) => {
        const sendBeacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = (url, data) => {
          const target = new URL(String(url), location.href);
          return sendBeacon(target.pathname === "/v1/thread-view-presence" ? `${origin}${target.pathname}` : url, data);
        };
      }, `http://127.0.0.1:${address.port}`);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      await page.goto("/threads/settings-chat");
      return page;
    },
    async close() {
      const releases = await Promise.allSettled([...held.values()].map((reply) => reply.send()));
      held.clear();
      // Stop query/focus producers while interception remains active. Playwright
      // bypasses route handlers once page.close starts, which can otherwise let
      // a late recovery request reach Vite's real gateway proxy.
      const navigations = await Promise.allSettled([...clients.keys()].filter((page) => !page.isClosed()).map((page) => page.goto("about:blank")));
      const closures = await Promise.allSettled([...clients.keys()].map((page) => page.close()));
      // Context teardown removes routing after pages/beacons have finished.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const result of [...releases, ...navigations, ...closures]) if (result.status === "rejected") throw result.reason;
    },
  };
}
