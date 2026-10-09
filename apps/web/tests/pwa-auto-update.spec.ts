import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const touch of [false, true]) {
  test.describe(touch ? "touch auto updates" : "pointer auto updates", () => {
    test.use({ viewport: { width: touch ? 390 : 1280, height: 844 }, hasTouch: touch, isMobile: touch });
    test("device preference converges and future SSE notices count down once in two tabs", async ({ context }, info) => {
      await context.route("**/src/pwa/registerServiceWorker.ts", async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: await response.text() + `
          setRegisterSWLoaderForTests(async () => options => {
            const registration = { scope: '/', waiting: new EventTarget(), update: async () => {
              window.pwaChecks = (window.pwaChecks || 0) + 1;
              options.onNeedRefresh();
            } };
            window.nextPwaBundle = () => { registration.waiting = new EventTarget(); };
            options.onRegisteredSW('/sw.js', registration);
            queueMicrotask(() => options.onNeedRefresh());
            return async () => { window.pwaAccepted = (window.pwaAccepted || 0) + 1; };
          });
        ` });
      });
      const fixture = await nativeSettingsFixture(context);
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const client of ["first", "second"]) await expect.poll(() => fixture.connected(client)).toBe(true);
        await first.clock.install();
        await second.clock.install();
        const notice = first.locator(".kodex-pwa-lifecycle-notice");
        const otherNotice = second.locator(".kodex-pwa-lifecycle-notice");
        const toggle = notice.getByRole("switch", { name: "Auto-update" });
        if (touch) {
          expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          await toggle.tap();
        }
        else await toggle.check();
        await expect(otherNotice.getByRole("switch", { name: "Auto-update" })).toBeChecked();
        await first.clock.runFor(4000);
        await second.clock.runFor(4000);
        expect(await first.evaluate(() => Reflect.get(window, "pwaAccepted"))).toBeUndefined();
        expect(await second.evaluate(() => Reflect.get(window, "pwaAccepted"))).toBeUndefined();
        await expect(notice).toContainText("Update available");
        for (const page of [first, second]) await page.evaluate(() => Reflect.get(window, "nextPwaBundle")());
        fixture.frontendUpdated();
        for (const banner of [notice, otherNotice]) await expect(banner).toContainText("Updating in 3s");
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
        await second.clock.runFor(3000);
        for (const page of [first, second]) {
          await expect.poll(() => page.evaluate(() => Reflect.get(window, "pwaAccepted"))).toBe(1);
          await page.clock.runFor(4000);
          expect(await page.evaluate(() => Reflect.get(window, "pwaAccepted"))).toBe(1);
        }
        await first.reload();
        await expect(toggle).toBeChecked();
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
