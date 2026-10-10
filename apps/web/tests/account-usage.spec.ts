import { expect, test, type Page } from "@playwright/test";
import type { RateLimitsResponse } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

async function openUsage(page: Page, narrow = false) {
  if (narrow) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await page.getByRole("button", { name: "Account settings", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Usage details" })).toContainText("123.5 credits remaining");
  await page.getByRole("menuitem", { name: "Usage details" }).click();
  const dialog = page.getByRole("dialog", { name: "Preferences", exact: true });
  await expect(dialog.getByText("Weekly limit", { exact: true })).toBeVisible();
  return dialog;
}

for (const shape of [
  { name: "desktop", width: 1280, touch: false },
  { name: "narrow fine pointer", width: 390, touch: false },
  { name: "narrow touch", width: 390, touch: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.touch, isMobile: shape.touch });
    test("Usage opens from the menu and a selected reset converges across two tabs", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const expiry = Date.now() / 1000 + 86400 * 20;
      const usage: RateLimitsResponse = {
        rateLimits: { credits: { balance: "123.5", hasCredits: true, unlimited: false }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: expiry } },
        rateLimitResetCredits: { availableCount: 2, credits: [
          { id: "first", title: "Full reset", grantedAt: 1, expiresAt: expiry, status: "available", resetType: "codexRateLimits" },
          { id: "second", title: "Thank you reset", grantedAt: 2, expiresAt: expiry + 86400, status: "available", resetType: "codexRateLimits" },
        ] }, rawPayload: {},
      };
      const writes: unknown[] = [];
      await context.route("**/v1/account/rate-limits", route => route.fulfill({ json: usage }));
      await context.route("**/v1/account/rate-limit-reset-credits/consume", async route => {
        writes.push(route.request().postDataJSON());
        usage.rateLimits!.secondary!.usedPercent = 0;
        usage.rateLimitResetCredits = { availableCount: 1, credits: usage.rateLimitResetCredits!.credits!.slice(0, 1) };
        await route.fulfill({ json: { outcome: "reset" } });
        fixture.usageChanged();
      });
      try {
        const a = await fixture.page("usage-a");
        const b = await fixture.page("usage-b");
        await expect.poll(() => fixture.connected("usage-a") && fixture.connected("usage-b")).toBe(true);
        const first = await openUsage(a, shape.width < 900);
        const second = await openUsage(b, shape.width < 900);
        await expect(first.getByRole("progressbar", { name: "Weekly limit remaining" })).toHaveAttribute("aria-valuenow", "0");
        await expect(first.getByRole("button", { name: "Use reset: Thank you reset" })).toBeInViewport();
        expect(await first.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await a.screenshot({ path: test.info().outputPath("usage-before.png") });
        await first.getByRole("button", { name: "Use reset: Thank you reset" }).click();
        await expect(first.getByText("Plan limits reset.", { exact: true })).toBeVisible();
        expect(writes).toEqual([{ creditId: "second", idempotencyKey: expect.any(String) }]);
        await expect(second.getByText("100% left", { exact: true })).toBeVisible();
        await expect(second.getByRole("button", { name: "Use reset: Thank you reset" })).toHaveCount(0);
        await expect(second.getByRole("button", { name: "Use reset: Full reset" })).toBeVisible();
        await b.screenshot({ path: test.info().outputPath("usage-after.png") });
        // A missed invalidation converges through the existing foreground read.
        usage.rateLimits!.credits!.balance = "0";
        fixture.usageChanged("usage-a");
        await expect(first.getByText("0 credits remaining", { exact: true })).toBeVisible();
        await b.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(second.getByText("0 credits remaining", { exact: true })).toBeVisible();
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}
