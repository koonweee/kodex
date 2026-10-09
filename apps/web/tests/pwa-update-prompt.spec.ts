import { expect, test, type BrowserContext } from "@playwright/test";
import { KODEX_COLOR_SCHEMES } from "../src/themeRegistry";
import { nativeSettingsFixture } from "./native-settings.fixture";
import { measureTheme } from "./theme-contrast.measure";

async function waitingUpdate(context: BrowserContext) {
  // Exercise the actual notice and subscription with a waiting-worker callback.
  // Real worker installation/acceptance remains covered by native-pwa.spec.ts.
  await context.route("**/src/pwa/registerServiceWorker.ts", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + `\nsetRegisterSWLoaderForTests(async () => options => {
      options.onRegisteredSW('/sw.js', { scope: '/' });
      queueMicrotask(() => options.onNeedRefresh());
      return async () => { window.pwaPromptAccepted = true; };
    });\n` });
  });
}

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("update notice fits one row and leaves the composer usable", async ({ context }, info) => {
      await waitingUpdate(context);
      const fixture = await nativeSettingsFixture(context);
      try {
        const page = await fixture.page("pwa-notice", "/threads/settings-chat");
        await expect(page.getByRole("main", { name: "Thread workspace" })).toBeVisible();
        const notice = page.getByRole("status").filter({ hasText: "Update available" });
        await expect(notice).toBeVisible();
        const label = await notice.getByText("Update available", { exact: true }).boundingBox();
        const update = notice.getByRole("button", { name: "Update", exact: true });
        const action = await update.boundingBox();
        const box = await notice.boundingBox();
        expect(label).not.toBeNull(); expect(action).not.toBeNull(); expect(box).not.toBeNull();
        const dismissBox = await notice.getByRole("button", { name: "Dismiss update notice" }).boundingBox();
        expect(dismissBox).not.toBeNull();
        expect(box!.height).toBeLessThanOrEqual(Math.max(label!.height, action!.height, dismissBox!.height) + 20);
        await expect(notice.getByRole("switch")).toHaveCount(0);
        expect(Math.abs(label!.y + label!.height / 2 - action!.y - action!.height / 2)).toBeLessThan(2);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(shape.width);
        if (shape.hasTouch) expect(action!.height).toBeGreaterThanOrEqual(44);
        const composer = page.locator(".kodex-thread-pane-existing").getByRole("textbox", { name: "Message composer", exact: true });
        if (shape.hasTouch) await composer.tap();
        await composer.fill("Keep my draft while an update waits.");
        await expect(composer).toHaveValue("Keep my draft while an update waits.");
        await page.screenshot({ path: info.outputPath("compact-update-notice.png"), animations: "disabled" });
        if (shape.width < 900) {
          const dismiss = notice.getByRole("button", { name: "Dismiss update notice" });
          if (shape.hasTouch) {
            const target = await dismiss.boundingBox();
            expect(target!.height).toBeGreaterThanOrEqual(44);
            expect(target!.width).toBeGreaterThanOrEqual(44);
            await dismiss.tap();
          } else await dismiss.click();
          await expect(notice).toHaveCount(0);
          expect(await page.evaluate(() => Reflect.get(window, "pwaPromptAccepted"))).not.toBe(true);
          if (shape.hasTouch) {
            const collapse = page.getByRole("button", { name: "Collapse composer" });
            await collapse.tap();
            await expect(collapse).toHaveCount(0);
          }
          await expect(composer).toHaveValue("Keep my draft while an update waits.");
          // Reopening the app offers the still-pending update again.
          await page.reload();
          await expect(notice).toBeVisible();
        }
        if (shape.hasTouch) await update.tap();
        else if (shape.width >= 900) await update.press("Enter");
        else await update.click();
        await expect.poll(() => page.evaluate(() => Reflect.get(window, "pwaPromptAccepted"))).toBe(true);
        expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
      } finally { await fixture.close(); }
    });
  });
}

test("update notice stays readable through every live theme", async ({ context }, info) => {
  await waitingUpdate(context);
  const fixture = await nativeSettingsFixture(context);
  try {
    const page = await fixture.page("pwa-theme", "/__theme");
    const notice = page.getByRole("status").filter({ hasText: "Update available" });
    await expect(notice).toBeVisible();
    for (const theme of KODEX_COLOR_SCHEMES) {
      await page.getByRole("radio", { name: theme.label, exact: true }).evaluate(el => (el as HTMLElement).click());
      await expect(page.locator("html")).toHaveAttribute("data-kodex-color-scheme", theme.id);
      for (const label of [notice.getByText("Update available", { exact: true }), notice.getByRole("button", { name: "Update", exact: true }).getByText("Update", { exact: true })]) {
        const result = await label.evaluate(measureTheme);
        expect(result.samples).toHaveLength(1);
        expect(result.samples[0].ratio, theme.label).toBeGreaterThanOrEqual(4.5);
      }
      await notice.screenshot({ path: info.outputPath(`${theme.id}.png`), animations: "disabled" });
      const button = notice.getByRole("button", { name: "Update", exact: true });
      await button.hover();
      const hover = await button.getByText("Update", { exact: true }).evaluate(measureTheme);
      expect(hover.samples[0].ratio, `${theme.label} hover`).toBeGreaterThanOrEqual(4.5);
      await page.mouse.move(0, 0);
    }
    expect(fixture.errors).toEqual([]); expect(fixture.unexpected).toEqual([]);
  } finally { await fixture.close(); }
});
