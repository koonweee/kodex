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
        if (shape.hasTouch) await expect(toggle).toHaveCSS("opacity", "1");
        else {
          await page.mouse.move(0, 0);
          await expect(toggle).toHaveCSS("opacity", "0");
          await toggle.hover();
          await expect(toggle).toHaveCSS("opacity", "1");
        }
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
