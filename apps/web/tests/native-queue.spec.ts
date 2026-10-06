import { expect, test, type Locator, type Page } from "@playwright/test";

import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
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
        await click(row(second, "Second queued work").getByRole("button", { name: "Move up", exact: true }), shape.hasTouch);
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
          await expect(page.getByText("Awaiting native receipt", { exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
        }
        expect(calls("POST", `${queuePath}/queued-2/steer`)).toHaveLength(1);
        expect(fixture.connections).toEqual(connections);

        // Only one tab receives uncertainty; reopening the other real stream
        // refills native state without a page reload or an automatic resend.
        const transfer = fixture.transfers[0];
        transfer.phase = "uncertain";
        transfer.error = "Native acknowledgement lost";
        fixture.queueChanged("first", true);
        await expect(first.getByText("Delivery uncertain", { exact: true })).toBeVisible();
        await expect(second.getByText("Awaiting native receipt", { exact: true })).toBeVisible();
        const beforeReconnect = fixture.connections.get("second") ?? 0;
        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(beforeReconnect);
        await expect(second.getByText("Delivery uncertain", { exact: true })).toBeVisible();
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
  });
}

function activePane(page: Page) { return page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]'); }
function composer(page: Page) { return activePane(page).getByLabel("Message composer", { exact: true }); }
function queueRows(page: Page) { return activePane(page).getByRole("group", { name: "Queued message", exact: true }); }
function row(page: Page, text: string) { return queueRows(page).filter({ hasText: text }); }
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
