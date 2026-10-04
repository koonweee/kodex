import { expect, test } from "@playwright/test";
import type { ThreadTimelineRow } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("attach pages preserve distinct native history across two tabs and reconnect", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const recent = [row("middle", 2), row("latest", 3)];
      fixture.detail.timeline = { ...fixture.detail.timeline, rows: recent, turns: ["middle", "latest"].map((id) => ({ id: `turn-${id}`, status: "completed" })), viewRevision: 2 };
      fixture.detail.historyPage = { olderCursor: "opaque:older/+==", newerCursor: null, hasOlder: true, limit: 50, loadedTurnCount: 2, resetWindow: false };
      let olderReads = 0;
      await context.route("**/v1/threads/settings-chat/timeline/pages?*", async (route) => {
        expect(route.request().method()).toBe("GET");
        expect(new URL(route.request().url()).searchParams.get("cursor")).toBe("opaque:older/+==");
        olderReads += 1;
        fixture.detail.timeline = { ...fixture.detail.timeline, rows: [row("oldest", 1), ...recent], turns: ["oldest", "middle", "latest"].map((id) => ({ id: `turn-${id}`, status: "completed" })), viewRevision: 3 };
        fixture.detail.historyPage = { ...fixture.detail.historyPage!, olderCursor: null, hasOlder: false, loadedTurnCount: 3 };
        await route.fulfill({ json: fixture.detail });
      });
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        const bubbles = (page: typeof first) => page.locator('.kodex-thread-pane[data-workspace-pane-active="true"] .kodex-user-message-bubble').filter({ hasText: "Repeated native history" });
        for (const page of [first, second]) await expect(bubbles(page)).toHaveCount(2);
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        // Opening/rebuilding the workspace SSE subscription can request an
        // authoritative refill. Each open and the initial pane load may do so;
        // no second attach effect or error retry loop should add requests.
        // Exclude actually canceled StrictMode setup; this is a browser request
        // budget, not a claim that its dispatched native RPC did not execute.
        for (const client of ["first", "second"]) {
          const calls = fixture.requests.filter((request) => request.client === client && request.key === "POST /v1/threads/settings-chat/attach" && request.failure() !== "net::ERR_ABORTED").length;
          expect(calls).toBeGreaterThan(0);
          expect(calls).toBeLessThanOrEqual((fixture.connections.get(client) ?? 0) + 1);
        }
        const readonlyReads = fixture.requests.filter((request) => request.key === "GET /v1/threads/settings-chat").length;
        const loadOlder = first.getByRole("button", { name: "Load older history", exact: true });
        if (shape.hasTouch) await loadOlder.tap();
        else await loadOlder.click();
        await expect(bubbles(first)).toHaveCount(3);
        expect(olderReads).toBe(1);
        await expect(first.getByRole("button", { name: "Load older history", exact: true })).toHaveCount(0);
        await expect(bubbles(second)).toHaveCount(2);

        const attachReads = fixture.requests.filter((request) => request.client === "second" && request.key === "POST /v1/threads/settings-chat/attach").length;
        const opens = fixture.connections.get("second") ?? 0;
        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(opens);
        await expect(bubbles(second)).toHaveCount(3);
        expect(fixture.requests.filter((request) => request.client === "second" && request.key === "POST /v1/threads/settings-chat/attach").length).toBeGreaterThan(attachReads);
        expect(fixture.requests.filter((request) => request.key === "GET /v1/threads/settings-chat")).toHaveLength(readonlyReads);
        await first.reload();
        await expect(bubbles(first)).toHaveCount(3);
      } finally {
        await fixture.close();
      }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

function row(id: string, displayOrder: number): ThreadTimelineRow {
  const turnId = `turn-${id}`;
  const itemId = `native-${id}`;
  return {
    id: `row-${id}`, turnId, kind: "user_message", status: "completed", displayOrder,
    item: { id: itemId, threadId: "settings-chat", turnId, itemId, itemType: "userMessage", status: "completed", codexMethod: "item/completed", displayOrder,
      payload: { source: "appServerSnapshot", turnId, itemId, itemSnapshot: { id: itemId, itemType: "userMessage", clientId: "reused-client" }, item: { id: itemId, type: "userMessage", clientId: "reused-client", content: [{ type: "text", text: "Repeated native history" }] } },
    }, items: [], collapsedRows: [], fileChanges: [],
  };
}
