import { expect, test } from "@playwright/test";
import { nativeProjectsFixture } from "./native-projects.fixture";
import { DesktopRfbFixture } from "./desktop-rfb.fixture";
import { openDesktop, sidebar } from "./desktop-pane.fixture";

for (const shape of [
  { name: "wide touch", touch: true },
  { name: "hybrid fine hover and touch", touch: false },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: 1600, height: 900 }, hasTouch: shape.touch });
    test("independent pane fit, adjacent draft focus, keyboard, resize and actual docking", async ({ context }) => {
      if (!shape.touch) await context.addInitScript(() => Object.defineProperty(navigator, "maxTouchPoints", { get: () => 1 }));
      await context.addInitScript(() => {
        if (window !== window.top) return;
        localStorage.setItem("kodex.instance.native-project-fixture:kodex.workspace.panes.v1", JSON.stringify({
          schemaVersion: 1, activePaneId: "history-pane", dockviewLayout: null,
          panes: [{ id: "history-pane", kind: "thread", target: { mode: "existing", threadId: "history" } }],
        }));
      });
      const app = await nativeProjectsFixture(context, { desktopEnabled: true });
      const remote = new DesktopRfbFixture(); await remote.install(context);
      try {
        const page = await app.page("layout", "/threads/history");
        if (!shape.touch) expect(await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches && navigator.maxTouchPoints > 0)).toBe(true);
        const composer = page.locator(".kodex-thread-pane-existing").getByRole("textbox", { name: "Message composer", exact: true });
        await composer.fill("Keep this local draft");
        const frame = await openDesktop(page);
        await frame.locator("#screen canvas").evaluate((canvas) => { (canvas.ownerDocument.defaultView as Window & { identity?: string }).identity = "retained"; });
        const groups = page.locator(".dv-groupview:visible");
        await expect(groups).toHaveCount(2);
        const boxes = (await groups.evaluateAll((elements) => elements.map((el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }))).sort((a, b) => a.x - b.x);
        const sashX = (boxes[0].x + boxes[0].width + boxes[1].x) / 2;
        await page.mouse.move(sashX, boxes[0].y + 150);
        await page.mouse.down();
        await page.mouse.move(boxes[1].x + boxes[1].width - 360, boxes[0].y + 150, { steps: 12 });
        await page.mouse.up();
        await expect(page.locator(".kodex-desktop-pane")).toHaveAttribute("data-pane-width", "compact");
        await expect(page.locator(".kodex-thread-pane-existing")).toHaveAttribute("data-pane-width", "regular");
        await expect(composer).toHaveValue("Keep this local draft");
        await frame.locator("#screen canvas").click();
        await page.keyboard.press("Escape");
        await expect.poll(() => remote.connections[0].keys).toContainEqual({ down: true, keysym: 0xff1b });
        const keys = remote.connections[0].keys.length;
        await composer.click();
        await page.keyboard.press("End"); await page.keyboard.type(" still here");
        await expect(composer).toHaveValue("Keep this local draft still here");
        expect(remote.connections[0].keys).toHaveLength(keys);
        if (shape.touch) await page.getByRole("button", { name: "Show remote keyboard" }).tap();
        else await page.getByRole("button", { name: "Show remote keyboard" }).click();
        await expect(frame.getByRole("textbox", { name: "Remote desktop keyboard" })).toBeFocused();
        await page.getByRole("button", { name: "Hide remote keyboard" }).click();
        await page.setViewportSize({ width: 1000, height: 680 });
        await page.setViewportSize({ width: 1600, height: 900 });
        expect(await frame.locator("#screen canvas").evaluate((canvas) => (canvas.ownerDocument.defaultView as Window & { identity?: string }).identity)).toBe("retained");
        expect(remote.connections).toHaveLength(1);
        await expect(composer).toHaveValue("Keep this local draft still here");
        // Exercise actual Dockview relocation: its retained renderer keeps the
        // same iframe document and socket in bundled Chromium.
        await expect(page.locator(".kodex-workspace-shell")).not.toHaveAttribute("data-single-pane", "true");
        const source = (await page.locator(".dv-tab").filter({ hasText: /^Desktop$/ }).boundingBox())!;
        const target = (await page.locator(".dv-tab").filter({ hasText: "History chat" }).boundingBox())!;
        await page.mouse.move(source.x + 30, source.y + source.height / 2);
        await page.mouse.down();
        await page.mouse.move(source.x + 45, source.y + source.height / 2, { steps: 5 });
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await page.mouse.move(target.x + 30, target.y + target.height / 2, { steps: 15 });
        await page.mouse.up();
        await expect(groups).toHaveCount(1);
        await expect(frame.locator("#screen canvas")).toBeVisible();
        await expect.poll(() => remote.connections.filter((connection) => !connection.closed).length).toBe(1);
        expect(remote.connections).toHaveLength(1);
        const retained = await frame.locator("#screen canvas").evaluate((canvas) => (canvas.ownerDocument.defaultView as Window & { identity?: string }).identity === "retained");
        expect(retained).toBe(true);
        test.info().annotations.push({ type: "docking", description: `document retained=${retained}; total connections=${remote.connections.length}` });
        await frame.locator("#screen canvas").click(); await page.keyboard.press("Escape");
        await expect.poll(() => remote.connections.at(-1)!.keys).toContainEqual({ down: true, keysym: 0xff1b });
        await page.screenshot({ path: test.info().outputPath("desktop-docked.png") });
        expect(remote.errors).toEqual([]); expect(app.errors).toEqual([]); expect(app.unexpected).toEqual([]);
      } finally { await app.close(); }
    });
  });
}

test.describe("keyboard viewport", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("software keyboard keeps the fit viewport and header controls reachable without reconnecting", async ({ context }) => {
    const app = await nativeProjectsFixture(context, { desktopEnabled: true });
    const remote = new DesktopRfbFixture(); await remote.install(context);
    await context.addInitScript(() => {
      const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number };
      Object.assign(viewport, { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    });
    try {
      const page = await app.page("viewport", "/threads/history");
      const frame = await openDesktop(page);
      await page.getByRole("button", { name: "Show remote keyboard" }).tap();
      await expect(frame.getByRole("textbox", { name: "Remote desktop keyboard" })).toBeFocused();
      await page.evaluate(() => { Object.assign(visualViewport!, { height: 544 }); visualViewport!.dispatchEvent(new Event("resize")); });
      await expect.poll(async () => { const b = (await page.getByTitle("Mac desktop viewer", { exact: true }).boundingBox())!; return Math.round(b.y + b.height); }).toBeLessThanOrEqual(544);
      for (const name of ["Hide remote keyboard", "Paste into Mac", "Reconnect desktop", "Desktop touch settings"]) {
        const b = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
        expect(b.y).toBeGreaterThanOrEqual(0); expect(b.y + b.height).toBeLessThan(544);
      }
      await page.screenshot({ path: test.info().outputPath("desktop-keyboard-viewport.png"), clip: { x: 0, y: 0, width: 390, height: 544 } });
      await page.evaluate(() => { Object.assign(visualViewport!, { height: 844 }); visualViewport!.dispatchEvent(new Event("resize")); });
      await page.getByRole("button", { name: "Hide remote keyboard" }).tap();
      await expect.poll(async () => { const b = (await page.getByTitle("Mac desktop viewer", { exact: true }).boundingBox())!; return Math.round(b.y + b.height); }).toBeGreaterThan(700);
      expect(remote.connections).toHaveLength(1);
      expect(remote.connections[0].messages).not.toContain(251);
      expect(app.errors).toEqual([]);
    } finally { await app.close(); }
  });
});

test("configured restoration normalizes duplicate Desktop panes to the active instance", async ({ context }) => {
  const app = await nativeProjectsFixture(context, { desktopEnabled: true });
  const remote = new DesktopRfbFixture(); await remote.install(context);
  try {
    const page = await app.page("restore", "/threads/history");
    await page.evaluate(() => localStorage.setItem("kodex.instance.native-project-fixture:kodex.workspace.panes.v1", JSON.stringify({
      schemaVersion: 1, activePaneId: "desktop-b", dockviewLayout: null,
      panes: [{ id: "desktop-a", kind: "desktop", target: {} }, { id: "desktop-b", kind: "desktop", target: {} }],
    })));
    await page.reload();
    await expect(page.getByTitle("Mac desktop viewer", { exact: true })).toHaveCount(1);
    await expect(page.frameLocator('iframe[title="Mac desktop viewer"]').locator("#screen canvas")).toBeVisible();
    await expect.poll(() => remote.connections.length).toBe(1);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("kodex.instance.native-project-fixture:kodex.workspace.panes.v1")!).panes.filter((pane: { kind: string }) => pane.kind === "desktop").map((pane: { id: string }) => pane.id))).toEqual(["desktop-b"]);
    await (await sidebar(page)).getByRole("button", { name: "Desktop", exact: true }).click();
    expect(remote.connections).toHaveLength(1);
  } finally { await app.close(); }
});
