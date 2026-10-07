import { expect, test } from "@playwright/test";

import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
  { name: "wide touch", width: 1280, hasTouch: true, isMobile: false },
  { name: "hybrid touch and mouse", width: 390, hasTouch: true, isMobile: false },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });

    test("composer keeps native focus and reachable actions while changing viewport", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.detail.thread.gitInfo = { branch: "main", originUrl: null, sha: null };
      try {
        const page = await fixture.page("composer");
        const pane = page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
        const textarea = pane.getByLabel("Message composer", { exact: true });
        await expect(textarea).toBeEnabled();
        await expect(pane.getByRole("toolbar", { name: /composer context|draft thread toolbar/i })).toHaveCount(0);
        await expect(pane.getByText("main", { exact: true })).toHaveCount(0);
        const originalTextarea = await textarea.elementHandle();
        const expandsOnTouch = shape.hasTouch && shape.width <= 900;
        // Touch capability must never make an ordinary mouse click expand.
        await textarea.click();
        await expect(pane.getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(0);
        if (shape.hasTouch) await textarea.tap();
        else await textarea.click();
        await expect(textarea).toBeFocused();
        expect(await originalTextarea!.evaluate((element) => element.isConnected && element === document.activeElement)).toBe(true);
        const dialog = pane.getByRole("dialog", { name: "Compose", exact: true });
        await expect(dialog).toHaveCount(expandsOnTouch ? 1 : 0);
        if (expandsOnTouch) {
          const dialogBounds = await dialog.boundingBox();
          expect(dialogBounds!.y).toBeLessThan(64);
          expect(dialogBounds!.height).toBeGreaterThan(750);
        }
        await textarea.fill("A draft that survives viewport changes");
        await page.screenshot({ path: test.info().outputPath("composer-full-height.png") });

        await page.setViewportSize({ width: shape.width, height: 420 });
        await expect(textarea).toHaveValue("A draft that survives viewport changes");
        await expect(textarea).toBeFocused();
        await expect(textarea).toBeInViewport();
        const send = pane.getByRole("button", { name: "Send message", exact: true });
        await expect(send).toBeInViewport();
        const bounds = await send.boundingBox();
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(420);
        await page.screenshot({ path: test.info().outputPath("composer-reduced-height.png") });
        if (expandsOnTouch) {
          const longDraft = Array.from({ length: 80 }, (_, i) => `Draft line ${i}`).join("\n");
          await textarea.fill(longDraft);
          const wrapper = pane.locator(".kodex-mobile-composer-textarea");
          await expect.poll(() => wrapper.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
          await expect.poll(() => textarea.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
          const before = await send.boundingBox();
          await textarea.evaluate(el => { el.scrollTop = el.scrollHeight; });
          await expect.poll(() => textarea.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
          expect(await send.boundingBox()).toEqual(before);
          await expect(pane.getByRole("button", { name: "Collapse composer", exact: true })).toBeInViewport();
          await textarea.fill("A draft that survives viewport changes");
        }
        if (expandsOnTouch) {
          await textarea.evaluate(el => el.setSelectionRange(2, 8));
          await page.setViewportSize({ width: 1280, height: 844 });
          await expect(dialog).toHaveCount(0);
          await expect(textarea).toBeFocused();
          expect(await originalTextarea!.evaluate(element => element === document.activeElement && element.isConnected)).toBe(true);
          expect(await textarea.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([2, 8]);
          await page.setViewportSize({ width: shape.width, height: 420 });
          await expect(dialog).toHaveCount(0);
          await expect(textarea).toBeFocused();
          await textarea.tap();
          await expect(dialog).toHaveCount(1);
          await pane.getByRole("button", { name: "Collapse composer", exact: true }).tap();
          await expect(pane.getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(0);
          expect(await originalTextarea!.evaluate((element) => element.isConnected)).toBe(true);
          await expect(textarea).toHaveValue("A draft that survives viewport changes");
        }
      } finally {
        await fixture.close();
      }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}


test("compact desktop pane keeps its input and actions while a spacious sibling stays regular", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  fixture.setGoal({ threadId: fixture.detail.thread.id, objective: "Finish the dashboard", status: "active", tokenBudget: null,
    tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 });
  try {
    const page = await fixture.page("pane-fit");
    await page.setViewportSize({ width: 1920, height: 900 });
    const original = page.locator('.kodex-thread-pane-existing');
    const input = original.getByRole("textbox", { name: "Message composer", exact: true });
    await expect(input).toBeEnabled({ timeout: 15000 });
    await expect(original.getByRole("region", { name: "Chat goal" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Workspace", exact: true });
    await nav.getByRole("button", { name: "Chats", exact: true }).click();
    await nav.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page.locator(".dv-groupview:visible")).toHaveCount(2);
    const sibling = page.locator('.kodex-thread-pane-empty');
    const siblingHero = sibling.locator(".kodex-composer-hero");
    await expect(siblingHero).toBeVisible();
    const regularHeadingSize = await siblingHero.evaluate(el => getComputedStyle(el).fontSize);
    await original.getByLabel("Add attachment", { exact: true }).setInputFiles([
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("A local draft attachment") },
    ]);
    await input.fill("Draft in a narrow desktop column");
    await input.evaluate(el => { el.focus(); el.setSelectionRange(2, 7); });
    const handle = await input.elementHandle();
    await original.evaluate(el => { el.style.maxWidth = "360px"; });
    await expect(original.getByRole("region", { name: "Chat goal" })).toHaveCount(0);
    await expect(original.getByRole("button", { name: "Manage goal: Active" })).toBeVisible();
    await expect(original.getByRole("button", { name: "Remove notes.txt" })).toBeVisible();
    await expect(original.getByRole("button", { name: "Send message", exact: true })).toBeInViewport();
    await expect(original.getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(0);
    expect(await handle!.evaluate(el => el.isConnected && document.activeElement === el)).toBe(true);
    expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([2, 7]);
    expect(await siblingHero.evaluate(el => getComputedStyle(el).fontSize)).toBe(regularHeadingSize);
    expect(await original.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await original.getByRole("button", { name: /Model:/ }).click();
    const settings = page.getByRole("menu", { name: "Model and speed controls" });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole("button", { name: "Close Run settings" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: test.info().outputPath("compact-pane-spacious-sibling.png") });
    await input.focus();
    await original.evaluate(el => { el.style.maxWidth = ""; });
    await expect(original.getByRole("region", { name: "Chat goal" })).toBeVisible();
    expect(await handle!.evaluate(el => el.isConnected && document.activeElement === el)).toBe(true);
    await expect(input).toHaveValue("Draft in a narrow desktop column");
    await expect(original.getByRole("button", { name: "Remove notes.txt" })).toBeVisible();
    const proportions = await page.locator(".dv-groupview:visible").evaluateAll(groups => groups.map(group => group.getBoundingClientRect().width));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Switch workspace pane", exact: true })).toContainText("Native settings chat");
    await expect(page.locator(".dv-groupview:visible")).toHaveCount(1);
    expect(await handle!.evaluate(el => el.isConnected && document.activeElement === el)).toBe(true);
    await expect(original.getByRole("button", { name: "Remove notes.txt" })).toBeVisible();
    await expect(original.getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect(page.locator(".dv-groupview:visible")).toHaveCount(2);
    expect(await handle!.evaluate(el => el.isConnected && document.activeElement === el)).toBe(true);
    await expect(input).toHaveValue("Draft in a narrow desktop column");
    const restoredProportions = await page.locator(".dv-groupview:visible").evaluateAll(groups => groups.map(group => group.getBoundingClientRect().width));
    for (let index = 0; index < proportions.length; index++) expect(restoredProportions[index]).toBeCloseTo(proportions[index], -1);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
