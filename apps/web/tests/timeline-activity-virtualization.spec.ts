import { compactCanonicalPayload } from "../src/test/canonicalPayloadFixture";
import { expect, test } from "@playwright/test";

import type { ThreadTimelineRow } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

test("activity disclosure and revealed items survive a virtualized remount", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  const activity = activityRow(100);
  const following = Array.from({ length: 30 }, (_, index) => assistantRow(index + 1));
  fixture.detail.timeline = {
    ...fixture.detail.timeline,
    rows: [activity, ...following],
    turns: [
      { id: activity.turnId, status: "completed" },
      ...following.map((row) => ({ id: row.turnId, status: "completed" as const })),
    ],
    viewRevision: 2,
  };

  try {
    const page = await fixture.page("activity-remount", "/threads/settings-chat");
    const pane = page.locator(".kodex-thread-pane-existing");
    const scroll = pane.locator(".kodex-timeline-scroll");
    await expect(pane.locator('[data-initial-bottom-aligned="true"]')).toBeVisible();
    await scroll.evaluate(element => {
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -10_000 }));
      element.scrollTop = 0;
    });
    await expect(pane.getByRole("button", { name: "Scroll to bottom", exact: true })).toBeVisible();

    const group = pane.locator("details.kodex-activity-group");
    await expect(group).toBeVisible();
    await group.locator(":scope > summary").click();
    await pane.getByRole("button", { name: "Show 20 more", exact: true }).click();
    const lastCommand = pane.locator("details.kodex-activity-item").filter({ hasText: "Ran echo command-99" });
    await lastCommand.locator(":scope > summary").click();
    await expect(lastCommand).toContainText("$ echo command-99");

    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(group).toHaveCount(0);
    await scroll.evaluate(element => { element.scrollTop = 0; });

    await expect(group).toBeVisible();
    await expect(group).toHaveAttribute("open", "");
    await expect(pane.locator("details.kodex-activity-item").filter({ hasText: "Ran echo command-99" })).toContainText("$ echo command-99");
  } finally {
    await fixture.close();
  }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

function activityRow(commandCount: number): ThreadTimelineRow {
  const turnId = "turn-activity";
  return {
    id: "activity",
    turnId,
    kind: "activity",
    status: "completed",
    displayOrder: 0,
    items: Array.from({ length: commandCount }, (_, index) => ({
      id: `command-${index}`,
      threadId: "settings-chat",
      turnId,
      itemId: `command-${index}`,
      itemType: "commandExecution",
      status: "completed",
      codexMethod: "item/completed",
      displayOrder: index,
      payload: { item: { command: `echo command-${index}`, output: `output-${index}`, exitCode: 0 } },
    })),
  };
}

function assistantRow(index: number): ThreadTimelineRow {
  const id = `assistant-${index}`;
  const turnId = `turn-${id}`;
  const text = `Following response ${index}.\n\n${"Content below the activity keeps it outside the virtual window. ".repeat(20)}`;
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
