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
          const threadContent = pane.locator(":scope > .kodex-thread-content");
          await expect(threadContent).toHaveCSS("visibility", "hidden");
          await expect(threadContent).toHaveCSS("opacity", "0");
          const dialogBounds = await dialog.boundingBox();
          expect(dialogBounds!.y).toBeCloseTo(await page.evaluate(() => visualViewport?.offsetTop ?? 0), 0);
          await expect(page.locator(".kodex-workspace-single-pane-header")).toBeHidden();
          await expect(dialog.locator(".kodex-mobile-composer-expanded-header")).toBeVisible();
          expect(await dialog.evaluate(el => {
            const bounds = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + 10));
          })).toBe(true);
          expect(dialogBounds!.height).toBeGreaterThan(750);
          const shell = page.locator(".kodex-shell");
          await shell.evaluate(el => (el as HTMLElement).style.setProperty("--kodex-mobile-safe-area-top", "24px"));
          await dialog.evaluate(el => el.style.setProperty("--kodex-mobile-visual-viewport-offset-top", "40px"));
          await expect.poll(async () => (await dialog.boundingBox())!.y).toBeCloseTo(40, 0);
          await dialog.evaluate(el => el.style.setProperty("--kodex-mobile-visual-viewport-offset-top", "0px"));
          await shell.evaluate(el => (el as HTMLElement).style.removeProperty("--kodex-mobile-safe-area-top"));
        }
        await textarea.fill("A draft that survives viewport changes");
        if (expandsOnTouch) {
          const shortDraftScroll = await textarea.evaluate(el => {
            el.scrollTop = 100;
            return { overflow: el.scrollHeight - el.clientHeight, scrollTop: el.scrollTop };
          });
          expect(shortDraftScroll.overflow).toBeLessThanOrEqual(1);
          expect(shortDraftScroll.scrollTop).toBe(0);
        }
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
          await expect(pane.locator(":scope > .kodex-thread-content")).toHaveCSS("visibility", "visible");
          await expect(pane.locator(":scope > .kodex-thread-content")).toHaveCSS("opacity", "1");
          const switcher = page.getByRole("button", { name: "Switch workspace pane", exact: true });
          await expect(switcher).toBeInViewport();
          expect(await switcher.evaluate(el => {
            const bounds = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
          })).toBe(true);
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

test("fullscreen keeps timeline paint out of the keyboard viewport gap", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    baseURL: test.info().project.use.baseURL });
  const fixture = await nativeSettingsFixture(context);
  try {
    const page = await fixture.page("keyboard-gap");
    await page.evaluate(() => {
      const events = new EventTarget();
      Object.defineProperty(window, "visualViewport", { configurable: true, value: {
        addEventListener: events.addEventListener.bind(events),
        height: 544,
        offsetTop: 0,
        removeEventListener: events.removeEventListener.bind(events),
      } });
    });
    const pane = page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
    const threadContent = pane.locator(":scope > .kodex-thread-content");
    await threadContent.evaluate((element) => {
      const probe = document.createElement("span");
      probe.dataset.keyboardBleedProbe = "true";
      probe.style.visibility = "visible";
      element.append(probe);
    });
    const contentHandle = await threadContent.elementHandle();
    await pane.getByLabel("Message composer", { exact: true }).tap();
    const dialog = pane.getByRole("dialog", { name: "Compose", exact: true });
    await expect(dialog).toBeVisible();
    await expect.poll(async () => {
      const dialogBounds = await dialog.boundingBox();
      const paneBounds = await pane.boundingBox();
      return Math.round((paneBounds ? paneBounds.y + paneBounds.height : 0) -
        (dialogBounds ? dialogBounds.y + dialogBounds.height : 0));
    }).toBe(300);
    await expect(threadContent).toHaveCSS("visibility", "hidden");
    await expect(threadContent).toHaveCSS("opacity", "0");
    const probe = threadContent.locator('[data-keyboard-bleed-probe="true"]');
    await expect(probe).toHaveCSS("visibility", "visible");
    expect(await probe.evaluate((element) => {
      let effectiveOpacity = 1;
      for (let current: Element | null = element; current; current = current.parentElement) {
        effectiveOpacity *= Number.parseFloat(getComputedStyle(current).opacity);
      }
      return effectiveOpacity;
    })).toBe(0);
    await pane.getByRole("button", { name: "Collapse composer", exact: true }).tap();
    await expect(dialog).toHaveCount(0);
    expect(await contentHandle!.evaluate(element => element.isConnected)).toBe(true);
    await expect(threadContent).toHaveCSS("visibility", "visible");
    await expect(threadContent).toHaveCSS("opacity", "1");
  } finally { await fixture.close(); await context.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("fullscreen regular pane keeps its active goal in the composer toolbar", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 768, height: 844 }, hasTouch: true,
    baseURL: test.info().project.use.baseURL });
  const fixture = await nativeSettingsFixture(context);
  fixture.setGoal({ threadId: fixture.detail.thread.id, objective: "Finish the dashboard", status: "active",
    tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 });
  try {
    const page = await fixture.page("fullscreen-goal");
    const pane = page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
    const input = pane.getByLabel("Message composer", { exact: true });
    await expect(pane.getByRole("region", { name: "Chat goal", exact: true })).toBeVisible();
    await input.tap();
    const dialog = pane.getByRole("dialog", { name: "Compose", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("region", { name: "Chat goal", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Manage goal: Active", exact: true })).toBeVisible();
    const layout = await dialog.evaluate(element => {
      const header = element.querySelector(".kodex-mobile-composer-expanded-header")!.getBoundingClientRect();
      const form = element.querySelector(".kodex-mobile-composer-expanded-body")!.getBoundingClientRect();
      const dialog = element.getBoundingClientRect();
      return { dialogBottom: dialog.bottom, formBottom: form.bottom, formTop: form.top, headerBottom: header.bottom };
    });
    expect(layout.formTop).toBeCloseTo(layout.headerBottom, 0);
    expect(layout.formBottom).toBeCloseTo(layout.dialogBottom, 0);
  } finally { await fixture.close(); await context.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});


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
    for (let index = 0; index < proportions.length; index++) {
      await expect.poll(() => page.locator(".dv-groupview:visible").nth(index).evaluate(group => group.getBoundingClientRect().width))
        .toBeCloseTo(proportions[index], -1);
    }
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
