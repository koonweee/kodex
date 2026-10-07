import { expect, test, type Page } from "@playwright/test";
import type { ThreadTimelineRow } from "../src/api/client";
import type { components } from "../src/api/generated/schema";
import { nativeSettingsFixture } from "./native-settings.fixture";

type InputRequest = components["schemas"]["TurnStartRequest"];
const question = "Finish the browser login, then reply **logged in**.";
const options = ["I’ll log in now", "Continue without live validation"];

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("inline choices and free text use ordinary input and converge across tabs", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.detail.timeline = { ...fixture.detail.timeline, rows: [questionRow()], turns: [{ id: "turn-1", status: "inProgress" }], activeTurnId: "turn-1", liveState: "streaming" };
      fixture.detail.liveState = "streaming";
      fixture.detail.thread.status = "active";
      const inputs = () => fixture.requests.filter((request) => request.key === "POST /v1/threads/settings-chat/input");
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        for (const page of [first, second]) {
          await expect(card(page)).toBeVisible();
          await expect(card(page).getByText("logged in", { exact: true })).toBeVisible();
          await expect(card(page).getByRole("textbox", { name: "Reply to question 1", exact: true })).toBeVisible();
          await expect(card(page).getByRole("button", { name: options[0], exact: true })).toHaveCount(1);
          await expect(card(page).getByRole("button", { name: options[1], exact: true })).toHaveCount(1);
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await expect(card(page).getByText("Agent is continuing", { exact: true })).toHaveCount(0);
          expect(await card(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
          const bounds = await card(page).boundingBox();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(shape.width);
          if (shape.hasTouch) {
            for (const option of options) {
              const target = await card(page).getByRole("button", { name: option, exact: true }).boundingBox();
              expect(target!.height).toBeGreaterThanOrEqual(44);
            }
          }
        }
        await setMainDraft(first, "First tab main draft", shape.hasTouch);
        await setMainDraft(second, "Second tab main draft", shape.hasTouch);
        await card(first).getByRole("textbox", { name: "Reply to question 1", exact: true }).fill("My separate question draft");
        await first.screenshot({ path: test.info().outputPath("inline-question.png") });
        const choice = card(first).getByRole("button", { name: options[0], exact: true });
        if (shape.hasTouch) await choice.tap();
        else await choice.click();
        await expect.poll(() => inputs().length).toBe(1);
        const chosen = inputs()[0].body as InputRequest;
        expect(chosen).toEqual({ input: [{ type: "text", text: options[0] }], clientUserMessageId: expect.any(String) });
        fixture.publishTimeline({ ...fixture.detail.timeline, rows: [questionRow(), replyRow("chosen", options[0], chosen.clientUserMessageId!, 2)] }, "first");
        await expect(card(first).getByRole("textbox")).toHaveCount(0);
        await expect(card(first).getByRole("button")).toHaveCount(0);
        await expect(card(first).locator("details")).not.toHaveAttribute("open", "");
        await expect(card(second).getByRole("textbox")).toBeVisible();
        await expect(mainComposer(first)).toHaveValue("First tab main draft");
        await expect(mainComposer(second)).toHaveValue("Second tab main draft");
        const connections = fixture.connections.get("second") ?? 0;
        fixture.disconnect("second");
        await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(connections);
        for (const page of [first, second]) {
          await expect(card(page).getByRole("textbox")).toHaveCount(0);
          await expect(card(page).getByRole("button")).toHaveCount(0);
          await card(page).getByText("Input requested", { exact: true }).click();
          await expect(card(page).getByRole("blockquote")).toHaveText(options[0]);
          await expect(card(page).getByText("logged in", { exact: true })).toBeVisible();
          await expect(mainComposer(page)).toHaveValue(page === first ? "First tab main draft" : "Second tab main draft");
          await page.screenshot({ path: test.info().outputPath(page === first ? "answered-first.png" : "answered-second.png") });
        }
        await first.reload();
        await expect(card(first)).toBeVisible();
        await expect(card(first).getByRole("textbox")).toHaveCount(0);
        await expect(card(first).locator("details")).not.toHaveAttribute("open", "");
        await card(first).getByText("Input requested", { exact: true }).click();
        await expect(card(first).getByRole("blockquote")).toHaveText(options[0]);
        expect(fixture.pending).toEqual([]);
        expect(inputs()).toHaveLength(1);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

test("native read-only chats show the question without accepting replies", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  fixture.detail.thread.canAcceptDirectInput = false;
  fixture.detail.timeline = { ...fixture.detail.timeline, rows: [questionRow()], turns: [{ id: "turn-1", status: "completed" }] };
  try {
    const page = await fixture.page("read-only");
    await expect(card(page)).toBeVisible();
    await expect(pane(page)).toContainText("This native subagent does not accept direct input.");
    await expect(card(page).getByRole("textbox", { name: "Reply to question 1", exact: true })).toBeDisabled();
    for (const option of options) await expect(card(page).getByRole("button", { name: option, exact: true })).toBeDisabled();
    await expect(card(page).getByRole("button", { name: "Send reply", exact: true })).toBeDisabled();
    expect(fixture.requests.filter((request) => request.key.endsWith("/input"))).toEqual([]);
  } finally { await fixture.close(); }
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

function pane(page: Page) { return page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]'); }
function card(page: Page) { return pane(page).getByRole("region", { name: "Question 1", exact: true }); }
function mainComposer(page: Page) { return pane(page).getByLabel("Message composer", { exact: true }); }
async function setMainDraft(page: Page, text: string, touch: boolean) {
  if (touch) await mainComposer(page).tap();
  await mainComposer(page).fill(text);
  if (touch) await pane(page).getByRole("button", { name: "Collapse composer", exact: true }).tap();
}
function questionRow(): ThreadTimelineRow {
  return row("question", "agentMessage", { id: "question", type: "agentMessage", phase: "final_answer", delivery: "async", questions: [{ title: question, options }], text: `${question}\n${options.map((option) => `- ${option}`).join("\n")}` }, 1);
}
function replyRow(id: string, text: string, clientId: string, order: number): ThreadTimelineRow {
  return row(id, "userMessage", { id, type: "userMessage", clientId, content: [{ type: "text", text }] }, order);
}
function row(id: string, itemType: string, raw: Record<string, unknown>, order: number): ThreadTimelineRow {
  return { id: `row-${id}`, turnId: "turn-1", kind: itemType === "agentMessage" ? "assistant_message" : "user_message", status: "completed", displayOrder: order,
    item: { id: `row-${id}`, threadId: "settings-chat", turnId: "turn-1", itemId: id, itemType, status: "completed", codexMethod: "item/completed", displayOrder: order, payload: { source: "appServerSnapshot", turnId: "turn-1", itemId: id, item: raw, itemSnapshot: { id, itemType, clientId: raw.clientId ?? null } } },
    items: [], collapsedRows: [], fileChanges: [] };
}
