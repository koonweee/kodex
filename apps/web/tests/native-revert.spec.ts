import { expect, test, type Page } from "@playwright/test";

import type { ThreadTimelineRow } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("native revert fences old reads and converges after a missed reset in another tab", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.detail.timeline = { ...fixture.detail.timeline, rows: [row("kept", 1), row("removed", 2)], turns: [{ id: "turn-kept", status: "completed" }, { id: "turn-removed", status: "completed" }], viewRevision: 2 };
      const attaches = (client: string) => fixture.requests.filter((request) => request.client === client && request.key === "POST /v1/threads/settings-chat/attach").length;
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const page of [first, second]) {
          await expect(message(page, "kept")).toBeVisible();
          await expect(message(page, "removed")).toBeVisible();
        }
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        const opens = new Map(fixture.connections);
        const observerReads = fixture.requests.filter((request) => request.key === "GET /v1/threads/settings-chat").length;

        fixture.holdNext("first", "snapshot");
        fixture.refreshRequired("first");
        await expect.poll(() => fixture.isHeld("first", "snapshot")).toBe(true);
        expect(fixture.wasAborted("first", "snapshot")).toBe(false);
        const beforeResetReads = attaches("first");
        fixture.holdNext("first", "snapshot", "after-revert");
        // Only the first tab sees the native revert's reset plus refetch marker.
        // The fixture captures the old response before changing native history.
        fixture.revertTimeline({ ...fixture.detail.timeline, rows: [row("kept", 1)], turns: [{ id: "turn-kept", status: "completed" }] }, "first");
        await expect.poll(() => fixture.wasAborted("first", "snapshot")).toBe(true);
        await expect.poll(() => attaches("first")).toBeGreaterThan(beforeResetReads);
        await expect.poll(() => fixture.isHeld("first", "snapshot", "after-revert")).toBe(true);
        // The canonical empty reset must take effect while the new read is held.
        // A refresh marker alone is never a source of timeline rows.
        await expect(message(first, "kept")).toHaveCount(0);
        await expect(message(first, "removed")).toHaveCount(0);
        await expect(message(second, "removed")).toBeVisible();
        expect(fixture.connections).toEqual(opens);
        await fixture.release("first", "snapshot");
        await expect(message(first, "kept")).toHaveCount(0);
        await expect(message(first, "removed")).toHaveCount(0);
        await fixture.release("first", "snapshot", "after-revert");
        await expect(message(first, "kept")).toBeVisible();
        await expect(message(first, "removed")).toHaveCount(0);

        const beforeReconnectReads = attaches("second");
        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(opens.get("second") ?? 0);
        await expect.poll(() => attaches("second")).toBeGreaterThan(beforeReconnectReads);
        await expect(message(second, "kept")).toBeVisible();
        await expect(message(second, "removed")).toHaveCount(0);
        expect(fixture.requests.filter((request) => request.key === "GET /v1/threads/settings-chat")).toHaveLength(observerReads);
        expect(fixture.requests.filter((request) => request.key.endsWith("/revert"))).toEqual([]);
        await first.reload();
        await expect(message(first, "kept")).toBeVisible();
        await expect(message(first, "removed")).toHaveCount(0);
      } finally {
        await fixture.close();
      }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

function message(page: Page, id: string) {
  return page.locator('.kodex-thread-pane[data-workspace-pane-active="true"] .kodex-user-message-bubble').filter({ hasText: `Native ${id} history` });
}

function row(id: string, displayOrder: number): ThreadTimelineRow {
  const turnId = `turn-${id}`;
  return {
    id, turnId, kind: "user_message", status: "completed", displayOrder, items: [], collapsedRows: [], fileChanges: [],
    item: { id, threadId: "settings-chat", turnId, itemId: id, itemType: "userMessage", status: "completed", displayOrder, codexMethod: "item/completed", payload: {
      source: "appServerSnapshot", turnId, itemId: id, itemSnapshot: { id, itemType: "userMessage" },
      item: { id, type: "userMessage", content: [{ type: "text", text: `Native ${id} history` }] },
    } },
  };
}
