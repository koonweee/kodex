import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 600 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("model and reasoning submenus fit and keep long catalogs reachable", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
      await context.route("**/v1/models?*", (route) => route.fulfill({ json: {
        models: Array.from({ length: 30 }, (_, index) => ({
          id: index === 0 ? "gpt-5.4" : `model-${index}`, model: index === 0 ? "gpt-5.4" : `model-${index}`,
          displayName: `Model ${index}`, description: "Fixture", defaultReasoningEffort: "medium", isDefault: index === 0,
          hidden: false, inputModalities: ["text"], supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })), rawPayload: {},
        })), rawPayload: {},
      } }));
      try {
        const page = await fixture.page("menus");
        const pane = page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
        const click = async (locator: ReturnType<typeof page.getByRole>) => shape.hasTouch ? locator.tap() : locator.click();
        await click(pane.getByRole("button", { name: "Model: gpt-5.4, medium", exact: true }));
        await expect(page.getByRole("menuitem", { name: "model-29", exact: true })).toHaveCount(0);
        await expect(page.getByRole("menuitemcheckbox", { name: "Fast", exact: true })).toBeVisible();
        await click(page.getByRole("menuitem", { name: "Model", exact: true }));
        const last = page.getByRole("menuitem", { name: "model-29", exact: true });
        await last.scrollIntoViewIfNeeded();
        await expect(last).toBeInViewport();
        const menu = page.getByRole("menu");
        const bounds = await menu.boundingBox();
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(600);
        await page.screenshot({ path: test.info().outputPath("model-submenu.png") });
        await click(last);
        await expect.poll(() => fixture.pending).toEqual([{ model: "model-29" }]);
        fixture.applyNext();
        await click(pane.getByRole("button", { name: "Model: model-29, medium", exact: true }));
        await click(page.getByRole("menuitem", { name: "Reasoning", exact: true }));
        const ultra = page.getByRole("menuitem", { name: "Ultra", exact: true });
        await ultra.scrollIntoViewIfNeeded();
        await expect(ultra).toBeInViewport();
        const reasoningBounds = await page.getByRole("menu").boundingBox();
        expect(reasoningBounds!.y).toBeGreaterThanOrEqual(0);
        expect(reasoningBounds!.y + reasoningBounds!.height).toBeLessThanOrEqual(600);
        await page.screenshot({ path: test.info().outputPath("reasoning-submenu.png") });
        await click(ultra);
        await expect.poll(() => fixture.pending).toEqual([{ effort: "ultra" }]);
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}
