import type { BrowserContext, Page, Route } from "@playwright/test";

import type { McpServerStatus } from "../src/api/client";
import { nativeConfigFixture } from "./native-config.fixture";

// This exercises the browser's HTTP/SSE contract, not a real OAuth provider or
// callback listener. Native status is authoritative and login URLs are per-call.
export async function nativeMcpAuthFixture(context: BrowserContext) {
  const fixture = await nativeConfigFixture(context);
  const clients = new Map<Page, string>();
  const runtime: McpServerStatus[] = ["proof.with.dot", "other-account"].map((name) => ({
    name, authStatus: "notLoggedIn", runtimeStatus: "authenticationRequired",
    resources: [], resourceTemplates: [], tools: {}, toolsError: null,
  }));
  const native = Object.assign(fixture.native, { future_policy: { approval: "required", allow: ["protected-tool"] } });
  const authRequests: Array<{ client: string; key: string; body: unknown }> = [];
  const holds = new Map<string, string>();
  const held = new Map<string, { send: () => Promise<void>; aborted: () => boolean }>();
  let attempt = 0;

  async function respond(route: Route, value: unknown, key: string) {
    const captured = structuredClone(value);
    const send = async () => {
      try { await route.fulfill({ json: captured }); }
      catch (error) { if (route.request().failure()?.errorText !== "net::ERR_ABORTED") throw error; }
    };
    const label = holds.get(key);
    if (label) {
      holds.delete(key);
      held.set(label, { send, aborted: () => route.request().failure()?.errorText === "net::ERR_ABORTED" });
    } else await send();
  }

  await context.route(/\/v1\/mcp\/servers(?:\/[^/]+\/oauth-login)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const client = clients.get(request.frame().page()) ?? "";
    const key = `${request.method()} ${path}`;
    authRequests.push({ client, key, body: request.postData() ? request.postDataJSON() : null });
    if (key === "GET /v1/mcp/servers") return respond(route, { servers: runtime }, `inventory:${client}`);
    const login = path.match(/^\/v1\/mcp\/servers\/([^/]+)\/oauth-login$/);
    if (request.method() === "POST" && login && runtime.some((server) => server.name === decodeURIComponent(login[1]))) {
      attempt += 1;
      return respond(route, { authorizationUrl: `https://auth.example.test/${login[1]}/attempt-${attempt}` }, `login:${client}`);
    }
    return route.fallback();
  });

  return {
    ...fixture, native, authRequests,
    async page(client: string) {
      const page = await fixture.page(client);
      clients.set(page, client);
      return page;
    },
    setAuthorized(name: string, authorized: boolean) {
      const server = runtime.find((entry) => entry.name === name);
      if (!server) throw new Error(`Unknown fixture MCP server ${name}`);
      server.authStatus = authorized ? "oAuth" : "notLoggedIn";
      server.runtimeStatus = authorized ? "connected" : "authenticationRequired";
      server.tools = authorized ? { lookup: { name: "lookup", inputSchema: { type: "object" } } } : {};
    },
    complete(name: string, success: boolean, client?: string) {
      if (!runtime.some((server) => server.name === name)) throw new Error(`Unknown fixture MCP server ${name}`);
      fixture.mcpOAuthCompleted(name, success, success ? null : "Fixture authorization expired", client);
    },
    holdNext(client: string, kind: "login" | "inventory", label: string) { holds.set(`${kind}:${client}`, label); },
    isHeld(label: string) { return held.has(label); },
    wasAborted(label: string) { return held.get(label)?.aborted() ?? false; },
    async release(label: string) {
      const response = held.get(label);
      if (!response) throw new Error(`No held MCP response ${label}`);
      held.delete(label);
      await response.send();
    },
    async close() {
      const releases = await Promise.allSettled([...held.values()].map(({ send }) => send()));
      held.clear();
      await fixture.close();
      for (const result of releases) if (result.status === "rejected") throw result.reason;
    },
  };
}
