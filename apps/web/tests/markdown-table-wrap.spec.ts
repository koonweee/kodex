import { compactCanonicalPayload } from "../src/test/canonicalPayloadFixture";
import { expect, test } from "@playwright/test";

import { nativeSettingsFixture } from "./native-settings.fixture";

test("assistant tables keep words intact and scroll within the table when needed", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  const text = [
    "| Area | Pal | Kirbot-pa |",
    "| --- | --- | --- |",
    "| Runtime | Main session and independent task threads | Persistent side sessions and orchestration state |",
    "| Delegation | Main searches, inspects, and delegates | Workers can delegate, consult, and message other sessions |",
  ].join("\n");
  const id = "answer-table";
  fixture.detail.timeline = {
    ...fixture.detail.timeline,
    turns: [{ id: "turn-table", status: "completed" }],
    rows: [{
      id, turnId: "turn-table", kind: "assistant_message", status: "completed", displayOrder: 1,

      item: {
        id, threadId: "settings-chat", turnId: "turn-table", itemId: id, itemType: "agentMessage",
        status: "completed", displayOrder: 1, codexMethod: "item/completed",
        payload: compactCanonicalPayload({ id, type: "agentMessage", phase: "final_answer", text }, { id, itemType: "agentMessage" }),
      },
    }],
  };

  try {
    const page = await fixture.page("table-wrap", "/threads/settings-chat");
    await page.setViewportSize({ width: 950, height: 900 });
    const table = page.getByRole("table");
    await expect(table).toBeVisible();
    const shell = page.locator(".kodex-markdown-table-scroll");
    const dimensions = await shell.evaluate((element) => ({ viewport: element.clientWidth, content: element.scrollWidth }));
    expect(dimensions.content).toBeGreaterThan(dimensions.viewport);
    expect(await shell.evaluate((element) => { element.scrollLeft = 80; return element.scrollLeft; })).toBeGreaterThan(0);
    for (const label of ["Runtime", "Delegation"]) {
      const lines = await table.getByRole("cell", { name: label }).evaluate((cell) => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        return range.getClientRects().length;
      });
      expect(lines).toBe(1);
    }
    const chatScroll = await page.locator(".kodex-thread-pane-scroll").evaluate((element) => ({
      viewport: element.clientWidth, content: element.scrollWidth,
    }));
    expect(chatScroll.content).toBeLessThanOrEqual(chatScroll.viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(950);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
