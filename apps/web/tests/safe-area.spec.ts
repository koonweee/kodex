import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const hasTouch of [false, true]) {
  test.describe(hasTouch ? "touch safe area" : "fine pointer safe area", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch, isMobile: hasTouch });
    test("sidebar controls stay below the top inset", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      try {
        const page = await fixture.page("safe-area");
        // Desktop engines have zero hardware insets; inject a representative notch.
        await page.addStyleTag({ content: ".kodex-shell { --kodex-mobile-safe-area-top: 59px !important; }" });
        await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
        const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
        await expect(sidebar).toBeVisible();
        const buttons = sidebar.getByRole("button");
        for (const button of await buttons.all()) {
          if (!await button.isVisible()) continue;
          const bounds = await button.boundingBox();
          expect(bounds!.y, await button.getAttribute("aria-label") ?? "sidebar button").toBeGreaterThanOrEqual(59);
        }
        await page.screenshot({ path: test.info().outputPath("sidebar-safe-area.png") });
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
    });
  });
}
