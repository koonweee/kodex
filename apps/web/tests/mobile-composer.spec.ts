import { expect, test } from "@playwright/test";

import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });

    test("composer keeps native focus and reachable actions while changing viewport", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.detail.thread.gitInfo = { branch: "main", originUrl: null, sha: null };
      try {
        const page = await fixture.page("composer");
        const pane = page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
        const textarea = pane.getByLabel("Message composer", { exact: true });
        await expect(textarea).toBeEnabled();
        await expect(pane.getByRole("toolbar", { name: /composer context|draft thread toolbar/i })).toHaveCount(0);
        await expect(pane.getByText("main", { exact: true })).toHaveCount(0);
        const originalTextarea = await textarea.elementHandle();
        if (shape.hasTouch) await textarea.tap();
        else await textarea.click();
        await expect(textarea).toBeFocused();
        expect(await originalTextarea!.evaluate((element) => element.isConnected && element === document.activeElement)).toBe(true);
        const dialog = pane.getByRole("dialog", { name: "Compose", exact: true });
        await expect(dialog).toHaveCount(shape.hasTouch ? 1 : 0);
        if (shape.hasTouch) {
          const dialogBounds = await dialog.boundingBox();
          expect(dialogBounds!.y).toBeLessThan(64);
          expect(dialogBounds!.height).toBeGreaterThan(750);
        }
        await textarea.fill("A draft that survives viewport changes");
        await page.screenshot({ path: test.info().outputPath("composer-full-height.png") });

        await page.setViewportSize({ width: shape.width, height: 420 });
        await expect(textarea).toHaveValue("A draft that survives viewport changes");
        await expect(textarea).toBeFocused();
        await expect(textarea).toBeInViewport();
        const send = pane.getByRole("button", { name: "Send message", exact: true });
        await expect(send).toBeInViewport();
        const bounds = await send.boundingBox();
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(420);
        await page.screenshot({ path: test.info().outputPath("composer-reduced-height.png") });
        if (shape.hasTouch) {
          const longDraft = Array.from({ length: 80 }, (_, i) => `Draft line ${i}`).join("\n");
          await textarea.fill(longDraft);
          const wrapper = pane.locator(".kodex-mobile-composer-textarea");
          await expect.poll(() => wrapper.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
          await expect.poll(() => textarea.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
          const before = await send.boundingBox();
          await textarea.evaluate(el => { el.scrollTop = el.scrollHeight; });
          await expect.poll(() => textarea.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
          expect(await send.boundingBox()).toEqual(before);
          await expect(pane.getByRole("button", { name: "Collapse composer", exact: true })).toBeInViewport();
          await textarea.fill("A draft that survives viewport changes");
        }
        if (shape.hasTouch) {
          await pane.getByRole("button", { name: "Collapse composer", exact: true }).tap();
          await expect(pane.getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(0);
          expect(await originalTextarea!.evaluate((element) => element.isConnected)).toBe(true);
          await expect(textarea).toHaveValue("A draft that survives viewport changes");
        }
      } finally {
        await fixture.close();
      }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}
