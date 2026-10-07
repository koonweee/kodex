import type { BrowserContext, Page, Route } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";

import type { components } from "../src/api/generated/schema";

import type { AppSurfaceSession, Automation, AutomationRun, Capabilities, EventEnvelope, MarkThreadSeenRequest, QueuedInput, QueueTransfer, ThreadRead, ThreadSettingsResponse, UnreadBadgeResponse, ThreadSettingsUpdateRequest, ThreadViewPatch, ThreadViewResponse } from "../src/api/client";

export async function nativeSettingsFixture(context: BrowserContext, options: { queuedSteerClient?: string } = {}) {
  let goal: components["schemas"]["ThreadGoal"] | null = null;
  const settings: ThreadSettingsResponse = { model: "gpt-5.4", effort: "medium", serviceTier: null, activePermissionProfile: null };
  const detail: ThreadViewResponse = {
    thread: { pinned: false, parentThreadId: null, canAcceptDirectInput: null, id: "settings-chat", name: "Native settings chat", projectId: null, cwd: "/execution/settings", status: "idle", createdAt: 0, updatedAt: 0, notificationsEnabled: true, latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: true, unreadCompletedAgentTurn: false },
    liveState: "idle",
    timeline: { activeTurnId: null, liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [], viewRevision: 1 },
  };
  const badge: UnreadBadgeResponse = { count: 0, readRevision: 0 };
  const capabilities: Capabilities = {
    gateway: { apiVersion: "2", instanceId: "native-settings-fixture", version: "test", sse: true, approvals: true, terminals: { enabled: false }, gatewayAuth: false, trustedNetworkOnly: true },
    appServer: { ready: true, experimentalApi: true, schemaVersion: "0.160.0", detectedVersion: "0.160.0", detectedVersionMatchesSchema: true },
  };
  const clients = new Map<Page, string>();
  const streams = new Map<ServerResponse, string>();
  const connections = new Map<string, number>();
  const requests: Array<{ client: string; key: string; body: unknown; failure: () => string | null }> = [];
  const pending: ThreadSettingsUpdateRequest[] = [];
  const automations: Automation[] = [];
  const automationRuns = new Map<string, AutomationRun[]>();
  const queuedInputs: QueuedInput[] = [];
  const transfers: QueueTransfer[] = [];
  const deliveredTransfers = new Set<string>();
  let nextQueueId = 0;
  let nextTransferId = 0;
  const unexpected: string[] = [];
  const errors: string[] = [];
  const holds = new Map<string, string>();
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

  function emit(kind: string, payload: unknown, client?: string, eventSeq = seq + 1) {
    seq = Math.max(seq, eventSeq);
    const event: EventEnvelope = { id: `${eventSeq}-${kind}`, seq: eventSeq, kind, threadId: ["config.changed", "mcp.oauth_login_completed", "mcp.server_status_updated", "thread.subagents_changed", "automation.run_updated"].includes(kind) ? null : detail.thread.id, payload, receivedAt: "2026-10-04T00:00:00Z" };
    for (const [stream, id] of streams) {
      if (!client || client === id) stream.write(`id: ${eventSeq}\nevent: ${kind}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }
  function applyRead(read: ThreadRead) {
    const { threadId: _threadId, updatedAt: _updatedAt, ...tuple } = read;
    Object.assign(detail.thread, tuple);
  }
  function canSteerQueuedInput(id: string) {
    return Boolean(detail.timeline.activeTurnId) && !transfers.some((transfer) => transfer.nativeQueueId === id);
  }
  function settingsChanged(client?: string) { emit("thread.settings_updated", { threadId: detail.thread.id }, client); }
  function publishQueuedTurn(turnId: string, client?: string) {
    const revision = Math.max(seq, detail.timeline.viewRevision ?? 0) + 1;
    detail.timeline = { ...detail.timeline, viewRevision: revision };
    const patch: ThreadViewPatch = { ...detail.timeline, scope: "turn", threadId: detail.thread.id,
      affectedTurnIds: [turnId], rows: detail.timeline.rows.filter((entry) => entry.turnId === turnId),
      turns: detail.timeline.turns.filter((turn) => turn.id === turnId) };
    emit("thread_view.patch", patch, client, revision);
  }
  function publishQueueTransfer(transfer: QueueTransfer, nativeItemId?: string, client?: string) {
    const turnId = transfer.expectedTurnId;
    const pendingItemId = `pending-user-${transfer.id}`;
    const itemId = nativeItemId ?? pendingItemId;
    const status = nativeItemId ? "completed" : "running";
    const rawItem = { id: itemId, type: "userMessage", clientId: transfer.id, content: transfer.input };
    const row: ThreadViewResponse["timeline"]["rows"][number] = {
      id: `row-${itemId}`, kind: "user_message", turnId, status, displayOrder: detail.timeline.rows.length + 1,
      item: { id: itemId, itemId, itemType: "userMessage", threadId: detail.thread.id, turnId, status,
        displayOrder: detail.timeline.rows.length + 1, codexMethod: nativeItemId ? "item/completed" : "item/upsert",
        payload: { source: "gatewayStream", turnId, itemId, item: rawItem,
          itemSnapshot: { id: itemId, itemType: "userMessage", clientId: transfer.id } } },
      items: [], collapsedRows: [], fileChanges: [],
    };
    detail.timeline = { ...detail.timeline,
      rows: [...detail.timeline.rows.filter((entry) => entry.item?.itemId !== pendingItemId && entry.item?.itemId !== itemId), row] };
    publishQueuedTurn(turnId, client);
  }
  async function respond(route: Route, body: unknown, status = 200, holdClient?: string) {
    const captured = structuredClone(body);
    const send = async () => {
      try { await route.fulfill({ status, json: captured }); }
      catch (error) { if (route.request().failure()?.errorText !== "net::ERR_ABORTED") throw error; }
    };
    const holdKey = holdClient ? holds.get(holdClient) : undefined;
    if (holdClient && holdKey) {
      holds.delete(holdClient);
      held.set(holdKey, { send, aborted: () => route.request().failure()?.errorText === "net::ERR_ABORTED" });
    } else await send();
  }
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    const client = clients.get(request.frame().page()) ?? "";
    const body = request.postData() ? request.postDataJSON() as unknown : null;
    requests.push({ client, key, body, failure: () => request.failure()?.errorText ?? null });
    if (key === "GET /v1/events") {
      url.searchParams.set("client", client);
      return route.continue({ url: `http://127.0.0.1:${address.port}${url.pathname}${url.search}` });
    }
    const fixed: Record<string, unknown> = {
      "GET /v1/capabilities": capabilities,
      "GET /v1/account": { account: null, requiresOpenaiAuth: false, rawPayload: {} },
      "GET /v1/account/rate-limits": { rateLimits: null, rawPayload: {} },
      "GET /v1/approvals": { runtimeId: "native-settings-runtime", revision: 0, approvals: [] },
      "GET /v1/sidebar/threads": { projects: [], projectThreads: {}, chatThreads: { threads: [detail.thread] }, pinnedThreads: { threads: [] } },
      "GET /v1/projects": { projects: [] },
      "GET /v1/automations": { automations },
      "GET /v1/models": { models: [{ id: "gpt-5.4", model: "gpt-5.4", displayName: "GPT-5.4", description: "Test model", defaultReasoningEffort: "medium", isDefault: true, hidden: false, inputModalities: ["text"], supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deeper reasoning" }], rawPayload: {} }], rawPayload: {} },
      "GET /v1/composer-settings": {},
      "GET /v1/permission-profiles": { profiles: [] },
      "GET /v1/threads/settings-chat": detail,
      "GET /v1/threads/settings-chat/app-surface": { session: null },
      "GET /v1/threads/settings-chat/subagents": { subagents: [] },
      "PUT /v1/thread-view-presence": { ok: true },
      "POST /v1/thread-view-presence": { ok: true },
    };
    if (key in fixed) return respond(route, fixed[key]);
    const runsPath = url.pathname.match(/^\/v1\/automations\/([^/]+)\/runs$/);
    if (request.method() === "GET" && runsPath && automationRuns.has(runsPath[1])) return respond(route, { runs: automationRuns.get(runsPath[1]) }, 200, `runs:${client}`);
    if (key === "GET /v1/threads/settings-chat/queued-inputs") return respond(route, { queuedInputs: queuedInputs.map((row) => ({ ...row, canSteer: canSteerQueuedInput(row.id) })), transfers, nextCursor: null }, 200, `queue:${client}`);
    if (key === "GET /v1/threads/unread-badge") return respond(route, badge, 200, `badge:${client}`);
    if (key === "POST /v1/threads/settings-chat/seen") {
      const expected = body as MarkThreadSeenRequest;
      if (!detail.thread.readStateKnown || expected.completedTurnId !== detail.thread.latestCompletedTurnId || expected.readRevision !== detail.thread.readRevision) {
        return respond(route, { code: "conflict", message: "Displayed completion is stale", retryable: false }, 409);
      }
      if (detail.thread.unreadCompletedAgentTurn) {
        badge.readRevision = Math.max(badge.readRevision, detail.thread.readRevision) + 1;
        badge.count = Math.max(0, badge.count - 1);
      }
      const read: ThreadRead = { threadId: detail.thread.id, latestCompletedTurnId: expected.completedTurnId,
        seenCompletedTurnId: expected.completedTurnId, readRevision: detail.thread.unreadCompletedAgentTurn ? badge.readRevision : detail.thread.readRevision, readStateKnown: true,
        unreadCompletedAgentTurn: false, updatedAt: "2026-10-05T00:00:00Z" };
      applyRead(read);
      emit("thread.read_updated", read);
      return respond(route, read, 200, `seen:${client}`);
    }
    if (key === "POST /v1/threads/settings-chat/attach") return respond(route, detail, 200, `snapshot:${client}`);
    if (key === "POST /v1/threads/settings-chat/interrupt-current") {
      if (goal?.status === "active") {
        goal = { ...goal, status: "paused" };
        emit("thread.goal_changed", { threadId: detail.thread.id });
      }
      const turnId = detail.timeline.activeTurnId;
      if (!turnId) return respond(route, { disposition: "idle", interruptedTurnId: null, rawPayload: null } satisfies components["schemas"]["ThreadInterruptCurrentResponse"]);
      const revision = Math.max(seq, detail.timeline.viewRevision ?? 0) + 1;
      detail.timeline = { ...detail.timeline, activeTurnId: null, liveState: "idle", viewRevision: revision,
        turns: detail.timeline.turns.map((turn) => turn.id === turnId ? { ...turn, status: "interrupted" } : turn) };
      detail.liveState = "idle";
      detail.thread.status = "idle";
      const patch: ThreadViewPatch = { ...detail.timeline, scope: "full_snapshot", threadId: detail.thread.id,
        affectedTurnIds: detail.timeline.turns.map((turn) => turn.id) };
      emit("thread_view.patch", patch, undefined, revision);
      emit("turn_queue.changed", { threadId: detail.thread.id });
      return respond(route, { disposition: "interrupted", interruptedTurnId: turnId, rawPayload: {} } satisfies components["schemas"]["ThreadInterruptCurrentResponse"]);
    }
    if (key === "GET /v1/threads/settings-chat/goal") return respond(route, { goal }, 200, `goal:${client}`);
    if (key === "PATCH /v1/threads/settings-chat/goal") {
      const update = body as components["schemas"]["ThreadGoalSetRequest"];
      goal = { threadId: detail.thread.id, objective: "", status: "active", tokenBudget: null,
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0, ...goal };
      if (update.objective != null) goal.objective = update.objective;
      if (update.status != null) goal.status = update.status;
      if ("tokenBudget" in update) goal.tokenBudget = update.tokenBudget ?? null;
      emit("thread.goal_changed", { threadId: detail.thread.id });
      return respond(route, { goal });
    }
    if (key === "DELETE /v1/threads/settings-chat/goal") {
      const cleared = goal !== null;
      goal = null;
      emit("thread.goal_changed", { threadId: detail.thread.id });
      return respond(route, { cleared });
    }
    if (request.method() === "GET" && /^\/v1\/threads\/[^/]+\/goal$/.test(url.pathname)) return respond(route, { goal: null });
    if (key === "GET /v1/threads/settings-chat/settings") return respond(route, settings, 200, `settings:${client}`);
    if (key === "PATCH /v1/threads/settings-chat/settings") {
      pending.push(body as ThreadSettingsUpdateRequest);
      // Native acknowledges the queued update independently of its application.
      return respond(route, {}, 202);
    }
    if (key === "POST /v1/threads/settings-chat/input") {
      if ((body as { queueIfPending?: boolean }).queueIfPending && queuedInputs.length) {
        const submitted = body as { input: QueuedInput["input"]; clientUserMessageId: string; attachments?: QueuedInput["attachments"] };
        const queued: QueuedInput = { id: `queued-${++nextQueueId}`, threadId: detail.thread.id, input: submitted.input, clientUserMessageId: submitted.clientUserMessageId, attachments: submitted.attachments ?? [], canSteer: Boolean(detail.timeline.activeTurnId) };
        queuedInputs.push(queued);
        emit("turn_queue.changed", { threadId: detail.thread.id });
        return respond(route, { payload: {}, disposition: "queued", queuedInput: queued });
      }

      detail.thread.status = "active";
      detail.liveState = "streaming";
      const revision = Math.max(seq, detail.timeline.viewRevision ?? 0) + 1;
      detail.timeline = { ...detail.timeline, activeTurnId: "turn-1", liveState: "streaming", turns: [{ id: "turn-1", status: "inProgress" }], viewRevision: revision };
      const patch: ThreadViewPatch = {
        scope: "lifecycle", threadId: detail.thread.id, viewRevision: revision,
        activeTurnId: "turn-1", liveState: "streaming", pendingApprovalRequests: [], pendingUserInputRequests: [],
      };
      emit("thread_view.patch", patch, undefined, revision);
      emit("turn_queue.changed", { threadId: detail.thread.id });
      return respond(route, { payload: {turn: {id:"turn-1",status:"inProgress"}} });
    }
    if (key === "POST /v1/threads/settings-chat/queued-inputs") {
      const submitted = body as { input: QueuedInput["input"]; clientUserMessageId: string };
      const queued: QueuedInput = { id: `queued-${++nextQueueId}`, threadId: detail.thread.id, input: submitted.input, clientUserMessageId: submitted.clientUserMessageId, attachments: [], canSteer: Boolean(detail.timeline.activeTurnId) };
      queuedInputs.push(queued);
      emit("turn_queue.changed", { threadId: detail.thread.id });
      return respond(route, { queuedInput: queued });
    }
    if (key === "POST /v1/threads/settings-chat/queued-inputs/reorder") {
      const ids = (body as { queuedSubmissionIds: string[] }).queuedSubmissionIds;
      if (ids.length !== queuedInputs.length || new Set(ids).size !== ids.length || ids.some((id) => !queuedInputs.some((row) => row.id === id))) throw new Error("Incomplete native queue order");
      const ordered = ids.map((id) => queuedInputs.find((row) => row.id === id)!);
      queuedInputs.splice(0, queuedInputs.length, ...ordered);
      emit("turn_queue.changed", { threadId: detail.thread.id });
      return respond(route, {});
    }
    if (key === "POST /v1/threads/settings-chat/queued-inputs/start") {
      if (detail.timeline.activeTurnId) return respond(route, { code: "app_server_error", message: "thread already has an active or pending turn", retryable: false }, 502);
      const id = (body as { queuedSubmissionId: string }).queuedSubmissionId;
      const index = queuedInputs.findIndex((row) => row.id === id);
      if (index < 0) throw new Error("Unknown native row start");
      queuedInputs.splice(index, 1);
      emit("turn_queue.changed", { threadId: detail.thread.id });
      return respond(route, { payload: { turn: { id: "manual-native-turn", status: "inProgress" } } });
    }
    const steerFirst = key === "POST /v1/threads/settings-chat/queued-inputs/steer-first";
    const queuePath = url.pathname.match(/^\/v1\/threads\/settings-chat\/queued-inputs\/([^/]+)(\/steer)?$/);
    if (queuePath) {
      const index = steerFirst ? 0 : queuedInputs.findIndex((row) => row.id === queuePath[1]);
      const row = queuedInputs[index];
      if (row && request.method() === "PUT" && !queuePath[2]) {
        row.input = (body as { input: QueuedInput["input"] }).input;
        emit("turn_queue.changed", { threadId: detail.thread.id });
        return respond(route, { queuedInput: row });
      }
      if (request.method() === "DELETE" && !queuePath[2]) {
        if (row) queuedInputs.splice(index, 1);
        emit("turn_queue.changed", { threadId: detail.thread.id });
        return respond(route, { id: queuePath[1], threadId: detail.thread.id, deleted: Boolean(row) });
      }
      if (request.method() === "POST" && (queuePath[2] === "/steer" || steerFirst)) {
        const expectedTurnId = detail.timeline.activeTurnId;
        if (!row || !expectedTurnId || !canSteerQueuedInput(row.id)) return respond(route, { code: "conflict", message: "The queued message cannot be steered", retryable: false }, 409);
        queuedInputs.splice(index, 1);
        const transfer: QueueTransfer = { id: `transfer-${++nextTransferId}`, threadId: detail.thread.id, nativeQueueId: row.id, clientUserMessageId: row.clientUserMessageId, expectedTurnId, input: row.input, phase: "accepted", error: null, createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" };
        transfers.push(transfer);
        emit("turn_queue.changed", { threadId: detail.thread.id });
        emit("turn_queue.transfer_changed", { threadId: detail.thread.id });
        publishQueueTransfer(transfer, undefined, options.queuedSteerClient);
        return respond(route, { status: "transfer", transfer });
      }
    }
    const transferPath = url.pathname.match(/^\/v1\/queue-transfers\/([^/]+)(\/reconcile)?$/);
    if (transferPath) {
      const index = transfers.findIndex((transfer) => transfer.id === transferPath[1]);
      const transfer = transfers[index];
      if (transfer && request.method() === "POST" && transferPath[2] === "/reconcile") {
        if (deliveredTransfers.has(transfer.id)) {
          transfers.splice(index, 1);
          emit("turn_queue.transfer_changed", { threadId: detail.thread.id });
          return respond(route, { status: "delivered", id: transfer.id });
        }
        return respond(route, { status: "transfer", transfer });
      }
      if (transfer?.phase === "uncertain" && request.method() === "DELETE" && !transferPath[2]) {
        transfers.splice(index, 1);
        emit("turn_queue.transfer_changed", { threadId: detail.thread.id });
        return respond(route, { id: transfer.id, threadId: detail.thread.id });
      }
    }
    unexpected.push(key);
    return respond(route, { code: "not_found", message: key, retryable: false }, 404);
  });
  return {
    settings, requests, pending, connections, unexpected, errors, settingsChanged,
    get goal() { return goal; },
    setGoal(value: components["schemas"]["ThreadGoal"] | null, client?: string) {
      goal = value;
      emit("thread.goal_changed", { threadId: detail.thread.id }, client);
    },
    goalChanged(client?: string) { emit("thread.goal_changed", { threadId: detail.thread.id }, client); },
    detail, badge, queuedInputs, transfers, deliveredTransfers, automations, automationRuns,
    receiveQueuedTransfer(id: string, nativeItemId: string, client?: string) {
      const index = transfers.findIndex((transfer) => transfer.id === id);
      const transfer = transfers[index];
      if (!transfer) throw new Error(`Unknown queued transfer ${id}`);
      publishQueueTransfer(transfer, nativeItemId, client);
      transfers.splice(index, 1);
      deliveredTransfers.add(id);
      emit("turn_queue.transfer_changed", { threadId: detail.thread.id }, client);
    },
    uncertainQueuedTransfer(id: string, client?: string) {
      const transfer = transfers.find((entry) => entry.id === id);
      if (!transfer) throw new Error(`Unknown queued transfer ${id}`);
      transfer.phase = "uncertain";
      transfer.error = "Native acknowledgement lost";
      detail.timeline = { ...detail.timeline, rows: detail.timeline.rows.filter((row) => row.item?.itemId !== `pending-user-${id}`) };
      publishQueuedTurn(transfer.expectedTurnId, client);
      emit("turn_queue.transfer_changed", { threadId: detail.thread.id }, client);
    },
    appSurfaceChanged(kind: "app_surface.session_upserted" | "app_surface.session_archived", session: AppSurfaceSession, client?: string) { emit(kind, session, client); },
    automationRunChanged(automationId: string, client?: string) { emit("automation.run_updated", { automationId }, client); },
    queueChanged(client?: string, transfer = false) { emit(transfer ? "turn_queue.transfer_changed" : "turn_queue.changed", { threadId: detail.thread.id }, client); },
    readChanged(read: ThreadRead, count: number, client?: string) {
      applyRead(read);
      Object.assign(badge, { count, readRevision: read.readRevision });
      emit("thread.read_updated", read, client);
    },
    publishTimeline(timeline: ThreadViewResponse["timeline"], client?: string) {
      const revision = Math.max(seq + 1, (detail.timeline.viewRevision ?? 0) + 1, timeline.viewRevision ?? 0);
      detail.timeline = { ...timeline, viewRevision: revision };
      detail.liveState = timeline.liveState;
      detail.thread.status = timeline.liveState === "streaming" ? "active" : "idle";
      const patch: ThreadViewPatch = { ...detail.timeline, scope: "full_snapshot", threadId: detail.thread.id, affectedTurnIds: timeline.turns.map((turn) => turn.id) };
      emit("thread_view.patch", patch, client, revision);
      emit("turn_queue.changed", { threadId: detail.thread.id }, client);
    },
    publishCanonicalEvent(event: Pick<EventEnvelope, "seq" | "payload"> & { kind: "thread_view.patch" | "thread_view.item_delta" }, client: string) {
      emit(event.kind, event.payload, client, event.seq);
    },
    configChanged(client?: string) { emit("config.changed", {}, client); },
    mcpOAuthCompleted(name: string, success: boolean, error: string | null, client?: string) { emit("mcp.oauth_login_completed", { name, threadId: null, success, error }, client); },
    subagentsChanged(client?: string, changedThreadId: string | null = null) { emit("thread.subagents_changed", { changedThreadId }, client); },
    refreshRequired(client?: string) { emit("thread_view.refresh_required", { threadId: detail.thread.id, reason: "snapshot_required" }, client); },
    revertTimeline(timeline: ThreadViewResponse["timeline"], client?: string) {
      const revision = Math.max(seq, detail.timeline.viewRevision ?? 0) + 1;
      const reset: ThreadViewPatch = { scope: "full_snapshot", threadId: detail.thread.id, affectedTurnIds: [], activeTurnId: null, liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [], viewRevision: revision };
      detail.timeline = { ...timeline, viewRevision: revision + 1 };
      detail.liveState = timeline.liveState;
      detail.thread.status = timeline.liveState === "streaming" ? "active" : "idle";
      // The durable cursor owns both the empty reset and the refetch marker.
      emit("thread_view.patch", reset, client, revision);
      emit("thread_view.refresh_required", { threadId: detail.thread.id, reason: "thread_reverted" }, client, revision);
    },
    connected(client: string) { return [...streams.values()].includes(client); },
    disconnect(client: string) { for (const [stream, id] of streams) if (client === id) stream.end(); },
    applyNext(client?: string) {
      const update = pending.shift();
      if (!update) throw new Error("No pending native settings update");
      Object.assign(settings, update);
      settingsChanged(client);
    },
    holdNext(client: string, kind: "settings" | "snapshot" | "seen" | "badge" | "queue" | "runs" | "goal" = "settings", label = "") { holds.set(`${kind}:${client}`, `${kind}:${client}:${label}`); },
    isHeld(client: string, kind: "settings" | "snapshot" | "seen" | "badge" | "queue" | "runs" | "goal" = "settings", label = "") { return held.has(`${kind}:${client}:${label}`); },
    wasAborted(client: string, kind: "settings" | "snapshot" | "seen" | "badge" | "queue" | "runs" | "goal" = "settings", label = "") { return held.get(`${kind}:${client}:${label}`)?.aborted() ?? false; },
    async release(client: string, kind: "settings" | "snapshot" | "seen" | "badge" | "queue" | "runs" | "goal" = "settings", label = "") {
      const key = `${kind}:${client}:${label}`;
      const reply = held.get(key);
      if (!reply) throw new Error(`No held ${kind} read for ${client}`);
      held.delete(key);
      await reply.send();
    },
    async page(client: string, path = "/threads/settings-chat") {
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
      await page.goto(path);
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
