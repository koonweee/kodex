import { expect, test, type Page } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

const pane = (page: Page) => page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
const composer = (page: Page) => pane(page).getByRole("textbox", { name: "Message composer" });
const rows = (page: Page) => pane(page).getByRole("group", { name: "Queued message" });

for (const width of [1280, 390]) {
  test.describe(`send now at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: false, isMobile: false });
    test("CmdEnter routes drafts using the native queue and refills two tabs after missed changes", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const inputCalls = () => fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/input");
      const queued = (id: string, text: string) => ({ id, threadId: "settings-chat", clientUserMessageId: id,
        input: [{ type: "text" as const, text }], attachments: [], canSteer: false });
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        await expect(rows(first)).toHaveCount(0);
        await composer(first).fill("Queue the first draft");
        await composer(first).press("Meta+Enter");
        for (const page of [first, second]) {
          await expect(rows(page)).toHaveText(["Queue the first draft"]);
          await expect(pane(page).getByRole("button", { name: "Stop turn", exact: true })).toHaveCount(0);
        }
        await expect(composer(first)).toHaveValue("");
        expect(inputCalls().at(-1)?.body).toMatchObject({ queueIfEmpty: true });

        // Another client drains the queue; first still sees its old queued row.
        fixture.queuedInputs.splice(0);
        fixture.queueChanged("second");
        await expect(rows(second)).toHaveCount(0);
        await expect(rows(first)).toHaveCount(1);
        await composer(first).fill("Queue after a missed drain");
        await composer(first).press("Meta+Enter");
        for (const page of [first, second]) await expect(rows(page)).toHaveText(["Queue after a missed drain"]);
        expect(fixture.detail.timeline.activeTurnId).toBeNull();
        await expect(composer(first)).toHaveValue("");

        fixture.queuedInputs.splice(0);
        fixture.queueChanged();
        for (const page of [first, second]) await expect(rows(page)).toHaveCount(0);
        // Native work arrives without first receiving the queue refill marker.
        fixture.queuedInputs.push(queued("other-client", "Existing native work"));
        fixture.queueChanged("second");
        await expect(rows(second)).toHaveText(["Existing native work"]);
        await expect(rows(first)).toHaveCount(0);
        await composer(first).fill("Send now after a missed addition");
        await composer(first).press("Meta+Enter");
        for (const page of [first, second]) {
          await expect(rows(page)).toHaveText(["Existing native work"]);
          await expect(pane(page).getByRole("button", { name: "Stop turn", exact: true })).toBeVisible();
        }
        expect(fixture.queuedInputs.map(row => row.id)).toEqual(["other-client"]);
        expect(inputCalls()).toHaveLength(3);
        for (const call of inputCalls()) expect(call.body).toMatchObject({ queueIfEmpty: true, clientUserMessageId: expect.any(String) });
        expect(new Set(inputCalls().map(call => (call.body as { clientUserMessageId: string }).clientUserMessageId)).size).toBe(3);
        expect(fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/queued-inputs")).toHaveLength(0);

        // First has no cached queue, but empty-composer dispatch still selects native work.
        fixture.queuedInputs.splice(0);
        fixture.queueChanged();
        for (const page of [first, second]) await expect(rows(page)).toHaveCount(0);
        fixture.queuedInputs.push(queued("hidden-front", "Native front missed by first"));
        fixture.queueChanged("second");
        await expect(rows(second)).toHaveCount(1);
        await expect(rows(first)).toHaveCount(0);
        await composer(first).press("Meta+Enter");
        const frontCalls = () => fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/queued-inputs/steer-first");
        await expect.poll(() => frontCalls().length).toBe(1);
        for (const page of [first, second]) await expect(rows(page)).toHaveCount(0);
        expect(fixture.transfers[0]).toMatchObject({ nativeQueueId: "hidden-front" });
        // Empty native queue remains a quiet no-op, preserving the unresolved transfer.
        fixture.uncertainQueuedTransfer(fixture.transfers[0].id);
        await expect.poll(() => pane(first).getByRole("region", { name: "Queue transfers" }).count()).toBe(1);
        await composer(first).press("Meta+Enter");
        await expect.poll(() => frontCalls().length).toBe(2);
        expect(fixture.transfers).toHaveLength(1);
        expect(inputCalls()).toHaveLength(3);
        await expect(pane(first).getByRole("alert")).toHaveCount(0);
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
    test("Stop keeps queued arrows usable, and draft/empty CmdEnter send now across two tabs", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.detail.thread.status = "active";
      fixture.detail.liveState = "streaming";
      fixture.detail.timeline = { ...fixture.detail.timeline, activeTurnId: "original", liveState: "streaming", turns: [{ id: "original", status: "inProgress" }] };
      fixture.queuedInputs.push(...["First", "Selected", "Last"].map((text) => ({
        id: text.toLowerCase(), threadId: "settings-chat", clientUserMessageId: text,
        input: [{ type: "text" as const, text }], attachments: [], canSteer: true,
      })));
      const queuePath = "/v1/threads/settings-chat/queued-inputs";
      const calls = (path: string) => fixture.requests.filter((request) => request.key === `POST ${path}`);
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        for (const page of [first, second]) await expect(rows(page)).toHaveCount(3);
        await pane(first).getByRole("button", { name: "Stop turn", exact: true }).click();
        for (const page of [first, second]) await expect(rows(page).getByRole("button", { name: "Send now", exact: true })).toHaveCount(3);
        await rows(first).filter({ hasText: "Selected" }).getByRole("button", { name: "Send now", exact: true }).click();
        for (const page of [first, second]) {
          await expect(rows(page)).toHaveText(["First", "Last"]);
          await expect(pane(page).getByRole("button", { name: "Stop turn", exact: true })).toBeVisible();
        }
        expect(fixture.detail.timeline.activeTurnId).toBe("queue-start-selected");
        expect(calls(`${queuePath}/selected/steer`)).toHaveLength(1);

        await composer(first).fill("Wait in order");
        await composer(first).press("Enter");
        for (const page of [first, second]) await expect(rows(page)).toHaveText(["First", "Last", "Wait in order"]);
        expect(calls("/v1/threads/settings-chat/input").at(-1)?.body).toMatchObject({ queueIfPending: true });
        await composer(first).fill("Immediate correction");
        await composer(first).press("Meta+Enter");
        await expect(composer(first)).toHaveValue("");
        await expect.poll(() => calls("/v1/threads/settings-chat/input").length).toBe(2);
        expect(calls("/v1/threads/settings-chat/input").at(-1)?.body).toEqual({ queueIfEmpty: true, input: [{ type: "text", text: "Immediate correction" }], clientUserMessageId: expect.any(String) });
        for (const page of [first, second]) await expect(rows(page)).toHaveText(["First", "Last", "Wait in order"]);

        await pane(second).getByRole("button", { name: "Stop turn", exact: true }).click();
        for (const page of [first, second]) await expect(rows(page).getByRole("button", { name: "Send now", exact: true })).toHaveCount(3);
        await composer(first).fill("Resume immediately");
        await composer(first).press("Meta+Enter");
        await expect(composer(first)).toHaveValue("");
        for (const page of [first, second]) {
          await expect(rows(page)).toHaveText(["First", "Last", "Wait in order"]);
          await expect(pane(page).getByRole("button", { name: "Stop turn", exact: true })).toBeVisible();
        }
        expect(calls("/v1/threads/settings-chat/input").at(-1)?.body).not.toHaveProperty("queueIfPending");
        await pane(second).getByRole("button", { name: "Stop turn", exact: true }).click();
        for (const page of [first, second]) await expect(rows(page).getByRole("button", { name: "Send now", exact: true })).toHaveCount(3);
        await composer(first).press("Meta+Enter");
        for (const page of [first, second]) await expect(rows(page)).toHaveText(["Last", "Wait in order"]);
        expect(fixture.detail.timeline.activeTurnId).toBe("queue-start-first");
        expect(calls(`${queuePath}/steer-first`)).toHaveLength(1);
        expect(calls(queuePath)).toHaveLength(0);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}
