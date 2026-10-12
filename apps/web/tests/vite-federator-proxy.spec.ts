import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createServer as createTcpServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function unusedPort(): Promise<number> {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test listener port");
  server.close();
  await once(server, "close");
  return address.port;
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(5_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("Vite preserves the documented federator Host and mutation Origin", async ({ page }) => {
  const upstreamPort = await unusedPort();
  const vitePort = await unusedPort();
  const browserOrigin = `http://127.0.0.1:${vitePort}`;
  const observations: Array<{ method: string; path: string; host?: string; origin?: string }> = [];
  const upstream: Server = createServer((request, response) => {
    observations.push({
      method: request.method ?? "",
      path: request.url ?? "",
      host: request.headers.host,
      origin: request.headers.origin,
    });
    if (request.method === "GET" && request.url === "/openapi.json") {
      response.setHeader("content-type", "application/json");
      response.end("{}");
      return;
    }
    if (request.method === "POST" && request.url === "/v1/executors") {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  upstream.listen(upstreamPort, "127.0.0.1");
  await once(upstream, "listening");

  const webRoot = resolve(import.meta.dirname, "..");
  const vite = spawn(
    process.execPath,
    [resolve(webRoot, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    {
      cwd: webRoot,
      env: {
        ...process.env,
        VITE_KODEX_PROXY_TARGET: `http://127.0.0.1:${upstreamPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let viteLogs = "";
  for (const stream of [vite.stdout, vite.stderr]) stream?.on("data", (chunk: Buffer) => {
    viteLogs = (viteLogs + chunk.toString()).slice(-8_000);
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (vite.exitCode !== null) throw new Error(`Vite exited before readiness:\n${viteLogs}`);
      try {
        const response = await fetch(`${browserOrigin}/openapi.json`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // The listener is still starting.
      }
      await delay(50);
    }
    expect(ready, viteLogs).toBe(true);

    await page.goto(`${browserOrigin}/openapi.json`);
    const mutationStatus = await page.evaluate(async () => {
      const response = await fetch("/v1/executors", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kodex-api-version": "4",
        },
        body: JSON.stringify({}),
      });
      return response.status;
    });
    expect(mutationStatus).toBe(204);

    const proxiedGet = observations.find((entry) => entry.method === "GET" && entry.path === "/openapi.json");
    const proxiedMutation = observations.find((entry) => entry.method === "POST" && entry.path === "/v1/executors");
    expect(proxiedGet?.host).toBe(`127.0.0.1:${vitePort}`);
    expect(proxiedMutation).toMatchObject({
      host: `127.0.0.1:${vitePort}`,
      origin: browserOrigin,
    });
  } finally {
    await stopProcess(vite);
    upstream.close();
    await once(upstream, "close");
  }
});
