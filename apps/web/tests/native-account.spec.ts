import { expect, test, type Page } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";

import type { AccountResponse, Capabilities, EventEnvelope, LoginStartResponse } from "../src/api/client";

test("device-code sign-in and native account changes converge across two tabs", async ({ context }) => {
  const capabilities: Capabilities = {
    gateway: { apiVersion: "1", instanceId: "native-account-fixture", version: "test", sse: true, approvals: true, gatewayAuth: false, trustedNetworkOnly: true },
    appServer: { ready: true, experimentalApi: true, schemaVersion: "0.160.0", detectedVersion: "0.160.0", detectedVersionMatchesSchema: true },
  };
  let account: AccountResponse = { account: null, requiresOpenaiAuth: true, rawPayload: {} };
  const login: LoginStartResponse = {
    loginType: "chatgptDeviceCode", loginId: "native-attempt", userCode: "NATIVE-CODE", verificationUrl: "https://auth.example.test/device",
  };
  // A real, held-open stream proves notification routing without account refills
  // caused by repeatedly closing a mocked EventSource response.
  const streams = new Set<ServerResponse>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*" });
    response.flushHeaders();
    streams.add(response);
    response.on("close", () => streams.delete(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local SSE address");
  let seq = 0;
  const unexpected: string[] = [];
  const loginBodies: Array<string | null> = [];
  const pageErrors: string[] = [];
  function emit(kind: string, payload: unknown) {
    seq += 1;
    const event: EventEnvelope = { id: String(seq), seq, kind, payload, receivedAt: "2026-10-04T00:00:00Z" };
    for (const stream of streams) stream.write(`id: ${seq}\nevent: ${kind}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  try {
    await context.route("**/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const key = `${request.method()} ${url.pathname}`;
      if (key === "GET /v1/events") {
        await route.continue({ url: `http://127.0.0.1:${address.port}${url.pathname}${url.search}` });
        return;
      }
      let body: unknown;
      switch (key) {
        case "GET /v1/capabilities": body = capabilities; break;
        case "GET /v1/sidebar/threads": body = { projects: [], projectThreads: {}, chatThreads: { threads: [] }, pinnedThreads: { threads: [] } }; break;
        case "GET /v1/threads/unread-badge": body = { count: 0, readRevision: 0 }; break;
        case "GET /v1/account": body = account; break;
        case "GET /v1/account/rate-limits": body = { rateLimits: null, rawPayload: {} }; break;
        case "GET /v1/approvals": body = { runtimeId: "native-account-runtime", revision: 0, approvals: [] }; break;
        case "GET /v1/models": body = { models: [], rawPayload: {} }; break;
        case "GET /v1/composer-settings": body = {}; break;
        case "PUT /v1/thread-view-presence": body = { ok: true }; break;
        case "POST /v1/account/login": loginBodies.push(request.postData()); body = login; break;
        case "POST /v1/account/logout":
          account = { ...account, account: null };
          emit("account.updated", { authMode: null });
          body = { rawPayload: {} };
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
    for (const page of [first, second]) {
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Account settings" })).toBeVisible();
    }
    await expect.poll(() => streams.size).toBe(2);
    await openAccount(first);
    await first.getByRole("menuitem", { name: "Sign in with ChatGPT" }).click();
    await expect(first.getByRole("dialog", { name: "Sign in with ChatGPT" })).toBeVisible();
    await expect(first.getByLabel("One-time code")).toHaveValue(login.userCode);
    await expect(first.getByRole("link", { name: "Open sign-in page" })).toHaveAttribute("href", login.verificationUrl);
    expect(loginBodies).toEqual([null]);

    // The fixture supplies native completion; no real credentials or external login.
    account = { ...account, account: { accountType: "chatgpt", email: "user@example.test", rawPayload: {} } };
    emit("account.updated", { authMode: "chatgpt" });
    emit("account.login_completed", { loginId: login.loginId, success: true });
    await expect(first.getByRole("dialog")).toHaveCount(0);
    for (const page of [first, second]) {
      await openAccount(page);
      await expect(page.getByRole("menuitem", { name: "Logout" })).toBeVisible();
    }
    await second.getByRole("menuitem", { name: "Logout" }).click();
    await expect(first.getByRole("menuitem", { name: "Sign in with ChatGPT" })).toBeVisible();
    await openAccount(second);
    await expect(second.getByRole("menuitem", { name: "Sign in with ChatGPT" })).toBeVisible();
    expect(unexpected).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

async function openAccount(page: Page) {
  await page.getByRole("button", { name: "Account settings" }).click();
}
