import { compactCanonicalPayload } from "../src/test/canonicalPayloadFixture";
import type { BrowserContext, Page, Route } from "@playwright/test";

import type { AppSurfaceBridgeRequest, AppSurfaceSession, ThreadTimelineSnapshotItem } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

// Browser fixture only: gateway-owned sessions and canonical receipts share the
// existing held-open SSE transport. It does not impersonate an MCP auth server.
export async function nativeAppSurfacesFixture(context: BrowserContext) {
  const fixture = await nativeSettingsFixture(context);
  const threadId = fixture.detail.thread.id;
  let current: AppSurfaceSession | null = session("generated", 1);
  const knownSessions = new Map([[current.id, current]]);
  const documents = new Map([[current.documentUrl, documentHtml(current)]]);
  const calls: Array<{ page: Page; key: string; body: unknown }> = [];
  const holdNext = new Set<Page>();
  const heldReads = new Map<Page, { send: () => Promise<void>; aborted: () => boolean }>();
  let pendingBridge: { send: () => Promise<void> } | null = null;

  function register(value: AppSurfaceSession) {
    current = value;
    knownSessions.set(value.id, value);
    documents.set(value.documentUrl, documentHtml(value));
  }
  async function respond(route: Route, body: unknown) {
    try { await route.fulfill({ json: body }); }
    catch (error) { if (route.request().failure()?.errorText !== "net::ERR_ABORTED") throw error; }
  }
  let receiptCount = 0;
  function publishReceipt() {
    receiptCount += 1;
    const id = `native-app-user-${receiptCount}`;
    const turnId = "native-app-turn";
    const clientId = `native-bridge-generated-client-${receiptCount}`;
    const item: ThreadTimelineSnapshotItem = {
      id: `row-${id}`, threadId, turnId, itemId: id, itemType: "userMessage", status: "completed", codexMethod: "item/completed", displayOrder: receiptCount,
      payload: compactCanonicalPayload({ id, type: "userMessage", clientId, content: [{ type: "text", text: "Pick mockup A" }] }, { id, clientId, itemType: "userMessage" }),
    };
    fixture.publishTimeline({ activeTurnId: turnId, liveState: "streaming", pendingApprovalRequests: [], pendingUserInputRequests: [],
      viewRevision: fixture.detail.timeline.viewRevision + 1, turns: [{ id: turnId, status: "inProgress" }],
      rows: [...fixture.detail.timeline.rows, { id: item.id, turnId, kind: "user_message", status: "completed", displayOrder: receiptCount, item }] });
  }
  await context.route(/\/v1\/(?:threads\/settings-chat\/app-surface|app-surfaces\/[^/]+\/(?:document|bridge))(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const page = request.frame().page();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    const body = request.postData() ? request.postDataJSON() as AppSurfaceBridgeRequest : null;
    calls.push({ page, key, body });
    if (key === `GET /v1/threads/${threadId}/app-surface`) {
      const captured = structuredClone({ session: current });
      if (holdNext.delete(page)) heldReads.set(page, { send: () => respond(route, captured), aborted: () => request.failure()?.errorText === "net::ERR_ABORTED" });
      else await respond(route, captured);
      return;
    }
    const document = documents.get(`${url.pathname}${url.search}`);
    if (request.method() === "GET" && url.pathname.endsWith("/document") && document) {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: document });
    }
    const id = url.pathname.match(/^\/v1\/app-surfaces\/([^/]+)\/bridge$/)?.[1];
    const target = id ? knownSessions.get(id) : undefined;
    if (request.method() !== "POST" || !target || !body) return route.fallback();
    if (body.bridgeToken !== target.bridgeToken || body.revision !== target.revision) throw new Error("Incorrect app session/token/revision target");
    if (body.method === "ui/message" && target.provider === "generated") {
      if (pendingBridge) throw new Error("Duplicate generated app submission");
      publishReceipt();
      pendingBridge = { send: () => respond(route, { id: body.id, result: { input: { payload: { turn: { id: "native-app-turn", status: "inProgress" } } } } }) };
      return;
    }
    if (body.method === "ui/initialize" && target.provider === "mcp") {
      return respond(route, { id: body.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "Kodex", version: "test" }, hostCapabilities: { resources: { read: true }, tools: { call: true } }, hostContext: { displayMode: "pane" } } });
    }
    if (body.method === "tools/call" && target.provider === "mcp") {
      if (JSON.stringify(body.params) !== JSON.stringify({ name: "native_lookup", arguments: { document: "account-document" } })) throw new Error("Unexpected MCP tool parameters");
      return respond(route, { id: body.id, result: { content: [{ type: "text", text: "Account-scoped tool result" }] } });
    }
    if (body.method === "resources/read" && target.provider === "mcp") {
      if (JSON.stringify(body.params) !== JSON.stringify({ uri: "docs://account/document" })) throw new Error("Unexpected MCP resource parameters");
      return respond(route, { id: body.id, result: { contents: [{ uri: "docs://account/document", text: "Account-scoped resource result" }] } });
    }
    if (body.method === "ui/open-link") return respond(route, { id: body.id, error: { code: -32000, message: "Link opening is not granted" } });
    return route.fallback();
  });

  return { ...fixture, calls,
    hasPendingBridge: () => pendingBridge !== null,
    async releaseBridge() {
      if (!pendingBridge) throw new Error("No held bridge acknowledgement");
      const pending = pendingBridge;
      pendingBridge = null;
      await pending.send();
    },
    update(provider: "generated" | "mcp", revision: number, client?: string) {
      const value = session(provider, revision);
      register(value);
      fixture.appSurfaceChanged("app_surface.session_upserted", value, client);
    },
    archive(client?: string) {
      if (!current) throw new Error("No current app surface");
      const archived: AppSurfaceSession = { ...current, status: "archived", archivedAt: "2026-10-05T00:00:02Z" };
      current = null;
      fixture.appSurfaceChanged("app_surface.session_archived", archived, client);
    },
    holdSessionRead(page: Page) { holdNext.add(page); },
    isSessionReadHeld: (page: Page) => heldReads.has(page),
    wasSessionReadAborted: (page: Page) => heldReads.get(page)?.aborted() ?? false,
    async releaseSessionRead(page: Page) {
      const held = heldReads.get(page);
      if (!held) throw new Error("No held app session read");
      heldReads.delete(page);
      await held.send();
    },
    async close() {
      if (pendingBridge) await pendingBridge.send();
      const releases = await Promise.allSettled([...heldReads.values()].map((held) => held.send()));
      heldReads.clear();
      await fixture.close();
      for (const result of releases) if (result.status === "rejected") throw result.reason;
    },
  };
}

function session(provider: "generated" | "mcp", revision: number): AppSurfaceSession {
  const id = provider === "generated" ? "generated-session" : "external-session";
  return {
    id, threadId: "settings-chat", provider, revision, title: `${provider === "generated" ? "Generated chooser" : "External native app"} ${revision}`,
    archivedAt: null, createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z", status: "active",
    csp: { connectDomains: [], resourceDomains: [] }, displayModes: ["pane"], documentUrl: `/v1/app-surfaces/${id}/document?revision=${revision}`,
    fallbackContent: "App fixture", grants: { canOpenLinks: false, canSendMessage: true, canUpdateModelContext: false, resources: [{ server: "account-server", uri: "docs://account/document" }], tools: [{ server: "account-server", tool: "native_lookup" }] },
    bridgeToken: `${id}-token`, permissions: {}, provenance: provider === "mcp" ? { mcp: { server: "account-server", arguments: { document: "account-document" }, result: { content: [{ type: "text", text: "Originating account result" }] } } } : { source: "generated" },
    resourceMimeType: "text/html", resourceUri: `ui://fixture/${id}`,
  };
}

function documentHtml(value: AppSurfaceSession): string {
  if (value.provider === "generated") return `<!doctype html><html><body><h1>${value.title}</h1><button onclick="parent.postMessage({jsonrpc:'2.0',id:'choose',method:'ui/message',params:{role:'user',content:{type:'text',text:'Pick mockup A'}}},'*')">Choose A</button></body></html>`;
  return `<!doctype html><html><body>
    <h1>${value.title}</h1><p id="input">Waiting for tool input</p><p id="result">Waiting for originating result</p><p id="call"></p>
    <button onclick="send('tool','tools/call',{name:'native_lookup',arguments:{document:'account-document'}})">Call native tool</button>
    <button onclick="send('resource','resources/read',{uri:'docs://account/document'})">Read native resource</button>
    <button onclick="send('link','ui/open-link',{url:'https://example.test/denied'})">Open ungranted link</button>
    <script>
      function send(id,method,params){parent.postMessage({jsonrpc:'2.0',id,method,params},'*')}
      addEventListener('message',function(event){const message=event.data;
        if(message.method==='ui/notifications/tool-input')document.getElementById('input').textContent=JSON.stringify(message.params.arguments);
        if(message.method==='ui/notifications/tool-result')document.getElementById('result').textContent=message.params.content[0].text;
        if(message.id==='tool'&&message.result)document.getElementById('call').textContent=message.result.content[0].text;
        if(message.id==='resource'&&message.result)document.getElementById('call').textContent=message.result.contents[0].text;
      });
      send('initialize','ui/initialize',{});
    </script></body></html>`;
}
