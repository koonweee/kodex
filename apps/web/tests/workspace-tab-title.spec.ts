import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

test.use({ viewport: { width: 1280, height: 720 } });

const fullTitle = "Evaluate how tightly coupled the workspace tab titles are to native thread summaries";

test("truncated tab tooltip shows the full live title and preserves unread status", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  fixture.detail.thread.name = fullTitle;
  fixture.detail.thread.unreadCompletedAgentTurn = true;
  try {
    const page = await fixture.page("tab-title");
    const tab = page.locator(".dv-tab").filter({ hasText: fullTitle });
    const label = tab.locator(".dv-default-tab-content");
    await expect(label).toHaveText(fullTitle);
    await label.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText(fullTitle);
    await expect(tooltip).toContainText("Unread completed agent turn");
    const renamedTitle = "A changed title that is also much longer than the available workspace tab width";
    fixture.detail.thread.name = renamedTitle;
    fixture.refreshRequired();
    await expect(page.locator(".dv-default-tab-content").filter({ hasText: renamedTitle })).toBeVisible();
    await expect(tooltip).toContainText(renamedTitle);
    await page.mouse.move(0, 700);
    await expect(tooltip).toBeHidden();
    await page.locator(".dv-tab").filter({ hasText: renamedTitle }).hover();
    await page.locator(".dv-tab").filter({ hasText: renamedTitle }).locator(".dv-default-tab-action").click();
    await expect(page.locator(".dv-tab").filter({ hasText: renamedTitle })).toHaveCount(0);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("tooltip tracks title clipping when the tab resizes and ignores fitting titles", async ({ context }, testInfo) => {
  const fixture = await nativeSettingsFixture(context);
  fixture.detail.thread.name = "A moderately sized tab title";
  try {
    const page = await fixture.page("tab-resize");
    const tab = page.locator(".dv-tab").filter({ hasText: fixture.detail.thread.name });
    const resize = (width: number) => tab.evaluate((el, value) => {
      el.style.width = `${value}px`;
      el.style.minWidth = `${value}px`;
      el.style.maxWidth = `${value}px`;
    }, width);
    await resize(380);
    await tab.locator(".dv-default-tab-content").hover({ position: { x: 2, y: 2 } });
    await expect(page.getByRole("tooltip")).toBeHidden();
    await resize(120);
    await expect(page.getByRole("tooltip")).toHaveText(fixture.detail.thread.name!);
    await page.screenshot({ path: testInfo.outputPath("truncated-title.png") });
    await resize(380);
    await expect(page.getByRole("tooltip")).toBeHidden();
    // The native close-control overlay can cover text even before CSS ellipsis applies.
    await page.mouse.move(0, 700);
    const textWidth = await tab.locator(".dv-default-tab-content").evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width;
    });
    const horizontalPadding = await tab.evaluate(el => {
      const style = getComputedStyle(el);
      return Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    });
    await resize(Math.ceil(textWidth + horizontalPadding + 4));
    await expect.poll(() => tab.locator(".dv-default-tab-content").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await tab.locator(".dv-default-tab-content").hover();
    await expect(page.getByRole("tooltip")).toHaveText(fixture.detail.thread.name!);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
