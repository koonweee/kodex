import { compactCanonicalPayload } from "../src/test/canonicalPayloadFixture";
import { expect, test, type Locator } from "@playwright/test";
import type { ThreadTimelineRow } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });

    test("regular rows use six leading pixels without trailing space", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.detail.timeline = {
        ...fixture.detail.timeline,
        rows: [
          completedAnswerRow("first-answer", "First answer", 1),
          completedUserRow("follow-up", "Follow-up question", 2),
          completedWorkRow(3),
        ],
        turns: [
          { id: "turn-first-answer", status: "completed" },
          { id: "turn-follow-up", status: "completed" },
          { id: "turn-work", status: "completed" },
        ],
      };
      try {
        const page = await fixture.page("message-spacing");
        const rows = page.locator(".kodex-turn-group");
        await expect(rows).toHaveCount(3);
        const intermessageGap = await verticalGap(
          rows.nth(0).locator(".kodex-assistant-message-footer"),
          rows.nth(1).locator(".kodex-user-message-stack"),
        );
        const workGap = await verticalGap(
          rows.nth(1).locator(".kodex-message-toolbar"),
          rows.nth(2).locator(".kodex-work-row"),
        );
        const trailingGap = await rows.nth(2).evaluate((row) => {
          const work = row.querySelector(".kodex-work-row");
          if (!(work instanceof HTMLElement)) throw new Error("Missing final work row");
          return row.getBoundingClientRect().bottom - work.getBoundingClientRect().bottom;
        });
        expect(intermessageGap).toBeCloseTo(6, 1);
        expect(workGap).toBeCloseTo(6, 1);
        expect(trailingGap).toBeCloseTo(0, 1);
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });

    test("a short timeline aligns its final row above the composer", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.detail.timeline = {
        ...fixture.detail.timeline,
        activeTurnId: null,
        liveState: "idle",
        rows: [completedAnswerRow("short-answer", "Short final answer", 1)],
        turns: [{ id: "turn-short-answer", status: "completed" }],
      };
      try {
        const page = await fixture.page("short-timeline-alignment");
        const answer = page.getByText("Short final answer", { exact: true });
        const pane = page.locator(".kodex-thread-pane").filter({ has: answer });
        await expect(answer).toBeVisible();
        await expect(pane.locator('[data-initial-bottom-aligned="true"]')).toBeVisible();
        await expect(pane.locator('[data-align-short-to-bottom="true"]')).toBeVisible();

        const row = pane.locator(".kodex-turn-group");
        const scroll = pane.locator(".kodex-thread-pane-scroll");
        const composer = pane.locator(".kodex-composer");
        const [rowBox, scrollBox, composerBox] = await Promise.all([
          row.boundingBox(),
          scroll.boundingBox(),
          composer.boundingBox(),
        ]);
        expect(rowBox).not.toBeNull();
        expect(scrollBox).not.toBeNull();
        expect(composerBox).not.toBeNull();
        expect(scrollBox!.y + scrollBox!.height - (rowBox!.y + rowBox!.height)).toBeCloseTo(16, 0);
        expect(composerBox!.y - (rowBox!.y + rowBox!.height)).toBeCloseTo(24, 0);
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });

    test("streaming footer stays hidden and completion preserves message height", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const publish = (text: string, done = false) => {
        const status = done ? "completed" : "inProgress";
        const row: ThreadTimelineRow = {
          id: "answer", turnId: "turn-answer", kind: "assistant_message", status, displayOrder: 1,

          item: { id: "answer", threadId: "settings-chat", turnId: "turn-answer", itemId: "answer", itemType: "agentMessage", status, displayOrder: 1,
            timestampMs: 1779000000000,
            payload: compactCanonicalPayload({ id: "answer", type: "agentMessage", phase: "final_answer", text }, { id: "answer", itemType: "agentMessage" }) },
        };
        fixture.publishTimeline({ ...fixture.detail.timeline, rows: [row], turns: [{ id: "turn-answer", status }], activeTurnId: done ? null : "turn-answer", liveState: done ? "idle" : "streaming" });
      };
      try {
        const page = await fixture.page("footer");
        await expect.poll(() => fixture.connected("footer")).toBe(true);
        publish("Beginning the answer.");
        const message = page.locator(".kodex-assistant-message-stack");
        const copy = message.getByRole("button", { name: "Copy message", includeHidden: true });
        await expect(message).toContainText("Beginning the answer.");
        await expect(copy).toBeHidden();
        const text = "Beginning the answer.\n\nA longer paragraph that wraps as the answer grows and the pane gets narrower.\n\n- First result\n- Second result";
        publish(text);
        await expect(message).toContainText("Second result");
        await expect(copy).toBeHidden();
        const before = await message.boundingBox();
        publish(text, true);
        await expect(copy).toBeVisible();
        const after = await message.boundingBox();
        expect(Math.abs(after!.height - before!.height)).toBeLessThan(1);
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}

function completedAnswerRow(id: string, text: string, displayOrder: number): ThreadTimelineRow {
  const turnId = `turn-${id}`;
  return {
    id, turnId, kind: "assistant_message", status: "completed", displayOrder,
    item: {
      id, threadId: "settings-chat", turnId, itemId: id, itemType: "agentMessage", status: "completed", displayOrder,
      timestampMs: 1779000000000 + displayOrder,
      payload: compactCanonicalPayload({ id, type: "agentMessage", phase: "final_answer", text }, { id, itemType: "agentMessage" }),
    },
  };
}

function completedUserRow(id: string, text: string, displayOrder: number): ThreadTimelineRow {
  const turnId = `turn-${id}`;
  return {
    id, turnId, kind: "user_message", status: "completed", displayOrder,
    item: {
      id, threadId: "settings-chat", turnId, itemId: id, itemType: "userMessage", status: "completed", displayOrder,
      timestampMs: 1779000000000 + displayOrder,
      payload: compactCanonicalPayload({ id, type: "userMessage", clientId: id, content: [{ type: "text", text }] },
        { id, itemType: "userMessage", clientId: id }),
    },
  };
}

function completedWorkRow(displayOrder: number): ThreadTimelineRow {
  return {
    id: "work", turnId: "turn-work", kind: "work", status: "completed", displayOrder,
    collapsedRows: [], work: { state: "completed", startedAt: 0, completedAt: 1 },
  };
}

async function verticalGap(before: Locator, after: Locator) {
  const [beforeBox, afterBox] = await Promise.all([before.boundingBox(), after.boundingBox()]);
  expect(beforeBox).not.toBeNull();
  expect(afterBox).not.toBeNull();
  return afterBox!.y - (beforeBox!.y + beforeBox!.height);
}
