import { expect, type BrowserContext, type Page, type WebSocket } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { Capabilities, FederatedExecutor, TerminalSessionInfo } from "../src/api/client";
import { API_VERSION } from "../src/api/compatibility";
import { createInstanceStorage } from "../src/api/instanceStorage";
import { createBrowserWorkspacePaneStore } from "../src/workspace/paneStore";

export const nativeFederationEnabled = process.platform !== "win32"
  && Boolean(
    process.env.KODEX_TEST_CODEX_BINARY
    && process.env.KODEX_TEST_FEDERATOR_BINARY
    && process.env.KODEX_TEST_GATEWAY_BINARY,
  );

type TerminalSocket = {
  socket: WebSocket;
  closed: boolean;
  output: string;
  sizes: Array<{ rows: number; cols: number }>;
};

export async function nativeTerminalFixture(context: BrowserContext, options?: {
  notifications?: { publicKey: string; privateKey: string; subject: string };
}) {
  const gatewayBinary = resolve(process.env.KODEX_TEST_GATEWAY_BINARY!);
  const federatorBinary = resolve(process.env.KODEX_TEST_FEDERATOR_BINARY!);
  const codex = resolve(process.env.KODEX_TEST_CODEX_BINARY!);
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const dist = join(repository, "apps/web/dist");
  await Promise.all([
    access(gatewayBinary),
    access(federatorBinary),
    access(codex),
    access(join(dist, "index.html")),
  ]);
  const root = await realpath(await mkdtemp(join(tmpdir(), "kodex-terminal-browser-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const frontendDist = join(root, "web");
  await cp(dist, frontendDist, { recursive: true });
  const executorInstance = join(root, "executor");
  const federatorInstance = join(root, "federator");
  const executorAddress = await unusedLocalAddress();
  const controlAddress = await unusedLocalAddress();
  const federatorAddress = await unusedLocalAddress();
  const sandboxAddress = await unusedLocalAddress();
  const executorBaseUrl = `http://${executorAddress}`;
  const baseUrl = `http://${federatorAddress}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:KODEX_|CODEX_|OPENAI_)/.test(key) && !["ENV", "BASH_ENV", "ZDOTDIR"].includes(key)));
  let gatewayLogs = "";
  let federatorLogs = "";
  const gateway = spawn(gatewayBinary, [], {
    cwd: workspace,
    env: {
      ...env,
      KODEX_DATA_DIR: executorInstance,
      KODEX_UPLOADS_DIR: join(root, "uploads"),
      KODEX_BIND: executorAddress,
      KODEX_CONTROL_BIND: controlAddress,
      KODEX_CODEX_BINARY: codex,
      KODEX_CODEX_ARGS: "app-server --listen stdio:// -c features.plugins=false -c features.apps=false -c analytics.enabled=false -c otel.exporter=\"none\" -c otel.trace_exporter=\"none\" -c otel.metrics_exporter=\"none\"",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const federator = spawn(federatorBinary, [], {
    cwd: workspace,
    env: {
      ...env,
      KODEX_FEDERATOR_BIND: federatorAddress,
      KODEX_FEDERATOR_DATA_DIR: federatorInstance,
      KODEX_FEDERATOR_PUBLIC_ORIGIN: baseUrl,
      KODEX_FEDERATOR_SANDBOX_BIND: sandboxAddress,
      KODEX_FEDERATOR_SANDBOX_PUBLIC_URL: `http://${sandboxAddress}/app-surface-sandbox.html`,
      KODEX_FRONTEND_DIST: frontendDist,
      ...(options?.notifications ? {
        KODEX_VAPID_PUBLIC_KEY: options.notifications.publicKey,
        KODEX_VAPID_PRIVATE_KEY: options.notifications.privateKey,
        KODEX_VAPID_SUBJECT: options.notifications.subject,
      } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [gateway.stdout, gateway.stderr]) stream?.on("data", (chunk: Buffer) => {
    gatewayLogs = (gatewayLogs + chunk.toString()).slice(-64_000);
  });
  for (const stream of [federator.stdout, federator.stderr]) stream?.on("data", (chunk: Buffer) => {
    federatorLogs = (federatorLogs + chunk.toString()).slice(-64_000);
  });
  let gatewaySpawnError: Error | null = null;
  let federatorSpawnError: Error | null = null;
  gateway.on("error", (error) => { gatewaySpawnError = error; });
  federator.on("error", (error) => { federatorSpawnError = error; });
  const pages: Page[] = [];
  const sockets = new Map<Page, TerminalSocket[]>();
  const errors: string[] = [];
  const rateLimitChecks: Promise<void>[] = [];
  const terminalRequests: Array<{ method: string; path: string }> = [];
  const noAccountRateLimits = {
    code: "bad_gateway",
    message: "app-server error -32600: codex account authentication required to read rate limits",
    retryable: true,
  };
  let executor: FederatedExecutor | null = null;

  async function originJson<T>(origin: string, path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-kodex-api-version": API_VERSION },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return await response.json() as T;
  }
  const executorPath = (path: string) => {
    if (!executor) throw new Error("Disposable executor is not registered");
    if (!path.startsWith("/v1/")) throw new Error(`Executor route must start with /v1/: ${path}`);
    return `/v1/executors/${encodeURIComponent(executor.id)}${path.slice(3)}`;
  };
  const executorUrl = (path: string) => `${baseUrl}${executorPath(path)}`;
  const executorJson = <T>(path: string, method = "GET", body?: unknown) => (
    originJson<T>(baseUrl, executorPath(path), method, body)
  );

  async function close() {
    try {
      // Close actual browser sockets before asking the gateway to exit, so its
      // graceful HTTP shutdown is not held open by SSE/terminal attachments.
      await Promise.allSettled(pages.map(async (page) => {
        if (!page.isClosed()) { await page.goto("about:blank"); await page.close(); }
      }));
      if (executor) {
        const { terminals } = await executorJson<{ terminals: TerminalSessionInfo[] }>("/v1/terminals");
        await Promise.all(terminals.map((terminal) => executorJson(`/v1/terminals/${terminal.id}`, "DELETE")));
      }
    } finally {
      await stopProcess(federator);
      await stopProcess(gateway);
      await rm(root, { recursive: true, force: true });
    }
  }

  try {
    let capabilities: Capabilities | null = null;
    await expect.poll(async () => {
      if (gatewaySpawnError) throw gatewaySpawnError;
      if (gateway.exitCode !== null) throw new Error(`Disposable executor exited: ${gatewayLogs}`);
      try {
        capabilities = await originJson<Capabilities>(executorBaseUrl, "/v1/capabilities");
        return capabilities.appServer.ready;
      }
      catch { return false; }
    }, { timeout: 20_000, message: "real disposable executor must start with its pinned native child" }).toBe(true);
    const actual = capabilities as Capabilities | null;
    if (!actual?.gateway.instanceId || actual.appServer.detectedVersion !== actual.appServer.schemaVersion) {
      throw new Error(`Native executor did not confirm its instance/version: ${gatewayLogs}`);
    }
    let federatorHealth: { instanceId: string; ready: boolean; service: string } | null = null;
    await expect.poll(async () => {
      if (federatorSpawnError) throw federatorSpawnError;
      if (federator.exitCode !== null) throw new Error(`Disposable federator exited: ${federatorLogs}`);
      try {
        federatorHealth = await originJson(baseUrl, "/healthz");
        return federatorHealth.ready && federatorHealth.service === "kodex-federator";
      } catch { return false; }
    }, { timeout: 20_000, message: "real disposable federator must start with its production bundle" }).toBe(true);
    executor = await originJson<FederatedExecutor>(baseUrl, "/v1/federation/executors", "POST", {
      displayName: "Native browser proof executor",
      baseUrl: executorBaseUrl,
    });
    expect(executor.instanceId).toBe(actual.gateway.instanceId);
    expect(executor.status).toBe("ready");
    // The fixture deliberately has no account credentials. Verify the native
    // boundary through the federator before allowing its browser console error.
    const rateLimits = await fetch(executorUrl("/v1/account/rate-limits"), { signal: AbortSignal.timeout(10_000) });
    expect(rateLimits.status).toBe(502);
    expect(await rateLimits.json()).toEqual(noAccountRateLimits);
    const { terminal } = await executorJson<{ terminal: TerminalSessionInfo }>("/v1/terminals", "POST", {
      title: "Native terminal proof", cwd: workspace, command: "/bin/sh",
    });
    const entries = new Map<string, string>();
    createBrowserWorkspacePaneStore(createInstanceStorage(federatorHealth!.instanceId, {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => { entries.set(key, value); },
    }), executor.id).save({
      activePaneId: "native-terminal-pane", dockviewLayout: null, schemaVersion: 2,
      panes: [{ id: "native-terminal-pane", kind: "terminal", title: terminal.title,
        target: { executorId: executor.id, terminalId: terminal.id, command: terminal.command, cwd: terminal.cwd } }],
    });

    // Seed only the existing per-browser visual workspace format, derived from
    // the live capabilities and real terminal response. All API/WS traffic is
    // untouched. This observer retains real WebSockets only to close one for
    // an explicit network-loss/reconnect test; it does not emulate transport.
    await context.addInitScript(({ origin, entries, terminalPath }) => {
      if (location.origin !== origin) return;
      if (!localStorage.getItem("native-terminal-proof-seeded")) {
        for (const [key, value] of entries) localStorage.setItem(key, value);
        localStorage.setItem("native-terminal-proof-seeded", "true");
      }
      const NativeWebSocket = window.WebSocket;
      const observed: globalThis.WebSocket[] = [];
      Reflect.set(window, "nativeTerminalProofSockets", observed);
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (new URL(String(url), location.href).pathname.startsWith(`${terminalPath}/`)) observed.push(this);
        }
      };
    }, { origin: baseUrl, entries: [...entries], terminalPath: executorPath("/v1/terminals") });

    async function page() {
      const page = await context.newPage();
      pages.push(page);
      sockets.set(page, []);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        if (message.location().url === executorUrl("/v1/account/rate-limits")
          && message.text() === "Failed to load resource: the server responded with a status of 502 (Bad Gateway)") return;
        errors.push(message.text());
      });
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith(executorPath("/v1/terminals"))) terminalRequests.push({ method: request.method(), path });
      });
      page.on("response", (response) => {
        if (response.url() !== executorUrl("/v1/account/rate-limits") || response.status() !== 502) return;
        rateLimitChecks.push(response.json().then((body) => {
          expect(body).toEqual(noAccountRateLimits);
        }).catch((error: unknown) => { errors.push(`Unexpected rate-limit failure: ${String(error)}`); }));
      });
      page.on("websocket", (socket) => {
        if (!new URL(socket.url()).pathname.startsWith(`${executorPath("/v1/terminals")}/`)) return;
        const observation: TerminalSocket = { socket, closed: false, output: "", sizes: [] };
        sockets.get(page)!.push(observation);
        socket.on("close", () => { observation.closed = true; });
        socket.on("framereceived", ({ payload }) => { observation.output += payload.toString(); });
        socket.on("framesent", ({ payload }) => {
          const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
          if (bytes.at(-1) === 0xff) observation.sizes.push(JSON.parse(bytes.subarray(0, -1).toString()) as { rows: number; cols: number });
        });
      });
      await page.goto(`${baseUrl}/executors/${encodeURIComponent(executor.id)}`);
      const region = page.getByRole("region", { name: "Terminal pane", exact: true });
      await expect(region).toBeVisible({ timeout: 20_000 });
      await expect.poll(
        () => sockets.get(page)!.some((entry) => !entry.closed && entry.sizes.length > 0),
        { timeout: 20_000 },
      ).toBe(true);
      return page;
    }

    return {
      baseUrl,
      executorId: executor.id,
      executorInstanceId: executor.instanceId,
      executorPath,
      executorUrl,
      workspace,
      frontendDist,
      codexHome: join(executorInstance, "codex-home"),
      terminal,
      errors,
      terminalRequests,
      sockets,
      page, close,
      assertClean: async () => {
        await Promise.all(rateLimitChecks);
        expect(errors).toEqual([]);
      },
      sessions: async () => (await executorJson<{ terminals: TerminalSessionInfo[] }>("/v1/terminals")).terminals,
      output: (page: Page) => sockets.get(page)?.map((entry) => entry.output).join("") ?? "",
      activeSocket: (page: Page) => [...(sockets.get(page) ?? [])].reverse().find((entry) => !entry.closed),
      disconnect: async (page: Page) => {
        await page.evaluate(() => {
          const sockets = Reflect.get(window, "nativeTerminalProofSockets") as globalThis.WebSocket[];
          for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close();
        });
      },
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nDisposable executor log:\n${gatewayLogs}\nDisposable federator log:\n${federatorLogs}`);
  }
}

async function unusedLocalAddress() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback test listener");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return `127.0.0.1:${address.port}`;
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), delay(5_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await exited;
}
