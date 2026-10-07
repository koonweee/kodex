import { expect, test, type Locator, type Page } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

const groups = (page: Page) => page.locator(".dv-groupview:visible");
const activeDraft = (page: Page) => page.locator('.kodex-thread-pane-empty[data-workspace-pane-active="true"]');
const activeGroup = (page: Page) => groups(page).filter({ has: activeDraft(page) });
const tabs = (page: Page) => page.getByTestId("dockview-dv-default-tab");

async function newDraft(page: Page, text: string) {
  const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
  if (!await sidebar.isVisible()) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await sidebar.getByRole("button", { name: "Chats", exact: true }).click();
  await sidebar.getByRole("button", { name: "New chat", exact: true }).click();
  await activeDraft(page).getByRole("textbox", { name: /message composer/i }).fill(text);
}

async function bounds(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function groupBounds(page: Page) {
  return groups(page).evaluateAll(elements => elements.map(el => {
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x, y, width, height };
  }));
}

// Dockview can redistribute subpixel remainders when tabs are added or restored.
function expectSameBounds(actual: Awaited<ReturnType<typeof groupBounds>>, expected: Awaited<ReturnType<typeof groupBounds>>) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((box, index) => {
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(box[key] - expected[index][key])).toBeLessThan(1);
    }
  });
}

test.describe("automatic pane placement", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("adds three columns, fills lower rows from right to left, then tabs bottom-right independently of focus", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const page = await fixture.page("auto-tiles", "/");
      await activeDraft(page).getByRole("textbox", { name: /message composer/i }).fill("Keep initial draft");
      await expect(groups(page)).toHaveCount(1);
      await newDraft(page, "Keep draft one");
      await expect(groups(page)).toHaveCount(2);
      await tabs(page).first().click();
      await newDraft(page, "Keep draft two");
      await expect(groups(page)).toHaveCount(3);
      const columns = (await groupBounds(page)).sort((a, b) => a.x - b.x);
      for (const column of columns) {
        expect(column.width).toBeGreaterThanOrEqual(359);
        expect(column.height).toBeGreaterThanOrEqual(639);
        expect(column.y).toBeCloseTo(columns[0].y, 0);
      }
      expect(columns[1].x - (columns[0].x + columns[0].width)).toBeCloseTo(1, 1);
      expect(columns[2].x - (columns[1].x + columns[1].width)).toBeCloseTo(1, 1);
      await page.screenshot({ path: test.info().outputPath("three-readable-columns.png"), animations: "disabled" });

      for (const [index, columnIndex] of [2, 1, 0].entries()) {
        await tabs(page).first().click();
        await newDraft(page, `Keep lower draft ${index + 1}`);
        await expect(groups(page)).toHaveCount(4 + index);
        const added = await bounds(activeGroup(page));
        const column = columns[columnIndex];
        expect(Math.abs(added.x - column.x)).toBeLessThanOrEqual(8);
        expect(Math.abs(added.width - column.width)).toBeLessThanOrEqual(8);
        expect(added.y).toBeGreaterThan(column.y + 300);
        for (const box of await groupBounds(page)) {
          expect(box.width).toBeGreaterThanOrEqual(359);
          expect(box.height).toBeGreaterThanOrEqual(319);
        }
      }
      await expect(page.getByRole("textbox", { name: /message composer/i }).filter({ visible: true })).toHaveCount(6);
      await page.screenshot({ path: test.info().outputPath("six-readable-tiles.png"), animations: "disabled" });
      const tiledBounds = await groupBounds(page);
      for (const column of columns) {
        const rows = tiledBounds.filter((box) => Math.abs(box.x - column.x) < 1).sort((a, b) => a.y - b.y);
        expect(rows).toHaveLength(2);
        expect(rows[1].y - (rows[0].y + rows[0].height)).toBeCloseTo(1, 1);
      }
      const bottomRight = tiledBounds.reduce((result, box) => box.x > result.x || (box.x === result.x && box.y > result.y) ? box : result);
      await tabs(page).first().click();
      await newDraft(page, "Keep bottom-right tab");
      await expect(groups(page)).toHaveCount(6);
      await expect(tabs(page)).toHaveCount(7);
      expectSameBounds(await groupBounds(page), tiledBounds);
      const tabPane = await bounds(activeGroup(page));
      expect(tabPane.x).toBeCloseTo(bottomRight.x, 0);
      expect(tabPane.y).toBeCloseTo(bottomRight.y, 0);
      const tabGroup = groups(page).filter({ has: activeDraft(page) });
      await expect(tabGroup.getByTestId("dockview-dv-default-tab")).toHaveCount(2);
      await expect(activeDraft(page).getByRole("textbox", { name: /message composer/i })).toHaveValue("Keep bottom-right tab");
      await page.screenshot({ path: test.info().outputPath("capacity-falls-back-to-bottom-right-tab.png"), animations: "disabled" });
      await expect.poll(() => page.evaluate(() => {
        const saved = localStorage.getItem("kodex.instance.native-settings-fixture:kodex.workspace.panes.v1");
        return saved ? Object.keys(JSON.parse(saved).dockviewLayout?.panels ?? {}).length : 0;
      })).toBe(7);
      await page.reload();
      await expect(groups(page)).toHaveCount(6);
      await expect(tabs(page)).toHaveCount(7);
      expectSameBounds(await groupBounds(page), tiledBounds);
      await expect(groups(page).filter({ has: activeDraft(page) }).getByTestId("dockview-dv-default-tab")).toHaveCount(2);
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

  test("tabs in a manually narrowed right column without seeking room in the focused left column", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const page = await fixture.page("uneven-columns", "/");
      await page.setViewportSize({ width: 1150, height: 900 });
      await activeDraft(page).getByRole("textbox", { name: /message composer/i }).fill("Keep the wide draft");
      await newDraft(page, "Keep the narrow neighbor");
      await expect(groups(page)).toHaveCount(2);
      const left = await bounds(groups(page).nth(0));
      const right = await bounds(groups(page).nth(1));
      const sashX = (left.x + left.width + right.x) / 2;
      await page.mouse.move(sashX, left.y + left.height / 2);
      await page.mouse.down();
      await page.mouse.move(left.x + 530, left.y + left.height / 2, { steps: 12 });
      await page.mouse.up();
      await expect.poll(async () => (await bounds(groups(page).nth(0))).width).toBeGreaterThanOrEqual(500);
      const before = await groupBounds(page);
      expect(before[1].width).toBeLessThan(300);
      await tabs(page).first().click();
      await newDraft(page, "Use the narrow right tab");
      await expect(groups(page)).toHaveCount(2);
      await expect(tabs(page)).toHaveCount(3);
      expect(await groupBounds(page)).toEqual(before);
      const added = await bounds(activeGroup(page));
      expect(added.x).toBeCloseTo(before[1].x, 0);
      await expect(groups(page).nth(1).getByTestId("dockview-dv-default-tab")).toHaveCount(2);
      await page.screenshot({ path: test.info().outputPath("uneven-columns-preserve-resize.png"), animations: "disabled" });
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

  test("preserves manually uneven nested rows while filling the next unsplit column", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const page = await fixture.page("uneven-nested-rows", "/");
      await activeDraft(page).getByRole("textbox", { name: /message composer/i }).fill("Keep the left column");
      await newDraft(page, "Keep the middle column");
      await newDraft(page, "Keep the tall nested row");
      await newDraft(page, "Keep the short nested row");
      await expect(groups(page)).toHaveCount(4);
      const upperGroup = await groups(page).nth(2).elementHandle();
      const lowerGroup = await groups(page).nth(3).elementHandle();
      const upper = (await upperGroup!.boundingBox())!;
      const lower = (await lowerGroup!.boundingBox())!;
      const sashY = (upper.y + upper.height + lower.y) / 2;
      await page.mouse.move(upper.x + upper.width / 2, sashY);
      await page.mouse.down();
      await page.mouse.move(upper.x + upper.width / 2, upper.y + 690, { steps: 12 });
      await page.mouse.up();
      await expect.poll(async () => (await upperGroup!.boundingBox())!.height).toBeGreaterThan(650);
      const resizedUpper = (await upperGroup!.boundingBox())!;
      const resizedLower = (await lowerGroup!.boundingBox())!;
      const middle = await bounds(groups(page).nth(1));
      expect(resizedLower.height).toBeLessThan(320);
      await tabs(page).first().click();
      await newDraft(page, "Fill the middle lower row");
      await expect(groups(page)).toHaveCount(5);
      const added = await bounds(activeGroup(page));
      expect(added.width).toBeGreaterThanOrEqual(359);
      expect(added.height).toBeGreaterThanOrEqual(319);
      expect(added.x).toBeCloseTo(middle.x, 0);
      expect(added.y).toBeGreaterThan(middle.y + 300);
      for (const [group, before] of [[upperGroup!, resizedUpper], [lowerGroup!, resizedLower]] as const) {
        const after = (await group.boundingBox())!;
        expect(after.y).toBe(before.y);
        expect(after.height).toBe(before.height);
        expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(8);
        expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(8);
      }
      await page.screenshot({ path: test.info().outputPath("nested-rows-preserve-resize.png"), animations: "disabled" });
      await newDraft(page, "Fill the left lower row");
      await expect(groups(page)).toHaveCount(6);
      const full = await groupBounds(page);
      // Even the manually enlarged upper row cannot receive a third row.
      await (await upperGroup!.$('[data-testid="dockview-dv-default-tab"]'))!.click();
      await newDraft(page, "Tab without subdividing the tall row");
      await expect(groups(page)).toHaveCount(6);
      await expect(tabs(page)).toHaveCount(7);
      expectSameBounds(await groupBounds(page), full);
      await expect(activeGroup(page).getByTestId("dockview-dv-default-tab")).toHaveCount(2);
      const final = await bounds(activeGroup(page));
      expect(final.y).toBe(resizedLower.y);
      expect(final.height).toBe(resizedLower.height);
      expect(Math.abs(final.x - resizedLower.x)).toBeLessThanOrEqual(8);
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

  test("adds two columns when both panes can be at least 300px wide", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const page = await fixture.page("two-narrow-columns", "/");
      await page.setViewportSize({ width: 950, height: 900 });
      await activeDraft(page).getByRole("textbox", { name: /message composer/i }).fill("Keep initial draft");
      await newDraft(page, "Keep the second column");
      await expect(groups(page)).toHaveCount(2);
      const [left, right] = await groupBounds(page);
      expect(right.x).toBeGreaterThan(left.x + left.width - 2);
      expect(left.width).toBeGreaterThanOrEqual(299);
      expect(right.width).toBeGreaterThanOrEqual(299);
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

  test("stacks once when the workspace is too narrow for two columns", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const page = await fixture.page("narrow-tiles", "/");
      await page.setViewportSize({ width: 910, height: 900 });
      await activeDraft(page).getByRole("textbox", { name: /message composer/i }).fill("Keep initial draft");
      const initial = await bounds(groups(page));
      expect(initial.width).toBeLessThan(606);
      await newDraft(page, "Keep the stacked draft");
      await expect(groups(page)).toHaveCount(2);
      const top = await bounds(groups(page).nth(0));
      const bottom = await bounds(groups(page).nth(1));
      expect(bottom.x).toBeCloseTo(top.x, 0);
      expect(bottom.width).toBeCloseTo(top.width, 0);
      expect(bottom.y).toBeGreaterThan(top.y + top.height - 2);
      expect(bottom.width).toBeGreaterThanOrEqual(359);
      expect(top.height).toBeGreaterThanOrEqual(319);
      expect(bottom.height).toBeGreaterThanOrEqual(319);
      const before = await groupBounds(page);
      await tabs(page).first().click();
      await newDraft(page, "Use a bottom tab at capacity");
      await expect(groups(page)).toHaveCount(2);
      await expect(tabs(page)).toHaveCount(3);
      expect(await groupBounds(page)).toEqual(before);
      await expect(groups(page).nth(1).getByTestId("dockview-dv-default-tab")).toHaveCount(2);
      await page.screenshot({ path: test.info().outputPath("narrow-workspace-stacks.png"), animations: "disabled" });
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

  test("uses a tab when neither split leaves usable pane height", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const page = await fixture.page("short-workspace", "/");
      await page.setViewportSize({ width: 910, height: 600 });
      await activeDraft(page).getByRole("textbox", { name: /message composer/i }).fill("Keep initial draft");
      const before = await bounds(groups(page));
      await newDraft(page, "A full-height tab");
      await expect(groups(page)).toHaveCount(1);
      await expect(tabs(page)).toHaveCount(2);
      expect(await bounds(groups(page))).toEqual(before);
      const twoTabWidth = (await bounds(page.locator(".dv-tabs-container > .dv-tab").first())).width;
      await newDraft(page, "Third tab");
      await newDraft(page, "Fourth tab shares available width");
      const fourTabWidth = (await bounds(page.locator(".dv-tabs-container > .dv-tab").first())).width;
      expect(fourTabWidth).toBeLessThan(twoTabWidth);
      expect(fourTabWidth).toBeGreaterThanOrEqual(120);
      await expect(page.getByRole("button", { name: "More tabs", exact: true })).toHaveCount(0);
      for (let index = 0; index < 4; index++) await newDraft(page, `Overflow tab ${index}`);
      expect((await bounds(page.locator(".dv-tabs-container > .dv-tab").first())).width).toBeGreaterThanOrEqual(120);
      await page.getByRole("button", { name: "More tabs", exact: true }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await page.screenshot({ path: test.info().outputPath("short-workspace-tabs.png"), animations: "disabled" });
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
});
