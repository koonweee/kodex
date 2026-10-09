import { compactCanonicalPayload } from "../src/test/canonicalPayloadFixture";
import { expect, test, type Page, type Route } from "@playwright/test";
import type { ThreadTimelineSnapshotItem } from "../src/api/client";
import type { components } from "../src/api/generated/schema";
import { nativeSettingsFixture } from "./native-settings.fixture";

type TurnStartRequest = components["schemas"]["TurnStartRequest"];

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("identical inputs in two tabs reconcile only their native client IDs", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const held: Array<{ route: Route; body: TurnStartRequest }> = [];
      await context.route("**/v1/threads/settings-chat/input", async (route) => {
        held.push({ route, body: route.request().postDataJSON() as TurnStartRequest });
      });
      const rows: ThreadTimelineSnapshotItem[] = [];
      function publish(id: string, clientId: string | null, client?: string) {
        const raw = { id, type: "userMessage", clientId, content: [{ type: "text", text: "Identical input" }] };
        const item: ThreadTimelineSnapshotItem = {
          id: `row-${id}`, threadId: "settings-chat", turnId: "native-turn", itemId: id, itemType: "userMessage", status: "completed", codexMethod: "item/completed", displayOrder: rows.length + 1,
          payload: compactCanonicalPayload(raw, { id, clientId, itemType: "userMessage" }),
        };
        rows.push(item);
        fixture.publishTimeline({ activeTurnId: "native-turn", liveState: "streaming", pendingApprovalRequests: [], pendingUserInputRequests: [], viewRevision: rows.length + 1, turns: [{ id: "native-turn", status: "inProgress" }], rows: rows.map((item) => ({ id: item.id, turnId: item.turnId, kind: "user_message", status: "completed", displayOrder: item.displayOrder, item })) }, client);
      }
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        await send(first, shape.hasTouch);
        await expect.poll(() => held.length).toBe(1);
        await send(second, shape.hasTouch);
        await expect.poll(() => held.length).toBe(2);
        for (const submission of held) expect(submission.body).toEqual({ input: [{ type: "text", text: "Identical input" }], clientUserMessageId: expect.any(String), queueIfPending: true });
        const firstId = held[0].body.clientUserMessageId!;
        const secondId = held[1].body.clientUserMessageId!;
        expect(firstId).not.toBe(secondId);
        for (const page of [first, second]) await expect(messages(page)).toHaveCount(1);

        publish("foreign", "another-client");
        for (const page of [first, second]) await expect(messages(page)).toHaveCount(2);
        publish("foreign-without-id", null);
        for (const page of [first, second]) await expect(messages(page)).toHaveCount(3);
        // Native confirms the second input first. It cannot consume the first
        // tab's identical optimistic message while that request remains held.
        publish("second-native", secondId);
        await expect(messages(first)).toHaveCount(4);
        await expect(messages(second)).toHaveCount(3);
        // The first tab misses its own receipt while its HTTP ACK is held.
        // Reopening SSE must refill the snapshot and settle the exact pending
        // identity, rather than only retaining its equal-text optimistic row.
        publish("first-native", firstId, "second");
        await expect(messages(first)).toHaveCount(4);
        await expect(messages(second)).toHaveCount(4);
        const reads = fixture.requests.filter((request) => request.client === "first" && request.key === "POST /v1/threads/settings-chat/attach").length;
        const connections = fixture.connections.get("first") ?? 0;
        fixture.disconnect("first");
        await expect.poll(() => fixture.connections.get("first") ?? 0).toBeGreaterThan(connections);
        await expect.poll(() => fixture.requests.filter((request) => request.client === "first" && request.key === "POST /v1/threads/settings-chat/attach").length).toBeGreaterThan(reads);
        for (const page of [first, second]) await expect(messages(page)).toHaveCount(4);
        expect(held).toHaveLength(2);
        for (const submission of held) await submission.route.fulfill({ json: { payload: { turn: { id: "native-turn", status: "inProgress", items: [] } } } });
        held.splice(0);
        for (const page of [first, second]) await expect(messages(page)).toHaveCount(4);
        await first.reload();
        await expect(messages(first)).toHaveCount(4);
      } finally {
        for (const submission of held) await submission.route.fulfill({ status: 503, json: { code: "fixture_closed", message: "Fixture closed", retryable: false } });
        await fixture.close();
      }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

function pane(page: Page) { return page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]'); }
function messages(page: Page) { return pane(page).locator(".kodex-user-message-bubble").filter({ hasText: "Identical input" }); }
async function send(page: Page, touch: boolean) {
  const composer = pane(page).getByLabel("Message composer", { exact: true });
  if (touch) {
    await composer.tap();
    await expect(pane(page).getByRole("dialog", { name: "Compose", exact: true })).toBeVisible();
  }
  await composer.fill("Identical input");
  const send = pane(page).getByRole("button", { name: "Send message", exact: true });
  if (touch) await send.tap();
  else await send.click();
}
