import { readFileSync } from "node:fs";
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

// Chromium cannot emulate standalone chrome or hardware insets. Exercise the
// production standalone stylesheet with only those environment facts replaced.
for (const shape of [
  { name: "iPad mini", width: 744, height: 1133, inset: 0 },
  { name: "iPhone 14 Pro Max", width: 430, height: 932, inset: 59 },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: shape.height }, hasTouch: true, isMobile: true });
    test("standalone header leaves navigation and fullscreen editing reachable", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      try {
        const page = await fixture.page("standalone-header");
        const css = readFileSync(new URL("../src/styles/pwa.css", import.meta.url), "utf8")
          .replaceAll("(display-mode: standalone)", "(min-width: 0px)")
          .replaceAll("env(safe-area-inset-top, 0px)", `${shape.inset}px`);
        await page.addStyleTag({ content: css });
        const surface = page.locator(".kodex-pwa-safe-area");
        const bounds = (await surface.boundingBox())!;
        expect(bounds.x).toBe(0);
        expect(bounds.y).toBe(0);
        expect(bounds.width).toBe(shape.width);
        expect(bounds.height).toBeGreaterThan(10);
        expect(bounds.height).toBeGreaterThanOrEqual(shape.inset);
        const header = page.locator(".kodex-workspace-single-pane-header");
        await expect(surface).toHaveCSS("background-color", await header.evaluate(el => getComputedStyle(el).backgroundColor));
        const navigation = page.getByRole("button", { name: "Show sidebar", exact: true });
        expect((await navigation.boundingBox())!.y).toBeGreaterThanOrEqual(bounds.height);
        await navigation.tap();
        const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
        await expect(sidebar).toBeVisible();
        await expect(surface).toHaveCSS("background-color", await sidebar.evaluate(el => getComputedStyle(el).backgroundColor));
        for (const button of await sidebar.getByRole("button").all()) {
          if (await button.isVisible()) expect((await button.boundingBox())!.y).toBeGreaterThanOrEqual(bounds.height);
        }
        await page.getByRole("button", { name: "Show thread", exact: true }).tap();
        const textarea = page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]').getByLabel("Message composer", { exact: true });
        await textarea.tap();
        const dialog = page.getByRole("dialog", { name: "Compose", exact: true });
        await expect(dialog).toBeVisible();
        await expect(surface).toHaveCSS("background-color", await dialog.evaluate(el => getComputedStyle(el).backgroundColor));
        expect((await dialog.boundingBox())!.y).toBeGreaterThanOrEqual(bounds.height);
        await textarea.fill("Device header check");
        await expect(textarea).toBeFocused();
        await expect(textarea).toHaveValue("Device header check");
        await page.screenshot({ path: test.info().outputPath("standalone-composer.png") });
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
    });
  });
}
