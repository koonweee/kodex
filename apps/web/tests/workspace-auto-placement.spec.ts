import { expect, test, type Locator, type Page } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

const groups = (page: Page) => page.locator(".dv-groupview:visible");
const activeDraft = (page: Page) => page.locator('.kodex-thread-pane-empty[data-workspace-pane-active="true"]');

async function newDraft(page: Page, text: string) {
  const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
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

test.describe("automatic pane placement", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("tiles readable columns vertically, then uses another roomy column and finally a tab", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const page = await fixture.page("auto-tiles", "/");
      const initialPane = page.locator(".kodex-thread-pane-empty").first();
      await initialPane.getByRole("textbox", { name: /message composer/i }).fill("Keep initial draft");
      await expect(groups(page)).toHaveCount(1);
      await newDraft(page, "Keep draft one");
      await expect(groups(page)).toHaveCount(2);
      const firstDraft = activeDraft(page);
      const initialExisting = await bounds(initialPane);
      const initialDraft = await bounds(firstDraft);
      expect(initialDraft.x).toBeGreaterThan(initialExisting.x + initialExisting.width - 2);
      expect(initialDraft.y).toBeCloseTo(initialExisting.y, 0);
      expect(initialExisting.width).toBeGreaterThanOrEqual(479);
      expect(initialDraft.width).toBeGreaterThanOrEqual(479);

      await newDraft(page, "Keep draft two");
      await expect(groups(page)).toHaveCount(3);
      const visibleComposers = page.getByRole("textbox", { name: /message composer/i }).filter({ visible: true });
      const secondBox = await bounds(activeDraft(page));
      expect(Math.abs(secondBox.x - initialDraft.x)).toBeLessThanOrEqual(8);
      expect(Math.abs(secondBox.width - initialDraft.width)).toBeLessThanOrEqual(8);
      expect(secondBox.y).toBeGreaterThan(initialDraft.y + 100);
      await expect(visibleComposers).toHaveCount(3);

      await newDraft(page, "Keep draft three");
      await expect(groups(page)).toHaveCount(4);
      const thirdBox = await bounds(activeDraft(page));
      expect(Math.abs(thirdBox.x - initialExisting.x)).toBeLessThanOrEqual(8);
      expect(thirdBox.y).toBeGreaterThan(initialExisting.y + 100);
      for (const group of await groups(page).all()) {
        const box = await bounds(group);
        expect(box.width).toBeGreaterThanOrEqual(479);
        expect(box.height).toBeGreaterThanOrEqual(319);
      }
      await page.screenshot({ path: test.info().outputPath("four-readable-tiles.png"), animations: "disabled" });

      const tiledBounds = await groups(page).evaluateAll(elements => elements.map(el => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return { x, y, width, height };
      }));
      await newDraft(page, "Keep draft four");
      await expect(groups(page)).toHaveCount(4);
      await expect(page.getByTestId("dockview-dv-default-tab")).toHaveCount(5);
      expect(await groups(page).evaluateAll(elements => elements.map(el => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return { x, y, width, height };
      }))).toEqual(tiledBounds);
      await expect(activeDraft(page).getByRole("textbox", { name: /message composer/i })).toHaveValue("Keep draft four");
      await page.screenshot({ path: test.info().outputPath("capacity-falls-back-to-tab.png"), animations: "disabled" });
      await expect.poll(() => page.evaluate(() => {
        const saved = localStorage.getItem("kodex.instance.native-settings-fixture:kodex.workspace.panes.v1");
        return saved ? Object.keys(JSON.parse(saved).dockviewLayout?.panels ?? {}).length : 0;
      })).toBe(5);
      await page.reload();
      await expect(groups(page)).toHaveCount(4);
      await expect(page.getByTestId("dockview-dv-default-tab")).toHaveCount(5);
      expect(await groups(page).evaluateAll(elements => elements.map(el => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return { x, y, width, height };
      }))).toEqual(tiledBounds);
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

  test("splits a manually widened column without redistributing its narrow neighbor", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const page = await fixture.page("uneven-columns", "/");
      await page.setViewportSize({ width: 1600, height: 900 });
      const initialPane = page.locator(".kodex-thread-pane-empty").first();
      await initialPane.getByRole("textbox", { name: /message composer/i }).fill("Keep the wide draft");
      await newDraft(page, "Keep the narrow neighbor");
      await expect(groups(page)).toHaveCount(2);
      const left = await bounds(groups(page).nth(0));
      const right = await bounds(groups(page).nth(1));
      const sashX = (left.x + left.width + right.x) / 2;
      await page.mouse.move(sashX, left.y + left.height / 2);
      await page.mouse.down();
      await page.mouse.move(left.x + 1040, left.y + left.height / 2, { steps: 12 });
      await page.mouse.up();
      await expect.poll(async () => (await bounds(groups(page).nth(0))).width).toBeGreaterThanOrEqual(1000);
      const narrowNeighbor = await bounds(groups(page).nth(1));
      expect(narrowNeighbor.width).toBeLessThan(480);
      await page.getByTestId("dockview-dv-default-tab").first().click();
      await newDraft(page, "Split the wide draft");
      await expect(groups(page)).toHaveCount(3);
      const sourceBox = await bounds(initialPane);
      const addedBox = await bounds(activeDraft(page));
      expect(sourceBox.width).toBeGreaterThanOrEqual(479);
      expect(addedBox.width).toBeGreaterThanOrEqual(479);
      expect(sourceBox.height).toBeGreaterThanOrEqual(319);
      expect(addedBox.height).toBeGreaterThanOrEqual(319);
      expect(addedBox.x >= sourceBox.x + sourceBox.width - 2 || addedBox.y >= sourceBox.y + sourceBox.height - 2).toBe(true);
      const neighborAfter = await bounds(groups(page).last());
      expect(Math.abs(neighborAfter.width - narrowNeighbor.width)).toBeLessThanOrEqual(8);
      await page.screenshot({ path: test.info().outputPath("uneven-columns-preserve-neighbor.png"), animations: "disabled" });
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

  test("preserves manually uneven rows inside a nested column when placing another pane", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const page = await fixture.page("uneven-nested-rows", "/");
      const initialPane = page.locator(".kodex-thread-pane-empty").first();
      await initialPane.getByRole("textbox", { name: /message composer/i }).fill("Keep the unsplit column");
      await newDraft(page, "Keep the tall nested row");
      await newDraft(page, "Keep the short nested row");
      await expect(groups(page)).toHaveCount(3);
      const upperGroup = await groups(page).nth(1).elementHandle();
      const lowerGroup = await groups(page).nth(2).elementHandle();
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
      expect(resizedLower.height).toBeLessThan(320);
      await page.getByTestId("dockview-dv-default-tab").nth(1).click();
      await newDraft(page, "Find another usable split");
      await expect(groups(page)).toHaveCount(4);
      const added = await bounds(activeDraft(page));
      expect(added.width).toBeGreaterThanOrEqual(479);
      expect(added.height).toBeGreaterThanOrEqual(319);
      expect(added.x).toBeLessThan(resizedUpper.x);
      for (const [group, before] of [[upperGroup!, resizedUpper], [lowerGroup!, resizedLower]] as const) {
        const after = (await group.boundingBox())!;
        expect(after.y).toBe(before.y);
        expect(after.height).toBe(before.height);
        expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(8);
        expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(8);
      }
      await page.screenshot({ path: test.info().outputPath("nested-rows-preserve-resize.png"), animations: "disabled" });
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

  test("stacks panes when the workspace is too narrow for two readable columns", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const page = await fixture.page("narrow-tiles", "/");
      await page.setViewportSize({ width: 1050, height: 900 });
      const initialPane = page.locator(".kodex-thread-pane-empty").first();
      await initialPane.getByRole("textbox", { name: /message composer/i }).fill("Keep initial draft");
      await expect(initialPane).toBeVisible();
      await newDraft(page, "Keep the stacked draft");
      await expect(groups(page)).toHaveCount(2);
      const top = await bounds(initialPane);
      const bottom = await bounds(activeDraft(page));
      expect(bottom.x).toBeCloseTo(top.x, 0);
      expect(bottom.width).toBeCloseTo(top.width, 0);
      expect(bottom.y).toBeGreaterThan(top.y + top.height - 2);
      expect(bottom.width).toBeGreaterThanOrEqual(479);
      await newDraft(page, "Use a tab at capacity");
      await expect(groups(page)).toHaveCount(2);
      await expect(page.getByTestId("dockview-dv-default-tab")).toHaveCount(3);
      await page.screenshot({ path: test.info().outputPath("narrow-workspace-stacks.png"), animations: "disabled" });
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

  test("uses a tab when neither split leaves usable pane height", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const page = await fixture.page("short-workspace", "/");
      await page.setViewportSize({ width: 1050, height: 600 });
      const initialPane = page.locator(".kodex-thread-pane-empty").first();
      await initialPane.getByRole("textbox", { name: /message composer/i }).fill("Keep initial draft");
      await expect(initialPane).toBeVisible();
      const before = await bounds(groups(page));
      await newDraft(page, "A full-height tab");
      await expect(groups(page)).toHaveCount(1);
      await expect(page.getByTestId("dockview-dv-default-tab")).toHaveCount(2);
      expect(await bounds(groups(page))).toEqual(before);
      await page.screenshot({ path: test.info().outputPath("short-workspace-tabs.png"), animations: "disabled" });
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
});
