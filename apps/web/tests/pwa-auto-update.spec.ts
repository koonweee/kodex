import { expect, test, type Page } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

async function openInterface(page: Page) {
  const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
  if (!await sidebar.isVisible()) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await sidebar.getByRole("button", { name: "Account settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Preferences", exact: true }).click();
  return page.getByRole("dialog", { name: "Preferences", exact: true });
}

for (const touch of [false, true]) {
  test.describe(touch ? "touch auto updates" : "pointer auto updates", () => {
    test.use({ viewport: { width: touch ? 390 : 1280, height: 844 }, hasTouch: touch, isMobile: touch });
    test("device preference converges and future SSE notices count down once in two tabs", async ({ context }, info) => {
      await context.route("**/src/pwa/registerServiceWorker.ts", async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: await response.text() + `
          setRegisterSWLoaderForTests(async () => options => {
            const registration = { scope: '/', waiting: null, update: async () => {
              window.pwaChecks = (window.pwaChecks || 0) + 1;
              if (registration.waiting) options.onNeedRefresh();
            } };
            window.nextPwaBundle = () => { registration.waiting = new EventTarget(); };
            options.onRegisteredSW('/sw.js', registration);
            window.showPwaNotice = () => { registration.waiting = new EventTarget(); options.onNeedRefresh(); };
            return async () => { window.pwaAccepted = (window.pwaAccepted || 0) + 1; };
          });
        ` });
      });
      const fixture = await nativeSettingsFixture(context);
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const client of ["first", "second"]) await expect.poll(() => fixture.connected(client)).toBe(true);
        const notice = first.locator(".kodex-pwa-lifecycle-notice");
        const otherNotice = second.locator(".kodex-pwa-lifecycle-notice");
        // Open settings before the banner arrives, then opt in with a notice already waiting.
        const preferences = await openInterface(first);
        const otherPreferences = await openInterface(second);
        for (const page of [first, second]) {
          await page.waitForFunction(() => typeof Reflect.get(window, "showPwaNotice") === "function");
          await page.evaluate(() => Reflect.get(window, "showPwaNotice")());
        }
        for (const banner of [notice, otherNotice]) await expect(banner).toContainText("Update available");
        const toggle = preferences.getByRole("switch", { name: "Auto-update" });
        await expect(toggle).not.toBeChecked();
        if (touch) {
          expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          await toggle.tap();
        }
        else await toggle.check();
        await first.screenshot({ path: info.outputPath("auto-update-preferences.png"), animations: "disabled" });
        await expect(otherPreferences.getByRole("switch", { name: "Auto-update" })).toBeChecked();
        for (const [page, dialog] of [[first, preferences], [second, otherPreferences]] as const) {
          await page.keyboard.press("Escape");
          await expect(dialog).toBeHidden();
          if (touch && page === second) {
            await otherNotice.getByRole("button", { name: "Dismiss update notice" }).tap();
            await page.getByRole("button", { name: "Show thread", exact: true }).tap();
          }
          await page.clock.install();
        }
        for (const banner of [notice, otherNotice]) await expect(banner.getByRole("switch")).toHaveCount(0);
        await first.clock.runFor(4000);
        await second.clock.runFor(4000);
        expect(await first.evaluate(() => Reflect.get(window, "pwaAccepted"))).toBeUndefined();
        expect(await second.evaluate(() => Reflect.get(window, "pwaAccepted"))).toBeUndefined();
        await expect(notice).toContainText("Update available");
        const secondComposer = second.locator('.kodex-thread-pane[data-workspace-pane-active="true"]')
          .getByRole("textbox", { name: "Message composer", exact: true });
        await secondComposer.fill("Keep this text draft while the update waits.");
        for (const page of [first, second]) await page.evaluate(() => Reflect.get(window, "nextPwaBundle")());
        fixture.frontendUpdated();
        await expect(notice).toContainText("Updating in 3s");
        await expect(otherNotice).toContainText("Update available");
        await first.clock.runFor(1000);
        await expect(notice).toContainText("Updating in 2s");
        const animation = await notice.locator(".kodex-animated-number").evaluate(el => el.getAnimations({ subtree: true }).map(a => ({
          duration: a.effect!.getTiming().duration,
          properties: [...new Set((a.effect as KeyframeEffect).getKeyframes().flatMap(frame => Object.keys(frame)
            .filter(key => !["offset", "computedOffset", "easing", "composite"].includes(key))))],
        })));
        expect(animation).toHaveLength(2);
        for (const item of animation) { expect(item.duration).toBeLessThanOrEqual(200); expect(item.properties.sort()).toEqual(["opacity", "transform"]); }
        await first.screenshot({ path: info.outputPath("auto-update-countdown.png"), animations: "allow" });
        await first.clock.runFor(1000);
        await expect(notice).toContainText("Updating in 1s");
        const beforeRepeatChecks = await first.evaluate(() => Reflect.get(window, "pwaChecks"));
        fixture.frontendUpdated();
        await expect.poll(() => first.evaluate(() => Reflect.get(window, "pwaChecks"))).toBeGreaterThan(beforeRepeatChecks);
        await expect(notice).toContainText("Updating in 1s");
        await first.clock.runFor(1000);
        await expect.poll(() => first.evaluate(() => Reflect.get(window, "pwaAccepted"))).toBe(1);
        await second.clock.runFor(4000);
        expect(await second.evaluate(() => Reflect.get(window, "pwaAccepted"))).toBeUndefined();
        await expect(secondComposer).toHaveValue("Keep this text draft while the update waits.");
        await secondComposer.fill("");
        await expect(otherNotice).toContainText("Updating in 3s");
        await second.clock.runFor(3000);
        await expect.poll(() => second.evaluate(() => Reflect.get(window, "pwaAccepted"))).toBe(1);
        for (const page of [first, second]) {
          await page.clock.runFor(4000);
          expect(await page.evaluate(() => Reflect.get(window, "pwaAccepted"))).toBe(1);
        }
        await first.reload();
        await first.waitForFunction(() => typeof Reflect.get(window, "showPwaNotice") === "function");
        await first.evaluate(() => Reflect.get(window, "showPwaNotice")());
        expect(await first.evaluate(() => JSON.parse(localStorage.getItem("kodex-interface")!).autoUpdatePwa)).toBe(true);
        await expect(notice).toContainText("Updating in 3s");
        await notice.getByRole("button", { name: "Dismiss update notice" }).click();
        await first.clock.runFor(4000);
        expect(await first.evaluate(() => Reflect.get(window, "pwaAccepted"))).toBeUndefined();
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}
