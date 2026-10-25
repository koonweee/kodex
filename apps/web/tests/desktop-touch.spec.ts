import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { nativeProjectsFixture } from "./native-projects.fixture";
import { DesktopRfbFixture } from "./desktop-rfb.fixture";
import { openDesktop } from "./desktop-pane.fixture";

type Point = { x: number; y: number; id: number };
async function touch(session: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", touchPoints: Point[]) {
  await session.send("Input.dispatchTouchEvent", { type, touchPoints });
}
async function trackpad(page: Page, enabled: boolean) {
  await page.getByRole("button", { name: "Desktop touch settings" }).click();
  const toggle = page.getByRole("checkbox", { name: "Trackpad mode (touch)" });
  if (enabled) await expect(toggle).not.toBeChecked(); else await expect(toggle).toBeChecked();
  await toggle.click(); // The controlled popover unmounts immediately on change.
}

test.describe("real browser touch events", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("Pal relative movement, short swipe, clicks, scroll, selection, local zoom/pan and direct touch", async ({ context }) => {
    const app = await nativeProjectsFixture(context, { desktopEnabled: true });
    const remote = new DesktopRfbFixture(); await remote.install(context);
    try {
      const page = await app.page("touch", "/threads/history");
      const frame = await openDesktop(page);
      const canvas = frame.locator("#screen canvas");
      const box = (await canvas.boundingBox())!;
      const session = await context.newCDPSession(page);
      const point = (x: number, y: number, id = 1) => ({ x: box.x + x, y: box.y + y, id });
      const center = point(box.width / 2, box.height / 2);
      const connection = remote.connections[0];
      const reset = () => { connection.pointers.length = 0; connection.pointerPositions.length = 0; };
      // A swipe below the gesture recognizer's drag threshold still moves the
      // relative cursor immediately, and lifting must never create a tap.
      await touch(session, "touchStart", [point(30, 30)]);
      await touch(session, "touchMove", [point(38, 30)]);
      await touch(session, "touchMove", [point(42, 32)]);
      await touch(session, "touchEnd", []);
      await expect.poll(() => connection.pointerPositions.at(-1)?.x ?? 0).toBeGreaterThan(160);
      expect(connection.pointers.every((mask) => mask === 0)).toBe(true);
      const cursor = connection.pointerPositions.at(-1)!;
      reset();
      await touch(session, "touchStart", [point(25, 25)]);
      await touch(session, "touchEnd", []);
      await expect.poll(() => connection.pointers).toContain(1);
      expect(connection.pointerPositions.find((pointer) => pointer.mask === 1)).toEqual({ ...cursor, mask: 1 });
      reset();
      const pair = [point(box.width / 2 - 25, box.height / 2, 1), point(box.width / 2 + 25, box.height / 2, 2)];
      await touch(session, "touchStart", pair);
      await touch(session, "touchEnd", []);
      await expect.poll(() => connection.pointers).toContain(4);
      expect(connection.pointers.at(-1)).toBe(0);
      reset();
      await touch(session, "touchStart", pair);
      await touch(session, "touchMove", pair.map((p) => ({ ...p, y: p.y + 50 })));
      await touch(session, "touchEnd", []);
      await expect.poll(() => connection.pointers).toContain(8);
      expect(connection.pointers.at(-1)).toBe(0);
      reset();
      await touch(session, "touchStart", pair);
      await touch(session, "touchMove", [point(box.width / 2 - 60, box.height / 2, 1), point(box.width / 2 + 60, box.height / 2, 2)]);
      await touch(session, "touchEnd", []);
      await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(box.width * 1.5);
      const zoomed = (await canvas.boundingBox())!;
      await touch(session, "touchStart", pair);
      await touch(session, "touchMove", pair.map((p) => ({ ...p, x: p.x + 20 })));
      await touch(session, "touchEnd", []);
      await expect.poll(async () => (await canvas.boundingBox())!.x).toBeGreaterThan(zoomed.x + 10);
      expect((await canvas.boundingBox())!.width).toBeCloseTo(zoomed.width, 0);
      expect(connection.pointers).toEqual([]);
      expect(connection.keys).toEqual([]);
      expect(connection.messages).not.toContain(251); // Never SetDesktopSize.
      expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
      // The exposed setting switches to stock absolute direct-touch behavior.
      await trackpad(page, false);
      await expect.poll(async () => (await canvas.boundingBox())!.width).toBeCloseTo(box.width, 0);
      reset();
      await touch(session, "touchStart", [point(40, 40)]);
      await touch(session, "touchMove", [point(120, 40)]);
      await touch(session, "touchEnd", []);
      await expect.poll(() => connection.pointers).toContain(1);
      expect(connection.pointers.at(-1)).toBe(0);
      expect(connection.pointerPositions.find((p) => p.mask === 1)!.x).toBeLessThan(160);
      await trackpad(page, true);
      reset();
      // Tap then drag holds selection until the finger lifts.
      await touch(session, "touchStart", [center]);
      await touch(session, "touchEnd", []);
      await touch(session, "touchStart", [center]);
      await touch(session, "touchMove", [{ ...center, x: center.x + 35 }]);
      await expect.poll(() => connection.pointers.at(-1)).toBe(1);
      await touch(session, "touchEnd", []);
      await expect.poll(() => connection.pointers.at(-1)).toBe(0);
      reset();
      // Physical mouse coordinates remain absolute in trackpad mode.
      await page.mouse.click(box.x + 30, box.y + 30);
      await expect.poll(() => connection.pointers).toContain(1);
      const mouse = connection.pointerPositions.find((p) => p.mask === 1)!;
      expect(mouse.x).toBeLessThan(80); expect(mouse.y).toBeLessThan(80);
      expect(remote.errors).toEqual([]); expect(app.errors).toEqual([]);
      await session.detach();
    } finally { await app.close(); }
  });
});
