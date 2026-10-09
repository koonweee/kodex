import { expect, test, type Locator } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "narrow fine pointer", hasTouch: false, isMobile: false },
  { name: "narrow touch", hasTouch: true, isMobile: true },
  { name: "hybrid", hasTouch: true, isMobile: false },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });

    test("tab selector and open list follow canonical running and unread state in two tabs", async ({ context }, testInfo) => {
      const fixture = await nativeSettingsFixture(context);
      const title = "A long conversation title that must leave room for its running and notification indicators";
      fixture.detail.thread.name = title;
      fixture.detail.thread.status = "active";
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const client of ["first", "second"]) await expect.poll(() => fixture.connected(client)).toBe(true);
        const selector = first.getByRole("button", { name: "Switch workspace pane", exact: true });
        const otherSelector = second.getByRole("button", { name: "Switch workspace pane", exact: true });
        const running = (parent: Locator) => parent.getByRole("status", { name: "Thread in progress", exact: true });
        const unread = (parent: Locator) => parent.getByRole("img", { name: "Unread completed agent turn", exact: true });
        await expect(running(selector)).toBeVisible();
        await expect(running(otherSelector)).toBeVisible();
        await assertIndicatorFits(selector, running(selector));
        await second.screenshot({ path: testInfo.outputPath("running-header.png") });
        if (shape.hasTouch) await selector.tap();
        else await selector.click();
        const manager = first.getByRole("dialog", { name: "Active panes", exact: true });
        const row = manager.getByRole("button", { name: new RegExp(`^${title}`) });
        await expect(running(row)).toBeVisible();
        await assertIndicatorFits(row, running(row));
        await first.screenshot({ path: testInfo.outputPath("running-selector.png") });

        fixture.detail.thread.status = "idle";
        fixture.detail.thread.unreadCompletedAgentTurn = true;
        fixture.detail.thread.readRevision += 1;
        fixture.refreshRequired();
        await expect(unread(selector)).toBeVisible();
        await expect(unread(otherSelector)).toBeVisible();
        await expect(unread(row)).toBeVisible();
        await expect(running(row)).toHaveCount(0);
        await assertIndicatorFits(selector, unread(selector));
        await assertIndicatorFits(row, unread(row));
        await first.screenshot({ path: testInfo.outputPath("unread-selector.png") });
        await second.screenshot({ path: testInfo.outputPath("unread-header.png") });

        fixture.detail.thread.unreadCompletedAgentTurn = false;
        fixture.detail.thread.readRevision += 1;
        fixture.refreshRequired();
        await expect(unread(selector)).toHaveCount(0);
        await expect(unread(otherSelector)).toHaveCount(0);
        await expect(unread(row)).toHaveCount(0);
        // Close the selector and cross the viewport boundary: the same native
        // state must still appear in desktop tabs, then in the compact header.
        await row.click();
        await first.setViewportSize({ width: 1280, height: 844 });
        fixture.detail.thread.status = "active";
        fixture.refreshRequired();
        const desktopTab = first.locator(".dv-tab").filter({ hasText: title });
        await expect(running(desktopTab)).toBeVisible();
        await first.setViewportSize({ width: 390, height: 844 });
        await expect(running(selector)).toBeVisible();
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}

async function assertIndicatorFits(button: Locator, indicator: Locator) {
  const outer = await button.boundingBox();
  const inner = await indicator.boundingBox();
  expect(inner!.width).toBeGreaterThan(0);
  expect(inner!.x).toBeGreaterThanOrEqual(outer!.x);
  expect(inner!.x + inner!.width).toBeLessThanOrEqual(outer!.x + outer!.width);
  expect(inner!.y).toBeGreaterThanOrEqual(outer!.y);
  expect(inner!.y + inner!.height).toBeLessThanOrEqual(outer!.y + outer!.height);
}
