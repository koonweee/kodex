import { compactCanonicalPayload } from "../src/test/canonicalPayloadFixture";
import { expect, test, type Page } from "@playwright/test";
import type { SkillsCatalogResponse, ThreadTimelineSnapshotItem, UserInput } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

const input: UserInput[] = [
  { type: "text", text: "请 $review-fix", text_elements: [{ byteRange: { start: 4, end: 15 }, placeholder: "$review-fix" }] },
  { type: "skill", name: "review-fix", path: "/skills/review-fix/SKILL.md" },
];

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    for (const queued of [false, true]) {
      test(`selected skill survives rejected ${queued ? "queue" : "send"} and canonical history reaches both tabs`, async ({ context }) => {
        const fixture = await nativeSettingsFixture(context);
        const catalog: SkillsCatalogResponse = {
          cwd: "/execution/settings", errors: [], invalidationGeneration: 0,
          skills: [{ name: "review-fix", path: "/skills/review-fix/SKILL.md", description: "Review changes", enabled: true, scope: "user", interface: { displayName: "Review Fix" } }],
        };
        const endpoint = `/v1/threads/settings-chat/${queued ? "queued-inputs" : "input"}`;
        const attempts: unknown[] = [];
        let catalogReads = 0;
        if (queued) {
          fixture.detail.liveState = fixture.detail.timeline.liveState = "streaming";
          fixture.detail.thread.status = "active";
          fixture.detail.timeline.activeTurnId = "active-turn";
          fixture.detail.timeline.turns = [{ id: "active-turn", status: "inProgress" }];
        }
        await context.route("**/v1/skills**", async (route) => {
          catalogReads += 1;
          await route.fulfill({ json: catalog });
        });
        await context.route(`**${endpoint}`, async (route) => {
          if (route.request().method() !== "POST") return route.fallback();
          attempts.push(route.request().postDataJSON());
          if (attempts.length === 1) {
            return route.fulfill({ status: 400, json: { code: "rejected", message: "Native input rejected", retryable: false } });
          }
          if (queued) return route.fallback();
          return route.fulfill({ json: { payload: {} } });
        });
        try {
          const first = await fixture.page("first");
          const second = await fixture.page("second");
          await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
          const composer = activePane(first).getByLabel("Message composer", { exact: true });
          if (shape.hasTouch) {
            await composer.tap();
            await expect(activePane(first).getByRole("dialog", { name: "Compose", exact: true })).toBeVisible();
          }
          await composer.fill("请 $rev");
          const skill = first.getByRole("option", { name: /Review Fix/ });
          if (shape.hasTouch) await skill.tap();
          else await skill.click();
          await expect(composer).toHaveValue("请 $review-fix ");
          await submit(first, queued, shape.hasTouch);
          await expect.poll(() => attempts.length).toBe(1);
          await expect(first.getByText("Native input rejected", { exact: true })).toBeVisible();
          await expect(composer).toHaveValue("请 $review-fix ");
          await expect(composer).toBeEnabled();
          await submit(first, queued, shape.hasTouch);
          await expect.poll(() => attempts.length).toBe(2);
          expect(attempts).toEqual([
            { input, clientUserMessageId: expect.any(String), ...(!queued ? { queueIfPending: true } : {}) },
            { input, clientUserMessageId: expect.any(String), ...(!queued ? { queueIfPending: true } : {}) },
          ]);
          expect((attempts[0] as {clientUserMessageId:string}).clientUserMessageId).not.toBe((attempts[1] as {clientUserMessageId:string}).clientUserMessageId);

          const pickerCatalogReads = catalogReads;
          if (queued) { fixture.queuedInputs.splice(0); fixture.queueChanged(); }
          // A native item supplies its own structured input. Only the first tab
          // sees its canonical patch; the second must recover from the snapshot.
          const item: ThreadTimelineSnapshotItem = {
            id: "native-skill-item", itemId: "native-user", threadId: "settings-chat", turnId: "skill-turn", itemType: "userMessage", status: "completed", codexMethod: "item/completed", displayOrder: 1,
            payload: compactCanonicalPayload({ id: "native-user", type: "userMessage", content: input }, { id: "native-user", itemType: "userMessage", skillMentions: [{ start: 2, end: 13, name: "review-fix", path: "/skills/review-fix/SKILL.md" }] }),
          };
          fixture.publishTimeline({ activeTurnId: null, liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], viewRevision: 5, turns: [{ id: "skill-turn", status: "completed" }], rows: [{ id: "native-skill-row", kind: "user_message", status: "completed", turnId: "skill-turn", displayOrder: 1, item }] }, "first");
          await expect(activePane(first).getByLabel("$review-fix skill", { exact: true })).toBeVisible();
          await expect(activePane(second).getByLabel("$review-fix skill", { exact: true })).toHaveCount(0);
          const connections = fixture.connections.get("second") ?? 0;
          fixture.disconnect("second");
          await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(connections);
          await expect(activePane(second).getByLabel("$review-fix skill", { exact: true })).toBeVisible();
          expect(catalogReads).toBe(pickerCatalogReads);
          await second.reload();
          await expect(activePane(second).getByLabel("$review-fix skill", { exact: true })).toBeVisible();
          expect(catalogReads).toBe(pickerCatalogReads);
          expect(attempts).toHaveLength(2);
          if (!queued) await second.screenshot({ path: test.info().outputPath("native-skills.png") });
        } finally {
          await fixture.close();
        }
        expect(fixture.unexpected).toEqual([]);
        // Chromium reports the deliberately rejected request in its console.
        expect(fixture.errors).toEqual(["Failed to load resource: the server responded with a status of 400 (Bad Request)"]);
      });
    }
  });
}

function activePane(page: Page) {
  return page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
}

async function submit(page: Page, queued: boolean, touch: boolean) {
  if (queued) {
    const menu = activePane(page).getByRole("button", { name: "Open attachment menu", exact: true });
    if (touch) await menu.tap();
    else await menu.click();
  }
  const action = queued
    ? page.getByRole("menuitem", { name: "Queue message", exact: true })
    : activePane(page).getByRole("button", { name: "Send message", exact: true });
  if (touch) await action.tap();
  else await action.click();
}
