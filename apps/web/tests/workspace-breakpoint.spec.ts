import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const hasTouch of [false, true]) {
  test.describe(hasTouch ? "touch available" : "fine pointer", () => {
    test.use({ viewport: { width: 900, height: 844 }, hasTouch });
    test("workspace switches at 768px and preserves editing across the boundary", async ({ context }, testInfo) => {
      const fixture = await nativeSettingsFixture(context);
      try {
        const page = await fixture.page("breakpoint");
        const header = page.locator(".kodex-workspace-single-pane-header");
        const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
        const pane = page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
        const textarea = pane.getByRole("textbox", { name: "Message composer", exact: true });
        await expect(textarea).toBeEnabled();
        await expect(header).toBeHidden();
        await expect(sidebar).toBeVisible();
        await textarea.fill("Keep this draft through workspace resize");
        await textarea.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 9));
        const original = await textarea.elementHandle();
        for (const width of [900, 769, 768, 769]) {
          await page.setViewportSize({ width, height: 844 });
          if (width <= 768) {
            await expect(header).toBeVisible();
            await expect(sidebar).toBeHidden();
          } else {
            await expect(header).toBeHidden();
            await expect(sidebar).toBeVisible();
            expect((await pane.boundingBox())!.width).toBeGreaterThan(300);
          }
          await expect.poll(async () => {
            const bounds = (await pane.boundingBox())!;
            return bounds.x + bounds.width;
          }).toBeLessThanOrEqual(width);
          await expect(textarea).toHaveValue("Keep this draft through workspace resize");
          await expect(textarea).toBeFocused();
          expect(await original!.evaluate(el => el.isConnected && el === document.activeElement)).toBe(true);
          expect(await textarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([5, 9]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await expect(pane.getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(0);
          await page.screenshot({ path: testInfo.outputPath(`workspace-${width}.png`) });
        }
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}
