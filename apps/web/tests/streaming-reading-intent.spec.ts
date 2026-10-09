import { compactCanonicalPayload } from "../src/test/canonicalPayloadFixture";
import { expect, test } from "@playwright/test";
import { appendResponseAnnotations } from "../src/composer/annotations";
import type { ThreadTimelineRow } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

function row(id: string, text: string, user = false): ThreadTimelineRow {
  const type = user ? "userMessage" : "agentMessage";
  return { id, turnId: "turn-live", kind: user ? "user_message" : "assistant_message", status: "inProgress", displayOrder: user ? 1 : 2,

    item: { id, threadId: "settings-chat", turnId: "turn-live", itemId: id, itemType: type, status: "inProgress", displayOrder: user ? 1 : 2,
      payload: compactCanonicalPayload(user ? { id, type, content: [{ type: "text", text }] } : { id, type, phase: "final_answer", text }, { id, itemType: type }) } };
}
for (const shape of [{ name: "desktop", width: 1280, touch: false }, { name: "narrow pointer", width: 390, touch: false }, { name: "touch", width: 390, touch: true }]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.touch, isMobile: shape.touch });
    test("expanding a quote preserves reading position until the user resumes following", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const quote = "Read this selected passage. " + "The gateway owns the authoritative state while the client renders it. ".repeat(10);
      const annotation = row("quote", appendResponseAnnotations("Please explain this.", [{ id: "a", text: quote, comment: "Keep this in view." }]), true);
      const answer = row("answer", "Beginning the response.");
      fixture.detail.timeline = { ...fixture.detail.timeline, rows: [annotation, answer], turns: [{ id: "turn-live", status: "inProgress" }], activeTurnId: "turn-live", liveState: "streaming" };
      fixture.detail.thread.status = "active";
      fixture.detail.liveState = "streaming";
      try {
        const page = await fixture.page("reading-intent");
        const summary = page.locator(".kodex-user-annotation-quote summary");
        await expect(summary).toBeVisible();
        await page.waitForTimeout(200);
        const before = (await summary.boundingBox())!.y;
        if (shape.touch) await summary.tap();
        else { await summary.focus(); await page.keyboard.press("Enter"); }
        await expect(summary.locator("..")).toHaveAttribute("open", "");
        for (let i = 0; i < 12; i++) {
          fixture.publishCanonicalEvent({ kind: "thread_view.item_delta", seq: 30 + i,
            payload: { threadId: "settings-chat", turnId: "turn-live", itemId: "answer", delta: "\n\nMore incoming text that should not pull the quote away while it is being read.", viewRevision: 30 + i } }, "reading-intent");
          await page.waitForTimeout(80);
        }
        expect(Math.abs((await summary.boundingBox())!.y - before)).toBeLessThan(2);
        const jump = page.getByRole("button", { name: "Scroll to bottom", exact: true });
        await expect(jump).toBeVisible();
        await jump.click();
        const scroll = page.locator(".kodex-thread-pane-existing .kodex-timeline-scroll");
        await expect.poll(() => scroll.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}

test("a paused short transcript does not offer a redundant return-to-bottom button", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  fixture.detail.timeline = { ...fixture.detail.timeline,
    rows: [row("quote", appendResponseAnnotations("Explain this.", [{ id: "a", text: "A brief source sentence.\nA second brief sentence.", comment: "Why?" }]), true), row("answer", "Beginning.")],
    turns: [{ id: "turn-live", status: "inProgress" }], activeTurnId: "turn-live", liveState: "streaming" };
  try {
    const page = await fixture.page("short-reading");
    const summary = page.locator(".kodex-user-annotation-quote summary");
    const jump = page.getByRole("button", { name: "Scroll to bottom", exact: true });
    await summary.click();
    await expect(summary.locator("..")).toHaveAttribute("open", "");
    fixture.publishCanonicalEvent({ kind: "thread_view.item_delta", seq: 30,
      payload: { threadId: "settings-chat", turnId: "turn-live", itemId: "answer", delta: " Still brief.", viewRevision: 30 } }, "short-reading");
    await expect(page.locator(".kodex-assistant-markdown")).toContainText("Still brief.");
    await expect(jump).toBeHidden();
    const readingY = (await summary.boundingBox())!.y;
    for (let index = 0; index < 8; index += 1) {
      fixture.publishCanonicalEvent({ kind: "thread_view.item_delta", seq: 31 + index,
        payload: { threadId: "settings-chat", turnId: "turn-live", itemId: "answer",
          delta: `\n\n${"Later output must not reclaim an explicitly paused short transcript. ".repeat(4)}`,
          viewRevision: 31 + index } }, "short-reading");
      await page.waitForTimeout(40);
    }
    await expect(page.locator(".kodex-assistant-markdown").filter({ hasText: "Later output must not reclaim" })).toBeAttached();
    expect(Math.abs((await summary.boundingBox())!.y - readingY)).toBeLessThan(2);
    await expect(jump).toBeVisible();
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test.describe("bottom disclosure recovery", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("collapsing untouched work details opened from bottom restores bottom", async ({ context }) => {
    const fixture = await bottomDisclosureFixture(context);
    try {
      const page = await fixture.page("bottom-disclosure-recovery");
      const pane = page.locator(".kodex-thread-pane-existing");
      const scroll = pane.locator(".kodex-timeline-scroll");
      const summary = pane.locator(".kodex-work-row > summary");
      const jump = pane.getByRole("button", { name: "Scroll to bottom", exact: true });
      await expect(pane.locator('[data-initial-bottom-aligned="true"]')).toBeVisible();
      await expect.poll(() => distanceFromBottom(scroll)).toBeLessThan(3);
      const collapsedHeight = await scroll.evaluate((element) => element.scrollHeight);

      await summary.tap();
      await expect(summary.locator("..")).toHaveAttribute("open", "");
      await expect(jump).toBeVisible();
      await expect.poll(() => scroll.evaluate((element) => element.scrollHeight)).toBeGreaterThan(collapsedHeight + 100);

      await summary.tap();
      await expect(summary.locator("..")).not.toHaveAttribute("open", "");
      await expect.poll(() => distanceFromBottom(scroll)).toBeLessThan(3);
      await expect(jump).toBeHidden();
      await expect.poll(() => scroll.evaluate((element) => element.scrollHeight)).toBeLessThan(collapsedHeight + 2);

      fixture.publishCanonicalEvent({
        kind: "thread_view.item_delta",
        seq: 30,
        payload: {
          threadId: "settings-chat",
          turnId: "turn-live",
          itemId: "bottom-answer",
          delta: `\n\n${"New live text should retain the restored bottom follow. ".repeat(12)}`,
          viewRevision: 30,
        },
      }, "bottom-disclosure-recovery");
      await expect(pane.locator(".kodex-assistant-markdown").filter({ hasText: "New live text should retain" })).toBeAttached();
      await expect.poll(() => distanceFromBottom(scroll)).toBeLessThan(3);
      await expect(jump).toBeHidden();
    } finally {
      await fixture.close();
    }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

  test("explicit reading intent prevents collapse from restoring bottom follow", async ({ context }) => {
    const fixture = await bottomDisclosureFixture(context);
    try {
      const page = await fixture.page("bottom-disclosure-paused");
      const pane = page.locator(".kodex-thread-pane-existing");
      const scroll = pane.locator(".kodex-timeline-scroll");
      const summary = pane.locator(".kodex-work-row > summary");
      const jump = pane.getByRole("button", { name: "Scroll to bottom", exact: true });
      await expect(pane.locator('[data-initial-bottom-aligned="true"]')).toBeVisible();
      await expect.poll(() => distanceFromBottom(scroll)).toBeLessThan(3);

      await summary.tap();
      await expect(summary.locator("..")).toHaveAttribute("open", "");
      await selectSummaryText(summary);
      await summary.tap();
      await expect(summary.locator("..")).not.toHaveAttribute("open", "");
      await expect.poll(() => distanceFromBottom(scroll)).toBeLessThan(3);
      await expect(jump).toBeHidden();

      fixture.publishCanonicalEvent({
        kind: "thread_view.item_delta",
        seq: 31,
        payload: {
          threadId: "settings-chat",
          turnId: "turn-live",
          itemId: "bottom-answer",
          delta: `\n\n${"Explicit reading intent must survive the disclosure collapse. ".repeat(12)}`,
          viewRevision: 31,
        },
      }, "bottom-disclosure-paused");
      await expect(pane.locator(".kodex-assistant-markdown").filter({ hasText: "Explicit reading intent must survive" })).toBeAttached();
      await expect.poll(() => distanceFromBottom(scroll)).toBeGreaterThan(60);
      await expect(jump).toBeVisible();
    } finally {
      await fixture.close();
    }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

  test("a reading pause before opening a disclosure is not overwritten by its collapse", async ({ context }) => {
    const fixture = await bottomDisclosureFixture(context);
    try {
      const page = await fixture.page("bottom-disclosure-prior-pause");
      const pane = page.locator(".kodex-thread-pane-existing");
      const scroll = pane.locator(".kodex-timeline-scroll");
      const summary = pane.locator(".kodex-work-row > summary");
      const jump = pane.getByRole("button", { name: "Scroll to bottom", exact: true });
      await expect(pane.locator('[data-initial-bottom-aligned="true"]')).toBeVisible();
      await expect.poll(() => distanceFromBottom(scroll)).toBeLessThan(3);

      await selectSummaryText(summary);
      await summary.tap();
      await expect(summary.locator("..")).toHaveAttribute("open", "");
      await summary.tap();
      await expect(summary.locator("..")).not.toHaveAttribute("open", "");
      await expect.poll(() => distanceFromBottom(scroll)).toBeLessThan(3);
      await expect(jump).toBeHidden();

      fixture.publishCanonicalEvent({
        kind: "thread_view.item_delta",
        seq: 32,
        payload: {
          threadId: "settings-chat",
          turnId: "turn-live",
          itemId: "bottom-answer",
          delta: `\n\n${"A prior reading pause must survive opening and collapsing details. ".repeat(12)}`,
          viewRevision: 32,
        },
      }, "bottom-disclosure-prior-pause");
      await expect(pane.locator(".kodex-assistant-markdown").filter({ hasText: "A prior reading pause must survive" })).toBeAttached();
      await expect.poll(() => distanceFromBottom(scroll)).toBeGreaterThan(60);
      await expect(jump).toBeVisible();
    } finally {
      await fixture.close();
    }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
});

async function selectSummaryText(summary: import("@playwright/test").Locator) {
  await summary.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new Event("selectstart", { bubbles: true }));
    document.dispatchEvent(new Event("selectionchange"));
  });
  await summary.page().waitForTimeout(20);
}

async function bottomDisclosureFixture(context: Parameters<typeof nativeSettingsFixture>[0]) {
  const fixture = await nativeSettingsFixture(context);
  const work = completedWorkRow();
  const answer = withDisplayOrder(row("bottom-answer", "The final response remains below the disclosure."), 101);
  const history = Array.from({ length: 16 }, (_, index) => completedHistoryRow(index));
  fixture.detail.timeline = {
    ...fixture.detail.timeline,
    rows: [...history, work, answer],
    turns: [
      ...history.map((entry) => ({ id: entry.turnId, status: "completed" as const })),
      { id: "turn-live", status: "inProgress" },
    ],
    activeTurnId: "turn-live",
    liveState: "streaming",
  };
  fixture.detail.thread.status = "active";
  fixture.detail.liveState = "streaming";
  return fixture;
}

function completedHistoryRow(index: number): ThreadTimelineRow {
  const id = `history-${index}`;
  const turnId = `history-turn-${index}`;
  const text = `Earlier response ${index}. ` + "Enough text to keep the timeline scrollable. ".repeat(8);
  return {
    id,
    turnId,
    kind: "assistant_message",
    status: "completed",
    displayOrder: index,
    item: {
      id,
      threadId: "settings-chat",
      turnId,
      itemId: id,
      itemType: "agentMessage",
      status: "completed",
      codexMethod: "item/completed",
      displayOrder: index,
      payload: compactCanonicalPayload({ id, type: "agentMessage", phase: "final_answer", text }, { id, itemType: "agentMessage" }),
    },
  };
}

function withDisplayOrder(entry: ThreadTimelineRow, displayOrder: number): ThreadTimelineRow {
  return { ...entry, displayOrder, item: entry.item ? { ...entry.item, displayOrder } : entry.item };
}

function completedWorkRow(): ThreadTimelineRow {
  return {
    id: "bottom-work",
    turnId: "turn-live",
    kind: "work",
    status: "completed",
    displayOrder: 100,
    work: { state: "completed", startedAt: 0, completedAt: 95 },
    collapsedRows: Array.from({ length: 8 }, (_, index) => {
      const nested = completedHistoryRow(100 + index);
      return {
        ...nested,
        id: `bottom-work-item-${index}`,
        turnId: "turn-live",
        displayOrder: 100 + index / 10,
        item: nested.item ? {
          ...nested.item,
          id: `bottom-work-item-${index}`,
          itemId: `bottom-work-item-${index}`,
          turnId: "turn-live",
          displayOrder: 100 + index / 10,
        } : nested.item,
      };
    }),
  };
}

function distanceFromBottom(scroll: import("@playwright/test").Locator) {
  return scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
}
