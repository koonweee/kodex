import { expect, test, type Page } from "@playwright/test";
import type { ThreadTimelineRow, ThreadViewPatch, ThreadViewResponse } from "../src/api/client";
import type { LiveDiagnosticsSnapshot } from "../src/events/liveDiagnostics";
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

test("partial lifecycle coverage refills late text once and converges after a missed stream", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  fixture.detail.thread.status = "active";
  fixture.detail.liveState = "streaming";
  fixture.detail.timeline = answerTimeline("Seed", 1);
  const completedAttaches = new Map<Page, number>();
  context.on("response", async (response) => {
    const request = response.request();
    if (request.method() !== "POST" || !response.url().endsWith("/v1/threads/settings-chat/attach") || response.status() !== 200) return;
    if (await response.finished() || request.failure()) return;
    const page = response.frame().page();
    completedAttaches.set(page, (completedAttaches.get(page) ?? 0) + 1);
  });
  const attaches = (client: string) => fixture.requests.filter((request) => request.client === client
    && request.key === "POST /v1/threads/settings-chat/attach" && request.failure() !== "net::ERR_ABORTED").length;
  try {
    const first = await fixture.page("first");
    const second = await fixture.page("second");
    for (const page of [first, second]) {
      await expect(answer(page)).toHaveText("Seed");
      // Settle the initial pane read and actual EventSource-open recovery before
      // budgeting the race. Aborted StrictMode setup is not a completed read.
      await expect.poll(() => completedAttaches.get(page) ?? 0).toBe(2);
    }
    await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
    const initialReads = { first: attaches("first"), second: attaches("second") };
    const opens = new Map(fixture.connections);
    const observerReads = fixture.requests.filter((request) => request.key === "GET /v1/threads/settings-chat").length;
    const lifecycle: ThreadViewPatch = {
      scope: "lifecycle", threadId: fixture.detail.thread.id, viewRevision: 3,
      activeTurnId: "turn-answer", liveState: "streaming", pendingApprovalRequests: [], pendingUserInputRequests: [],
    };
    const lateText = { threadId: fixture.detail.thread.id, turnId: "turn-answer", itemId: "answer", delta: " A", viewRevision: 2 };

    // Observe a completed reducer batch so these two payloads cannot be sorted
    // into revision order inside one batch. No transcript state is injected.
    const beforeLifecycle = await reducerEvents(first);
    fixture.publishCanonicalEvent({ kind: "thread_view.patch", payload: lifecycle, seq: 30 }, "first");
    await expect.poll(() => reducerEvents(first)).toBeGreaterThan(beforeLifecycle);
    fixture.detail.timeline = answerTimeline("Seed A", 3);
    fixture.holdNext("first", "snapshot", "late-text");
    // Equal transport cursor still carries uncopied projection data. The partial
    // lifecycle revision is not proof that this older text is already visible.
    fixture.publishCanonicalEvent({ kind: "thread_view.item_delta", payload: lateText, seq: 30 }, "first");
    await expect.poll(() => fixture.isHeld("first", "snapshot", "late-text")).toBe(true);
    expect(fixture.wasAborted("first", "snapshot", "late-text")).toBe(false);
    await expect(answer(first)).toHaveText("Seed");
    await expect(answer(second)).toHaveText("Seed");
    expect(attaches("first")).toBe(initialReads.first + 1);
    expect(attaches("second")).toBe(initialReads.second);
    expect(fixture.connections).toEqual(opens);
    await fixture.release("first", "snapshot", "late-text");
    await expect(answer(first)).toHaveText("Seed A");

    const beforeReplay = await reducerEvents(first);
    fixture.publishCanonicalEvent({ kind: "thread_view.patch", payload: lifecycle, seq: 31 }, "first");
    fixture.publishCanonicalEvent({ kind: "thread_view.item_delta", payload: lateText, seq: 32 }, "first");
    await expect.poll(() => reducerEvents(first)).toBeGreaterThanOrEqual(beforeReplay + 2);
    await expect(answer(first)).toHaveText("Seed A");
    expect(attaches("first")).toBe(initialReads.first + 1);

    // A lower envelope cursor must also deliver a genuinely newer projection.
    fixture.detail.timeline = answerTimeline("Seed A B", 4);
    fixture.publishCanonicalEvent({ kind: "thread_view.item_delta", payload: { ...lateText, delta: " B", viewRevision: 4 }, seq: 29 }, "first");
    await expect(answer(first)).toHaveText("Seed A B");
    await expect(answer(second)).toHaveText("Seed");
    expect(attaches("first")).toBe(initialReads.first + 1);
    expect(fixture.connections).toEqual(opens);

    fixture.disconnect("second");
    await expect.poll(() => fixture.connections.get("second") ?? 0).toBe((opens.get("second") ?? 0) + 1);
    await expect(answer(second)).toHaveText("Seed A B");
    expect(attaches("second")).toBe(initialReads.second + 1);
    expect(attaches("first")).toBe(initialReads.first + 1);
    expect(fixture.requests.filter((request) => request.key === "GET /v1/threads/settings-chat")).toHaveLength(observerReads);
  } finally {
    await fixture.close();
  }
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

function answer(page: Page) {
  return page.locator('.kodex-thread-pane[data-workspace-pane-active="true"] .kodex-assistant-markdown');
}

async function reducerEvents(page: Page) {
  const diagnostics = await page.evaluate<LiveDiagnosticsSnapshot | undefined>(() => window.__KODEX_LIVE_DIAGNOSTICS__?.());
  return diagnostics?.reducerEventCount ?? 0;
}

function answerTimeline(text: string, viewRevision: number): ThreadViewResponse["timeline"] {
  return {
    activeTurnId: "turn-answer", liveState: "streaming", pendingApprovalRequests: [], pendingUserInputRequests: [], viewRevision,
    turns: [{ id: "turn-answer", status: "inProgress" }],
    rows: [{
      id: "answer", kind: "assistant_message", status: "inProgress", turnId: "turn-answer", displayOrder: 1,
      item: { id: "answer", itemId: "answer", itemType: "agentMessage", threadId: "settings-chat", turnId: "turn-answer", status: "inProgress", displayOrder: 1, codexMethod: "item/started",
        payload: { source: "gatewayStream", turnId: "turn-answer", itemId: "answer", item: { id: "answer", type: "agentMessage", text }, itemSnapshot: { id: "answer", itemType: "agentMessage" } },
      },
      items: [], collapsedRows: [], fileChanges: [],
    }],
  };
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
