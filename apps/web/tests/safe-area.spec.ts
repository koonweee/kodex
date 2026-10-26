import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

function standaloneCss(inset: number) {
  return readFileSync(new URL("../src/styles/pwa.css", import.meta.url), "utf8")
    .replaceAll("(display-mode: standalone)", "(min-width: 0px)")
    .replaceAll("env(safe-area-inset-top, 0px)", `${inset}px`);
}

async function expectTopEdgeAboveContent(page: Page) {
  // Temporarily include the decorative surface in hit testing to check stacking.
  expect(await page.locator(".kodex-pwa-safe-area").evaluate((el: HTMLElement) => {
    el.style.pointerEvents = "auto";
    const onTop = document.elementFromPoint(innerWidth / 2, 4) === el;
    el.style.removeProperty("pointer-events");
    return onTop;
  })).toBe(true);
}

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
  { name: "iPad mini portrait", width: 744, height: 1133, inset: 0 },
  { name: "iPad mini landscape", width: 1133, height: 744, inset: 0 },
  { name: "iPhone 14 Pro Max", width: 430, height: 932, inset: 59 },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: shape.height }, hasTouch: true, isMobile: true });
    for (const colorScheme of ["light", "dark"] as const) {
      test(`standalone top edge is painted before React in ${colorScheme} mode`, async ({ page }) => {
        await page.emulateMedia({ colorScheme });
        await page.route("**/src/main.tsx*", route => route.abort());
        await page.route("**/src/styles/pwa.css*", route => route.fulfill({
          contentType: "text/css", body: standaloneCss(shape.inset),
        }));
        await page.goto("/");
        await expect(page.locator("#root")).toBeEmpty();
        await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", colorScheme);
        const surface = page.locator("body > .kodex-pwa-safe-area");
        await expect(surface).toBeVisible();
        expect(await surface.evaluate(el => el.nextElementSibling?.id)).toBe("root");
        const bounds = (await surface.boundingBox())!;
        expect(bounds).toMatchObject({ x: 0, y: 0, width: shape.width });
        expect(bounds.height).toBeGreaterThan(10);
        expect(bounds.height).toBeGreaterThanOrEqual(shape.inset);
        const shellColor = await page.locator("html").evaluate(el =>
          getComputedStyle(el).getPropertyValue("--kodex-bg-shell").trim());
        expect(shellColor).not.toBe("");
        // The default themes use sRGB; rgb() serialization proves alpha is 1.
        expect(await surface.evaluate(el => getComputedStyle(el).backgroundColor))
          .toMatch(/^rgb\(\d+, \d+, \d+\)$/);
        await expect(surface).toHaveCSS("background-color", await surface.evaluate((el, color) => {
          const sample = document.createElement("div");
          sample.style.backgroundColor = color;
          el.appendChild(sample);
          const resolved = getComputedStyle(sample).backgroundColor;
          sample.remove();
          return resolved;
        }, shellColor));
      });
    }
    test("standalone header leaves navigation and fullscreen editing reachable", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      try {
        await context.route("**/src/styles/pwa.css*", route => route.fulfill({
          contentType: "text/css", body: standaloneCss(shape.inset),
        }));
        const page = await fixture.page("standalone-header");
        const surface = page.locator(".kodex-pwa-safe-area");
        const bounds = (await surface.boundingBox())!;
        expect(bounds.x).toBe(0);
        expect(bounds.y).toBe(0);
        expect(bounds.width).toBe(shape.width);
        expect(bounds.height).toBeGreaterThan(10);
        expect(bounds.height).toBeGreaterThanOrEqual(shape.inset);
        const header = page.locator(".kodex-workspace-single-pane-header");
        if (shape.width <= 768) {
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
        } else {
          const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
          await expect(sidebar).toBeVisible();
          for (const button of await sidebar.getByRole("button").all()) {
            if (await button.isVisible()) expect((await button.boundingBox())!.y).toBeGreaterThanOrEqual(bounds.height);
          }
          const mainBounds = (await page.locator(".kodex-main-stack").boundingBox())!;
          expect(mainBounds.y).toBeGreaterThanOrEqual(bounds.height);
          expect(mainBounds.y + mainBounds.height).toBeLessThanOrEqual(shape.height);
        }
        const textarea = page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]').getByLabel("Message composer", { exact: true });
        await expectTopEdgeAboveContent(page);
        await textarea.tap();
        const originalTextarea = await textarea.elementHandle();
        const dialog = page.getByRole("dialog", { name: "Compose", exact: true });
        await expect(dialog).toBeVisible();
        await expect(surface).toHaveCSS("background-color", await dialog.evaluate(el => getComputedStyle(el).backgroundColor));
        expect((await dialog.boundingBox())!.y).toBeGreaterThanOrEqual(bounds.height);
        await textarea.fill("Device header check");
        await expect(textarea).toBeFocused();
        await expect(textarea).toHaveValue("Device header check");
        await expectTopEdgeAboveContent(page);
        await page.screenshot({ path: test.info().outputPath("standalone-composer.png") });
        if (shape.name.startsWith("iPad")) {
          await textarea.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 8));
          for (const viewport of [
            { width: shape.height, height: shape.width },
            { width: shape.width, height: shape.height },
          ]) {
            await page.setViewportSize(viewport);
            await expect(textarea).toHaveValue("Device header check");
            await expect(textarea).toBeFocused();
            expect(await originalTextarea!.evaluate(el => el.isConnected && el === document.activeElement)).toBe(true);
            expect(await textarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([2, 8]);
            await expect.poll(async () => (await dialog.boundingBox())!.y).toBeGreaterThanOrEqual(bounds.height);
            await expect(dialog.getByRole("button", { name: "Send message", exact: true })).toBeInViewport();
            expect(await surface.boundingBox()).toMatchObject({
              x: 0, y: 0, width: viewport.width, height: bounds.height,
            });
            await expectTopEdgeAboveContent(page);
          }
        }
        await page.getByRole("button", { name: "Collapse composer", exact: true }).tap();
        if (shape.width <= 768) await page.getByRole("button", { name: "Show sidebar", exact: true }).tap();
        await page.getByRole("button", { name: "Account settings", exact: true }).tap();
        await page.getByRole("menuitem", { name: "Preferences", exact: true }).tap();
        await expect(page.getByRole("dialog", { name: "Preferences", exact: true })).toBeVisible();
        await expectTopEdgeAboveContent(page);
        await page.screenshot({ path: test.info().outputPath("standalone-preferences.png") });
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
    });
  });
}
