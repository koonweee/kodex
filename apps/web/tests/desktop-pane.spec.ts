import { expect, test, type Page } from "@playwright/test";
import { nativeProjectsFixture } from "./native-projects.fixture";
import { DesktopRfbFixture } from "./desktop-rfb.fixture";

async function sidebar(page: Page) {
  const nav = page.getByRole("navigation", { name: "Workspace", exact: true });
  if (!await nav.isVisible()) await page.getByRole("button", { name: /^(Show sidebar|Projects)$/i }).click();
  await expect(nav).toBeVisible();
  return nav;
}
async function openDesktop(page: Page) {
  await (await sidebar(page)).getByRole("button", { name: "Desktop", exact: true }).click();
  await expect(page.getByTitle("Mac desktop viewer", { exact: true })).toBeVisible();
  const frame = page.frameLocator('iframe[title="Mac desktop viewer"]');
  await expect(frame.locator("#screen canvas")).toBeVisible();
  return frame;
}

for (const shape of [
  { name: "desktop fine pointer", width: 1280, hasTouch: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false },
  { name: "narrow touch", width: 390, hasTouch: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch });
    test("singleton, header controls, hidden connection, and close/reopen", async ({ context }) => {
      const app = await nativeProjectsFixture(context, { desktopEnabled: true });
      try {
        const page = await app.page("desktop", "/threads/history");
        const remote = new DesktopRfbFixture(); await remote.install(page);
        const frame = await openDesktop(page);
        await expect.poll(() => remote.connections[0]?.shared).toBe(1);
        await frame.locator("#screen canvas").evaluate((canvas) => { (canvas.ownerDocument.defaultView as Window & { identity?: string }).identity = "retained"; });
        await openDesktop(page);
        expect(remote.connections).toHaveLength(1);
        await expect(page.getByTitle("Mac desktop viewer", { exact: true })).toHaveCount(1);
        await page.getByRole("button", { name: "Desktop touch settings", exact: true }).click();
        const toggle = page.getByRole("checkbox", { name: "Trackpad mode (touch)" });
        await expect(toggle).toBeChecked();
        await toggle.click();
        if (shape.hasTouch) {
          await page.getByRole("button", { name: "Show remote keyboard" }).tap();
          await expect(frame.getByRole("textbox", { name: "Remote desktop keyboard" })).toBeFocused();
          await page.getByRole("button", { name: "Hide remote keyboard" }).tap();
          await expect(frame.getByRole("textbox", { name: "Remote desktop keyboard" })).not.toBeFocused();
        }
        await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => "explicit paste" } }));
        await page.getByRole("button", { name: "Paste into Mac" }).click();
        await expect.poll(() => remote.connections[0].clipboard).toEqual(["explicit paste"]);
        await page.screenshot({ path: test.info().outputPath("desktop-pane.png") });
        // Narrow workspace maximizes one tab without remounting its neighbors.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "Switch workspace pane" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "History chat", exact: true }).click();
        await expect(page.getByTitle("Mac desktop viewer", { exact: true })).not.toBeVisible();
        expect(remote.connections[0].closed).toBe(false);
        await openDesktop(page);
        expect(remote.connections).toHaveLength(1);
        expect(await frame.locator("#screen canvas").evaluate((canvas) => (canvas.ownerDocument.defaultView as Window & { identity?: string }).identity)).toBe("retained");
        await page.getByRole("button", { name: "Desktop touch settings", exact: true }).click();
        await expect(page.getByRole("checkbox", { name: "Trackpad mode (touch)" })).not.toBeChecked();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Switch workspace pane" }).click();
        await page.getByRole("button", { name: "Close pane Desktop", exact: true }).click();
        await expect.poll(() => remote.connections[0].closed).toBe(true);
        await page.keyboard.press("Escape");
        await openDesktop(page);
        await expect.poll(() => remote.connections.length).toBe(2);
        expect(remote.errors).toEqual([]);
        expect(app.unexpected).toEqual([]);
        expect(app.errors).toEqual([]);
      } finally { await app.close(); }
    });
  });
}

test("unconfigured gateways hide Desktop and restore an unavailable pane without connecting", async ({ context }) => {
  const app = await nativeProjectsFixture(context);
  try {
    const page = await app.page("unconfigured", "/threads/history");
    await expect((await sidebar(page)).getByRole("button", { name: "Desktop", exact: true })).toHaveCount(0);
    await page.evaluate(() => localStorage.setItem("kodex.instance.native-project-fixture:kodex.workspace.panes.v1", JSON.stringify({
      schemaVersion: 1, activePaneId: "desktop", dockviewLayout: null,
      panes: [{ id: "desktop", kind: "desktop", target: {} }],
    })));
    await page.reload();
    await expect(page.getByText("Desktop is unavailable until a VNC password is configured on the Mac gateway.")).toBeVisible();
    await expect(page.getByTitle("Mac desktop viewer", { exact: true })).toHaveCount(0);
  } finally { await app.close(); }
});


test("Desktop stays connected while project settings hide the workspace", async ({ context }) => {
  const app = await nativeProjectsFixture(context, { desktopEnabled: true });
  try {
    const page = await app.page("desktop", "/threads/history");
    const remote = new DesktopRfbFixture(); await remote.install(page);
    await openDesktop(page);
    const nav = await sidebar(page);
    const project = nav.getByRole("group", { name: "Alpha", exact: true });
    await project.hover();
    await project.getByRole("button", { name: "Project settings for Alpha", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Alpha", exact: true })).toBeVisible();
    await page.waitForTimeout(100);
    expect(remote.connections[0].closed).toBe(false);
    await openDesktop(page);
    expect(remote.connections).toHaveLength(1);
  } finally { await app.close(); }
});


test("same-user tabs connect independently and closing one leaves the other controllable", async ({ context }) => {
  const app = await nativeProjectsFixture(context, { desktopEnabled: true });
  const remote = new DesktopRfbFixture(); await remote.install(context);
  try {
    const first = await app.page("first", "/threads/history");
    await openDesktop(first);
    const second = await app.page("second", "/threads/history");
    const secondFrame = await openDesktop(second);
    await expect.poll(() => remote.connections.length).toBe(2);
    expect(remote.connections.map((connection) => connection.shared)).toEqual([1, 1]);
    await first.setViewportSize({ width: 390, height: 844 });
    await first.getByRole("button", { name: "Switch workspace pane" }).click();
    await first.getByRole("button", { name: "Close pane Desktop", exact: true }).click();
    await expect.poll(() => remote.connections[0].closed).toBe(true);
    expect(remote.connections[1].closed).toBe(false);
    await secondFrame.locator("#screen canvas").click();
    await second.keyboard.press("Escape");
    await expect.poll(() => remote.connections[1].keys).toContainEqual({ down: true, keysym: 0xff1b });
    expect(app.errors).toEqual([]);
  } finally { await app.close(); }
});

test("temporary failure retries, permanent failure stops, and Reconnect starts a fresh attempt", async ({ context }) => {
  const app = await nativeProjectsFixture(context, { desktopEnabled: true });
  const remote = new DesktopRfbFixture(); await remote.install(context);
  try {
    const page = await app.page("recovery", "/threads/history");
    await openDesktop(page);
    remote.sockets[0].close({ code: 4500, reason: JSON.stringify("timeout") });
    await expect(page.getByText("Retrying automatically…")).toBeVisible();
    await expect.poll(() => remote.connections.length).toBe(2);
    await expect(page.getByText("Retrying automatically…")).toHaveCount(0);
    remote.sockets[1].close({ code: 4400, reason: JSON.stringify("authentication") });
    await expect(page.getByText("The Mac rejected the gateway’s VNC password.")).toBeVisible();
    await page.waitForTimeout(1300); // Exceed the first automatic backoff.
    expect(remote.connections).toHaveLength(2);
    await page.getByRole("button", { name: "Reconnect desktop", exact: true }).click();
    await expect.poll(() => remote.connections.length).toBe(3);
    await expect(page.getByText("The Mac rejected the gateway’s VNC password.")).toHaveCount(0);
  } finally { await app.close(); }
});
