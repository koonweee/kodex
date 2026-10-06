import { expect, test, type Locator, type Page } from "@playwright/test";

import type { ThreadTimelineRow } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

const firstQuote = "Keep the gateway authoritative.";
const secondQuote = "Use a bounded native read.";
const discardedQuote = "Preserve browser drafts.";
const assistantText = `${firstQuote}\n\n${secondQuote}\n\n${discardedQuote}`;
const firstComment = 'Explain the "source of truth".';
const secondComment = "Show how the read stays bounded.";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });

    test("assistant selections become local editable annotations and submitted input converges across tabs", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.detail.timeline = { ...fixture.detail.timeline, rows: [assistantRow()], turns: [{ id: "turn-answer", status: "completed" }] };
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        for (const page of [first, second]) {
          await expect(answer(page)).toContainText(firstQuote);
          await expect(composer(page)).toBeEnabled();
        }
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);

        await selectExcerpt(first, firstQuote, shape.hasTouch);
        const add = first.getByRole("button", { name: "Add to chat", exact: true });
        await expect(add).toBeInViewport();
        const selectionTop = await first.evaluate(() => window.getSelection()!.getRangeAt(0).getBoundingClientRect().top);
        const bubbleBounds = await add.boundingBox();
        expect(bubbleBounds!.y + bubbleBounds!.height).toBeLessThanOrEqual(selectionTop + 2);
        await first.screenshot({ path: test.info().outputPath("annotation-selection.png") });
        await click(add, shape.hasTouch);
        const annotationToggle = activePane(first).getByRole("button", { name: "1 annotation", exact: true });
        await expect(annotationToggle).toBeVisible();
        await expect(annotationToggle).toHaveAttribute("aria-expanded", String(!shape.hasTouch));
        if (shape.hasTouch) {
          await expect(activePane(first).getByRole("textbox", { name: "Annotation 1 comment", exact: true })).toBeHidden();
          await addExcerpt(first, discardedQuote, shape.hasTouch);
          const collapsedToggle = activePane(first).getByRole("button", { name: "2 annotations", exact: true });
          await expect(collapsedToggle).toHaveAttribute("aria-expanded", "false");
          await click(collapsedToggle, shape.hasTouch);
          await click(activePane(first).getByRole("button", { name: "Remove annotation 2", exact: true }), shape.hasTouch);
        }
        await expect(activePane(first).locator("blockquote")).toHaveText(firstQuote);
        await expect(second.getByRole("button", { name: /^\d+ annotations?$/ })).toHaveCount(0);
        const comment = activePane(first).getByRole("textbox", { name: "Annotation 1 comment", exact: true });
        await click(comment, shape.hasTouch);
        await comment.fill(firstComment);
        await expect(comment).toBeFocused();
        if (shape.hasTouch) {
          const originalComment = await comment.elementHandle();
          await first.setViewportSize({ width: shape.width, height: 420 });
          await expect(comment).toBeFocused();
          await expect(comment).toHaveValue(firstComment);
          await expect(comment).toBeInViewport();
          expect(await originalComment!.evaluate((element) => element.isConnected && element === document.activeElement)).toBe(true);
          await first.screenshot({ path: test.info().outputPath("annotation-keyboard-viewport.png") });
          await first.setViewportSize({ width: shape.width, height: 844 });
          await collapseTouchComposer(first, shape.hasTouch);
        }

        await addExcerpt(first, discardedQuote, shape.hasTouch);
        await expect(activePane(first).getByRole("button", { name: "2 annotations", exact: true })).toHaveAttribute("aria-expanded", "true");
        await click(activePane(first).getByRole("button", { name: "Remove annotation 2", exact: true }), shape.hasTouch);
        await expect(activePane(first).getByRole("textbox", { name: "Annotation 2 comment", exact: true })).toHaveCount(0);
        await expect(activePane(first).locator("blockquote")).toHaveText(firstQuote);
        await addExcerpt(first, secondQuote, shape.hasTouch);
        await expect(activePane(first).locator("blockquote")).toHaveText([firstQuote, secondQuote]);
        await expect(activePane(first).getByRole("textbox", { name: "Annotation 1 comment", exact: true })).toHaveValue(firstComment);
        const secondCommentInput = activePane(first).getByRole("textbox", { name: "Annotation 2 comment", exact: true });
        await expect(secondCommentInput).toHaveValue("");
        await secondCommentInput.fill(secondComment);
        await click(activePane(first).getByRole("button", { name: "2 annotations", exact: true }), shape.hasTouch);
        await expect(activePane(first).getByRole("textbox", { name: "Annotation 1 comment", exact: true })).toBeHidden();
        await click(activePane(first).getByRole("button", { name: "2 annotations", exact: true }), shape.hasTouch);
        await expect(activePane(first).getByRole("textbox", { name: "Annotation 1 comment", exact: true })).toBeVisible();
        await click(composer(first), shape.hasTouch);
        await composer(first).fill("Review these.");
        await first.screenshot({ path: test.info().outputPath("annotation-draft.png") });
        await expect(second.getByRole("button", { name: /^\d+ annotations?$/ })).toHaveCount(0);
        await expect(composer(second)).toHaveValue("");

        await click(activePane(first).getByRole("button", { name: "Send message", exact: true }), shape.hasTouch);
        const inputKey = "POST /v1/threads/settings-chat/input";
        await expect.poll(() => fixture.requests.filter((request) => request.key === inputKey).length).toBe(1);
        const submittedText = [
          "Review these.", "", "<response_annotations>", "<annotation1>",
          `Assistant text: ${JSON.stringify(firstQuote)}`,
          `User annotation: ${JSON.stringify(firstComment)}`,
          "</annotation1>", "<annotation2>", `Assistant text: ${JSON.stringify(secondQuote)}`,
          `User annotation: ${JSON.stringify(secondComment)}`,
          "</annotation2>", "</response_annotations>",
        ].join("\n");
        const submitted = fixture.requests.find((request) => request.key === inputKey)!.body as { input: unknown; clientUserMessageId: string };
        expect(submitted).toEqual({ input: [{ type: "text", text: submittedText }], clientUserMessageId: expect.any(String) });
        await expect(activePane(first).getByRole("button", { name: /^\d+ annotations?$/ })).toHaveCount(0);
        await expect(composer(first)).toHaveValue("");

        // Native receipt becomes canonical user history for both tabs, without
        // sharing the unsent annotation tray or requiring another page load.
        fixture.publishTimeline({ ...fixture.detail.timeline,
          rows: [assistantRow(), submittedRow(submittedText, submitted.clientUserMessageId)],
          turns: [{ id: "turn-answer", status: "completed" }, { id: "turn-1", status: "inProgress" }],
        });
        for (const page of [first, second]) {
          await expectSentAnnotations(page, shape.hasTouch);
          await expect(page.getByRole("button", { name: /^\d+ annotations?$/ })).toHaveCount(0);
        }
        await expectReadableCopy(first, shape.hasTouch);
        await second.screenshot({ path: test.info().outputPath("annotation-canonical-history.png") });
        await second.reload();
        await expectSentAnnotations(second, shape.hasTouch);
        await expect(second.getByRole("button", { name: /^\d+ annotations?$/ })).toHaveCount(0);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });

    test("quote-only annotations can be removed and queued without ordinary composer text", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.detail.timeline = { ...fixture.detail.timeline, rows: [assistantRow()], turns: [{ id: "turn-answer", status: "completed" }] };
      try {
        const first = await fixture.page("first");
        const second = await fixture.page("second");
        await expect(answer(first)).toContainText(secondQuote);
        await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
        await addExcerpt(first, firstQuote, shape.hasTouch);
        await expect(activePane(first).getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
        if (shape.hasTouch) await click(activePane(first).getByRole("button", { name: "1 annotation", exact: true }), shape.hasTouch);
        await click(activePane(first).getByRole("button", { name: "Remove annotation 1", exact: true }), shape.hasTouch);
        await expect(activePane(first).getByRole("button", { name: /^\d+ annotations?$/ })).toHaveCount(0);
        await expect(activePane(first).getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
        await addExcerpt(first, secondQuote, shape.hasTouch);
        await expect(activePane(first).getByRole("button", { name: "1 annotation", exact: true })).toHaveAttribute("aria-expanded", String(!shape.hasTouch));
        await expect(composer(first)).toHaveValue("");
        await click(activePane(first).getByRole("button", { name: "Open attachment menu", exact: true }), shape.hasTouch);
        await click(first.getByRole("menuitem", { name: "Queue message", exact: true }), shape.hasTouch);
        const queueKey = "POST /v1/threads/settings-chat/queued-inputs";
        await expect.poll(() => fixture.requests.filter((request) => request.key === queueKey).length).toBe(1);
        const queuedText = ["<response_annotations>", "<annotation1>", `Assistant text: ${JSON.stringify(secondQuote)}`, "</annotation1>", "</response_annotations>"].join("\n");
        expect(fixture.requests.find((request) => request.key === queueKey)!.body).toEqual({ input: [{ type: "text", text: queuedText }], clientUserMessageId: expect.any(String) });
        for (const page of [first, second]) {
          await expect(activePane(page).getByRole("group", { name: "Queued message", exact: true })).toContainText(secondQuote);
          await expect(page.getByRole("button", { name: /^\d+ annotations?$/ })).toHaveCount(0);
        }
        expect(fixture.requests.filter((request) => request.key === "POST /v1/threads/settings-chat/input")).toHaveLength(0);
        await first.screenshot({ path: test.info().outputPath("annotation-queued.png") });
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

function activePane(page: Page) { return page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]'); }
function answer(page: Page) { return activePane(page).locator(".kodex-assistant-markdown"); }
function composer(page: Page) { return activePane(page).getByLabel("Message composer", { exact: true }); }
async function click(locator: Locator, touch: boolean) { if (touch) await locator.tap(); else await locator.click(); }
async function expectSentAnnotations(page: Page, touch: boolean) {
  const bubble = activePane(page).locator(".kodex-user-message-bubble").filter({ hasText: "Review these." });
  await expect(bubble).toHaveCount(1);
  await expect(bubble.getByText("Review these.", { exact: true })).toBeVisible();
  await expect(bubble).not.toContainText("<response_annotations>");
  await expect(bubble).not.toContainText("Assistant text:");
  await expect(bubble).not.toContainText("User annotation:");
  await expect(bubble.getByRole("group", { name: /^Annotation \d+$/ })).toHaveCount(2);
  const first = bubble.getByRole("group", { name: "Annotation 1", exact: true });
  const second = bubble.getByRole("group", { name: "Annotation 2", exact: true });
  const firstToggle = first.getByLabel("Quoted from assistant, annotation 1", { exact: true });
  const secondToggle = second.getByLabel("Quoted from assistant, annotation 2", { exact: true });
  await expect(firstToggle).toHaveText("Quoted from assistant");
  await expect(secondToggle).toHaveText("Quoted from assistant");
  await expect(first.locator("blockquote")).toHaveText(firstQuote);
  await expect(second.locator("blockquote")).toHaveText(secondQuote);
  await expect(first.locator("blockquote")).toBeVisible();
  await expect(second.locator("blockquote")).toBeVisible();
  await expect(first.getByText(firstComment, { exact: true })).toBeVisible();
  await expect(second.getByText(secondComment, { exact: true })).toBeVisible();

  await click(firstToggle, touch);
  await expect(first.locator("blockquote")).toBeHidden();
  await expect(second.locator("blockquote")).toBeVisible();
  await expect(first.getByText(firstComment, { exact: true })).toBeVisible();
  await click(secondToggle, touch);
  await expect(second.locator("blockquote")).toBeHidden();
  await expect(second.getByText(secondComment, { exact: true })).toBeVisible();
  await click(firstToggle, touch);
  await expect(first.locator("blockquote")).toBeVisible();
  await expect(second.locator("blockquote")).toBeHidden();
  await click(secondToggle, touch);
  await expect(second.locator("blockquote")).toBeVisible();
}
async function expectReadableCopy(page: Page, touch: boolean) {
  // Observe the clipboard API payload without replacing the user's clipboard.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { document.documentElement.dataset.copiedMessage = text; },
    } });
  });
  const row = activePane(page).locator(".kodex-user-message-row").filter({ hasText: "Review these." });
  if (!touch) await row.hover();
  await click(row.getByRole("button", { name: "Copy message", exact: true }), touch);
  await expect(row.getByRole("button", { name: "Copied message", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.copiedMessage)).toBe([
    "Review these.", "", `> ${firstQuote}`, "", firstComment, "", `> ${secondQuote}`, "", secondComment,
  ].join("\n"));
}
async function collapseTouchComposer(page: Page, touch: boolean) {
  const collapse = activePane(page).getByRole("button", { name: "Collapse composer", exact: true });
  if (touch && await collapse.isVisible()) await collapse.tap();
}
async function addExcerpt(page: Page, text: string, touch: boolean) {
  await collapseTouchComposer(page, touch);
  await selectExcerpt(page, text, touch);
  await click(page.getByRole("button", { name: "Add to chat", exact: true }), touch);
}
async function selectExcerpt(page: Page, text: string, touch: boolean) {
  const paragraph = answer(page).locator("p").filter({ hasText: text });
  await paragraph.scrollIntoViewIfNeeded();
  const bounds = await paragraph.evaluate((element, excerpt) => {
    const node = element.firstChild!;
    const start = node.textContent!.indexOf(excerpt);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + excerpt.length);
    const rectangles = [...range.getClientRects()];
    const first = rectangles[0];
    const last = rectangles.at(-1)!;
    return { start: { x: first.left + 0.5, y: first.top + first.height / 2 }, end: { x: last.right - 0.5, y: last.top + last.height / 2 } };
  }, text);
  if (touch) {
    // Chromium mobile emulation does not expose native long-press handles;
    // create the same DOM selection, then use real touch for all UI actions.
    await paragraph.evaluate((element, excerpt) => {
      const node = element.firstChild!;
      const start = node.textContent!.indexOf(excerpt);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + excerpt.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    }, text);
  } else {
    await page.mouse.move(bounds.start.x, bounds.start.y);
    await page.mouse.down();
    await page.mouse.move(bounds.end.x, bounds.end.y, { steps: 12 });
    await page.mouse.up();
  }
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(text);
  await expect(page.getByRole("button", { name: "Add to chat", exact: true })).toBeVisible();
}

function assistantRow(): ThreadTimelineRow {
  return { id: "answer", turnId: "turn-answer", kind: "assistant_message", status: "completed", displayOrder: 1,
    items: [], collapsedRows: [], fileChanges: [],
    item: { id: "answer", threadId: "settings-chat", turnId: "turn-answer", itemId: "answer", itemType: "agentMessage", status: "completed", displayOrder: 1, codexMethod: "item/completed",
      payload: { source: "appServerSnapshot", turnId: "turn-answer", itemId: "answer", itemSnapshot: { id: "answer", itemType: "agentMessage" }, item: { id: "answer", type: "agentMessage", phase: "final_answer", text: assistantText } } },
  };
}
function submittedRow(text: string, clientId: string): ThreadTimelineRow {
  return { id: "submitted", turnId: "turn-1", kind: "user_message", status: "completed", displayOrder: 2,
    items: [], collapsedRows: [], fileChanges: [],
    item: { id: "submitted", threadId: "settings-chat", turnId: "turn-1", itemId: "submitted", itemType: "userMessage", status: "completed", displayOrder: 2, codexMethod: "item/completed",
      payload: { source: "appServerSnapshot", turnId: "turn-1", itemId: "submitted", itemSnapshot: { id: "submitted", itemType: "userMessage", clientId }, item: { id: "submitted", type: "userMessage", clientId, content: [{ type: "text", text }] } } },
  };
}
