import { expect, test, type Locator } from "@playwright/test";
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
      // The full-width surface now fits two columns; explicitly dock these as tabs.
      await page.locator(".dv-tab").filter({ hasText: "New chat" }).dragTo(
        page.locator(".dv-tab").filter({ hasText: "Native settings chat" }),
      );
      await page.locator(".dv-tab").filter({ hasText: "Native settings chat" }).click();
      const scroll = page.locator(".kodex-thread-pane-scroll");
      await expect(page.locator('[data-initial-bottom-aligned="true"]')).toBeVisible();
      await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(3);
      if (position === "history") {
        await scroll.hover();
        await page.mouse.wheel(0, -1200);
        await expect(page.getByRole("button", { name: "Scroll to bottom", exact: true })).toBeVisible();
      }
      const before = position === "history" ? await settledVisibleAnchor(scroll) : null;
      expect(await scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
      for (let i = 0; i < 2; i++) {
        await page.locator(".dv-tab").filter({ hasText: "New chat" }).click();
        await expect(scroll).toBeHidden();
        fixture.publishTimeline({ ...fixture.detail.timeline, viewRevision: (fixture.detail.timeline.viewRevision ?? 0) + 1 });
        await page.locator(".dv-tab").filter({ hasText: "Native settings chat" }).click();
        await expect(scroll).toBeVisible();
        if (position === "bottom") {
          await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(3);
        } else {
          const after = await settledVisibleAnchor(scroll);
          expect(after.text).toBe(before!.text);
          expect(Math.abs(after.offset - before!.offset)).toBeLessThan(2);
        }
      }
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

async function settledVisibleAnchor(scroll: Locator): Promise<{ text: string; offset: number; totalHeight: number }> {
  let previous: { text: string; offset: number; totalHeight: number } | null = null;
  let stableSamples = 0;
  // The wheel can expose unmeasured rows before Virtuoso finishes its height
  // corrections. Capture a stable reading position before hiding the pane.
  await expect.poll(async () => {
    const next = await scroll.evaluate(el => {
      const viewport = el.getBoundingClientRect();
      const row = [...el.querySelectorAll(".kodex-timeline-virtual-row")].find(candidate => {
        const bounds = candidate.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      });
      if (!row) return null;
      return {
        text: row.querySelector("p")?.textContent ?? "",
        offset: row.getBoundingClientRect().top - viewport.top,
        totalHeight: el.scrollHeight,
      };
    });
    stableSamples = next && previous && next.text === previous.text
      && Math.abs(next.offset - previous.offset) < 1 && next.totalHeight === previous.totalHeight
      ? stableSamples + 1 : 0;
    previous = next;
    return stableSamples;
  }, { intervals: [100] }).toBeGreaterThanOrEqual(3);
  if (!previous) throw new Error("Expected a visible history message");
  return previous;
}
