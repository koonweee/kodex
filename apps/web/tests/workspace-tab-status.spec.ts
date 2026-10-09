import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const hasTouch of [false, true]) {
  test.describe(hasTouch ? "touch-capable desktop tabs" : "fine-pointer desktop tabs", () => {
    test.use({ viewport: { width: 1280, height: 844 }, hasTouch });

    test("running uses the sidebar spinner and shares close space through canonical status changes", async ({ context }, testInfo) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.detail.thread.status = "active";
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const client of ["first", "second"]) await expect.poll(() => fixture.connected(client)).toBe(true);
        const tab = first.locator(".dv-tab").filter({ hasText: "Native settings chat" });
        const otherTab = second.locator(".dv-tab").filter({ hasText: "Native settings chat" });
        const running = tab.getByRole("status", { name: "Thread in progress", exact: true });
        const close = tab.locator(".dv-default-tab-action");
        await first.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: "Chats", exact: true }).click();
        await first.mouse.move(1100, 750);
        await second.mouse.move(1100, 750);
        await expect(running).toBeVisible();
        await expect(otherTab.getByRole("status", { name: "Thread in progress", exact: true })).toBeVisible();
        const sidebarSpinner = first.getByRole("navigation", { name: "Workspace", exact: true })
          .getByRole("status", { name: "Thread in progress", exact: true }).locator(":scope > span");
        const spinnerBounds = await sidebarSpinner.evaluate(el => ({ width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight }));
        const runningBounds = await running.boundingBox();
        expect(runningBounds!.width).toBeCloseTo(spinnerBounds!.width, 1);
        expect(runningBounds!.height).toBeCloseTo(spinnerBounds!.height, 1);
        const slot = tab.locator(".kodex-workspace-pane-title-adornment");
        await expect(slot).toHaveCSS("opacity", "1");
        const before = await tab.boundingBox();
        await first.screenshot({ path: testInfo.outputPath("running-tab.png") });
        if (hasTouch) {
          await expect(close).toBeVisible();
          const slotBounds = await slot.boundingBox();
          const closeBounds = await close.boundingBox();
          expect(slotBounds!.x + slotBounds!.width).toBeLessThanOrEqual(closeBounds!.x);
          await tab.hover();
          await expect(slot).toHaveCSS("opacity", "1");
        } else {
          await expect(close).toBeHidden();
          await tab.hover();
          await expect(slot).toHaveCSS("opacity", "0");
          await expect(close).toBeVisible();
          const slotBounds = await slot.boundingBox();
          expect(await close.boundingBox()).toEqual(slotBounds);
          await first.screenshot({ path: testInfo.outputPath("hover-close.png") });
          await first.mouse.move(1100, 750);
          await expect(slot).toHaveCSS("opacity", "1");
          await expect(close).toBeHidden();
          // Establish keyboard modality before focusing the native tab.
          await first.keyboard.press("Tab");
          await tab.focus();
          await expect(close).toBeVisible();
          await expect(slot).toHaveCSS("opacity", "0");
          await tab.evaluate(el => (el as HTMLElement).blur());
          await expect(slot).toHaveCSS("opacity", "1");
        }
        expect(await tab.boundingBox()).toEqual(before);
        await first.mouse.move(1100, 750);
        fixture.detail.thread.status = "idle";
        fixture.detail.thread.unreadCompletedAgentTurn = true;
        fixture.detail.thread.readRevision += 1;
        fixture.refreshRequired();
        for (const parent of [tab, otherTab]) {
          await expect(parent.getByRole("status", { name: "Thread in progress", exact: true })).toHaveCount(0);
          await expect(parent.getByRole("img", { name: "Unread completed agent turn", exact: true })).toBeVisible();
        }
        expect(await tab.boundingBox()).toEqual(before);
        await first.screenshot({ path: testInfo.outputPath("unread-tab.png") });
        fixture.detail.thread.unreadCompletedAgentTurn = false;
        fixture.detail.thread.readRevision += 1;
        fixture.refreshRequired();
        for (const parent of [tab, otherTab]) {
          await expect(parent.getByRole("img", { name: "Unread completed agent turn", exact: true })).toHaveCount(0);
        }
        expect(await tab.boundingBox()).toEqual(before);
        if (hasTouch) await close.tap();
        else { await tab.hover(); await close.click(); }
        await expect(tab).toHaveCount(0);
        await expect(otherTab).toBeVisible();
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}
