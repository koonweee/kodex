import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { KODEX_COLOR_SCHEMES } from "../src/themeRegistry";
import { nativeSettingsFixture } from "./native-settings.fixture";
import { measureTheme } from "./theme-contrast.measure";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false },
  { name: "narrow touch", width: 390, hasTouch: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 900 }, hasTouch: shape.hasTouch });
    test("native and custom scroll areas keep content reachable", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      try {
        const page = await fixture.page("scrollbars", "/__theme");
        const native = page.getByRole("region", { name: "Native scrollbar sample", exact: true });
        await native.scrollIntoViewIfNeeded();
        await native.focus();
        await page.keyboard.press("End");
        await expect.poll(() => native.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
        await native.evaluate(el => { el.scrollLeft = el.scrollWidth; });
        await expect.poll(() => native.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
        await expect(native.getByText(/Scrollable content 12:/)).toBeInViewport();

        const custom = page.getByRole("region", { name: "Custom scrollbar sample", exact: true });
        await custom.scrollIntoViewIfNeeded();
        await custom.focus();
        await page.keyboard.press("End");
        await expect.poll(() => custom.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
        await expect(custom.getByRole("cell", { name: "Skeleton", exact: true })).toBeInViewport();
        if (!shape.hasTouch) {
          const bar = custom.locator("..").locator('.kodex-mantine-scroll-area-scrollbar[data-orientation="vertical"]');
          const thumb = bar.locator(".kodex-mantine-scroll-area-thumb");
          const start = await thumb.boundingBox(), lane = await bar.boundingBox();
          await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
          await page.mouse.down();
          await page.mouse.move(start!.x + start!.width / 2, lane!.y, { steps: 8 });
          await page.mouse.up();
          await expect.poll(() => custom.evaluate(el => el.scrollTop)).toBe(0);
        }
        expect(fixture.errors).toEqual([]);
        expect(fixture.unexpected).toEqual([]);
      } finally { await fixture.close(); }
    });
  });
}

const output = process.env.KODEX_SCROLLBAR_AUDIT_DIR;
test("capture scrollbar theme contact sheet", async ({ context }) => {
  test.skip(!output, "Set KODEX_SCROLLBAR_AUDIT_DIR for diagnostic captures");
  test.setTimeout(90_000);
  await mkdir(path.resolve(output!), { recursive: true });
  const fixture = await nativeSettingsFixture(context);
  try {
    const page = await fixture.page("scrollbar-captures", "/__theme");
    await page.setViewportSize({ width: 1280, height: 1200 });
    await expect(page.getByRole("region", { name: "Data surfaces", exact: true })).toBeVisible();
    // Use the real xterm renderer and production CSS without launching a shell.
    await page.evaluate(async () => {
      const modulePath = "/node_modules/@xterm/xterm/lib/xterm.mjs";
      const componentPath = "/src/terminal/XtermTerminal.tsx";
      const { Terminal } = await import(modulePath);
      const { terminalThemeColors } = await import(componentPath);
      const host = document.createElement("div");
      host.className = "kodex-terminal-viewport";
      host.setAttribute("data-testid", "scrollbar-terminal");
      host.style.cssText = "height: 140px; --kodex-terminal-bg: color-mix(in srgb, var(--kodex-bg-app) 96%, black)";
      document.querySelector('[aria-label="Data surfaces"]')!.append(host);
      const terminal = new Terminal({ cols: 28, rows: 5, theme: terminalThemeColors(host) });
      terminal.open(host);
      await new Promise<void>(resolve => terminal.write(Array.from({ length: 24 }, (_, i) => `Terminal line ${i + 1}\r\n`).join(""), resolve));
      terminal.scrollToTop();
      Reflect.set(host, "auditTerminal", terminal);
      new MutationObserver(() => { terminal.options.theme = terminalThemeColors(host); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-kodex-color-scheme"] });
    });
    const terminalHost = page.getByTestId("scrollbar-terminal");
    await terminalHost.scrollIntoViewIfNeeded();
    const terminalSlider = terminalHost.locator(".scrollbar.vertical > .slider");
    const thumbBox = await terminalSlider.boundingBox();
    const trackBox = await terminalHost.locator(".scrollbar.vertical").boundingBox();
    await page.mouse.move(thumbBox!.x + thumbBox!.width / 2, thumbBox!.y + thumbBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(thumbBox!.x + thumbBox!.width / 2, trackBox!.y + trackBox!.height - 1, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => terminalHost.evaluate(el => Reflect.get(el, "auditTerminal").buffer.active.viewportY)).toBeGreaterThan(0);
    await terminalHost.evaluate(el => Reflect.get(el, "auditTerminal").scrollToTop());
    for (const scheme of KODEX_COLOR_SCHEMES) {
      await page.getByRole("radio", { name: scheme.label, exact: true }).click();
      const section = page.getByRole("region", { name: "Data surfaces", exact: true });
      await section.scrollIntoViewIfNeeded();
      const slider = section.locator(".scrollbar.vertical > .slider");
      await terminalHost.hover();
      await expect(slider).toBeVisible();
      await slider.hover();
      // Stay inside xterm so its scrollbar remains visible without thumb hover.
      await terminalHost.hover({ position: { x: 8, y: 8 } });
      await expect.poll(async () => (await slider.evaluate(measureTheme)).samples[0]?.unsupported).toBe(false);
      const measured = await slider.evaluate(measureTheme);
      expect(measured.samples[0].surfaceRatio, `${scheme.label} terminal scrollbar contrast`).toBeGreaterThanOrEqual(3);
      await section.screenshot({ path: path.resolve(output!, `${scheme.id}.png`), animations: "disabled" });
    }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally { await fixture.close(); }
});
