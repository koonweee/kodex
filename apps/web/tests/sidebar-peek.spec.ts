import { expect, test, type Locator, type Page } from "@playwright/test";

import { nativeProjectsFixture, preservedHistory } from "./native-projects.fixture";

test.describe("desktop sidebar peek", () => {
  test.use({ viewport: { width: 1280, height: 844 }, hasTouch: false, isMobile: false });

  test("cancels brief hovers, overlays without moving the pane, and pins explicitly", async ({ context }) => {
    const fixture = await nativeProjectsFixture(context);
    try {
      const first = await fixture.page("first", "/threads/history");
      const second = await fixture.page("second", "/threads/history");
      await expect(first.getByRole("button", { name: "Collapse workspace sidebar", exact: true })).toBeVisible();
      const expandedSidebar = first.getByRole("navigation", { name: "Workspace", exact: true });
      const expandedRect = await rectangle(expandedSidebar);
      for (const page of [first, second]) {
        await expect(page.getByText(preservedHistory, { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Collapse workspace sidebar", exact: true }).click();
        await moveOutside(page);
      }
      const preview = first.locator(".kodex-sidebar-peek-panel");
      const trigger = first.getByRole("button", { name: "Expand workspace sidebar", exact: true });
      const pane = first.locator(".kodex-main-stack");
      await expect.poll(() => pane.evaluate((element) => element.getBoundingClientRect().x)).toBe(44);
      const initialRect = await rectangle(pane);
      const railRect = await rectangle(first.getByRole("navigation", { name: "Workspace", exact: true }));
      await trigger.hover();
      await first.waitForTimeout(60);
      await moveOutside(first);
      await first.waitForTimeout(450);
      await expect(preview).toHaveCount(0);
      await trigger.hover();
      await expect(preview).toBeVisible();
      await expect(preview.getByRole("button", { name: "Projects", exact: true })).toBeVisible();
      await expect.poll(() => rectangle(preview)).toEqual({ ...expandedRect, x: railRect.x + railRect.width });
      await expect.poll(() => rectangle(pane)).toEqual(initialRect);
      await expect(second.locator(".kodex-sidebar-peek-panel")).toHaveCount(0);
      await expect(second.getByRole("button", { name: "Expand workspace sidebar", exact: true })).toBeVisible();
      await first.screenshot({ path: test.info().outputPath("sidebar-peek.png") });
      await moveOutside(first);
      await expect(preview).toHaveCount(0);
      await trigger.hover();
      await expect(preview).toBeVisible();
      await expect(preview.getByRole("button", { name: /workspace sidebar/ })).toHaveCount(0);
      await expect(trigger).toBeVisible();
      await trigger.click();
      await moveOutside(first);
      await expect(preview).toHaveCount(0);
      await expect(first.getByRole("button", { name: "Collapse workspace sidebar", exact: true })).toBeVisible();
      await expect.poll(() => pane.evaluate((element) => element.getBoundingClientRect().x)).toBe(292);
      await expect(second.getByRole("button", { name: "Expand workspace sidebar", exact: true })).toBeVisible();
      await first.reload();
      await expect(first.getByRole("button", { name: "Collapse workspace sidebar", exact: true })).toBeVisible();
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally { await fixture.close(); }
  });

  test("pins when clicking the original hover trigger and stays closed after Escape", async ({ context }) => {
    const fixture = await nativeProjectsFixture(context);
    try {
      const page = await fixture.page("first", "/threads/history");
      await page.getByRole("button", { name: "Collapse workspace sidebar", exact: true }).click();
      await moveOutside(page);
      const trigger = page.getByRole("button", { name: "Expand workspace sidebar", exact: true });
      await expect.poll(() => page.getByRole("navigation", { name: "Workspace", exact: true }).evaluate((element) => element.getBoundingClientRect().width)).toBe(44);
      const bounds = await trigger.boundingBox();
      if (!bounds) throw new Error("Missing expand button");
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      await page.mouse.move(x, y);
      const preview = page.locator(".kodex-sidebar-peek-panel");
      await expect(preview).toBeVisible();
      await page.mouse.click(x, y);
      await expect(page.getByRole("button", { name: "Collapse workspace sidebar", exact: true })).toBeVisible();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await page.getByRole("button", { name: "Collapse workspace sidebar", exact: true }).click();
      await moveOutside(page);
      await expect.poll(() => page.getByRole("navigation", { name: "Workspace", exact: true }).evaluate((element) => element.getBoundingClientRect().width)).toBe(44);
      await page.mouse.move(x, y);
      await expect(preview).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(preview).toHaveCount(0);
      await page.waitForTimeout(600);
      await expect(preview).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await moveOutside(page);
      await trigger.hover();
      await expect(preview).toBeVisible();
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally { await fixture.close(); }
  });

  test("keeps a portaled thread menu usable and restores keyboard focus on Escape", async ({ context }) => {
    const fixture = await nativeProjectsFixture(context);
    fixture.pinThread("history", true);
    try {
      const page = await fixture.page("first", "/threads/history");
      await expect(page.getByText(preservedHistory, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Collapse workspace sidebar", exact: true }).click();
      await moveOutside(page);
      const trigger = page.getByRole("button", { name: "Expand workspace sidebar", exact: true });
      const preview = page.locator(".kodex-sidebar-peek-panel");
      await trigger.hover();
      await expect(preview).toBeVisible();
      const actions = preview.getByRole("button", { name: "Thread actions for History chat", exact: true });
      await preview.getByRole("button", { name: "History chat", exact: true }).hover();
      await actions.click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      expect(await menu.evaluate((element) => element.closest('nav[aria-label="Workspace"]') === null)).toBe(true);
      await menu.getByRole("menuitem", { name: "Archive thread", exact: true }).hover();
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
      await page.waitForTimeout(500);
      await expect(preview).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Archive thread", exact: true })).toBeVisible();
      await menu.getByRole("menuitem", { name: "Archive thread", exact: true }).focus();
      await moveOutside(page);
      await page.waitForTimeout(500);
      await expect(preview).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(actions).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(preview).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Collapse workspace sidebar", exact: true })).toBeVisible();
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally { await fixture.close(); }
  });
});

test.describe("wide touch sidebar", () => {
  test.use({ viewport: { width: 1280, height: 844 }, hasTouch: true, isMobile: false });

  test("does not hover-peek and expands through an explicit tap", async ({ context }) => {
    const fixture = await nativeProjectsFixture(context);
    try {
      const page = await fixture.page("first", "/threads/history");
      await expect(page.getByText(preservedHistory, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Collapse workspace sidebar", exact: true }).tap();
      const trigger = page.getByRole("button", { name: "Expand workspace sidebar", exact: true });
      await trigger.hover();
      await page.waitForTimeout(450);
      await expect(page.locator(".kodex-sidebar-peek-panel")).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: "Projects", exact: true })).toHaveCount(0);
      await trigger.tap();
      await expect(page.getByRole("button", { name: "Collapse workspace sidebar", exact: true })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: "Projects", exact: true })).toBeVisible();
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally { await fixture.close(); }
  });
});

test.describe("reduced-motion desktop sidebar", () => {
  test.use({ viewport: { width: 1280, height: 844 }, hasTouch: false, isMobile: false, contextOptions: { reducedMotion: "reduce" } });

  test("opens a usable preview without animated movement", async ({ context }) => {
    const fixture = await nativeProjectsFixture(context);
    try {
      const page = await fixture.page("first", "/threads/history");
      expect(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
      await expect(page.getByText(preservedHistory, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Collapse workspace sidebar", exact: true }).click();
      await moveOutside(page);
      const trigger = page.getByRole("button", { name: "Expand workspace sidebar", exact: true });
      const preview = page.locator(".kodex-sidebar-peek-panel");
      await trigger.hover();
      await expect(preview).toBeVisible();
      const motion = await preview.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          hasTransitions: style.transitionDuration.split(",").some((duration) => parseFloat(duration) > 0),
          hasAnimations: element.getAnimations().length > 0 || style.animationDuration.split(",").some((duration) => parseFloat(duration) > 0),
          opacity: style.opacity,
          transform: style.transform,
        };
      });
      expect(motion).toEqual({ hasTransitions: false, hasAnimations: false, opacity: "1", transform: "none" });
      await preview.getByRole("button", { name: "Search", exact: true }).click();
      const search = preview.getByRole("textbox", { name: "Search", exact: true });
      await expect(search).toBeFocused();
      await search.fill("Alpha");
      await expect(preview.getByRole("group", { name: "Alpha", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(preview).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    } finally { await fixture.close(); }
  });
});

for (const shape of [
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("uses explicit mobile navigation without a hover preview", async ({ context }) => {
      const fixture = await nativeProjectsFixture(context);
      try {
        const page = await fixture.page("first", "/threads/history");
        await expect(page.getByText(preservedHistory, { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
        const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
        const thread = sidebar.getByRole("button", { name: "History chat", exact: true });
        await expect(thread).toBeVisible();
        if (!shape.hasTouch) await thread.hover();
        await expect(page.locator(".kodex-sidebar-peek-panel")).toHaveCount(0);
        await expect(sidebar.getByRole("button", { name: "Expand workspace sidebar", exact: true })).toHaveCount(0);
        if (shape.hasTouch) await thread.tap();
        else await thread.click();
        await expect(sidebar).toBeHidden();
        await expect(page.getByText(preservedHistory, { exact: true })).toBeVisible();
        expect(fixture.errors).toEqual([]);
        expect(fixture.unexpected).toEqual([]);
      } finally { await fixture.close(); }
    });
  });
}

async function moveOutside(page: Page) {
  await page.mouse.move(1100, 700);
}

async function rectangle(locator: Locator) {
  return locator.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  });
}
