import { expect, test } from "@playwright/test";

import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("queue handle clears hover and tooltip when leaving or starting a captured gesture", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.queuedInputs.push(...["First", "Second"].map((text, index) => ({
        id: `tooltip-${index}`, threadId: "settings-chat", input: [{ type: "text" as const, text }],
        clientUserMessageId: `tooltip-client-${index}`, attachments: [], canSteer: false,
      })));
      try {
        const page = await fixture.page("first");
        const pane = page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
        const rows = pane.getByRole("group", { name: "Queued message", exact: true });
        await expect(rows).toHaveCount(2);
        const handle = rows.first().getByRole("button", { name: "Reorder queued message", exact: true });
        const tooltip = page.getByRole("tooltip", { name: "Drag to reorder · ↑/↓ to move" });
        const background = () => handle.evaluate((element) => getComputedStyle(element).backgroundColor);
        const restingBackground = await background();
        if (shape.hasTouch) {
          await handle.tap();
          await expect(tooltip).toBeHidden();
          await expect.poll(background).toBe(restingBackground);
        } else {
          await handle.hover();
          await expect(tooltip).toBeVisible();
          await expect.poll(background).not.toBe(restingBackground);
          await rows.first().getByText("First", { exact: true }).hover();
          await expect(tooltip).toBeHidden();
          await expect.poll(background).toBe(restingBackground);

          // Hover dismissal must work even while keyboard focus stays elsewhere.
          await pane.getByLabel("Message composer", { exact: true }).focus();
          await handle.hover();
          await expect(tooltip).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(tooltip).toBeHidden();
          await rows.first().getByText("First", { exact: true }).hover();

          await handle.hover();
          await expect(tooltip).toBeVisible();
          const bounds = await handle.boundingBox();
          if (!bounds) throw new Error("Expected a visible queue handle");
          await page.mouse.down();
          // Pointer capture suppresses hover-exit events until the button is released.
          await page.mouse.move(bounds.x + bounds.width + 30, bounds.y + bounds.height / 2);
          await expect(handle).toBeFocused();
          await expect(tooltip).toBeHidden();
          await expect.poll(background).toBe(restingBackground);
          await page.mouse.up();
          await expect(tooltip).toBeHidden();
          await expect.poll(background).toBe(restingBackground);

          await handle.hover();
          await expect(tooltip).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(tooltip).toBeHidden();

          await rows.first().getByText("First", { exact: true }).hover();
          await handle.hover();
          await expect(tooltip).toBeVisible();
          await page.mouse.down();
          const target = await rows.last().boundingBox();
          if (!target) throw new Error("Expected a visible drop target");
          await page.mouse.move(bounds.x + bounds.width + 30, target.y + target.height / 2, { steps: 8 });
          await expect(tooltip).toBeHidden();
          await page.keyboard.press("Escape");
          await page.mouse.up();
          await expect(tooltip).toBeHidden();
          await handle.hover();
          await expect(tooltip).toBeVisible();
          await expect.poll(background).not.toBe(restingBackground);
          await rows.first().getByText("First", { exact: true }).hover();
          await expect(tooltip).toBeHidden();
          await expect.poll(background).toBe(restingBackground);
        }
        await page.screenshot({ path: test.info().outputPath("queue-handle-resting.png") });
        await expect(rows).toHaveText(["First", "Second"]);
        expect(fixture.requests.filter((request) => request.key.endsWith("/reorder"))).toEqual([]);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}
