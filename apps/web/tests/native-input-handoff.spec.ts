import { expect, test } from "@playwright/test";
import type { ThreadTimelineRow } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

test.use({ viewport: { width: 910, height: 700 } });

function row(id: string, text: string, order: number, clientId?: string): ThreadTimelineRow {
  const user = clientId !== undefined;
  const item = user ? { id, type: "userMessage", clientId, content: [{ type: "text", text }] }
    : { id, type: "agentMessage", phase: "commentary", text };
  return {
    id, turnId: "turn-1", kind: user ? "user_message" : "assistant_message", status: "completed", displayOrder: order,
    items: [], collapsedRows: [], fileChanges: [],
    item: { id, itemId: id, threadId: "settings-chat", turnId: "turn-1", itemType: item.type,
      status: "completed", displayOrder: order, codexMethod: "item/completed",
      payload: { source: "appServerSnapshot", turnId: "turn-1", itemId: id, item,
        itemSnapshot: { id, itemType: item.type, clientId } } },
  };
}

for (const receiptFirst of [false, true]) {
  test(`Send keeps one message in place when ${receiptFirst ? "canonical delivery" : "HTTP acknowledgement"} arrives first`, async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    const previous = row("previous", "Earlier assistant output", 1);
    fixture.detail.timeline = { ...fixture.detail.timeline, rows: [previous], turns: [{ id: "turn-1", status: "inProgress" }], activeTurnId: "turn-1", liveState: "streaming" };
    let clientId: string | undefined;
    let acknowledge: () => void = () => {};
    const gate = new Promise<void>(resolve => { acknowledge = resolve; });
    await context.route("**/v1/threads/settings-chat/input", async route => {
      clientId = route.request().postDataJSON().clientUserMessageId;
      await gate;
      await route.fulfill({ json: { payload: { turn: { id: "turn-1", status: "inProgress" } } } });
    });
    try {
      const sender = await fixture.page("sender");
      const observer = await fixture.page("observer");
      await expect.poll(() => fixture.connected("sender") && fixture.connected("observer")).toBe(true);
      await sender.locator('.kodex-thread-pane[data-workspace-pane-active="true"]').getByRole("textbox", { name: "Message composer", exact: true }).fill("Keep this message in place");
      const response = sender.waitForResponse(r => r.url().endsWith("/input") && r.request().method() === "POST");
      await sender.locator('.kodex-thread-pane[data-workspace-pane-active="true"]').getByRole("textbox", { name: "Message composer", exact: true }).press("Enter");
      await expect.poll(() => clientId).toBeTruthy();
      await expect(sender.getByText("Keep this message in place", { exact: true })).toHaveCount(1);
      await expect(observer.getByText("Keep this message in place", { exact: true })).toHaveCount(0);
      const publish = (id: string) => fixture.publishTimeline({ ...fixture.detail.timeline, rows: [previous,
        row(id, "Keep this message in place", 2, clientId!), row("following", "Following assistant output", 3)] });
      if (receiptFirst) publish("pending-user-input");
      acknowledge();
      await response;
      await expect(sender.getByText("Sending", { exact: true })).toHaveCount(0);
      await expect(sender.getByText("Keep this message in place", { exact: true })).toHaveCount(1);
      if (!receiptFirst) publish("pending-user-input");
      for (const page of [sender, observer]) await expect(page.getByText("Following assistant output", { exact: true })).toBeVisible();
      publish("native-receipt");
      for (const page of [sender, observer]) {
        await expect(page.getByText("Keep this message in place", { exact: true })).toHaveCount(1);
        const positions = await Promise.all(["Earlier assistant output", "Keep this message in place", "Following assistant output"].map(text => page.getByText(text, { exact: true }).evaluate(el => el.getBoundingClientRect().top)));
        expect(positions[0]).toBeLessThan(positions[1]);
        expect(positions[1]).toBeLessThan(positions[2]);
      }
    } finally { acknowledge(); await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
