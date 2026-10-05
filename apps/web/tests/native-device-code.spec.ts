import { expect, test as base } from "@playwright/test";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { components } from "../src/api/generated/schema";
import { nativeTerminalEnabled, nativeTerminalFixture } from "./native-terminal.fixture";

const test = base.extend<{}, { suppressDeviceCodeArtifacts: void }>({
  suppressDeviceCodeArtifacts: [async ({}, use) => {
    const previous = process.env.PLAYWRIGHT_NO_COPY_PROMPT;
    process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
    try { await use(); }
    finally {
      if (previous === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT;
      else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previous;
    }
  }, { scope: "worker", auto: true }],
});

// The real one-time code stays in the disposable browser/native response only.
// Do not retain screenshots, traces, videos, or assertion diffs of its value.
// The automatic worker fixture also suppresses error-context aria snapshots
// through context teardown, including a timeout while the code is visible.
test.use({ channel: "chromium", trace: "off", screenshot: "off", video: "off", viewport: { width: 1280, height: 844 } });
test.describe.configure({ retries: 0 });
test.skip(!nativeTerminalEnabled || process.env.KODEX_TEST_REAL_DEVICE_CODE_LOGIN !== "1",
  "requires explicit real device-code opt-in, pinned native/gateway binaries, and a current production web build");

test("shows a real native device code and cancels that attempt without authorizing sign-in", async ({ context }, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await nativeTerminalFixture(context);
  let observer: Awaited<ReturnType<typeof observeAccountEvents>> | undefined;
  try {
    const capabilities = await readJson<components["schemas"]["CapabilitiesResponse"]>(`${fixture.baseUrl}/v1/capabilities`);
    expect(capabilities.appServer.detectedVersion).toBe("0.160.0");
    const authPath = join(fixture.codexHome, "auth.json");
    expect((await readJson<components["schemas"]["AccountResponse"]>(`${fixture.baseUrl}/v1/account`)).account === null).toBe(true);
    expect(await exists(authPath)).toBe(false);
    const page = await fixture.page();
    observer = await observeAccountEvents(fixture.baseUrl);

    let startRequests = 0;
    let cancelRequests = 0;
    let exactCancellation = false;
    let loginId: string | undefined;
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const path = new URL(request.url()).pathname;
      if (path === "/v1/account/login") startRequests += 1;
      if (path.startsWith("/v1/account/login/") && path.endsWith("/cancel")) {
        cancelRequests += 1;
        exactCancellation = path === `/v1/account/login/${encodeURIComponent(loginId ?? "")}/cancel`;
      }
    });
    await page.getByRole("button", { name: "Account settings", exact: true }).click({ timeout: 10_000 });
    const [started] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "POST"
        && response.url() === `${fixture.baseUrl}/v1/account/login`, { timeout: 30_000 }),
      page.getByRole("menuitem", { name: "Sign in with ChatGPT", exact: true }).click({ timeout: 10_000 }),
    ]);
    expect(started.status()).toBe(200);
    const login = await bounded(started.json(), 5_000) as components["schemas"]["LoginStartResponse"];
    expect(login.loginType === "chatgptDeviceCode" && typeof login.loginId === "string" && login.loginId.length > 0).toBe(true);
    loginId = login.loginId;
    const code = page.getByLabel("One-time code", { exact: true });
    await expect.poll(() => code.count(), { timeout: 5_000 }).toBe(1);
    // Evaluate to a boolean inside the page; never return or assert the code.
    const codePresented = await code.evaluate((element) => element instanceof HTMLInputElement
      && element.value.trim().length > 0 && element.getClientRects().length > 0, undefined, { timeout: 5_000 });
    expect(codePresented).toBe(true);

    const [canceled] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "POST"
        && new URL(response.url()).pathname === `/v1/account/login/${encodeURIComponent(loginId!)}/cancel`, { timeout: 10_000 }),
      page.getByRole("button", { name: "Cancel sign-in", exact: true }).click({ timeout: 5_000 }),
    ]);
    expect(canceled.status()).toBe(200);
    const cancellation = await bounded(canceled.json(), 5_000) as components["schemas"]["RawAppServerResponse"];
    const status = cancellation.payload && typeof cancellation.payload === "object" && "status" in cancellation.payload
      ? cancellation.payload.status : null;
    expect(status === "canceled").toBe(true);
    await expect.poll(() => observer!.completions.some((completion) => completion.loginId === loginId
      && completion.success === false && completion.error === "Login was not completed"), { timeout: 10_000 }).toBe(true);
    await expect(page.getByRole("dialog", { name: "Sign in with ChatGPT", exact: true })).toHaveCount(0);
    expect({ startRequests, cancelRequests, exactCancellation }).toEqual({ startRequests: 1, cancelRequests: 1, exactCancellation: true });
    expect((await readJson<components["schemas"]["AccountResponse"]>(`${fixture.baseUrl}/v1/account`)).account === null).toBe(true);
    expect(await exists(authPath)).toBe(false);
    expect(observer.accountUpdatedCount()).toBe(0);
    expect(observer.failed()).toBe(false);
    expect(context.pages().every((entry) => new URL(entry.url()).origin === fixture.baseUrl)).toBe(true);
    await fixture.assertClean();

    const evidencePath = testInfo.outputPath("native-device-code-evidence.json");
    await writeFile(evidencePath, JSON.stringify({
      nativeVersion: capabilities.appServer.detectedVersion,
      scope: "real device-code issuance and local cancellation only",
      streamOpenedBeforeLogin: true, codePresented, exactCancellation: true, canceledAcknowledgment: true,
      matchingFailedCompletion: true, accountNullBeforeAndAfter: true, authFileAbsentBeforeAndAfter: true,
      accountUpdated: false, verificationPageOpened: false, authenticatedSignInProven: false, managedIsolationProven: false,
    }, null, 2));
    await testInfo.attach("native-device-code-evidence", { path: evidencePath, contentType: "application/json" });
  } finally {
    try { await observer?.close(); }
    finally { await fixture.close(); }
  }
});

async function observeAccountEvents(origin: string) {
  const controller = new AbortController();
  try {
    const response = await bounded(fetch(`${origin}/v1/events?includeGlobal=true`, {
      headers: { accept: "text/event-stream" }, signal: controller.signal,
    }), 12_000);
    expect(response.status).toBe(200);
    if (!response.body) throw new Error("Global account event stream was unavailable");
    const reader = response.body.getReader();
    const completions: components["schemas"]["AccountLoginCompleted"][] = [];
    let accountUpdatedCount = 0;
    let failed = false;
    const task = (async () => {
      const decoder = new TextDecoder();
      let pending = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) { if (!controller.signal.aborted) failed = true; return; }
          pending += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
            const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const event = JSON.parse(data) as components["schemas"]["EventEnvelope"];
            if (event.kind === "account.login_completed" && event.codexMethod === "account/login/completed") {
              completions.push(event.payload as components["schemas"]["AccountLoginCompleted"]);
            }
            if (event.kind === "account.updated") accountUpdatedCount += 1;
          }
        }
      } catch { if (!controller.signal.aborted) failed = true; }
      finally { reader.releaseLock(); }
    })();
    return { completions, accountUpdatedCount: () => accountUpdatedCount, failed: () => failed,
      close: async () => { controller.abort(); await bounded(task, 3_000); } };
  } catch (error) {
    controller.abort();
    throw error;
  }
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
  expect(response.status).toBe(200);
  return await response.json() as T;
}

async function exists(path: string) {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Bounded native sign-in observation timed out")), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
