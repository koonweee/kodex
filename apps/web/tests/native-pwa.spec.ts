import { expect, test, type Page } from "@playwright/test";
import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { components } from "../src/api/generated/schema";
import { nativeTerminalEnabled, nativeTerminalFixture } from "./native-terminal.fixture";

// Full Chromium supports the worker BadgeService; the separate headless-shell
// binary crashes in that browser binding before the real worker can be tested.
test.use({ channel: "chromium", serviceWorkers: "allow", viewport: { width: 1280, height: 844 } });

test.describe("real built PWA", () => {
  test.skip(!nativeTerminalEnabled, "requires explicit gateway/native binaries and a current production web build");

  test("precaches only static assets and applies a waiting worker only after Update", async ({ context }, testInfo) => {
    test.setTimeout(90_000);
    const fixture = await nativeTerminalFixture(context);
    try {
      const page = await fixture.page();
      expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
      await expect.poll(() => page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return registration?.active?.state === "activated" && navigator.serviceWorker.controller?.state === "activated";
      })).toBe(true);
      const registration = await page.evaluate(async () => {
        const registration = (await navigator.serviceWorker.getRegistration())!;
        return { scope: registration.scope, script: registration.active!.scriptURL, waiting: registration.waiting !== null };
      });
      expect(registration).toEqual({ scope: `${fixture.baseUrl}/`, script: `${fixture.baseUrl}/sw.js`, waiting: false });

      const staticFiles = new Set((await readdir(fixture.frontendDist, { recursive: true })).map((path) => `/${path}`));
      const initialCache = await cacheEntries(page);
      expect(initialCache.length).toBeGreaterThan(0);
      expect(initialCache.some((entry) => new URL(entry).pathname === "/index.html")).toBe(true);
      expect(initialCache.some((entry) => new URL(entry).pathname.startsWith("/assets/"))).toBe(true);
      for (const entry of initialCache) {
        const url = new URL(entry);
        expect(url.origin).toBe(fixture.baseUrl);
        expect(staticFiles.has(url.pathname), entry).toBe(true);
      }

      const networkResponses: Array<{ path: string; fromWorker: boolean; status: number }> = [];
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith("/v1/") || path === "/openapi.json") {
          networkResponses.push({ path, fromWorker: response.fromServiceWorker(), status: response.status() });
        }
      });
      const read = await page.evaluate(async () => {
        const capabilities = await fetch("/v1/capabilities");
        const schema = await fetch("/openapi.json");
        const image = await (await fetch("/icon-192.png")).blob();
        const form = new FormData();
        form.append("images", image, "pwa-cache-proof.png");
        const upload = await fetch("/v1/uploads/images", { method: "POST", body: form });
        if (!upload.ok) throw new Error(`Image upload failed: ${upload.status} ${await upload.text()}`);
        const body = await upload.json() as components["schemas"]["ImageUploadResponse"];
        if (body.images.length !== 1) throw new Error("Expected one disposable image upload");
        // This real local-file preview endpoint uses the gateway's retained file
        // response implementation without requiring a model turn or credentials.
        const preview = await fetch(`/v1/skills/icon?path=${encodeURIComponent(body.images[0].path)}`);
        return {
          statuses: [capabilities.status, schema.status, upload.status, preview.status],
          imageSize: image.size,
          previewSize: (await preview.arrayBuffer()).byteLength,
        };
      });
      expect(read.statuses).toEqual([200, 200, 200, 200]);
      expect(read.previewSize).toBe(read.imageSize);
      for (const path of ["/v1/capabilities", "/openapi.json", "/v1/uploads/images", "/v1/skills/icon"]) {
        expect(networkResponses).toContainEqual({ path, fromWorker: false, status: 200 });
      }
      expect(await cacheEntries(page)).toEqual(initialCache);

      let reloads = 0;
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame() && new URL(frame.url()).origin === fixture.baseUrl) reloads += 1;
      });
      await page.evaluate(() => {
        const original = navigator.serviceWorker.controller;
        Reflect.set(window, "originalPwaProofController", original);
        sessionStorage.setItem("pwa-proof-controller-replaced", "false");
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          sessionStorage.setItem("pwa-proof-controller-replaced", String(navigator.serviceWorker.controller !== original));
        });
      });

      // Only the copied disposable bundle changes. A byte-level script update
      // exercises the real browser waiting lifecycle, not a mocked SW event.
      await appendFile(join(fixture.frontendDist, "sw.js"), "\n// Disposable native PWA update proof.\n");
      await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
      await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe("installed");
      await expect(page.getByRole("status")).toContainText("Update available");
      expect(await page.evaluate(() => navigator.serviceWorker.controller === Reflect.get(window, "originalPwaProofController"))).toBe(true);
      expect(reloads).toBe(0);
      await page.screenshot({ path: testInfo.outputPath("real-pwa-waiting-update.png"), fullPage: true });

      await Promise.all([
        page.waitForEvent("load"),
        page.getByRole("button", { name: "Update", exact: true }).click(),
      ]);
      await expect(page.getByRole("navigation", { name: "Workspace", exact: true })).toBeAttached();
      await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe("activated");
      expect(await page.evaluate(() => sessionStorage.getItem("pwa-proof-controller-replaced"))).toBe("true");
      expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting ?? null)).toBeNull();
      await expect(page.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
      expect(await cacheEntries(page)).toEqual(initialCache);
      expect(reloads).toBe(1);
      await fixture.assertClean();
      await testInfo.attach("native-pwa-evidence", {
        body: JSON.stringify({ registration, cacheEntries: initialCache, networkResponses, reloads }, null, 2),
        contentType: "application/json",
      });
    } finally {
      await fixture.close();
    }
  });
});

async function cacheEntries(page: Page) {
  return page.evaluate(async () => {
    const entries = await Promise.all((await caches.keys()).map(async (name) => (await (await caches.open(name)).keys()).map((request) => request.url)));
    return entries.flat().sort();
  });
}
