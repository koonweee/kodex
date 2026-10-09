import { compactCanonicalPayload } from "../src/test/canonicalPayloadFixture";
import { expect, test } from "@playwright/test";
import type { ThreadTimelineRow } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
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
