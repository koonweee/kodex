import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

test.use({ viewport: { width: 910, height: 600 } });

for (const position of ["history", "bottom"] as const) {
  test(`switching dock tabs preserves a thread at ${position}`, async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    fixture.detail.timeline.turns = Array.from({ length: 60 }, (_, index) => ({ id: `turn-${index}`, status: "completed" }));
    fixture.detail.timeline.rows = fixture.detail.timeline.turns.map((turn, index) => {
      const id = `answer-${index}`;
      return {
        id, turnId: turn.id, kind: "assistant_message", status: "completed", displayOrder: index,
        items: [], collapsedRows: [], fileChanges: [],
        item: {
          id, threadId: "settings-chat", turnId: turn.id, itemId: id, itemType: "agentMessage",
          status: "completed", displayOrder: index, codexMethod: "item/completed",
          payload: { source: "appServerSnapshot", turnId: turn.id, itemId: id,
            itemSnapshot: { id, itemType: "agentMessage" },
            item: { id, type: "agentMessage", phase: "final_answer", text: `Message ${index}\n\n${"History content. ".repeat(30)}` } },
        },
      };
    });
    try {
      const page = await fixture.page(`scroll-${position}`);
      const scroll = page.locator(".kodex-thread-pane-scroll");
      await expect(page.locator('[data-initial-bottom-aligned="true"]')).toBeVisible();
      await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(3);
      if (position === "history") {
        await scroll.hover();
        await page.mouse.wheel(0, -1200);
        await expect(page.getByRole("button", { name: "Scroll to bottom", exact: true })).toBeVisible();
      }
      const before = await scroll.evaluate(el => el.scrollTop);
      expect(before).toBeGreaterThan(100);
      for (let i = 0; i < 2; i++) {
        await page.locator(".dv-tab").filter({ hasText: "New chat" }).click();
        await expect(scroll).toBeHidden();
        fixture.publishTimeline({ ...fixture.detail.timeline, viewRevision: (fixture.detail.timeline.viewRevision ?? 0) + 1 });
        await page.locator(".dv-tab").filter({ hasText: "Native settings chat" }).click();
        await expect(scroll).toBeVisible();
        if (position === "bottom") {
          await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(3);
        } else {
          await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeCloseTo(before, 0);
        }
      }
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
