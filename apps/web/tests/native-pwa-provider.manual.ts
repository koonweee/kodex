import { chromium, expect, test, type BrowserContext, type CDPSession, type Worker } from "@playwright/test";
import { createECDH } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { components } from "../src/api/generated/schema";
import { nativeTerminalEnabled, nativeTerminalFixture } from "./native-terminal.fixture";

// Manual-only: run test:push-provider:manual from a user-opened terminal.
// Installed Chrome startup can trigger macOS App Management under a gateway parent.
// This workflow handles a real provider endpoint and subscription keys.
// Keep those out of traces, screenshots, videos, assertion diffs, and evidence.
test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(!nativeTerminalEnabled || !process.env.KODEX_TEST_CHROME_BINARY,
  "requires explicit Chrome, gateway, and pinned native binaries plus a current production web build");

test("delivers a real provider Test push to the built worker in a disposable Chrome profile", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const profile = await mkdtemp(join(tmpdir(), "kodex-pwa-provider-"));
  const key = createECDH("prime256v1");
  key.generateKeys();
  const publicKey = key.getPublicKey().toString("base64url");
  let context: BrowserContext | undefined;
  let fixture: Awaited<ReturnType<typeof nativeTerminalFixture>> | undefined;
  let worker: Worker | undefined;
  let cdp: CDPSession | undefined;
  let endpoint: string | undefined;
  let subscriptionSaved = false;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.KODEX_TEST_CHROME_BINARY!,
      headless: true,
      serviceWorkers: "allow",
      ignoreDefaultArgs: ["--disable-background-networking"],
      viewport: { width: 1280, height: 844 },
      timeout: 20_000,
    });
    fixture = await nativeTerminalFixture(context, { notifications: {
      publicKey, privateKey: key.getPrivateKey().toString("base64url"),
      subject: "https://localhost.invalid/kodex-disposable-proof",
    } });
    await context.grantPermissions(["notifications"], { origin: fixture.baseUrl });
    const page = await fixture.page();
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe("activated");
    expect(await page.evaluate(() => Notification.permission)).toBe("granted");
    worker = context.serviceWorkers().find((entry) => entry.url() === `${fixture!.baseUrl}/sw.js`);
    if (!worker) throw new Error("The built service worker was not registered");

    const subscription = await bounded(page.evaluate(async (publicKey) => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return null;
      try {
        const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
        return (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })).toJSON();
      } catch {
        // A browser/provider error can contain the endpoint. Report only the
        // failed boundary; never serialize it into the test report.
        return null;
      }
    }, publicKey), 45_000, "Real provider subscription timed out");
    endpoint = subscription?.endpoint;
    if (!endpoint || !subscription?.keys?.p256dh || !subscription.keys.auth) {
      throw new Error("Real provider subscription did not return the required endpoint and keys");
    }
    const providerOrigin = new URL(endpoint).origin;
    expect(providerOrigin).toBe("https://fcm.googleapis.com");

    cdp = await context.newCDPSession(page);
    let registrationId: string | undefined;
    let version: { versionId: string; registrationId: string; runningStatus: string } | undefined;
    let workerErrorCount = 0;
    const displays: Array<{ origin: string; registrationId: string; tag: string; title?: string; body?: string }> = [];
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      for (const registration of registrations) {
        if (!registration.isDeleted && registration.scopeURL === `${fixture!.baseUrl}/`) registrationId = registration.registrationId;
      }
    });
    cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      for (const current of versions) {
        if (current.scriptURL === `${fixture!.baseUrl}/sw.js` && current.status === "activated") version = current;
      }
    });
    cdp.on("ServiceWorker.workerErrorReported", () => { workerErrorCount += 1; });
    cdp.on("BackgroundService.backgroundServiceEventReceived", ({ backgroundServiceEvent: event }) => {
      if (event.service !== "notifications" || event.eventName !== "Notification displayed") return;
      const metadata = new Map(event.eventMetadata.map(({ key, value }) => [key, value]));
      displays.push({
        origin: event.origin, registrationId: event.serviceWorkerRegistrationId,
        tag: event.instanceId, title: metadata.get("Title"), body: metadata.get("Body"),
      });
    });
    await cdp.send("ServiceWorker.enable");
    await cdp.send("BackgroundService.startObserving", { service: "notifications" });
    await cdp.send("BackgroundService.setRecording", { service: "notifications", shouldRecord: true });
    await expect.poll(() => registrationId).toBeDefined();
    await worker.evaluate(() => {
      globalThis.addEventListener("push", (event) => {
        const data = Reflect.get(event, "data") as { json(): unknown } | null;
        Reflect.set(globalThis, "providerProofPush", { trusted: event.isTrusted, payload: data?.json() });
      }, { once: true });
    });

    const request = {
      endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      userAgent: "Disposable Chrome provider proof",
    } satisfies components["schemas"]["PushSubscriptionUpsertRequest"];
    const saved = await gatewayJson<components["schemas"]["PushSubscriptionUpsertResponse"]>(
      fixture.baseUrl, "/v1/notifications/subscriptions", "POST", 201, request,
    );
    subscriptionSaved = true;
    expect(saved.subscription.enabled).toBe(true);

    // No application window handles delivery. CDP only observes the native
    // browser boundary; the gateway sends the encrypted message via FCM.
    await page.goto("about:blank");
    expect(context.pages().every((entry) => !entry.url().startsWith(fixture!.baseUrl))).toBe(true);
    const sendTest = async () => {
      const sent = await gatewayJson<components["schemas"]["TestNotificationResponse"]>(
        fixture!.baseUrl, "/v1/notifications/test", "POST", 200,
      );
      expect({ configured: sent.configured, activeSubscriptions: sent.activeSubscriptionCount, enqueued: sent.enqueued, deliveries: sent.deliveryIds.length })
        .toEqual({ configured: true, activeSubscriptions: 1, enqueued: true, deliveries: 1 });
      return sent.deliveryIds[0];
    };
    const warmDeliveryId = await sendTest();
    const payload = { kind: "test", title: "Kodex test notification", body: "Push notifications are working.", route: "/" };
    const expectedDisplay = {
      origin: `${fixture.baseUrl}/`, registrationId, tag: "kodex-test-notification", title: payload.title, body: payload.body,
    };
    await expect.poll(() => displays, { timeout: 45_000 }).toEqual([expectedDisplay]);
    expect(await worker.evaluate(() => Reflect.get(globalThis, "providerProofPush"))).toEqual({ trusted: true, payload });

    await worker.evaluate(async () => {
      const registration = Reflect.get(globalThis, "registration") as ServiceWorkerRegistration;
      for (const notification of await registration.getNotifications()) notification.close();
    });
    await expect.poll(() => version?.registrationId).toBe(registrationId);
    const coldVersionId = version!.versionId;
    await cdp.send("ServiceWorker.stopWorker", { versionId: coldVersionId });
    await expect.poll(() => ({ versionId: version?.versionId, state: version?.runningStatus }))
      .toEqual({ versionId: coldVersionId, state: "stopped" });
    // Do not read or execute worker code, navigate, or request a native start
    // between this stopped witness and the real provider delivery below.
    const coldDeliveryId = await sendTest();
    expect(coldDeliveryId).not.toBe(warmDeliveryId);
    await expect.poll(() => displays, { timeout: 45_000 }).toEqual([expectedDisplay, expectedDisplay]);
    await expect.poll(() => ({ versionId: version?.versionId, state: version?.runningStatus }))
      .toEqual({ versionId: coldVersionId, state: "running" });
    expect(workerErrorCount).toBe(0);
    await fixture.assertClean();

    // Test notifications intentionally do not refresh unread badges. This
    // proves provider delivery and browser display, not OS installation/clicks.
    const evidencePath = testInfo.outputPath("native-pwa-provider-evidence.json");
    await writeFile(evidencePath, JSON.stringify({ chromeVersion: context.browser()?.version(), providerOrigin, trustedWarmPush: true,
      coldWake: { versionId: coldVersionId, before: "stopped", after: "running" }, displays }, null, 2));
    await testInfo.attach("native-pwa-provider-evidence", {
      path: evidencePath,
      contentType: "application/json",
    });
  } finally {
    const failures: string[] = [];
    const cleanup = async (label: string, action: () => Promise<unknown>) => {
      try { await action(); } catch { failures.push(label); }
    };
    if (fixture && endpoint) await cleanup("disable gateway subscription", async () => {
      // Disable by endpoint even if a saved subscription response was lost.
      const disabled = await gatewayJson<components["schemas"]["CurrentPushSubscriptionResponse"]>(
        fixture!.baseUrl, `/v1/notifications/subscription/current?endpoint=${encodeURIComponent(endpoint!)}`, "DELETE", 200,
      );
      expect(disabled.subscribed).toBe(false);
      if (subscriptionSaved) expect(disabled.subscription?.enabled).toBe(false);
    });
    if (context && fixture) await cleanup("unsubscribe browser and close notifications", async () => {
      // The stopped worker's execution context is gone. Use a fresh client
      // only after the delivery assertions, including when cold delivery fails.
      const cleanupPage = await context!.newPage();
      try {
        await cleanupPage.goto(fixture!.baseUrl, { timeout: 10_000 });
        const result = await bounded(cleanupPage.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          const subscription = await registration.pushManager.getSubscription();
          const unsubscribed = subscription ? await subscription.unsubscribe() : true;
          for (const notification of await registration.getNotifications()) notification.close();
          return { unsubscribed, remaining: (await registration.pushManager.getSubscription()) !== null };
        }), 10_000, "Browser subscription cleanup timed out");
        expect(result).toEqual({ unsubscribed: true, remaining: false });
      } finally {
        await cleanupPage.close();
      }
    });
    if (cdp) await cleanup("detach browser observer", () => cdp!.detach());
    if (fixture) await cleanup("close disposable gateway", () => fixture!.close());
    if (context) await cleanup("close disposable Chrome", () => context!.close());
    await cleanup("remove disposable Chrome profile", () => rm(profile, { recursive: true, force: true }));
    expect(failures, "Every provider-proof resource must be cleaned up").toEqual([]);
  }
});

async function gatewayJson<T>(origin: string, path: string, method: string, expectedStatus: number, body?: unknown): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  // Do not include API response bodies: subscription responses contain tokens.
  expect(response.status, "Disposable notification API status").toBe(expectedStatus);
  return await response.json() as T;
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally {
    clearTimeout(timer);
  }
}
