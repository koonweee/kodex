import { expect, test, type Page } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

const pane = (page: Page) => page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
const composer = (page: Page) => pane(page).getByRole("textbox", { name: "Message composer" });
const rows = (page: Page) => pane(page).getByRole("group", { name: "Queued message" });

for (const width of [1280, 390]) {
  test.describe(`send now at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: false, isMobile: false });
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
        expect(calls("/v1/threads/settings-chat/input").at(-1)?.body).toEqual({ input: [{ type: "text", text: "Immediate correction" }], clientUserMessageId: expect.any(String) });
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
