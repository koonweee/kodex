import { expect, test, type Page, type Request } from "@playwright/test";
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

      const passivePage = await fixture.page();
      await passivePage.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: "Chats", exact: true }).click();
      await passivePage.getByRole("button", { name: "New chat", exact: true }).click();
      const passiveDraft = passivePage.getByRole("textbox", { name: "Message composer", exact: true });
      await passiveDraft.fill("Keep this unsent draft while another tab updates.");
      let passiveReloads = 0;
      passivePage.on("framenavigated", (frame) => {
        if (frame === passivePage.mainFrame() && new URL(frame.url()).origin === fixture.baseUrl) passiveReloads += 1;
      });
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
      await expect(passivePage.getByRole("status")).toContainText("Update available");
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
      expect(passiveReloads).toBe(0);
      await expect(passiveDraft).toHaveValue("Keep this unsent draft while another tab updates.");
      await expect(passivePage.getByRole("button", { name: "Update", exact: true })).toBeVisible();
      // That tab may explicitly reload the worker already activated elsewhere.
      await Promise.all([
        passivePage.waitForEvent("load"),
        passivePage.getByRole("button", { name: "Update", exact: true }).click(),
      ]);
      await expect(passivePage.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
      expect(passiveReloads).toBe(1);
      await fixture.assertClean();
      await testInfo.attach("native-pwa-evidence", {
        body: JSON.stringify({ registration, cacheEntries: initialCache, networkResponses, reloads, passiveReloads }, null, 2),
        contentType: "application/json",
      });
    } finally {
      await fixture.close();
    }
  });

  test("handles a browser-dispatched Push and reads the current zero badge without a subscription", async ({ context }, testInfo) => {
    test.setTimeout(60_000);
    const fixture = await nativeTerminalFixture(context);
    const pendingBadgeReads = new Set<Request>();
    context.on("request", (request) => {
      if (request.url() === `${fixture.baseUrl}/v1/threads/unread-badge` && request.serviceWorker()) pendingBadgeReads.add(request);
    });
    context.on("requestfinished", (request) => { pendingBadgeReads.delete(request); });
    context.on("requestfailed", (request) => { pendingBadgeReads.delete(request); });
    try {
      await context.grantPermissions(["notifications"], { origin: fixture.baseUrl });
      const page = await fixture.page();
      await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe("activated");
      expect(await page.evaluate(() => Notification.permission)).toBe("granted");
      expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.pushManager.getSubscription())).toBeNull();
      const worker = context.serviceWorkers().find((worker) => worker.url() === `${fixture.baseUrl}/sw.js`)!;
      expect(worker).toBeDefined();
      const cdp = await context.newCDPSession(page);
      let registrationId: string | undefined;
      const workerErrors: string[] = [];
      const displayedNotifications: Array<{ origin: string; registrationId: string; tag: string; title?: string; body?: string }> = [];
      cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
        for (const registration of registrations) {
          if (!registration.isDeleted && registration.scopeURL === `${fixture.baseUrl}/`) registrationId = registration.registrationId;
        }
      });
      cdp.on("ServiceWorker.workerErrorReported", ({ errorMessage }) => { workerErrors.push(errorMessage.errorMessage); });
      cdp.on("BackgroundService.backgroundServiceEventReceived", ({ backgroundServiceEvent: event }) => {
        if (event.service !== "notifications" || event.eventName !== "Notification displayed") return;
        const metadata = new Map(event.eventMetadata.map(({ key, value }) => [key, value]));
        displayedNotifications.push({
          origin: event.origin, registrationId: event.serviceWorkerRegistrationId, tag: event.instanceId,
          title: metadata.get("Title"), body: metadata.get("Body"),
        });
      });
      await cdp.send("ServiceWorker.enable");
      await cdp.send("BackgroundService.startObserving", { service: "notifications" });
      await cdp.send("BackgroundService.setRecording", { service: "notifications", shouldRecord: true });
      await expect.poll(() => registrationId).toBeDefined();

      // Remove the app client and drain its existing badge messages so the next
      // worker-owned network read belongs to Push, not a foreground refill.
      await page.goto("about:blank");
      await expect.poll(() => pendingBadgeReads.size).toBe(0);
      await worker.evaluate(() => {
        globalThis.addEventListener("push", (event) => { Reflect.set(globalThis, "pwaProofTrustedPush", event.isTrusted); }, { once: true });
        const registration = Reflect.get(globalThis, "registration") as ServiceWorkerRegistration;
        const nativeShow = registration.showNotification;
        const calls: Array<{ title: string; options?: NotificationOptions; fulfilled: boolean; error?: string }> = [];
        Reflect.set(globalThis, "pwaProofNotificationCalls", calls);
        // Observe the real call and original promise, without replacing the
        // browser result. Native DevTools display events are asserted below.
        registration.showNotification = function (title, options) {
          const call: (typeof calls)[number] = { title, options, fulfilled: false };
          calls.push(call);
          const promise = nativeShow.call(this, title, options);
          void promise.then(() => { call.fulfilled = true; }, (error) => { call.error = String(error); });
          return promise;
        };
      });
      const payload = {
        kind: "unreadAgentMessage", threadId: "pwa-worker-proof", title: "Native worker notification",
        body: "Delivery is independent of the current unread count.", route: "/?threadId=pwa-worker-proof",
        // An old payload count must not replace the fresh gateway inventory.
        badgeCount: 999, readRevision: 999,
      };
      const badgeResponsePromise = context.waitForEvent("response", {
        predicate: (response) => response.url() === `${fixture.baseUrl}/v1/threads/unread-badge` && response.request().serviceWorker() !== null,
      });
      await cdp.send("ServiceWorker.deliverPushMessage", { origin: fixture.baseUrl, registrationId: registrationId!, data: JSON.stringify(payload) });
      const badgeResponse = await badgeResponsePromise;
      expect(badgeResponse.status()).toBe(200);
      expect(badgeResponse.fromServiceWorker()).toBe(false);
      const badge = await badgeResponse.json() as components["schemas"]["UnreadBadgeResponse"];
      expect(badge.count).toBe(0);
      expect(Number.isSafeInteger(badge.readRevision)).toBe(true);
      await expect.poll(() => worker.evaluate(() => Reflect.get(globalThis, "pwaProofNotificationCalls"))).toEqual([{
        title: payload.title, fulfilled: true,
        options: { badge: "/kodex-badge.png", body: payload.body, data: payload, icon: "/icon-192.png", tag: `kodex-unread-agent-message:${payload.threadId}` },
      }]);
      await expect.poll(() => displayedNotifications).toEqual([{
        origin: `${fixture.baseUrl}/`, registrationId, tag: `kodex-unread-agent-message:${payload.threadId}`,
        title: payload.title, body: payload.body,
      }]);
      // Platform notification lifetimes are independent of worker completion.
      // Validate any still-visible inventory without requiring OS persistence.
      const notificationInventory = await worker.evaluate(async () => {
        const registration = Reflect.get(globalThis, "registration") as ServiceWorkerRegistration;
        return (await registration.getNotifications()).map((notification) => ({
          title: notification.title, body: notification.body, tag: notification.tag, data: notification.data,
        }));
      });
      expect(notificationInventory.length).toBeLessThanOrEqual(1);
      for (const notification of notificationInventory) {
        expect(notification).toEqual({ title: payload.title, body: payload.body, tag: `kodex-unread-agent-message:${payload.threadId}`, data: payload });
      }
      expect(await worker.evaluate(() => Reflect.get(globalThis, "pwaProofTrustedPush"))).toBe(true);

      // CDP dispatch exercises the actual worker and browser display boundary.
      // It does not prove provider delivery, notification clicks, or OS badges.
      await worker.evaluate(async () => {
        const registration = Reflect.get(globalThis, "registration") as ServiceWorkerRegistration;
        for (const notification of await registration.getNotifications()) notification.close();
      });
      await expect.poll(() => pendingBadgeReads.size).toBe(0);
      expect(workerErrors).toEqual([]);
      await fixture.assertClean();
      await testInfo.attach("native-pwa-push-evidence", {
        body: JSON.stringify({ registrationId, trustedPush: true, notification: payload, authoritativeBadge: badge, subscription: null, displayedNotifications, notificationInventory }, null, 2),
        contentType: "application/json",
      });
      await cdp.detach();
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
