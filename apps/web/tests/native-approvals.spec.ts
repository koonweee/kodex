import { expect, test, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";

import type { Approval, ApprovalListResponse, Capabilities, EventEnvelope, ThreadViewResponse } from "../src/api/client";

test("two tabs converge from native approval snapshots after responding, missed events and runtime replacement", async ({ context }) => {
  const capabilities: Capabilities = {
    gateway: { instanceId: "native-approval-fixture", version: "test", sse: true, approvals: true, gatewayAuth: false, trustedNetworkOnly: true },
    appServer: { ready: true, experimentalApi: true, schemaVersion: "0.160.0", detectedVersion: "0.160.0", detectedVersionMatchesSchema: true },
  };
  const detail: ThreadViewResponse = {
    liveState: "idle",
    thread: { id: "thread-1", name: "Approval review", cwd: "/workspace", status: "idle", createdAt: 0, updatedAt: 0, notificationsEnabled: true, latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: false, unreadCompletedAgentTurn: false },
    timeline: { activeTurnId: null, liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [], viewRevision: 0 },
  };
  const approval: Approval = {
    id: "runtime-1-request-1", requestId: "request-1", source: "native", status: "pending", threadId: "thread-1",
    method: "item/commandExecution/requestApproval", payload: { command: "native approval command" }, createdAt: "2026-10-04T00:00:00Z",
  };
  let snapshot: ApprovalListResponse = { runtimeId: "runtime-1", revision: 1, approvals: [approval] };
  const streams = new Map<ServerResponse, string>();
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*" });
    response.flushHeaders();
    streams.set(response, new URL(request.url ?? "/", "http://localhost").searchParams.get("client") ?? "");
    response.on("close", () => streams.delete(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local SSE address");
  const clients = new Map<Page, string>();
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  const decisions: unknown[] = [];
  const reads = new Map<string, number>();
  let finishDelayedRead: (() => Promise<void>) | undefined;
  let delayNextSecondRead = false;
  function emit(client?: string, runtimeId = snapshot.runtimeId, seq = snapshot.revision) {
    const event: EventEnvelope = { id: String(seq), seq, kind: "approval.changed", payload: { runtimeId }, receivedAt: "2026-10-04T00:00:00Z" };
    for (const [stream, id] of streams) {
      if (!client || client === id) stream.write(`id: ${seq}\nevent: approval.changed\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }
  try {
    await context.route("**/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const key = `${request.method()} ${url.pathname}`;
      const client = clients.get(request.frame().page()) ?? "";
      if (key === "GET /v1/events") {
        url.searchParams.set("client", client);
        await route.continue({ url: `http://127.0.0.1:${address.port}${url.pathname}${url.search}` });
        return;
      }
      let body: unknown;
      switch (key) {
        case "GET /v1/capabilities": body = capabilities; break;
        case "GET /v1/sidebar/threads": body = { projects: [], projectThreads: {}, chatThreads: { threads: [detail.thread] }, sections: [], sectionThreads: {} }; break;
        case "GET /v1/threads/thread-1":
        case "POST /v1/threads/thread-1/attach": body = detail; break;
        case "GET /v1/threads/thread-1/settings": body = { model: "gpt-5.4", effort: "medium", serviceTier: null, activePermissionProfile: null }; break;
        case "GET /v1/threads/thread-1/app-surface": body = { session: null }; break;
        case "GET /v1/threads/thread-1/queued-inputs": body = { queuedInputs: [] }; break;
        case "GET /v1/threads/thread-1/subagents": body = { subagents: [] }; break;
        case "GET /v1/account": body = { account: null, requiresOpenaiAuth: false, rawPayload: {} }; break;
        case "GET /v1/account/rate-limits": body = { rateLimits: null, rawPayload: {} }; break;
        case "GET /v1/threads/unread-badge": body = { count: 0, readRevision: 0 }; break;
        case "GET /v1/models": body = { models: [], rawPayload: {} }; break;
        case "GET /v1/composer-settings": body = {}; break;
        case "PUT /v1/thread-view-presence": body = { ok: true }; break;
        case "GET /v1/approvals":
          expect(url.searchParams.has("status")).toBe(false);
          reads.set(client, (reads.get(client) ?? 0) + 1);
          body = snapshot;
          if (client === "second" && delayNextSecondRead) {
            delayNextSecondRead = false;
            finishDelayedRead = () => route.fulfill({ json: body });
            return;
          }
          break;
        case "POST /v1/approvals/runtime-1-request-1/decision":
          decisions.push(request.postDataJSON());
          snapshot = { ...snapshot, revision: 2, approvals: [{ ...approval, status: "responding" }] };
          emit();
          body = snapshot.approvals[0];
          break;
        default:
          unexpected.push(key);
          await route.fulfill({ status: 404, json: { code: "not_found", message: key, retryable: false } });
          return;
      }
      await route.fulfill({ json: body });
    });
    const first = await context.newPage();
    const second = await context.newPage();
    clients.set(first, "first");
    clients.set(second, "second");
    for (const page of [first, second]) {
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto("/threads/thread-1");
      await expect(page.getByRole("button", { name: "Yes, proceed", exact: true })).toBeEnabled();
    }
    await expect.poll(() => new Set(streams.values()).size).toBe(2);
    await first.getByRole("button", { name: "Yes, proceed", exact: true }).click();
    for (const page of [first, second]) await expect(page.getByRole("button", { name: "Yes, proceed", exact: true })).toBeDisabled();
    expect(decisions).toEqual([{ decision: { decision: "accept" } }]);

    // The second client begins an old snapshot read, then misses runtime removal.
    delayNextSecondRead = true;
    emit("second", "runtime-1", 3);
    await expect.poll(() => Boolean(finishDelayedRead)).toBe(true);
    snapshot = { runtimeId: "runtime-2", revision: 1, approvals: [] };
    emit("first");
    await expect(first.getByText("$ native approval command", { exact: true })).toHaveCount(0);
    const beforeReconnect = reads.get("second") ?? 0;
    for (const [stream, id] of streams) if (id === "second") stream.end();
    await expect.poll(() => reads.get("second") ?? 0).toBeGreaterThan(beforeReconnect);
    await expect(second.getByText("$ native approval command", { exact: true })).toHaveCount(0);
    await finishDelayedRead?.();
    emit(undefined, "runtime-1", 100);
    for (const page of [first, second]) await expect(page.getByRole("button", { name: "Yes, proceed", exact: true })).toHaveCount(0);
    expect(unexpected).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
