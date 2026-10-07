import { expect, test, type Locator, type Page } from "@playwright/test";

import type { ThreadRead, ThreadTimelineRow } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("exact visible read receipts and complete badges survive delayed replies and a missed event in another tab", async ({ context }) => {
      await context.addInitScript(() => {
        const writes: number[] = [];
        Object.assign(window, { badgeWrites: writes });
        Object.defineProperty(navigator, "setAppBadge", { value: async (count: number) => { writes.push(count); } });
        Object.defineProperty(navigator, "clearAppBadge", { value: async () => { writes.push(0); } });
      });
      const fixture = await nativeSettingsFixture(context);
      Object.assign(fixture.badge, { count: 26, readRevision: 9 }); // All 26 are outside the loaded sidebar page.
      const seen = () => fixture.requests.filter((request) => request.key === "POST /v1/threads/settings-chat/seen");
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        for (const page of [first, second]) await expect.poll(() => badge(page)).toBe(26);
        expect(seen()).toEqual([]);
        const opens = new Map(fixture.connections);

        await first.bringToFront();
        fixture.holdNext("first", "seen", "turn-a");
        fixture.readChanged(read("turn-a", null, 10), 27);
        fixture.publishTimeline({ ...fixture.detail.timeline, rows: [row("turn-a")], turns: [{ id: "turn-a", status: "completed" }], viewRevision: 10 }, "first");
        await expect.poll(() => fixture.isHeld("first", "seen", "turn-a")).toBe(true);
        expect(seen().map((request) => request.body)).toEqual([{ completedTurnId: "turn-a", readRevision: 10 }]);
        for (const page of [first, second]) await expect.poll(() => badge(page)).toBe(26);

        // The next native terminal is not yet present in either pane's canonical
        // window. A read tuple alone must never acknowledge it.
        fixture.readChanged(read("turn-b", "turn-a", 12), 27, "first");
        await expect.poll(() => badge(first)).toBe(27);
        expect(await badge(second)).toBe(26);
        expect(seen()).toHaveLength(1);
        await fixture.release("first", "seen", "turn-a");
        await openSidebar(first, shape.hasTouch);
        await expect(first.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("img", { name: /unread completed agent/i })).toBeVisible();
        if (shape.width > 700) await expect(first.locator(".dv-tab").getByRole("img", { name: /unread completed agent/i })).toBeVisible();
        expect(await badge(first)).toBe(27);
        expect(seen()).toHaveLength(1);
        expect(fixture.connections).toEqual(opens);

        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(opens.get("second") ?? 0);
        await expect.poll(() => badge(second)).toBe(27);
        await openSidebar(second, shape.hasTouch);
        await expect(second.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("img", { name: /unread completed agent/i })).toBeVisible();
        if (shape.width > 700) await expect(second.locator(".dv-tab").getByRole("img", { name: /unread completed agent/i })).toBeVisible();
        expect(seen()).toHaveLength(1);

        // Showing the canonical turn, rather than focusing a sidebar row or
        // receiving an idle lifecycle patch, creates the exact receipt.
        await second.bringToFront();
        fixture.publishTimeline({ ...fixture.detail.timeline, rows: [row("turn-b")], turns: [{ id: "turn-b", status: "completed" }], viewRevision: 20 }, "second");
        if (shape.width < 700) {
          // The main pane stays mounted behind the narrow sidebar. Rendered
          // canonical history there is neither a visible read nor presence.
          await expect(second.getByText("Native answer turn-b", { exact: true })).toHaveCount(1);
          await expect(second.getByText("Native answer turn-b", { exact: true })).not.toBeVisible();
          expect(seen()).toHaveLength(1);
          expect(fixture.requests.filter((request) => request.client === "second" && request.key === "PUT /v1/thread-view-presence").at(-1)?.body)
            .toMatchObject({ visibleThreadIds: [] });
          await choose(second.getByRole("button", { name: "Native settings chat", exact: true }), shape.hasTouch);
        }
        await expect.poll(() => seen().length).toBe(2);
        await expect(second.getByText("Native answer turn-b", { exact: true })).toBeVisible();
        await expect.poll(() => seen().map((request) => ({ client: request.client, body: request.body }))).toEqual([
          { client: "first", body: { completedTurnId: "turn-a", readRevision: 10 } },
          { client: "second", body: { completedTurnId: "turn-b", readRevision: 12 } },
        ]);
        for (const page of [first, second]) await expect.poll(() => badge(page)).toBe(26);
        await expect(first.getByRole("img", { name: /unread completed agent/i })).toHaveCount(0);

        // Native completion sends the live terminal patch, invalidates its read
        // head, then asks for persisted canonical history. The refill can
        // replace the unknown-head read; neither may duplicate an answer/ACK.
        await first.bringToFront();
        await choose(first.getByRole("button", { name: "Native settings chat", exact: true }), shape.hasTouch);
        await expect(first.locator('.kodex-thread-pane[data-workspace-pane-active="true"]').getByLabel("Message composer", { exact: true })).toBeVisible();
        const beforeCompletionReads = fixture.requests.filter((request) => request.client === "first" && request.key === "POST /v1/threads/settings-chat/attach").length;
        fixture.publishTimeline({ ...fixture.detail.timeline, rows: [row("turn-c")], turns: [{ id: "turn-c", status: "completed" }], viewRevision: 30 }, "first");
        const known = read("turn-c", "turn-b", 15);
        fixture.readChanged({ ...known, latestCompletedTurnId: null, readRevision: 14, readStateKnown: false, unreadCompletedAgentTurn: false }, 26, "first");
        // Ordinary native reads now reconcile the persisted head. Aggregate
        // reads are silent: the response, not a synthetic read event, is truth.
        const { threadId: _id, updatedAt: _updatedAt, ...tuple } = known;
        Object.assign(fixture.detail.thread, tuple);
        Object.assign(fixture.badge, { count: 27, readRevision: 15 });
        fixture.refreshRequired("first");
        await expect.poll(() => fixture.requests.filter((request) => request.client === "first" && request.key === "POST /v1/threads/settings-chat/attach").length).toBeGreaterThan(beforeCompletionReads);
        await expect(first.getByText("Native answer turn-c", { exact: true })).toHaveCount(1);
        await expect.poll(() => seen().map((request) => request.body)).toEqual([
          { completedTurnId: "turn-a", readRevision: 10 },
          { completedTurnId: "turn-b", readRevision: 12 },
          { completedTurnId: "turn-c", readRevision: 15 },
        ]);
        for (const page of [first, second]) await expect.poll(() => badge(page)).toBe(26);
        await expect(first.getByText("Native answer turn-c", { exact: true })).toHaveCount(1);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

function badge(page: Page) {
  return page.evaluate(() => (window as Window & { badgeWrites?: number[] }).badgeWrites?.at(-1));
}

async function choose(locator: Locator, touch: boolean) { if (touch) await locator.tap(); else await locator.click(); }

async function openSidebar(page: Page, touch: boolean) {
  const sidebar = page.getByRole("navigation", { name: "Workspace", exact: true });
  if (!await sidebar.isVisible()) await choose(page.getByRole("button", { name: /^(Show sidebar|Projects)$/i }), touch);
  await expect(sidebar).toBeVisible();
  const chats = sidebar.getByRole("button", { name: "Chats", exact: true });
  if (await chats.getAttribute("aria-pressed") !== "true") await choose(chats, touch);
  await expect(sidebar.getByRole("button", { name: "Native settings chat", exact: true })).toBeVisible();
}

function read(latest: string, seen: string | null, revision: number): ThreadRead {
  return { threadId: "settings-chat", latestCompletedTurnId: latest, seenCompletedTurnId: seen, readRevision: revision,
    readStateKnown: true, unreadCompletedAgentTurn: latest !== seen, updatedAt: "2026-10-05T00:00:00Z" };
}

function row(turnId: string): ThreadTimelineRow {
  const id = `answer-${turnId}`;
  return { id, turnId, kind: "assistant_message", status: "completed", displayOrder: 1, items: [], collapsedRows: [], fileChanges: [],
    item: { id, threadId: "settings-chat", turnId, itemId: id, itemType: "agentMessage", status: "completed", displayOrder: 1, codexMethod: "item/completed",
      payload: { source: "appServerSnapshot", turnId, itemId: id, itemSnapshot: { id, itemType: "agentMessage" }, item: { id, type: "agentMessage", phase: "final_answer", text: `Native answer ${turnId}` } } } };
}
