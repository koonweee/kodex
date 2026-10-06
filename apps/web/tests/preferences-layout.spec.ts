import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("preferences section names remain fully visible", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      await context.route("**/v1/notifications/status", (route) => route.fulfill({ json: { configured: false, subscriptionsEnabled: false, vapidPublicKey: null } }));
      try {
        const page = await fixture.page("preferences");
        const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
        if (shape.width < 900) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
        await sidebar.getByRole("button", { name: "Account settings", exact: true }).click();
        await page.getByRole("menuitem", { name: "Preferences", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Preferences", exact: true });
        for (const name of ["Appearance", "Execution", "Notifications", "Plugins", "MCP"]) {
          const button = dialog.getByRole("button", { name, exact: true });
          await expect(button).toBeInViewport();
          expect(await button.evaluate((element) => {
            const label = element.querySelector(".mantine-Button-label")!;
            return label.scrollWidth <= label.clientWidth;
          }), `${name} is clipped`).toBe(true);
        }
        await expect(dialog.getByRole("radiogroup", { name: "Appearance mode", exact: true })).toBeVisible();
        const themes = dialog.getByRole("radiogroup", { name: /^(Light|Dark) theme$/ });
        for (const card of await themes.getByRole("radio").all()) {
          const contentFits = await card.evaluate((element) => {
            const cardBounds = element.getBoundingClientRect();
            const visibleContent = element.querySelectorAll(".kodex-scheme-preview, .kodex-scheme-label, .kodex-scheme-swatches");
            return [...visibleContent].every((content) => {
              const bounds = content.getBoundingClientRect();
              return bounds.width > 0 && bounds.height > 0 && bounds.top >= cardBounds.top && bounds.bottom <= cardBounds.bottom && bounds.left >= cardBounds.left && bounds.right <= cardBounds.right;
            });
          });
          expect(contentFits, `${await card.getAttribute("aria-label")} preview, name and swatches must fit within its card`).toBe(true);
        }
        const selected = themes.getByRole("radio", { checked: true });
        await selected.focus();
        await page.keyboard.press("End");
        const last = themes.getByRole("radio").last();
        await expect(last).toBeFocused();
        await expect(last).toBeInViewport();
        expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), "Appearance must not overflow horizontally").toBe(true);
        await page.screenshot({ path: test.info().outputPath("preferences-appearance.png") });
        await dialog.getByRole("button", { name: "Notifications", exact: true }).click();
        await page.screenshot({ path: test.info().outputPath("preferences-notifications.png") });
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
    });
  });
}
