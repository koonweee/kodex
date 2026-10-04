import type { BrowserContext, Route } from "@playwright/test";

import { nativeSettingsFixture } from "./native-settings.fixture";

// Reuse the held-open, per-client SSE/foreground fixture; config has one native
// version for all writes, independent of the browser or the gateway projection.
export async function nativeConfigFixture(context: BrowserContext) {
  const fixture = await nativeSettingsFixture(context);
  const requests: Array<{ key: string; body: unknown }> = [];
  const filePath = "/dedicated/config.toml";
  let revision = 1;
  let reloadError: string | null = null;
  const native = {
    url: "https://initial.example/mcp", enabled: true, required: true,
    disabled_tools: ["protected-tool"],
    http_headers: { Authorization: "fixture-private-secret", "X.Proof.Key": "private-header" } as Record<string, string>,
  };
  const defaults = { approvalPolicy: "on-request", approvalsReviewer: "user", permissionProfileId: null as string | null };
  const writeTarget = () => ({ filePath, version: `native-v${revision}` });
  const inventory = () => ({ writeTarget: writeTarget(), servers: [{
    name: "proof.with.dot", enabled: native.enabled, required: native.required, hasStoredSecrets: true,
    scopes: [], enabledTools: [], startupTimeoutSec: null, toolTimeoutSec: null,
    transport: { type: "streamableHttp", url: native.url, bearerTokenEnvVar: null, oauthResource: null,
      envHttpHeaders: {}, httpHeaders: Object.fromEntries(Object.keys(native.http_headers).map((key) => [key, { configured: true, masked: true }])) },
  }] });
  const response = () => ({ saved: true,
    write: { status: "ok", filePath, version: writeTarget().version, overriddenMetadata: null },
    reload: { queued: !reloadError, error: reloadError },
  });
  async function respond(route: Route, value: unknown, status = 200) { await route.fulfill({ json: value, status }); }
  const handler = async (route: Route) => {
    const request = route.request();
    const key = `${request.method()} ${new URL(request.url()).pathname}`;
    const body = request.postData() ? request.postDataJSON() : null;
    requests.push({ key, body });
    if (key === "GET /v1/composer-settings") return respond(route, { writeTarget: writeTarget(), ...defaults, model: "gpt-5.4", effort: "medium", serviceTier: null, permissionsPreset: "default" });
    if (key === "GET /v1/mcp/configured-servers") return respond(route, inventory());
    if (key === "GET /v1/mcp/servers") return respond(route, { servers: [] });
    if (key === "POST /v1/mcp/reload") return respond(route, { queued: true });
    if (key === "PATCH /v1/composer-settings" || key === "PATCH /v1/mcp/servers/proof.with.dot") {
      if (body.writeTarget?.version !== writeTarget().version || body.writeTarget?.filePath !== filePath) {
        return respond(route, { code: "config_version_conflict", message: "Native configuration changed elsewhere.", retryable: false }, 409);
      }
      if (key.includes("composer-settings")) {
        for (const field of ["approvalPolicy", "approvalsReviewer", "permissionProfileId"] as const) {
          if (field in body) defaults[field] = body[field];
        }
      } else {
        for (const edit of body.edits) {
          if (edit.keyPath.length === 1 && edit.keyPath[0] === "url") native.url = edit.value;
          else if (edit.keyPath.length === 1 && edit.keyPath[0] === "required") native.required = edit.value;
          else if (edit.keyPath.length === 2 && edit.keyPath[0] === "http_headers") {
            if (edit.value === null) delete native.http_headers[edit.keyPath[1]];
            else native.http_headers[edit.keyPath[1]] = edit.value;
          } else throw new Error(`Unexpected native config edit ${JSON.stringify(edit.keyPath)}`);
        }
      }
      revision += 1;
      fixture.configChanged();
      return respond(route, response());
    }
    return route.fallback();
  };
  await context.route(/\/v1\/(?:composer-settings|mcp\/.*)(?:\?.*)?$/, handler);
  return { ...fixture, requests, native, defaults, writeTarget,
    failReload(error: string) { reloadError = error; },
    externalChange(values: Partial<typeof native>, client?: string) { Object.assign(native, values); revision += 1; fixture.configChanged(client); },
  };
}
