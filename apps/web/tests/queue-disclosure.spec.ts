import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("queue disclosure preserves focus and actions, with a short-pane default", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.queuedInputs.push(...["First", "Second"].map((text, i) => ({
        id: `q-${i}`, threadId: "settings-chat", input: [{ type: "text" as const, text }],
        clientUserMessageId: `c-${i}`, attachments: [], canSteer: false,
      })));
      try {
        const page = await fixture.page("disclosure");
        const region = page.getByRole("region", { name: "Queued messages", exact: true });
        await expect(region.getByRole("group", { name: "Queued message", exact: true })).toHaveCount(2);
        const toggle = region.getByRole("button", { name: "Collapse queued messages" });
        if (shape.hasTouch) {
          await expect(toggle).toHaveCSS("opacity", "1");
          const layout = await region.evaluate(element => {
            const region = element.getBoundingClientRect();
            const zone = element.querySelector(".kodex-queue-collapse-zone")!.getBoundingClientRect();
            const button = element.querySelector(".kodex-queue-collapse")!.getBoundingClientRect();
            const first = element.querySelector(".kodex-queue-row")!.getBoundingClientRect();
            return {
              buttonBottom: button.bottom,
              buttonHeight: button.height,
              firstOffset: first.top - region.top,
              firstTop: first.top,
              regionWidth: region.width,
              zoneCenterX: zone.left + zone.width / 2,
              zoneWidth: zone.width,
            };
          });
          expect(layout.buttonHeight).toBeGreaterThanOrEqual(44);
          expect(layout.zoneWidth).toBeLessThan(layout.regionWidth / 2);
          expect(layout.firstOffset).toBeLessThan(20);
          const touchOverlap = layout.buttonBottom - layout.firstTop;
          expect(touchOverlap).toBeGreaterThan(0);
          expect(touchOverlap).toBeLessThanOrEqual(16);
          expect(await page.evaluate(({ x, y }) =>
            document.elementFromPoint(x, y)?.closest("button")?.getAttribute("aria-label"), {
              x: layout.zoneCenterX,
              y: layout.firstTop + Math.min(4, touchOverlap / 2),
            })).toBe("Collapse queued messages");

          const preview = region.getByRole("button", { name: "Modify queued message: First", exact: true });
          const previewBox = await preview.boundingBox();
          expect(previewBox).not.toBeNull();
          await page.touchscreen.tap(
            previewBox!.x + previewBox!.width / 2,
            previewBox!.y + Math.min(previewBox!.height - 8, touchOverlap + 8),
          );
          const editor = page.getByRole("dialog", { name: "Edit queued message", exact: true });
          await expect(editor).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(editor).not.toBeVisible();
        } else {
          await page.mouse.move(0, 0);
          await expect(toggle).toHaveCSS("opacity", "0");
          await toggle.hover();
          await expect(toggle).toHaveCSS("opacity", "1");
        }
        await page.screenshot({ path: test.info().outputPath("expanded-queue.png"), animations: "disabled" });
        await page.setViewportSize({ width: shape.width, height: 540 });
        const summary = region.getByRole("button", { name: "2 queued messages" });
        await expect(summary).toBeVisible();
        await summary.focus();
        await page.keyboard.press("Enter");
        await expect(toggle).toBeFocused();
        await expect(region.getByRole("button", { name: "Edit", exact: true })).toHaveCount(2);
        await page.keyboard.press("Enter");
        await expect(summary).toBeFocused();
        await expect(region.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
        await page.screenshot({ path: test.info().outputPath("collapsed-queue.png") });
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}
