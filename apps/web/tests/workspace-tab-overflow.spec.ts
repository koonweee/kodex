import { expect, test, type Locator, type Page } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

test.use({ viewport: { width: 910, height: 600 } });

for (const hasTouch of [false, true]) {
  test.describe(hasTouch ? "desktop touch" : "desktop mouse", () => {
    test.use({ viewport: { width: 910, height: 600 }, hasTouch });
    test("fitting tabs stay fixed and hidden selection stays visible through resize and close", async ({ context }, testInfo) => {
      const fixture = await nativeSettingsFixture(context);
      try {
        const page = await fixture.page("fixed-tabs", "/");
        const dock = page.locator(".kodex-workspace-dock");
        await dock.evaluate(el => { el.style.maxWidth = "400px"; });
        await createDraftTabs(page);
        const allTabs = page.locator(".dv-tabs-container > .dv-tab");
        await expect(allTabs).toHaveCount(7);
        await dock.evaluate(el => { el.style.maxWidth = "400px"; });
        const strip = page.locator(".dv-tabs-container");
        const more = page.getByRole("button", { name: "More tabs", exact: true });
        await expect(more).toBeVisible();
        await assertNoScroll(strip);
        const visible = page.locator(".dv-tabs-container > .dv-tab:visible");
        expect(await visible.count()).toBeLessThan(7);
        await expect(page.locator(".dv-tab.dv-active-tab:visible")).toHaveCount(1);
        await assertTabsFit(visible, strip);
        const bounds = await visible.evaluateAll(els => els.map(el => { const b = el.getBoundingClientRect(); return [b.x, b.width]; }));
        await strip.hover();
        await page.mouse.wheel(500, 500);
        await page.mouse.wheel(-500, -500);
        await assertNoScroll(strip);
        expect(await visible.evaluateAll(els => els.map(el => { const b = el.getBoundingClientRect(); return [b.x, b.width]; }))).toEqual(bounds);
        if (hasTouch) await more.tap();
        else await more.click();
        const items = page.getByRole("menuitem");
        await expect(items).toHaveCount(7 - await visible.count());
        const selectedId = await items.last().getAttribute("data-pane-id");
        if (hasTouch) await items.last().tap();
        else await items.last().click();
        await expect(page.getByRole("menu")).toBeHidden();
        await expect(page.locator(".dv-tab.dv-active-tab:visible .kodex-workspace-tab")).toHaveAttribute("data-pane-id", selectedId!);
        await assertNoScroll(strip);
        await assertTabsFit(visible, strip);
        await page.screenshot({ path: testInfo.outputPath("fixed-tab-overflow.png"), animations: "disabled" });
        await more.click();
        await expect(page.getByRole("menu")).toBeVisible();
        await page.setViewportSize({ width: 1440, height: 600 });
        await dock.evaluate(el => { el.style.maxWidth = "1100px"; });
        await expect(more).toBeHidden();
        await expect(page.getByRole("menu")).toBeHidden();
        await expect(visible).toHaveCount(7);
        await assertNoScroll(strip);
        await dock.evaluate(el => { el.style.maxWidth = "400px"; });
        await expect(more).toBeVisible();
        await expect(page.locator(".dv-tab.dv-active-tab:visible .kodex-workspace-tab")).toHaveAttribute("data-pane-id", selectedId!);
        await expect(page.getByRole("menu")).toBeHidden();
        await dock.evaluate(el => { el.style.maxWidth = "180px"; });
        await expect(visible).toHaveCount(1);
        await assertNoScroll(strip);
        await assertTabsFit(visible, strip);
        await more.focus();
        await more.press("Enter");
        await expect(page.getByRole("menu")).toBeVisible();
        const keyboardItem = page.getByRole("menuitem").first();
        const keyboardId = await keyboardItem.getAttribute("data-pane-id");
        await keyboardItem.focus();
        await keyboardItem.press("Enter");
        await expect(page.getByRole("menu")).toBeHidden();
        await expect(page.locator(".dv-tab.dv-active-tab:visible .kodex-workspace-tab")).toHaveAttribute("data-pane-id", keyboardId!);
        const active = page.locator(".dv-tab.dv-active-tab:visible");
        await active.hover();
        await active.locator(".dv-default-tab-action").click();
        await expect(allTabs).toHaveCount(6);
        await expect(page.locator(".dv-tab.dv-active-tab:visible")).toHaveCount(1);
        await assertNoScroll(strip);
        await assertTabsFit(visible, strip);
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}

test("visible tabs reorder using native positions while intervening tabs are hidden", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  try {
    const page = await fixture.page("fixed-tab-drag", "/");
    const dock = page.locator(".kodex-workspace-dock");
    await dock.evaluate(el => { el.style.maxWidth = "400px"; });
    await createDraftTabs(page);
    const tabs = page.locator(".dv-tabs-container > .dv-tab");
    const ids = () => tabs.locator(".kodex-workspace-tab").evaluateAll(els => els.map(el => (el as HTMLElement).dataset.paneId));
    await expect(tabs).toHaveCount(7);
    const before = await ids();
    const visible = page.locator(".dv-tabs-container > .dv-tab:visible");
    await expect(visible).toHaveCount(2);
    const sourceBounds = (await visible.first().boundingBox())!;
    const lastBounds = (await visible.last().boundingBox())!;
    await page.mouse.move(sourceBounds.x + sourceBounds.width / 2, sourceBounds.y + sourceBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceBounds.x + sourceBounds.width / 2 + 10, sourceBounds.y + sourceBounds.height / 2, { steps: 5 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.mouse.move(lastBounds.x + 5, lastBounds.y + lastBounds.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(ids).toEqual([...before.slice(1, 6), before[0], before[6]]);
    const target = visible.first();
    const bounds = (await target.boundingBox())!;
    await visible.last().dragTo(target, { targetPosition: { x: 5, y: bounds.height / 2 } });
    await expect.poll(ids).toEqual([...before.slice(1, 6), before[6], before[0]]);
    await assertNoScroll(page.locator(".dv-tabs-container"));
    await page.setViewportSize({ width: 1440, height: 600 });
    await dock.evaluate(el => { el.style.maxWidth = "1100px"; });
    await expect(visible).toHaveCount(7);
    await expect(page.locator(".dv-tab.dv-active-tab .kodex-workspace-tab")).toHaveAttribute("data-pane-id", before[6]!);
    await expect(page.getByRole("textbox", { name: /message composer/i })).toHaveValue("Draft 6");
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

async function createDraftTabs(page: Page) {
  const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
  await sidebar.getByRole("button", { name: "Chats", exact: true }).click();
  for (let i = 0; i < 7; i++) {
    await sidebar.getByRole("button", { name: "New chat", exact: true }).click();
    await page.locator('.kodex-thread-pane-empty[data-workspace-pane-active="true"]').getByRole("textbox", { name: /message composer/i }).fill(`Draft ${i}`);
  }
}

async function assertNoScroll(strip: Locator) {
  await expect.poll(() => strip.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect.poll(() => strip.evaluate(el => el.scrollLeft)).toBe(0);
}
async function assertTabsFit(tabs: Locator, strip: Locator) {
  await expect.poll(async () => {
    const outer = (await strip.boundingBox())!;
    return tabs.evaluateAll((els, b) => els.every(el => {
      const bounds = el.getBoundingClientRect();
      return bounds.width > 0 && bounds.left >= b.x - 1 && bounds.right <= b.x + b.width + 1;
    }), outer);
  }).toBe(true);
}
