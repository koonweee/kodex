import { compactCanonicalPayload } from "../src/test/canonicalPayloadFixture";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ThreadTimelineRow } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("selecting an already-open sidebar thread preserves its reading position", async ({ context }) => {
      const fixture = await scrollingFixture(context);
      try {
        const page = await fixture.page("reading", "/threads/settings-chat");
        const pane = page.locator(".kodex-thread-pane-existing");
        const scroll = pane.locator(".kodex-timeline-scroll");
        await expect(pane.locator('[data-initial-bottom-aligned="true"]')).toBeVisible();
        await expect.poll(async () => (await metrics(scroll)).top).toBeGreaterThan(1000);
        await settle(page, scroll);
        await scroll.evaluate(el => {
          el.dispatchEvent(new Event("wheel", { bubbles: true }));
          el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
        });
        await expect(pane.getByRole("button", { name: "Scroll to bottom", exact: true })).toBeVisible();
        await expect.poll(async () => (await metrics(scroll)).bottom).toBeGreaterThan(60);
        await settle(page, scroll);
        const before = await metrics(scroll);
        expect(before.top).toBeGreaterThan(1000);
        expect(before.bottom).toBeGreaterThan(1000);
        const original = await scroll.elementHandle();
        for (let i = 0; i < 3; i += 1) {
          if (shape.width < 900) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
          const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
          await sidebar.getByRole("button", { name: "Chats", exact: true }).click();
          await sidebar.getByRole("button", { name: "Native settings chat", exact: true }).click();
          await expect(scroll).toBeVisible();
          await settle(page, scroll);
          expect(await original!.evaluate(el => el.isConnected)).toBe(true);
          expect((await metrics(scroll)).top).toBeCloseTo(before.top, 0);
        }
        await page.screenshot({ path: test.info().outputPath("sidebar-thread-reading-position.png"), animations: "disabled" });
        expect(fixture.unexpected).toEqual([]);
        expect(fixture.errors).toEqual([]);
      } finally { await fixture.close(); }
    });

    test("sidebar focus preserves a visible inactive split pane's reading position", async ({ context }) => {
      test.skip(shape.width < 900, "Only desktop displays neighboring split panes");
      const fixture = await scrollingFixture(context);
      try {
        const page = await fixture.page("split-reading", "/threads/settings-chat");
        const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
        await sidebar.getByRole("button", { name: "Chats", exact: true }).click();
        await sidebar.getByRole("button", { name: "New chat", exact: true }).click();
        const pane = page.locator(".kodex-thread-pane-existing");
        const scroll = pane.locator(".kodex-timeline-scroll");
        await expect(pane).not.toHaveAttribute("data-workspace-pane-active", "true");
        await expect(pane.locator('[data-initial-bottom-aligned="true"]')).toBeVisible();
        await settle(page, scroll);
        await scroll.evaluate(el => {
          el.dispatchEvent(new Event("wheel", { bubbles: true }));
          el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
        });
        await expect(pane.getByRole("button", { name: "Scroll to bottom", exact: true })).toBeVisible();
        await expect.poll(async () => (await metrics(scroll)).top).toBeGreaterThan(1000);
        await settle(page, scroll);
        const before = await metrics(scroll);
        expect(before.top).toBeGreaterThan(1000);
        expect(before.bottom).toBeGreaterThan(1000);
        const original = await scroll.elementHandle();
        for (let i = 0; i < 3; i += 1) {
          await sidebar.getByRole("button", { name: "Native settings chat", exact: true }).click();
          await expect(pane).toHaveAttribute("data-workspace-pane-active", "true");
          await settle(page, scroll);
          expect(await original!.evaluate(el => el.isConnected)).toBe(true);
          expect((await metrics(scroll)).top).toBeCloseTo(before.top, 0);
          if (i < 2) {
            await page.getByTestId("dockview-dv-default-tab").filter({ hasText: /^New chat$/ }).click();
            await expect(pane).not.toHaveAttribute("data-workspace-pane-active", "true");
          }
        }
        await page.screenshot({ path: test.info().outputPath("sidebar-split-reading-position.png"), animations: "disabled" });
        expect(fixture.unexpected).toEqual([]);
        expect(fixture.errors).toEqual([]);
      } finally { await fixture.close(); }
    });
  });
}

async function scrollingFixture(context: Parameters<typeof nativeSettingsFixture>[0]) {
  const fixture = await nativeSettingsFixture(context);
  fixture.detail.timeline = { ...fixture.detail.timeline,
    rows: Array.from({ length: 80 }, (_, i) => historyRow(i)),
    turns: Array.from({ length: 80 }, (_, i) => ({ id: `turn-${i}`, status: "completed" })),
  };
  return fixture;
}

async function settle(page: Page, scroll: Locator) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => undefined)));
  });
  // Virtuoso measures newly rendered rows after the initial alignment and scroll.
  // Wait for its viewport geometry to remain stable before capturing a reading position.
  await scroll.evaluate(async el => {
    const geometry = () => JSON.stringify({
      top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight,
      rows: [...el.querySelectorAll(".kodex-timeline-virtual-row")].map(row => {
        const rect = row.getBoundingClientRect();
        return [row.getAttribute("data-index"), rect.top, rect.height];
      }),
    });
    let previous = geometry();
    let stableSince = performance.now();
    const deadline = stableSince + 5000;
    while (performance.now() < deadline) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const current = geometry();
      if (current !== previous) {
        previous = current;
        stableSince = performance.now();
      } else if (performance.now() - stableSince >= 250) {
        return;
      }
    }
    throw new Error("Timeline viewport geometry did not settle");
  });
}

async function metrics(scroll: Locator) {
  return scroll.evaluate(el => ({ top: el.scrollTop, bottom: el.scrollHeight - el.clientHeight - el.scrollTop }));
}

function historyRow(index: number): ThreadTimelineRow {
  const id = `message-${index}`;
  const turnId = `turn-${index}`;
  const text = `History message ${index}.\n\n` + "A longer paragraph to keep this timeline scrollable while its existing pane receives focus from the sidebar. ".repeat(5);
  return {
    id, turnId, kind: "assistant_message", status: "completed", displayOrder: index,
    item: { id, threadId: "settings-chat", turnId, itemId: id, itemType: "agentMessage", status: "completed", codexMethod: "item/completed", displayOrder: index,
      payload: compactCanonicalPayload({ id, type: "agentMessage", text }, { id, itemType: "agentMessage" }) },

  };
}
