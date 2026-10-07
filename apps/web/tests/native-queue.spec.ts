import { expect, test, type Locator, type Page } from "@playwright/test";

import { nativeSettingsFixture } from "./native-settings.fixture";
import { appendResponseAnnotations } from "../src/composer/annotations";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("older queued input steers the current native turn and stale tabs converge without resending", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context, { queuedSteerClient: "first" });
      const queuePath = "/v1/threads/settings-chat/queued-inputs";
      fixture.detail.thread.status = "active";
      fixture.detail.liveState = "streaming";
      fixture.detail.timeline = { ...fixture.detail.timeline, activeTurnId: "turn-1", liveState: "streaming", turns: [{ id: "turn-1", status: "inProgress" }] };
      fixture.queuedInputs.push({ id: "older-queue", threadId: "settings-chat", clientUserMessageId: "older-client", input: [{ type: "text", text: "Correction queued during the first turn" }], attachments: [], canSteer: true });
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const page of [first, second]) await expect(queueRows(page).getByRole("button", { name: "Steer", exact: true })).toBeVisible();
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);

        fixture.publishTimeline({ ...fixture.detail.timeline, activeTurnId: null, liveState: "idle", turns: [{ id: "turn-1", status: "completed" }] });
        for (const page of [first, second]) {
          await expect(queueRows(page)).toHaveCount(1);
          await expect(queueRows(page).getByRole("button", { name: "Steer", exact: true })).toHaveCount(0);
        }
        fixture.publishTimeline({ ...fixture.detail.timeline, activeTurnId: "turn-2", liveState: "streaming", turns: [{ id: "turn-1", status: "completed" }, { id: "turn-2", status: "inProgress" }] });
        for (const page of [first, second]) await expect(queueRows(page).getByRole("button", { name: "Steer", exact: true })).toBeEnabled();
        await first.screenshot({ path: test.info().outputPath("older-queue-steer.png") });

        // The acting tab retains a captured queue read and misses the next turn.
        // The gateway selects the request-time turn, independent of that tab.
        fixture.holdNext("first", "queue");
        fixture.queueChanged("first");
        await expect.poll(() => fixture.isHeld("first", "queue")).toBe(true);
        fixture.publishTimeline({ ...fixture.detail.timeline, activeTurnId: "turn-3", liveState: "streaming", turns: [{ id: "turn-1", status: "completed" }, { id: "turn-2", status: "completed" }, { id: "turn-3", status: "inProgress" }] }, "second");
        await click(queueRows(first).getByRole("button", { name: "Steer", exact: true }), shape.hasTouch);
        await expect.poll(() => fixture.transfers.length).toBe(1);
        expect(fixture.transfers[0]).toMatchObject({ nativeQueueId: "older-queue", expectedTurnId: "turn-3", clientUserMessageId: "older-client" });
        for (const page of [first, second]) await expect(queueRows(page)).toHaveCount(0);
        await expect.poll(() => fixture.wasAborted("first", "queue")).toBe(true);
        await fixture.release("first", "queue");
        await expect(queueRows(first)).toHaveCount(0);
        await expect(userMessages(first, "Correction queued during the first turn")).toHaveCount(1);
        await expect(userMessages(second, "Correction queued during the first turn")).toHaveCount(0);

        // A pending receipt and an empty queue must not trigger a second action.
        await composer(first).press("Meta+Enter");
        await composer(first).press("Meta+Enter");
        const connections = fixture.connections.get("second") ?? 0;
        fixture.receiveQueuedTransfer(fixture.transfers[0].id, "native-older-receipt", "first");
        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(connections);
        for (const page of [first, second]) {
          await expect(queueRows(page)).toHaveCount(0);
          await expect(userMessages(page, "Correction queued during the first turn")).toHaveCount(1);
          await expect(page.getByRole("region", { name: "Queue transfers" })).toHaveCount(0);
        }
        expect(fixture.detail.timeline.rows).toHaveLength(1);
        expect(fixture.detail.timeline.rows[0]).toMatchObject({ turnId: "turn-3", item: { itemId: "native-older-receipt" } });
        expect(fixture.requests.filter((request) => request.key === `POST ${queuePath}/older-queue/steer`).map((request) => request.body)).toEqual([null]);
        expect(fixture.requests.filter((request) => ["POST /v1/threads/settings-chat/input", `POST ${queuePath}`, `POST ${queuePath}/steer-first`].includes(request.key))).toHaveLength(0);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });

    test("queued Steer renders one canonical annotated message and reconnects replace its pending receipt", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context, { queuedSteerClient: "first" });
      const text = appendResponseAnnotations("Queued correction", [{ id: "quote", text: "Keep the gateway authoritative.", comment: "Apply this constraint." }]);
      fixture.detail.thread.status = "active";
      fixture.detail.liveState = "streaming";
      fixture.detail.timeline = { ...fixture.detail.timeline, activeTurnId: "turn-1", liveState: "streaming", turns: [{ id: "turn-1", status: "inProgress" }] };
      fixture.queuedInputs.push({ id: "annotated-queue", threadId: "settings-chat", clientUserMessageId: "original-queued-client", input: [{ type: "text", text }], attachments: [], canSteer: true });
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const page of [first, second]) await expect(row(page, "Queued correction")).toBeVisible();
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        await composer(first).fill("Keep my unsent draft");
        if (shape.hasTouch) await click(first.getByRole("button", { name: "Collapse composer", exact: true }), true);
        await click(row(first, "Queued correction").getByRole("button", { name: "Steer", exact: true }), shape.hasTouch);
        await expect(userMessages(first, "Queued correction")).toHaveCount(1);
        await expect(userMessages(second, "Queued correction")).toHaveCount(0);
        for (const page of [first, second]) {
          await expect(queueRows(page)).toHaveCount(0);
          await expect(page.getByRole("region", { name: "Queue transfers" })).toHaveCount(0);
        }
        await expect(composer(first)).toHaveValue("Keep my unsent draft");
        const transfer = fixture.transfers[0];
        const pendingItemId = `pending-user-${transfer.id}`;
        expect(fixture.detail.timeline.rows.map((entry) => entry.item?.itemId)).toEqual([pendingItemId]);
        const pendingConnections = fixture.connections.get("second") ?? 0;
        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(pendingConnections);
        await expect(userMessages(second, "Queued correction")).toHaveCount(1);
        for (const page of [first, second]) {
          const annotation = userMessages(page, "Queued correction").getByRole("group", { name: "Annotation 1", exact: true });
          await expect(annotation.locator("blockquote")).toHaveText("Keep the gateway authoritative.");
          await expect(annotation).toContainText("Apply this constraint.");
          await expect(userMessages(page, "Queued correction")).not.toContainText("<response_annotations>");
        }
        // A receipt replaces the gateway row by native ID. The second tab misses
        // that patch and recovers the same one-bubble view through reconnect.
        fixture.receiveQueuedTransfer(transfer.id, "native-queued-receipt", "first");
        await expect(userMessages(first, "Queued correction")).toHaveCount(1);
        expect(fixture.detail.timeline.rows.map((entry) => entry.item?.itemId)).toEqual(["native-queued-receipt"]);
        const receiptConnections = fixture.connections.get("second") ?? 0;
        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(receiptConnections);
        for (const page of [first, second]) {
          await expect(userMessages(page, "Queued correction")).toHaveCount(1);
          await expect(page.getByRole("region", { name: "Queue transfers" })).toHaveCount(0);
        }
        await expect(composer(first)).toHaveValue("Keep my unsent draft");
        await second.reload();
        await expect(userMessages(second, "Queued correction")).toHaveCount(1);
        expect(fixture.requests.filter((request) => request.key === "POST /v1/threads/settings-chat/queued-inputs/annotated-queue/steer")).toHaveLength(1);
        expect(fixture.requests.filter((request) => request.key === "POST /v1/threads/settings-chat/input")).toHaveLength(0);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });

    test("empty composer Cmd+Enter steers the native front after another tab reorders", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.detail.thread.status = "active";
      fixture.detail.liveState = "streaming";
      fixture.detail.timeline = { ...fixture.detail.timeline, activeTurnId: "turn-1", liveState: "streaming", turns: [{ id: "turn-1", status: "inProgress" }] };
      fixture.queuedInputs.push(...["First queued correction", "Second queued correction"].map((text, index) => ({
        id: `shortcut-${index + 1}`, threadId: "settings-chat", input: [{ type: "text" as const, text }],
        clientUserMessageId: `shortcut-client-${index + 1}`, attachments: [], canSteer: true,
      })));
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const page of [first, second]) await expect(queueRows(page)).toContainText(["First queued correction", "Second queued correction"]);
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);

        // Keep this tab's cached order stale while the other tab mutates native order.
        fixture.holdNext("first", "queue");
        await reorderHandle(second, "Second queued correction").press("ArrowUp");
        await expect.poll(() => fixture.isHeld("first", "queue")).toBe(true);
        await expect(queueRows(second)).toContainText(["Second queued correction", "First queued correction"]);
        await expect(queueRows(first)).toContainText(["First queued correction", "Second queued correction"]);
        await expect(composer(first)).toHaveValue("");
        await composer(first).press("Meta+Enter");
        await expect.poll(() => fixture.transfers.length).toBe(1);
        expect(fixture.transfers[0].nativeQueueId).toBe("shortcut-2");
        if (shape.hasTouch) await click(first.getByRole("button", { name: "Collapse composer", exact: true }), true);
        for (const page of [first, second]) {
          await expect(queueRows(page)).toContainText(["First queued correction"]);
          await expect(userMessages(page, "Second queued correction")).toHaveCount(1);
          await expect(userMessages(page, "First queued correction")).toHaveCount(0);
        }
        await expect.poll(() => fixture.wasAborted("first", "queue")).toBe(true);
        await fixture.release("first", "queue");
        await expect(queueRows(first)).toContainText(["First queued correction"]);
        await expect(composer(first)).toHaveValue("");
        expect(fixture.requests.filter((request) => request.key === "POST /v1/threads/settings-chat/queued-inputs/steer-first")).toHaveLength(1);
        expect(fixture.requests.filter((request) => request.key === "POST /v1/threads/settings-chat/input" || request.key === "POST /v1/threads/settings-chat/queued-inputs")).toHaveLength(0);
        fixture.receiveQueuedTransfer(fixture.transfers[0].id, "native-shortcut-receipt");
        for (const page of [first, second]) await expect(userMessages(page, "Second queued correction")).toHaveCount(1);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });

    test("native queue order, explicit commands and uncertain transfers converge across tabs", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const queuePath = "/v1/threads/settings-chat/queued-inputs";
      const calls = (method: string, path: string) => fixture.requests.filter((request) => request.key === `${method} ${path}`);
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const page of [first, second]) await expect(composer(page)).toBeEnabled();
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        const connections = new Map(fixture.connections);

        // Ordinary Send remains atomic native input even while another turn runs.
        await submit(first, "First native input", "Send message", shape.hasTouch);
        await expect(activePane(second).getByRole("button", { name: "Stop turn", exact: true })).toBeVisible();
        if (shape.hasTouch) {
          await submit(second, "Second native input", "Send message", true);
        } else {
          await composer(second).fill("Second native input");
          await composer(second).press("Enter");
        }
        await expect.poll(() => calls("POST", "/v1/threads/settings-chat/input").length).toBe(2);
        expect(calls("POST", queuePath)).toHaveLength(0);
        if (shape.hasTouch) {
          await submit(first, "First queued work", "Queue message", true);
        } else {
          await composer(first).fill("First queued work");
          await composer(first).press("Meta+Enter");
        }
        for (const page of [first, second]) {
          await expect(queueRows(page)).toHaveCount(1);
          await expect(queueRows(page).getByRole("button", { name: "Reorder queued message", exact: true })).toHaveCount(0);
        }
        await first.screenshot({ path: test.info().outputPath("native-single-queue.png") });
        await submit(second, "Second queued work", "Queue message", shape.hasTouch);
        for (const page of [first, second]) {
          await expect(queueRows(page)).toHaveCount(2);
          await expect(queueRows(page).getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
        }
        expect(calls("POST", queuePath).map((request) => request.body)).toEqual([
          { input: [{ type: "text", text: "First queued work" }], clientUserMessageId: expect.any(String) },
          { input: [{ type: "text", text: "Second queued work" }], clientUserMessageId: expect.any(String) },
        ]);
        expect(fixture.connections).toEqual(connections);
        await first.screenshot({ path: test.info().outputPath("native-queue.png") });

        // Editing one known text field retains unfamiliar native input unchanged.
        fixture.queuedInputs[0].input = [{ type: "text", text: "First queued work", nativeAnnotation: "preserve" }, { type: "futureInput", opaque: { keep: true } }];
        fixture.queueChanged();
        await click(row(first, "First queued work").getByRole("button", { name: "Edit", exact: true }), shape.hasTouch);
        await first.getByLabel("Queued message text", { exact: true }).fill("Edited queued work");
        await click(first.getByRole("button", { name: "Save queued message", exact: true }), shape.hasTouch);
        await expect(row(second, "Edited queued work")).toBeVisible();
        expect(calls("PUT", `${queuePath}/queued-1`).map((request) => request.body)).toEqual([
          { input: [{ type: "text", text: "Edited queued work", nativeAnnotation: "preserve", text_elements: [] }, { type: "futureInput", opaque: { keep: true } }] },
        ]);
        await expect(row(first, "Edited queued work").getByRole("button", { name: "Steer", exact: true })).toBeVisible();
        await dragQueueRow(second, "Second queued work", "Edited queued work", shape.hasTouch);
        for (const page of [first, second]) await expect(queueRows(page).first()).toContainText("Second queued work");
        expect(calls("POST", `${queuePath}/reorder`).map((request) => request.body)).toEqual([{ queuedSubmissionIds: ["queued-2", "queued-1"] }]);

        // A captured queue snapshot may not restore a row removed by another tab.
        fixture.holdNext("second", "queue");
        fixture.queueChanged("second");
        await expect.poll(() => fixture.isHeld("second", "queue")).toBe(true);
        await click(row(first, "Edited queued work").getByRole("button", { name: "Remove", exact: true }), shape.hasTouch);
        for (const page of [first, second]) await expect(queueRows(page)).toHaveCount(1);
        await expect.poll(() => fixture.wasAborted("second", "queue")).toBe(true);
        await fixture.release("second", "queue");
        await expect(row(second, "Edited queued work")).toHaveCount(0);
        expect(calls("DELETE", `${queuePath}/queued-1`)).toHaveLength(1);

        await click(row(first, "Second queued work").getByRole("button", { name: "Steer", exact: true }), shape.hasTouch);
        for (const page of [first, second]) {
          await expect(queueRows(page)).toHaveCount(0);
          await expect(userMessages(page, "Second queued work")).toHaveCount(1);
          await expect(page.getByRole("region", { name: "Queue transfers" })).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
        }
        expect(calls("POST", `${queuePath}/queued-2/steer`)).toHaveLength(1);
        expect(fixture.connections).toEqual(connections);

        // Only one tab receives uncertainty; reopening the other real stream
        // refills native state without a page reload or an automatic resend.
        const transfer = fixture.transfers[0];
        fixture.uncertainQueuedTransfer(transfer.id, "first");
        await expect(first.getByText("Delivery uncertain", { exact: true })).toBeVisible();
        await expect(userMessages(first, "Second queued work")).toHaveCount(0);
        await expect(userMessages(second, "Second queued work")).toHaveCount(1);
        await expect(second.getByRole("region", { name: "Queue transfers" })).toHaveCount(0);
        const beforeReconnect = fixture.connections.get("second") ?? 0;
        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(beforeReconnect);
        await expect(second.getByText("Delivery uncertain", { exact: true })).toBeVisible();
        await expect(userMessages(second, "Second queued work")).toHaveCount(0);
        for (const page of [first, second]) await expect(page.getByRole("button", { name: /^Retry|Resend$/ })).toHaveCount(0);
        await click(second.getByRole("button", { name: "Reconcile", exact: true }), shape.hasTouch);
        await expect.poll(() => calls("POST", `/v1/queue-transfers/${transfer.id}/reconcile`).length).toBe(1);
        await expect(second.getByText("Delivery uncertain", { exact: true })).toBeVisible();
        await click(first.getByRole("button", { name: "Restore to composer", exact: true }), shape.hasTouch);
        const warning = first.getByRole("dialog", { name: "Restore saved input", exact: true });
        await expect(warning).toContainText("may already have been delivered");
        await expect(composer(first)).toHaveValue("");
        await click(warning.getByRole("button", { name: "Restore text", exact: true }), shape.hasTouch);
        await expect(composer(first)).toHaveValue("Second queued work");
        expect(calls("POST", queuePath)).toHaveLength(2);
        expect(calls("POST", "/v1/threads/settings-chat/input")).toHaveLength(2);
        await click(second.getByRole("button", { name: "Dismiss", exact: true }), shape.hasTouch);
        for (const page of [first, second]) await expect(page.getByRole("region", { name: "Queue transfers" })).toHaveCount(0);
        expect(calls("DELETE", `/v1/queue-transfers/${transfer.id}`)).toHaveLength(1);

        fixture.publishTimeline({ ...fixture.detail.timeline, activeTurnId: null, liveState: "idle", turns: [{ id: "turn-1", status: "interrupted" }] });
        await expect(activePane(second).getByRole("button", { name: "Send message", exact: true })).toBeVisible();
        await submit(second, "Idle queued work", "Queue message", shape.hasTouch);
        for (const page of [first, second]) {
          await expect(row(page, "Idle queued work")).toBeVisible();
          await expect(row(page, "Idle queued work").getByRole("button", { name: "Steer", exact: true })).toHaveCount(0);
        }
        for (const page of [first, second]) await expect(queueRows(page).getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
        expect(calls("POST", `${queuePath}/start`)).toHaveLength(0);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });

    test("queue handle cancels interrupted gestures and keyboard changes converge across tabs", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const reorderRequests = () => fixture.requests.filter((request) => request.key === "POST /v1/threads/settings-chat/queued-inputs/reorder");
      fixture.queuedInputs.push(...["First", "Second", "Third"].map((text, index) => ({
        id: `drag-${index + 1}`, threadId: "settings-chat", input: [{ type: "text" as const, text }],
        clientUserMessageId: `drag-client-${index + 1}`, attachments: [], canSteer: false,
      })));
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const page of [first, second]) await expect(queueRows(page)).toHaveCount(3);
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);

        // A tap or cancelled drag never writes an order.
        await click(reorderHandle(first, "Second"), shape.hasTouch);
        expect(reorderRequests()).toHaveLength(0);
        const cancelled = await startQueueDrag(first, "Third", "First", shape.hasTouch);
        await cancelled.cancel();
        for (const page of [first, second]) await expect(queueRows(page)).toHaveText(["First", "Second", "Third"]);
        expect(reorderRequests()).toHaveLength(0);

        // Keyboard users use the same native reorder command as drag users.
        await reorderHandle(second, "Second").press("ArrowUp");
        for (const page of [first, second]) await expect(queueRows(page)).toHaveText(["Second", "First", "Third"]);
        await reorderHandle(first, "Second").press("ArrowDown");
        for (const page of [first, second]) await expect(queueRows(page)).toHaveText(["First", "Second", "Third"]);
        expect(reorderRequests().map((request) => request.body)).toEqual([
          { queuedSubmissionIds: ["drag-2", "drag-1", "drag-3"] },
          { queuedSubmissionIds: ["drag-1", "drag-2", "drag-3"] },
        ]);

        // Another tab removing a row invalidates the captured drag order.
        const stale = await startQueueDrag(first, "Third", "First", shape.hasTouch);
        await click(row(second, "Second").getByRole("button", { name: "Remove", exact: true }), shape.hasTouch);
        for (const page of [first, second]) await expect(queueRows(page)).toHaveCount(2);
        await stale.finish();
        for (const page of [first, second]) await expect(queueRows(page)).toHaveText(["First", "Third"]);
        expect(reorderRequests()).toHaveLength(2);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

test.describe("desktop long queue", () => {
  test.use({ viewport: { width: 1280, height: 844 }, hasTouch: false, isMobile: false });
  test("a stationary drag at the list edge keeps scrolling and cancellation stops without reordering", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    const texts = Array.from({ length: 20 }, (_, index) => `Queued task ${index + 1}`);
    fixture.queuedInputs.push(...texts.map((text, index) => ({
      id: `scroll-${index + 1}`, threadId: "settings-chat", input: [{ type: "text" as const, text }],
      clientUserMessageId: `scroll-client-${index + 1}`, attachments: [], canSteer: false,
    })));
    try {
      const page = await fixture.page("first");
      await expect(queueRows(page)).toHaveCount(texts.length);
      const list = activePane(page).locator(".kodex-queue-list");
      const handle = queueRows(page).first().getByRole("button", { name: "Reorder queued message", exact: true });
      await handle.scrollIntoViewIfNeeded();
      const source = await handle.boundingBox();
      const bounds = await list.boundingBox();
      if (!source || !bounds) throw new Error("Edge scrolling requires a visible queue");
      expect(await list.evaluate((element) => element.scrollHeight)).toBeGreaterThan(bounds.height * 2);
      const x = source.x + source.width / 2;
      await page.mouse.move(x, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, bounds.y + bounds.height - 8, { steps: 8 });

      // Start the stationary phase at the top: movement may already have scrolled
      // far enough that another full page would exceed the list's maximum scroll.
      await list.evaluate((element) => { element.scrollTop = 0; });
      await expect.poll(() => list.evaluate((element) => element.scrollTop), { timeout: 5000 })
        .toBeGreaterThan(bounds.height);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      const cancelledScroll = await list.evaluate((element) => element.scrollTop);
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }));
      expect(await list.evaluate((element) => element.scrollTop)).toBe(cancelledScroll);
      await expect(queueRows(page)).toHaveText(texts);
      expect(fixture.requests.filter((request) => request.key === "POST /v1/threads/settings-chat/queued-inputs/reorder")).toHaveLength(0);
    } finally { await fixture.close(); }
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
});

test("queued annotation edits appear in another tab's editor", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  const original = appendResponseAnnotations("Review sidebar", [{ id: "quote", text: "The sidebar has 12px padding.", comment: "Old note" }]);
  fixture.queuedInputs.push({
    id: "annotated-queue", threadId: "settings-chat", clientUserMessageId: "annotation-client",
    input: [{ type: "text", text: original }, { type: "futureInput", opaque: { keep: true } }],
    attachments: [], canSteer: false,
  });
  try {
    const first = await fixture.page("first");
    const second = await fixture.page("second");
    for (const page of [first, second]) await expect(queueRows(page)).toHaveCount(1);
    await row(first, "Review sidebar").getByRole("button", { name: "Edit" }).click();
    const firstEditor = first.getByRole("dialog", { name: "Edit queued message" });
    await expect(firstEditor).toBeVisible();
    await expect(firstEditor.getByRole("textbox", { name: "Queued message text" })).toHaveValue("Review sidebar");
    await first.screenshot({ path: test.info().outputPath("queued-annotation-editor.png"), animations: "disabled" });
    await firstEditor.getByRole("textbox", { name: "Annotation 1 comment" }).fill("Use 10px");
    await firstEditor.getByRole("button", { name: "Save queued message" }).click();
    const saved = appendResponseAnnotations("Review sidebar", [{ id: "quote", text: "The sidebar has 12px padding.", comment: "Use 10px" }]);
    await expect.poll(() => (fixture.queuedInputs[0].input[0] as { text: string }).text).toBe(saved);
    await expect(row(second, "Review sidebar")).toContainText("Use 10px");
    await row(second, "Review sidebar").getByRole("button", { name: "Edit" }).click();
    await expect(second.getByRole("dialog", { name: "Edit queued message" }).getByRole("textbox", { name: "Annotation 1 comment" })).toHaveValue("Use 10px");
    expect(fixture.queuedInputs[0].input[1]).toEqual({ type: "futureInput", opaque: { keep: true } });
  } finally { await fixture.close(); }
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

function activePane(page: Page) { return page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]'); }
function composer(page: Page) { return activePane(page).getByLabel("Message composer", { exact: true }); }
function queueRows(page: Page) { return activePane(page).getByRole("group", { name: "Queued message", exact: true }); }
function userMessages(page: Page, text: string) { return activePane(page).locator(".kodex-user-message-bubble").filter({ hasText: text }); }
function row(page: Page, text: string) { return queueRows(page).filter({ hasText: text }); }
function reorderHandle(page: Page, text: string) { return row(page, text).getByRole("button", { name: "Reorder queued message", exact: true }); }

async function startQueueDrag(page: Page, text: string, targetText: string, touch: boolean) {
  const handle = reorderHandle(page, text);
  await handle.scrollIntoViewIfNeeded();
  const source = await handle.boundingBox();
  const target = await row(page, targetText).boundingBox();
  if (!source || !target) throw new Error("Queue drag requires visible rows");
  const x = source.x + source.width / 2;
  const startY = source.y + source.height / 2;
  const endY = target.y + target.height / 2;
  if (touch) {
    const session = await page.context().newCDPSession(page);
    const point = (y: number) => [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }];
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(startY) });
    for (let step = 1; step <= 8; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(startY + (endY - startY) * step / 8) });
    }
    return {
      finish: async () => { await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await session.detach(); },
      cancel: async () => { await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }); await session.detach(); },
    };
  }
  await page.mouse.move(x, startY);
  await page.mouse.down();
  await page.mouse.move(x, endY, { steps: 8 });
  return {
    finish: async () => { await page.mouse.up(); },
    cancel: async () => { await page.keyboard.press("Escape"); await page.mouse.up(); },
  };
}
async function dragQueueRow(page: Page, text: string, targetText: string, touch: boolean) {
  const drag = await startQueueDrag(page, text, targetText, touch);
  await drag.finish();
}
async function click(locator: Locator, touch: boolean) { if (touch) await locator.tap(); else await locator.click(); }
async function submit(page: Page, text: string, label: string, touch: boolean) {
  if (touch) {
    await composer(page).tap();
    await expect(activePane(page).getByRole("dialog", { name: "Compose", exact: true })).toBeVisible();
  }
  await composer(page).fill(text);
  await expect(composer(page)).toHaveValue(text);
  if (label === "Queue message") {
    await click(activePane(page).getByRole("button", { name: "Open attachment menu", exact: true }), touch);
    await click(page.getByRole("menuitem", { name: "Queue message", exact: true }), touch);
  } else {
    await click(activePane(page).getByRole("button", { name: label, exact: true }), touch);
  }
}
