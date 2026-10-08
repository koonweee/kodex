import { compactCanonicalPayload } from "../src/test/canonicalPayloadFixture";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { appendResponseAnnotations } from "../src/composer/annotations";
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
        const layoutViewportHeight = await first.evaluate(() => innerHeight);
        if (shape.hasTouch) await setVisualViewport(first, layoutViewportHeight - 300);
        await click(add, shape.hasTouch);
        const annotationToggle = activePane(first).getByRole("button", { name: "1 annotation", exact: true });
        await expect(annotationToggle).toBeVisible();
        await expect(annotationToggle).toHaveAttribute("aria-expanded", "true");
        await expect(activePane(first).locator("blockquote")).toHaveText(firstQuote);
        await expect(second.getByRole("button", { name: /^\d+ annotations?$/ })).toHaveCount(0);
        const comment = activePane(first).getByRole("textbox", { name: "Annotation 1 comment", exact: true });
        await expect(comment).toBeFocused();
        await comment.fill(firstComment);
        await comment.press("Shift+Enter");
        await expect(comment).toHaveValue(`${firstComment}\n`);
        expect(fixture.requests.filter((request) => request.key === "POST /v1/threads/settings-chat/input")).toHaveLength(0);
        await comment.press("Backspace");
        await expect(comment).toBeFocused();
        await first.screenshot({ path: test.info().outputPath("annotation-comment-focused.png") });
        if (shape.hasTouch) {
          const originalComment = await comment.elementHandle();
          await expect(activePane(first).getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(0);
          await expect(comment).toBeFocused();
          await expect(comment).toHaveValue(firstComment);
          const visualBottom = await first.evaluate(() =>
            (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight));
          for (const control of [comment, activePane(first).getByRole("button", { name: "Send message", exact: true })]) {
            const bounds = await control.boundingBox();
            expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(visualBottom);
          }
          expect(await originalComment!.evaluate((element) => element.isConnected && element === document.activeElement)).toBe(true);
          await click(activePane(first).getByRole("button", { name: "Open attachment menu", exact: true }), true);
          await expect(first.getByRole("menuitem", { name: "Add attachment", exact: true })).toBeVisible();
          const composerBounds = await activePane(first).locator(":scope > .kodex-composer-shell").boundingBox();
          expect(composerBounds!.y + composerBounds!.height).toBeLessThanOrEqual(visualBottom);
          await first.keyboard.press("Escape");
          await first.screenshot({ path: test.info().outputPath("annotation-keyboard-viewport.png") });
          await setVisualViewport(first, layoutViewportHeight);
          await collapseTouchComposer(first, shape.hasTouch);
        }

        await click(annotationToggle, shape.hasTouch);
        await addExcerpt(first, discardedQuote, shape.hasTouch);
        await expect(activePane(first).getByRole("button", { name: "2 annotations", exact: true })).toHaveAttribute("aria-expanded", "true");
        await expect(activePane(first).getByRole("textbox", { name: "Annotation 2 comment", exact: true })).toBeFocused();
        await click(activePane(first).getByRole("button", { name: "Remove annotation 2", exact: true }), shape.hasTouch);
        await expect(activePane(first).getByRole("textbox", { name: "Annotation 2 comment", exact: true })).toHaveCount(0);
        await expect(activePane(first).locator("blockquote")).toHaveText(firstQuote);
        await addExcerpt(first, secondQuote, shape.hasTouch);
        await expect(activePane(first).locator("blockquote")).toHaveText([firstQuote, secondQuote]);
        await expect(activePane(first).getByRole("textbox", { name: "Annotation 1 comment", exact: true })).toHaveValue(firstComment);
        const secondCommentInput = activePane(first).getByRole("textbox", { name: "Annotation 2 comment", exact: true });
        await expect(secondCommentInput).toHaveValue("");
        await expect(secondCommentInput).toBeFocused();
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

        await click(secondCommentInput, shape.hasTouch);
        await secondCommentInput.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(input.value.length, input.value.length));
        if (shape.hasTouch) {
          // Annotation keyboard behavior follows the composer's touch policy.
          await secondCommentInput.press("Enter");
          await expect(secondCommentInput).toHaveValue(`${secondComment}\n`);
          expect(fixture.requests.filter((request) => request.key === "POST /v1/threads/settings-chat/input")).toHaveLength(0);
          await secondCommentInput.press("Backspace");
        }
        await secondCommentInput.press(shape.hasTouch ? "Meta+Enter" : "Enter");
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
        expect(submitted).toEqual({ input: [{ type: "text", text: submittedText }], clientUserMessageId: expect.any(String),
          ...(shape.hasTouch ? { queueIfEmpty: true } : { queueIfPending: true }) });
        await expect(activePane(first).getByRole("button", { name: /^\d+ annotations?$/ })).toHaveCount(0);
        await expect(composer(first)).toHaveValue("");

        // Native receipt becomes canonical user history for both tabs, without
        // sharing the unsent annotation tray or requiring another page load.
        fixture.publishTimeline({ ...fixture.detail.timeline,
          rows: [assistantRow(), submittedRow(submittedText, submitted.clientUserMessageId)],
          turns: [{ id: "turn-answer", status: "completed" }, { id: "turn-1", status: "inProgress" }],
        });
        for (const page of [first, second]) {
          await expectSentAnnotations(page);
          await expect(page.getByRole("button", { name: /^\d+ annotations?$/ })).toHaveCount(0);
        }
        await expectReadableCopy(first, shape.hasTouch);
        await second.screenshot({ path: test.info().outputPath("annotation-canonical-history.png") });
        await second.reload();
        await expectSentAnnotations(second);
        await expect(second.getByRole("button", { name: /^\d+ annotations?$/ })).toHaveCount(0);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });

    test("sent quote disclosure keeps a single-line preview when collapsed", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      const quote = "Automatically pausing schedules when a task becomes completed would be a separate code behavior.\nKeep this complete quote available when expanded, including " + "unbroken".repeat(24);
      const comment = "Do we need code behavior or will the agent do this?";
      fixture.detail.timeline = { ...fixture.detail.timeline,
        rows: [submittedRow(appendResponseAnnotations("", [{ id: "quote", text: quote, comment }]), "fixture")],
        turns: [{ id: "turn-1", status: "completed" }],
      };
      try {
        const page = await fixture.page("compact-quote");
        const annotation = activePane(page).getByRole("group", { name: "Annotation 1", exact: true });
        const block = annotation.locator("blockquote");
        const toggle = annotation.locator("summary");
        await expect(block).toHaveText(quote);
        await expect(toggle).toHaveAccessibleName(quote);
        await expect(annotation.locator("details")).not.toHaveAttribute("open");
        await expect(block).toBeVisible();
        await expect(toggle).toHaveText(quote);
        const preview = await toggle.locator("span").evaluate(element => {
          const bounds = element.getBoundingClientRect();
          return { height: bounds.height, lineHeight: parseFloat(getComputedStyle(element).lineHeight),
            width: bounds.width, contentWidth: element.scrollWidth };
        });
        expect(preview.height).toBeCloseTo(preview.lineHeight, 0);
        expect(preview.contentWidth).toBeGreaterThan(preview.width);
        await expect(annotation.getByText(comment, { exact: true })).toBeVisible();
        await page.screenshot({ path: test.info().outputPath("quote-collapsed.png") });
        // Native summary keyboard activation also restores the full quote.
        await toggle.focus();
        await toggle.press("Enter");
        const expandedHeight = await toggle.locator("span").evaluate(element => element.getBoundingClientRect().height);
        expect(expandedHeight).toBeGreaterThan(preview.height * 2);
        await expect(block).toHaveText(quote);
        const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(horizontalOverflow).toBe(false);
        await page.screenshot({ path: test.info().outputPath("quote-expanded.png") });
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });

    test("fitting quotes gain a collapsed disclosure only while their pane is too narrow", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.detail.timeline = { ...fixture.detail.timeline,
        rows: [submittedRow(appendResponseAnnotations("", [{ id: "quote", text: firstQuote, comment: "A reminder." }]), "fixture")],
        turns: [{ id: "turn-1", status: "completed" }],
      };
      try {
        const page = await fixture.page("quote-resize");
        const annotation = activePane(page).getByRole("group", { name: "Annotation 1", exact: true });
        const block = annotation.locator("blockquote");
        await expect(block).toHaveText(firstQuote);
        await expect(annotation.locator("summary")).toHaveCount(0);
        await expect(block.locator("svg")).toHaveCount(0);
        await block.evaluate(element => { element.style.width = "100px"; });
        const toggle = annotation.locator("summary");
        await expect(toggle).toHaveAccessibleName(firstQuote);
        await expect(annotation.locator("details")).not.toHaveAttribute("open");
        await click(toggle, shape.hasTouch);
        await expect(annotation.locator("details")).toHaveAttribute("open", "");
        const expanded = await toggle.locator("span").evaluate(element => ({
          height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight),
        }));
        expect(expanded.height).toBeGreaterThan(expanded.lineHeight);
        await block.evaluate(element => { element.style.removeProperty("width"); });
        await expect(toggle).toHaveCount(0);
        await expect(block.locator("svg")).toHaveCount(0);
        await expect(block).toHaveText(firstQuote);
        await expect(annotation.getByText("A reminder.", { exact: true })).toBeVisible();
        await block.evaluate(element => { element.style.width = "100px"; });
        await expect(toggle).toBeVisible();
        await expect(annotation.locator("details")).not.toHaveAttribute("open");
        await block.evaluate(element => { element.style.width = "260px"; });
        await expect(toggle).toHaveCount(0);
        const largerText = await page.addStyleTag({ content: ".kodex-user-annotation-quote-body { font-size: 32px !important; }" });
        await expect(toggle).toBeVisible();
        await expect(annotation.locator("details")).not.toHaveAttribute("open");
        await largerText.evaluate(element => element.remove());
        await expect(toggle).toHaveCount(0);
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
        await click(activePane(first).getByRole("button", { name: "Remove annotation 1", exact: true }), shape.hasTouch);
        await expect(activePane(first).getByRole("button", { name: /^\d+ annotations?$/ })).toHaveCount(0);
        await expect(activePane(first).getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
        await addExcerpt(first, secondQuote, shape.hasTouch);
        await expect(activePane(first).getByRole("button", { name: "1 annotation", exact: true })).toHaveAttribute("aria-expanded", "true");
        await expect(composer(first)).toHaveValue("");
        await click(activePane(first).getByRole("button", { name: "Open attachment menu", exact: true }), shape.hasTouch);
        await click(first.getByRole("menuitem", { name: "Queue message", exact: true }), shape.hasTouch);
        const queueKey = "POST /v1/threads/settings-chat/queued-inputs";
        await expect.poll(() => fixture.requests.filter((request) => request.key === queueKey).length).toBe(1);
        const queuedText = ["<response_annotations>", "<annotation1>", `Assistant text: ${JSON.stringify(secondQuote)}`, "</annotation1>", "</response_annotations>"].join("\n");
        expect(fixture.requests.find((request) => request.key === queueKey)!.body).toEqual({ input: [{ type: "text", text: queuedText }], clientUserMessageId: expect.any(String) });
        for (const page of [first, second]) {
          const queued = activePane(page).getByRole("group", { name: "Queued message", exact: true });
          await expect(queued).toContainText("Quoted message");
          await expect(page.getByRole("button", { name: /^\d+ annotations?$/ })).toHaveCount(0);
          await click(queued.getByRole("button", { name: "Edit", exact: true }), shape.hasTouch);
          const editor = page.getByRole("dialog", { name: "Edit queued message", exact: true });
          await expect(editor.locator("blockquote")).toHaveText(secondQuote);
          await expect(editor.getByRole("textbox", { name: "Queued message text", exact: true })).toHaveValue("");
          await page.keyboard.press("Escape");
          await expect(editor).toBeHidden();
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
async function setVisualViewport(page: Page, height: number) {
  await page.evaluate((nextHeight) => {
    type TestVisualViewport = EventTarget & { height: number; offsetLeft: number; offsetTop: number; width: number };
    const owner = window as typeof window & { __kodexTestVisualViewport?: TestVisualViewport };
    if (!owner.__kodexTestVisualViewport) {
      owner.__kodexTestVisualViewport = Object.assign(new EventTarget(), {
        height: nextHeight, offsetLeft: 0, offsetTop: 0, width: innerWidth,
      });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: owner.__kodexTestVisualViewport });
    }
    owner.__kodexTestVisualViewport.height = nextHeight;
    owner.__kodexTestVisualViewport.dispatchEvent(new Event("resize"));
  }, height);
}
async function expectSentAnnotations(page: Page) {
  const bubble = activePane(page).locator(".kodex-user-message-bubble").filter({ hasText: "Review these." });
  await expect(bubble).toHaveCount(1);
  await expect(bubble.getByText("Review these.", { exact: true })).toBeVisible();
  await expect(bubble).not.toContainText("<response_annotations>");
  await expect(bubble).not.toContainText("Assistant text:");
  await expect(bubble).not.toContainText("User annotation:");
  await expect(bubble.getByRole("group", { name: /^Annotation \d+$/ })).toHaveCount(2);
  const first = bubble.getByRole("group", { name: "Annotation 1", exact: true });
  const second = bubble.getByRole("group", { name: "Annotation 2", exact: true });
  await expect(first.locator("blockquote")).toHaveText(firstQuote);
  await expect(second.locator("blockquote")).toHaveText(secondQuote);
  await expect(first.locator("blockquote")).toBeVisible();
  await expect(second.locator("blockquote")).toBeVisible();
  await expect(first.getByText(firstComment, { exact: true })).toBeVisible();
  await expect(second.getByText(secondComment, { exact: true })).toBeVisible();
  await expect(first.locator("summary")).toHaveCount(0);
  await expect(second.locator("summary")).toHaveCount(0);
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

    item: { id: "answer", threadId: "settings-chat", turnId: "turn-answer", itemId: "answer", itemType: "agentMessage", status: "completed", displayOrder: 1, codexMethod: "item/completed",
      payload: compactCanonicalPayload({ id: "answer", type: "agentMessage", phase: "final_answer", text: assistantText }, { id: "answer", itemType: "agentMessage" }) },
  };
}
function submittedRow(text: string, clientId: string): ThreadTimelineRow {
  return { id: "submitted", turnId: "turn-1", kind: "user_message", status: "completed", displayOrder: 2,

    item: { id: "submitted", threadId: "settings-chat", turnId: "turn-1", itemId: "submitted", itemType: "userMessage", status: "completed", displayOrder: 2, codexMethod: "item/completed",
      payload: compactCanonicalPayload({ id: "submitted", type: "userMessage", clientId, content: [{ type: "text", text }] }, { id: "submitted", itemType: "userMessage", clientId }) },
  };
}
