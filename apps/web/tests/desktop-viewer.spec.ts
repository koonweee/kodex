import { expect, test, type Frame, type Page } from "@playwright/test";
import { prepareDesktopViewer } from "../scripts/prepare-desktop-viewer.mjs";
import { DesktopRfbFixture } from "./desktop-rfb.fixture";

const viewer = prepareDesktopViewer();
async function open(page: Page) {
  await page.route("**/desktop-test-host", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>
    <textarea aria-label="Kodex input"></textarea>
    <iframe title="Desktop" src="${viewer.url}" style="width:600px;height:400px"></iframe>
    </body></html>` }));
  await page.goto("/desktop-test-host");
  const frame = page.frame({ url: new RegExp(viewer.url) })!;
  await frame.waitForFunction(() => window.kodexDesktop);
  await frame.evaluate(() => {
    (window as Window & { states: unknown[] }).states = [];
    window.kodexDesktop!.subscribe((state) => (window as Window & { states: unknown[] }).states.push(state));
  });
  return frame;
}
async function status(frame: Frame) {
  return frame.evaluate(() => {
    const states = (window as Window & { states: { status: string; failure?: string; retryable?: boolean; keyboardOpen: boolean }[] }).states;
    return states.at(-1)!;
  });
}
async function connect(frame: Frame, active = true) {
  await frame.evaluate((active) => { window.kodexDesktop!.setActive(active); window.kodexDesktop!.connect(); }, active);
  await expect.poll(async () => (await status(frame)).status).toBe("connected");
}

test("pinned client uses shared None authentication, renders pixels, and keeps Escape inside the viewer", async ({ page }) => {
  const fixture = new DesktopRfbFixture();
  await fixture.install(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const frame = await open(page);
  await connect(frame);
  await expect.poll(() => fixture.connections[0].shared).toBe(1);
  await expect.poll(() => frame.locator("#screen canvas").evaluate((canvas) => Array.from(canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data))).toEqual([17, 34, 204, 255]);
  await frame.locator("#screen canvas").click();
  await page.keyboard.press("Escape");
  await expect.poll(() => fixture.connections[0].keys).toContainEqual({ down: true, keysym: 0xff1b });
  const count = fixture.connections[0].keys.length;
  await page.getByRole("textbox", { name: "Kodex input" }).click();
  await page.keyboard.type("local draft");
  await page.keyboard.press("Escape");
  expect(fixture.connections[0].keys).toHaveLength(count);
  expect(fixture.connections[0].messages).not.toContain(251);
  expect(fixture.errors).toEqual([]);
  expect(errors).toEqual([]);
  await expect(frame.getByRole("button")).toHaveCount(0);
});

test("hidden viewer connects without focus, stays connected, and closes independently", async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  const a = new DesktopRfbFixture(); const b = new DesktopRfbFixture();
  await a.install(first); await b.install(second);
  const one = await open(first); const two = await open(second);
  await first.getByRole("textbox", { name: "Kodex input" }).focus();
  await connect(one, false); await connect(two);
  await expect(first.getByRole("textbox", { name: "Kodex input" })).toBeFocused();
  await expect(one.locator("html")).toHaveAttribute("inert", "");
  await one.evaluate(() => window.kodexDesktop!.setActive(true));
  await expect(one.locator("html")).not.toHaveAttribute("inert");
  expect(a.connections).toHaveLength(1);
  await one.evaluate(() => window.kodexDesktop!.disconnect());
  await expect.poll(() => a.connections[0].closed).toBe(true);
  expect((await status(two)).status).toBe("connected");
  expect(b.connections[0].closed).toBe(false);
  await two.locator("#screen canvas").click();
  await second.keyboard.press("a");
  await expect.poll(() => b.connections[0].keys).toContainEqual({ keysym: 97, down: true });
});

test("explicit paste writes before Command-V, rejects lossy Unicode and empty text, and never copies back", async ({ page }) => {
  const fixture = new DesktopRfbFixture(); await fixture.install(page);
  const frame = await open(page); await connect(frame);
  await frame.evaluate(() => window.kodexDesktop!.paste("café\nline 2"));
  await expect.poll(() => fixture.connections[0].clipboard).toEqual(["café\nline 2"]);
  await expect.poll(() => fixture.connections[0].keys).toEqual([
    { down: true, keysym: 0xffeb }, { down: true, keysym: 118 },
    { down: false, keysym: 118 }, { down: false, keysym: 0xffeb },
  ]);
  const messages = fixture.connections[0].messages;
  expect(messages.indexOf(6)).toBeLessThan(messages.indexOf(4));
  for (const text of ["Unicode 👋", ""]) {
    const error = await frame.evaluate(async (text) => {
      try { await window.kodexDesktop!.paste(text); return ""; } catch (error) { return (error as Error).message; }
    }, text);
    expect(error).toMatch(text ? /Unicode/ : /empty/);
  }
  expect(fixture.connections[0].clipboard).toHaveLength(1);
  expect(fixture.connections[0].keys).toHaveLength(4);
});

for (const [code, failure, retryable] of [[4400, "authentication", false], [4500, "timeout", true]] as const) {
  test(`classifies gateway close ${code} and does not create its own retry`, async ({ page }) => {
    const fixture = new DesktopRfbFixture(); await fixture.install(page);
    const frame = await open(page); await connect(frame);
    fixture.sockets[0].close({ code, reason: JSON.stringify(failure) });
    await expect.poll(() => status(frame)).toMatchObject({ status: "disconnected", failure, retryable });
    expect(fixture.connections).toHaveLength(1);
  });
}

test("keyboard forwards text and releases focus when hidden", async ({ page }) => {
  const fixture = new DesktopRfbFixture(); await fixture.install(page);
  const frame = await open(page); await connect(frame);
  await frame.evaluate(() => window.kodexDesktop!.setKeyboard(true));
  await expect(frame.getByRole("textbox", { name: "Remote desktop keyboard" })).toBeFocused();
  await expect.poll(() => status(frame)).toMatchObject({ keyboardOpen: true });
  await page.keyboard.type("hello");
  await expect.poll(() => fixture.connections[0].keys.filter((key) => key.down).map((key) => key.keysym)).toEqual([104, 101, 108, 108, 111]);
  await frame.evaluate(() => window.kodexDesktop!.setActive(false));
  await expect.poll(() => status(frame)).toMatchObject({ keyboardOpen: false });
  await frame.evaluate(() => window.kodexDesktop!.setKeyboard(true));
  await expect.poll(() => status(frame)).toMatchObject({ keyboardOpen: false });
});


test("extended Unicode paste waits for Provide before sending Command-V", async ({ page }) => {
  const fixture = new DesktopRfbFixture(true); await fixture.install(page);
  const frame = await open(page); await connect(frame);
  // Start without awaiting; the fake Mac deliberately withholds its Request.
  await frame.evaluate(() => {
    (window as Window & { pasteResult?: string }).pasteResult = undefined;
    void window.kodexDesktop!.paste("Unicode 👋\nline 2").then(
      () => { (window as Window & { pasteResult?: string }).pasteResult = "ok"; },
      (error: Error) => { (window as Window & { pasteResult?: string }).pasteResult = error.message; },
    );
  });
  await expect.poll(() => fixture.connections[0].messages.filter((type) => type === 6).length).toBe(2);
  expect(fixture.connections[0].keys).toEqual([]);
  fixture.requestClipboard();
  await expect.poll(() => fixture.connections[0].clipboard).toEqual(["Unicode 👋\r\nline 2"]);
  await expect.poll(() => fixture.connections[0].keys.length).toBe(4);
  expect(await frame.evaluate(() => (window as Window & { pasteResult?: string }).pasteResult)).toBe("ok");
});

test("disconnect during an extended clipboard wait never sends the paste shortcut", async ({ page }) => {
  const fixture = new DesktopRfbFixture(true); await fixture.install(page);
  const frame = await open(page); await connect(frame);
  await frame.evaluate(() => {
    void window.kodexDesktop!.paste("Unicode 👋").catch((error: Error) => {
      (window as Window & { pasteError?: string }).pasteError = error.message;
    });
  });
  await expect.poll(() => fixture.connections[0].messages.filter((type) => type === 6).length).toBe(2);
  await frame.evaluate(() => window.kodexDesktop!.disconnect());
  await expect.poll(() => frame.evaluate(() => (window as Window & { pasteError?: string }).pasteError)).toMatch(/disconnected/);
  expect(fixture.connections[0].keys).toEqual([]);
});


test("virtual keyboard fallback handles composition, emoji replacement and deletion as code points", async ({ page }) => {
  const fixture = new DesktopRfbFixture(); await fixture.install(page);
  const frame = await open(page); await connect(frame);
  await frame.evaluate(() => {
    window.kodexDesktop!.setKeyboard(true);
    const input = document.getElementById("keyboard") as HTMLTextAreaElement;
    const base = input.value;
    input.value = base + "👋";
    input.dispatchEvent(new InputEvent("input", { isComposing: true }));
  });
  expect(fixture.connections[0].keys).toEqual([]);
  await frame.evaluate(() => document.getElementById("keyboard")!.dispatchEvent(new InputEvent("input", { isComposing: false })));
  await expect.poll(() => fixture.connections[0].keys.filter((key) => key.down).map((key) => key.keysym)).toEqual([0x101f44b]);
  await frame.evaluate(() => {
    const input = document.getElementById("keyboard") as HTMLTextAreaElement;
    input.value = input.value.slice(0, -2) + "😀";
    input.dispatchEvent(new InputEvent("input"));
    input.value = input.value.slice(0, -2);
    input.dispatchEvent(new InputEvent("input"));
  });
  await expect.poll(() => fixture.connections[0].keys.filter((key) => key.down).map((key) => key.keysym)).toEqual([0x101f44b, 0xff08, 0x101f600, 0xff08]);
});

test("a persisted pagehide can reconnect with its virtual keyboard intact", async ({ page }) => {
  const fixture = new DesktopRfbFixture(); await fixture.install(page);
  const frame = await open(page); await connect(frame);
  await frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect.poll(() => fixture.connections[0].closed).toBe(true);
  await frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await connect(frame);
  await frame.evaluate(() => window.kodexDesktop!.setKeyboard(true));
  await page.keyboard.type("resume");
  await expect.poll(() => fixture.connections[1].keys.filter((key) => key.down).map((key) => key.keysym)).toEqual([114, 101, 115, 117, 109, 101]);
});

test("history restoration preserves a permanent authentication failure", async ({ page }) => {
  const fixture = new DesktopRfbFixture(); await fixture.install(page);
  const frame = await open(page); await connect(frame);
  fixture.sockets[0].close({ code: 4400, reason: JSON.stringify("authentication") });
  await expect.poll(() => status(frame)).toMatchObject({ failure: "authentication", retryable: false });
  await frame.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  expect(await status(frame)).toMatchObject({ status: "disconnected", failure: "authentication", retryable: false });
});


test("rapid Reconnect waits for the closing socket, and cancellation cannot revive it", async ({ page }) => {
  const fixture = new DesktopRfbFixture(); await fixture.install(page);
  const frame = await open(page); await connect(frame);
  fixture.pause();
  await frame.evaluate(() => { window.kodexDesktop!.connect(); window.kodexDesktop!.connect(); });
  await page.waitForTimeout(100); // Deliberately withhold the close handshake.
  expect(fixture.connections).toHaveLength(1);
  fixture.resume();
  await expect.poll(() => fixture.connections.length).toBe(2);
  await expect.poll(async () => (await status(frame)).status).toBe("connected");
  expect(fixture.connections[0].closed).toBe(true);
  fixture.pause(1);
  await frame.evaluate(() => { window.kodexDesktop!.connect(); window.kodexDesktop!.disconnect(); });
  fixture.resume(1);
  await expect.poll(() => fixture.connections[1].closed).toBe(true);
  await page.waitForTimeout(100);
  expect(fixture.connections).toHaveLength(2);
});


test("hiding during clipboard negotiation cancels the text and shortcut without closing", async ({ page }) => {
  const fixture = new DesktopRfbFixture(true); await fixture.install(page);
  const frame = await open(page); await connect(frame);
  await frame.evaluate(() => {
    void window.kodexDesktop!.paste("Unicode 👋").catch((error: Error) => {
      (window as Window & { pasteError?: string }).pasteError = error.message;
    });
  });
  await expect.poll(() => fixture.connections[0].messages.filter((type) => type === 6).length).toBe(2);
  await frame.evaluate(() => window.kodexDesktop!.setActive(false));
  fixture.requestClipboard();
  await expect.poll(() => frame.evaluate(() => (window as Window & { pasteError?: string }).pasteError)).toMatch(/hidden|cancel/i);
  expect(fixture.connections[0].keys).toEqual([]);
  expect(fixture.connections[0].clipboard).toEqual([]);
  expect(fixture.connections[0].closed).toBe(false);
});
