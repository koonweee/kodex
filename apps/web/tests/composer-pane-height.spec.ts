import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

test("composer row limits follow pane height and preserve text during resizing", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  try {
    const page = await fixture.page("height", "/");
    await page.setViewportSize({ width: 1280, height: 900 });
    const input = page.getByRole("textbox", { name: "Message composer", exact: true });
    const rows = () => input.evaluate(el => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
    await expect.poll(rows).toBeCloseTo(4, 0);
    const text = Array.from({ length: 14 }, (_, i) => `Line ${i}`).join("\n");
    await input.fill(text);
    await expect.poll(rows).toBeCloseTo(10, 0);
    await page.setViewportSize({ width: 1280, height: 500 });
    await expect.poll(rows).toBeCloseTo(5, 0);
    await expect(input).toHaveValue(text);
    expect(await input.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await input.fill("");
    await expect.poll(rows).toBeCloseTo(2, 0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(rows).toBeCloseTo(4, 0);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("short split panes use compact rows while neighboring tall panes retain normal rows", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  try {
    const page = await fixture.page("split-height", "/");
    await page.setViewportSize({ width: 1440, height: 900 });
    const activeInput = () => page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]').getByRole("textbox", { name: "Message composer", exact: true });
    await activeInput().fill("Keep initial draft");
    for (let index = 0; index < 3; index++) {
      const nav = page.getByRole("navigation", { name: "Workspace", exact: true });
      await nav.getByRole("button", { name: "Chats", exact: true }).click();
      await nav.getByRole("button", { name: "New chat", exact: true }).click();
      await activeInput().fill(`Draft ${index}`);
    }
    await expect(page.locator(".dv-groupview:visible")).toHaveCount(4);
    await expect.poll(() => page.locator(".kodex-thread-pane").evaluateAll(panes => panes.map(pane => {
      const input = pane.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message composer"]')!;
      return { short: pane.getBoundingClientRect().height < 600, rows: Math.round(input.getBoundingClientRect().height / parseFloat(getComputedStyle(input).lineHeight)) };
    }))).toEqual([{ short: false, rows: 4 }, { short: false, rows: 4 }, { short: true, rows: 2 }, { short: true, rows: 2 }]);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("mobile inline composer keeps two starting rows in tall and short panes", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, baseURL: test.info().project.use.baseURL });
  const fixture = await nativeSettingsFixture(context);
  try {
    const page = await fixture.page("mobile-height", "/");
    const input = page.getByRole("textbox", { name: "Message composer", exact: true });
    const rows = () => input.evaluate(el => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
    await expect.poll(rows).toBeCloseTo(2, 0);
    await page.setViewportSize({ width: 390, height: 500 });
    await expect.poll(rows).toBeCloseTo(2, 0);
  } finally {
    await fixture.close();
    await context.close();
  }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
