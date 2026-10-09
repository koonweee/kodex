import { expect, test, type Locator, type Page } from "@playwright/test";

import type { ThreadTimelineRow } from "../src/api/client";
import { compactCanonicalPayload } from "../src/test/canonicalPayloadFixture";
import { nativeSettingsFixture } from "./native-settings.fixture";

type Fixture = Awaited<ReturnType<typeof nativeSettingsFixture>>;
const turnId = "animation-turn";
const itemId = "animation-answer";

function answer(text: string, completed = false): ThreadTimelineRow {
  const status = completed ? "completed" : "running";
  return {
    id: itemId, turnId, kind: "assistant_message", status, displayOrder: 1,
    item: {
      id: itemId, threadId: "settings-chat", turnId, itemId, itemType: "agentMessage",
      status, displayOrder: 1, codexMethod: completed ? "item/completed" : "item/upsert",
      payload: compactCanonicalPayload({ id: itemId, type: "agentMessage", phase: "final_answer", text }, { id: itemId, itemType: "agentMessage" }),
    },
  };
}

function seed(fixture: Fixture, text = "Earlier words. ") {
  fixture.detail.timeline = {
    ...fixture.detail.timeline, rows: [answer(text)], turns: [{ id: turnId, status: "inProgress" }],
    activeTurnId: turnId, liveState: "streaming",
  };
  fixture.detail.liveState = "streaming";
  fixture.detail.thread.status = "active";
}

function append(fixture: Fixture, suffix: string, clients: string[]) {
  const text = String(fixture.detail.timeline.rows[0].item!.payload.item.text) + suffix;
  const revision = (fixture.detail.timeline.viewRevision ?? 1) + 1;
  fixture.detail.timeline = { ...fixture.detail.timeline, rows: [answer(text)], viewRevision: revision };
  for (const client of clients) fixture.publishCanonicalEvent({
    kind: "thread_view.item_delta", seq: revision,
    payload: { threadId: "settings-chat", turnId, itemId, delta: suffix, viewRevision: revision },
  }, client);
  return text;
}

function replace(fixture: Fixture, text: string, completed = false) {
  fixture.publishTimeline({
    ...fixture.detail.timeline, rows: [answer(text, completed)],
    turns: [{ id: turnId, status: completed ? "completed" : "inProgress" }],
    activeTurnId: completed ? null : turnId, liveState: completed ? "idle" : "streaming",
  });
}

function message(page: Page) { return page.locator(".kodex-assistant-markdown").first(); }
async function animationCount(target: Locator) {
  return target.evaluate(el => el.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length);
}

// Observe the first committed frame, so CI delays after an assertion cannot hide a short fade.
async function watchAppearance(target: Locator) {
  await target.evaluate(el => {
    type ProofElement = HTMLElement & { streamProof?: { animated: boolean; translucent: boolean } };
    const root = el as ProofElement;
    root.streamProof = { animated: false, translucent: false };
    const observe = () => {
      for (const animation of root.getAnimations({ subtree: true })) {
        if (animation.playState !== "running") continue;
        root.streamProof!.animated = true;
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        if (target instanceof Element && Number(getComputedStyle(target).opacity) < 1) root.streamProof!.translucent = true;
      }
    };
    const observer = new MutationObserver(() => { observe(); requestAnimationFrame(observe); });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    window.setTimeout(() => observer.disconnect(), 1500);
  });
}

async function selectText(target: Locator, text: string) {
  await target.evaluate((el, selected) => {
    const start = el.textContent!.indexOf(selected);
    if (start < 0) throw new Error(`Missing selection text: ${selected}`);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let offset = 0;
    let began = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const end = offset + node.textContent!.length;
      if (!began && start < end) { range.setStart(node, start - offset); began = true; }
      if (began && start + selected.length <= end) { range.setEnd(node, start + selected.length - offset); break; }
      offset = end;
    }
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, text);
}

async function selectedText(page: Page) { return page.evaluate(() => window.getSelection()?.toString() ?? ""); }

for (const shape of [
  { name: "desktop fine pointer", width: 1280, touch: false, mobile: false },
  { name: "narrow fine pointer", width: 390, touch: false, mobile: false },
  { name: "narrow touch", width: 390, touch: true, mobile: true },
  { name: "wide touch with compact pane", width: 1280, touch: true, mobile: true },
  { name: "hybrid touch and fine hover", width: 1280, touch: false, mobile: false },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.touch, isMobile: shape.mobile });
    test("live canonical append fades and settles with unchanged visible content", async ({ context }) => {
      const hybrid = shape.name.startsWith("hybrid");
      if (hybrid) await context.addInitScript(() => Object.defineProperty(navigator, "maxTouchPoints", { get: () => 1 }));
      const fixture = await nativeSettingsFixture(context);
      seed(fixture);
      try {
        const page = await fixture.page("appearance");
        if (hybrid) {
          expect(await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches && navigator.maxTouchPoints > 0)).toBe(true);
        }
        if (shape.touch && shape.width > 900) {
          const pane = page.locator(".kodex-thread-pane-existing");
          await pane.evaluate(el => { el.style.maxWidth = "360px"; });
          await expect(pane).toHaveAttribute("data-pane-width", "compact");
        }
        const target = message(page);
        await expect(target).toHaveText("Earlier words.");
        await expect.poll(() => fixture.connected("appearance")).toBe(true);
        expect(await animationCount(target)).toBe(0);
        await watchAppearance(target);
        const text = append(fixture, "Fresh words arrive smoothly.", ["appearance"]);
        await expect(target).toHaveText(text);
        await target.evaluate(el => {
          const root = el as HTMLElement & { quietMutations?: number; quietObserver?: MutationObserver };
          root.quietMutations = 0;
          root.quietObserver = new MutationObserver(records => { root.quietMutations! += records.length; });
          root.quietObserver.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
        });
        await expect.poll(() => target.evaluate(el => (el as HTMLElement & { streamProof?: { animated: boolean; translucent: boolean } }).streamProof)).toEqual({ animated: true, translucent: true });
        await expect.poll(() => animationCount(target)).toBe(0);
        // A stalled stream stays fully visible without recurring animation or DOM cleanup.
        await page.waitForTimeout(350);
        const quiet = await target.evaluate(el => {
          const root = el as HTMLElement & { quietMutations?: number; quietObserver?: MutationObserver };
          root.quietObserver!.disconnect();
          return {
            mutations: root.quietMutations,
            running: root.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length,
            translucent: [...root.querySelectorAll("span")].some(span => Number(getComputedStyle(span).opacity) < 1),
          };
        });
        expect(quiet).toEqual({ mutations: 0, running: 0, translucent: false });
        await expect(target).toHaveText(text);
        replace(fixture, text, true);
        await expect(page.getByRole("button", { name: "Copy message", exact: true })).toBeVisible();
        await expect(target).toHaveText(text);
        expect(await animationCount(target)).toBe(0);
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}

test("selection of the fresh suffix survives motion changes, settling, append, resize and completion", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  seed(fixture);
  try {
    const page = await fixture.page("selection");
    const target = message(page);
    await expect(target).toContainText("Earlier words.");
    await expect.poll(() => fixture.connected("selection")).toBe(true);
    const text = append(fixture, "fresh selected suffix", ["selection"]);
    await expect(target).toHaveText(text);
    await selectText(target, "fresh selected suffix");
    await expect.poll(() => selectedText(page)).toBe("fresh selected suffix");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => animationCount(target)).toBe(0);
    expect(await selectedText(page)).toBe("fresh selected suffix");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect(await selectedText(page)).toBe("fresh selected suffix");
    expect(await animationCount(target)).toBe(0);
    // An expired fade must not unwrap the browser's selected text nodes.
    await page.waitForTimeout(400);
    expect(await selectedText(page)).toBe("fresh selected suffix");
    const finalText = append(fixture, " and another incoming sentence.", ["selection"]);
    await expect(target).toHaveText(finalText);
    expect(await selectedText(page)).toBe("fresh selected suffix");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await selectedText(page)).toBe("fresh selected suffix");
    replace(fixture, finalText, true);
    await expect(page.getByRole("button", { name: "Copy message", exact: true })).toBeVisible();
    expect(await selectedText(page)).toBe("fresh selected suffix");
    expect(await animationCount(target)).toBe(0);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect(target).toHaveText(finalText);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("split Unicode deltas preserve complete graphemes in rendered text nodes", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  seed(fixture, "Unicode: ");
  try {
    const page = await fixture.page("unicode");
    const target = message(page);
    await expect(target).toContainText("Unicode:");
    await expect.poll(() => fixture.connected("unicode")).toBe(true);
    for (const suffix of ["\uD83D", "\uDE00 e", "\u0301 \uD83D\uDC69", "\u200D", "\uD83D\uDCBB 中文"]) {
      const text = append(fixture, suffix, ["unicode"]);
      await expect(target).toHaveText(text);
    }
    await expect(target).toHaveText("Unicode: 😀 é 👩‍💻 中文");
    const nodes = await target.evaluate(el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const result: string[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) result.push(node.textContent!);
      return result;
    });
    expect(nodes.some(text => text.includes("😀"))).toBe(true);
    expect(nodes.some(text => text.includes("é"))).toBe(true);
    expect(nodes.some(text => text.includes("👩‍💻"))).toBe(true);
    await expect.poll(() => animationCount(target)).toBe(0);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("append-like snapshots, revert and page remount show canonical content immediately", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  seed(fixture);
  try {
    const page = await fixture.page("replacement");
    const target = message(page);
    await expect(target).toContainText("Earlier words.");
    await expect.poll(() => fixture.connected("replacement")).toBe(true);
    append(fixture, "Live suffix.", ["replacement"]);
    await expect(target).toContainText("Live suffix.");
    replace(fixture, "Earlier words. Live suffix. Canonical refill extension.");
    await expect(target).toHaveText("Earlier words. Live suffix. Canonical refill extension.");
    expect(await animationCount(target)).toBe(0);
    const restored = "Restored canonical answer.";
    fixture.revertTimeline({ ...fixture.detail.timeline, rows: [answer(restored)] }, "replacement");
    await expect(target).toHaveText(restored);
    expect(await animationCount(target)).toBe(0);
    const text = append(fixture, " Another live suffix.", ["replacement"]);
    await expect(target).toHaveText(text);
    await page.reload();
    await expect(message(page)).toHaveText(text);
    expect(await animationCount(message(page))).toBe(0);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("reduced motion snaps current and subsequent canonical text", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  seed(fixture);
  try {
    const page = await fixture.page("motion");
    const target = message(page);
    await expect(target).toContainText("Earlier words.");
    await expect.poll(() => fixture.connected("motion")).toBe(true);
    const first = append(fixture, "Animated suffix.", ["motion"]);
    await expect(target).toHaveText(first);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => animationCount(target)).toBe(0);
    const text = append(fixture, " Immediate additional text.", ["motion"]);
    await expect(target).toHaveText(text);
    expect(await animationCount(target)).toBe(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect(await animationCount(target)).toBe(0);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("a second tab that misses deltas converges by canonical refill without replaying animation", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  seed(fixture);
  try {
    const first = await fixture.page("first");
    const second = await fixture.page("second");
    await expect(message(first)).toContainText("Earlier words.");
    await expect(message(second)).toContainText("Earlier words.");
    await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
    const text = append(fixture, "Only the first tab received this suffix.", ["first"]);
    await expect(message(first)).toHaveText(text);
    await expect(message(second)).toHaveText("Earlier words.");
    fixture.refreshRequired("second");
    await expect(message(second)).toHaveText(text);
    expect(await animationCount(message(second))).toBe(0);
    const finalText = append(fixture, " Shared live text.", ["first", "second"]);
    await expect(message(first)).toHaveText(finalText);
    await expect(message(second)).toHaveText(finalText);
    replace(fixture, finalText, true);
    for (const page of [first, second]) {
      await expect(page.getByRole("button", { name: "Copy message", exact: true })).toBeVisible();
      await expect(message(page)).toHaveText(finalText);
      expect(await animationCount(message(page))).toBe(0);
    }
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
