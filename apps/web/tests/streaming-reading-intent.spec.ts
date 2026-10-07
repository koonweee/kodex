import { expect, test } from "@playwright/test";
import { appendResponseAnnotations } from "../src/composer/annotations";
import type { ThreadTimelineRow } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

function row(id: string, text: string, user = false): ThreadTimelineRow {
  const type = user ? "userMessage" : "agentMessage";
  return { id, turnId: "turn-live", kind: user ? "user_message" : "assistant_message", status: "inProgress", displayOrder: user ? 1 : 2,
    items: [], collapsedRows: [], fileChanges: [],
    item: { id, threadId: "settings-chat", turnId: "turn-live", itemId: id, itemType: type, status: "inProgress", displayOrder: user ? 1 : 2,
      payload: { source: "gatewayStream", turnId: "turn-live", itemId: id, itemSnapshot: { id, itemType: type },
        item: user ? { id, type, content: [{ type: "text", text }] } : { id, type, phase: "final_answer", text } } } };
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
    await page.locator(".kodex-user-annotation-quote summary").click();
    fixture.publishCanonicalEvent({ kind: "thread_view.item_delta", seq: 30,
      payload: { threadId: "settings-chat", turnId: "turn-live", itemId: "answer", delta: " Still brief.", viewRevision: 30 } }, "short-reading");
    await expect(page.locator(".kodex-assistant-markdown")).toContainText("Still brief.");
    await expect(page.getByRole("button", { name: "Scroll to bottom", exact: true })).toBeHidden();
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
