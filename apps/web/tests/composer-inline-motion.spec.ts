import { writeFile } from "node:fs/promises";
import { expect, test, type Locator } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

type Frame = {
  elapsed: number;
  height: number;
  bottom: number;
  shadowBottom: number;
  shadowHeight: number;
  shadowBoxShadow: string;
  shadowScaled: boolean;
  surfaceBoxShadow: string;
  addX: number;
  addY: number;
  modelX: number;
  modelY: number;
  idle: boolean;
  expanded: boolean;
  sameInput: boolean;
  focused: boolean;
  value: string;
  inputScaled: boolean;
  movingControls: boolean;
  runningAnimations: number;
};
type Recording = { frames: Frame[] };
type RecordedForm = HTMLFormElement & { motionRecording?: Promise<Recording> };

// Start and sample in the page so protocol latency cannot miss this short motion.
async function recordMotion(form: Locator, action: "focus" | "rapid" | "resize" | "none" = "focus") {
  await form.evaluate((node, action) => {
    const form = node as RecordedForm;
    const input = form.querySelector("textarea")!;
    const pane = form.closest<HTMLElement>(".kodex-thread-pane-existing")!;
    const started = performance.now();
    const translated = (element: Element) => {
      const transform = getComputedStyle(element).transform;
      if (transform === "none") return false;
      const matrix = new DOMMatrixReadOnly(transform);
      return Math.abs(matrix.m41) > 0.01 || Math.abs(matrix.m42) > 0.01 ||
        Math.abs(matrix.m11 - 1) > 0.01 || Math.abs(matrix.m22 - 1) > 0.01;
    };
    const scaled = (element: Element) => {
      const transform = getComputedStyle(element).transform;
      if (transform === "none") return false;
      const matrix = new DOMMatrixReadOnly(transform);
      return Math.abs(matrix.m11 - 1) > 0.01 || Math.abs(matrix.m22 - 1) > 0.01 ||
        Math.abs(matrix.m12) > 0.01 || Math.abs(matrix.m21) > 0.01;
    };
    const measure = (): Frame => {
      // The fallback gives the pre-animation implementation a behavioral failure.
      const surfaceElement = form.querySelector<HTMLElement>(".kodex-composer-surface") ?? form;
      const shadowElement = form.querySelector<HTMLElement>(".kodex-composer-shadow") ?? surfaceElement;
      const surface = surfaceElement.getBoundingClientRect();
      const shadow = shadowElement.getBoundingClientRect();
      const add = form.querySelector(".kodex-composer-secondary-action")!.getBoundingClientRect();
      const model = form.querySelector(".kodex-composer-model-control")!.getBoundingClientRect();
      return {
        elapsed: performance.now() - started, height: surface.height, bottom: surface.bottom,
        shadowBottom: shadow.bottom,
        shadowHeight: shadow.height,
        shadowBoxShadow: getComputedStyle(shadowElement).boxShadow,
        shadowScaled: scaled(shadowElement),
        surfaceBoxShadow: getComputedStyle(surfaceElement).boxShadow,
        addX: add.left, addY: add.top, modelX: model.left, modelY: model.top,
        idle: form.dataset.idleCompact === "true",
        expanded: Boolean(form.closest('[role="dialog"][aria-label="Compose"]')),
        sameInput: input.isConnected && input === form.querySelector("textarea"),
        focused: document.activeElement === input,
        value: input.value,
        inputScaled: (() => {
          let element: Element | null = input;
          while (element) {
            const transform = getComputedStyle(element).transform;
            if (transform !== "none") {
              const matrix = new DOMMatrixReadOnly(transform);
              if (Math.abs(matrix.m11 - 1) > 0.01 || Math.abs(matrix.m22 - 1) > 0.01 ||
                Math.abs(matrix.m12) > 0.01 || Math.abs(matrix.m21) > 0.01) return true;
            }
            if (element === form) break;
            element = element.parentElement;
          }
          return false;
        })(),
        movingControls: [...form.querySelectorAll(".kodex-composer-textarea, .kodex-composer-attachment-target, .kodex-composer-control-slot, .kodex-composer-toolbar-left > .kodex-adaptive-icon-button, .kodex-composer-action")].some(translated),
        runningAnimations: form.getAnimations({ subtree: true }).filter(animation => animation.playState === "running" &&
          animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some(keyframe =>
            ["transform", "width", "height", "borderRadius"].some(property => property in keyframe))).length,
      };
    };
    const frames = [measure()];
    form.motionRecording = new Promise(resolve => {
      let index = 0;
      function tick() {
        index += 1;
        frames.push(measure());
        if (action === "rapid" && index === 2) input.blur();
        if (action === "rapid" && index === 5) input.focus({ preventScroll: true });
        if (action === "resize" && index === 2) {
          pane.style.maxWidth = "900px";
          pane.style.width = "900px";
        }
        if (performance.now() - started < 420) requestAnimationFrame(tick);
        else resolve({ frames });
      }
      requestAnimationFrame(tick);
    });
    if (action !== "none") input.focus({ preventScroll: true });
  }, action);
}

async function finishMotion(form: Locator) {
  const result = await form.evaluate(async node => {
    const recording = (node as RecordedForm).motionRecording;
    if (!recording) throw new Error("Motion recording was not started");
    return recording;
  });
  const path = test.info().outputPath("rendered-motion-frames.json");
  await writeFile(path, JSON.stringify(result.frames));
  await test.info().attach("rendered-motion-frames", { path, contentType: "application/json" });
  return result;
}

function expectSettled(frames: Frame[]) {
  const tail = frames.slice(-3);
  expect(tail.every(frame => frame.sameInput && !frame.inputScaled)).toBe(true);
  expect(tail.every(frame => !frame.movingControls && frame.runningAnimations === 0)).toBe(true);
  expect(Math.max(...tail.map(frame => frame.height)) - Math.min(...tail.map(frame => frame.height))).toBeLessThan(0.5);
}

function expectInlineMorph(frames: Frame[]) {
  const idle = frames[0];
  const active = frames.at(-1)!;
  expect(active.height).toBeGreaterThan(idle.height + 10);
  expect(frames.filter(frame => frame.height > idle.height + 1 && frame.height < active.height - 1).length).toBeGreaterThan(1);
  expect(Math.max(...frames.map(frame => Math.abs(frame.bottom - idle.bottom)))).toBeLessThan(1);
  expect(Math.max(...frames.map(frame => Math.abs(frame.shadowBottom - idle.shadowBottom)))).toBeLessThan(1);
  expect(Math.max(...frames.map(frame => Math.abs(frame.shadowHeight - frame.height)))).toBeLessThan(1);
  expect(frames.every(frame => frame.height >= idle.height - 0.5 && frame.height <= active.height + 0.5)).toBe(true);
  expect(frames.every(frame => frame.sameInput && !frame.inputScaled && !frame.expanded)).toBe(true);
  expect(frames.every(frame => !frame.shadowScaled && frame.surfaceBoxShadow === "none")).toBe(true);
  expect(idle.shadowBoxShadow).not.toBe("none");
  expect(new Set(frames.map(frame => frame.shadowBoxShadow))).toEqual(new Set([idle.shadowBoxShadow]));
  // Even a short control glide must show a real intermediate position.
  expect(Math.abs(active.modelX - idle.modelX)).toBeGreaterThan(2);
  expect(frames.some(frame => frame.modelX > Math.min(idle.modelX, active.modelX) + 1 &&
    frame.modelX < Math.max(idle.modelX, active.modelX) - 1)).toBe(true);
  for (const position of ["addX", "addY", "modelX", "modelY"] as const) {
    expect(frames.every(frame => frame[position] >= Math.min(idle[position], active[position]) - 1 &&
      frame[position] <= Math.max(idle[position], active[position]) + 1)).toBe(true);
  }
  expectSettled(frames);
}

async function ready(fixture: Awaited<ReturnType<typeof nativeSettingsFixture>>, client: string, compactPane = false) {
  const page = await fixture.page(client);
  const pane = page.locator(".kodex-thread-pane-existing");
  if (compactPane) await pane.evaluate(node => { node.style.maxWidth = "360px"; });
  const form = pane.locator("form.kodex-composer");
  const input = pane.getByRole("textbox", { name: "Message composer", exact: true });
  await expect(pane).toHaveAttribute("data-pane-width", "compact");
  await expect(form).toHaveAttribute("data-idle-compact", "true");
  await expect(pane.getByRole("button", { name: "Model: gpt-5.4, medium", exact: true })).toBeEnabled();
  // Let pane observation and initial autosize settle before taking the idle frame.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return { page, pane, form, input };
}

function expectClean(fixture: Awaited<ReturnType<typeof nativeSettingsFixture>>) {
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
}

test.describe("compact inline composer motion", () => {
  test.use({ viewport: { width: 640, height: 844 }, hasTouch: false });

  test("grows upward smoothly while the original textarea accepts immediate typing", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const { page, pane, form, input } = await ready(fixture, "inline-morph");
      const original = await input.elementHandle();
      await page.screenshot({ path: test.info().outputPath("idle-inline.png") });
      await recordMotion(form);
      await page.keyboard.insertText("Typing during motion");
      await page.screenshot({ path: test.info().outputPath("opening-inline.png") });
      const { frames } = await finishMotion(form);
      await page.screenshot({ path: test.info().outputPath("active-inline.png") });
      expectInlineMorph(frames);
      expect(frames.some(frame => frame.height > frames[0].height + 1 &&
        frame.height < frames.at(-1)!.height - 1 && frame.value === "Typing during motion")).toBe(true);
      expect(frames.slice(1).every(frame => frame.focused)).toBe(true);
      await expect(input).toHaveValue("Typing during motion");
      await expect(input).toBeFocused();
      expect(await original!.evaluate(node => node === document.activeElement)).toBe(true);
      await expect(pane.getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(0);
    } finally { await fixture.close(); }
    expectClean(fixture);
  });

  test("rapid blur and reopen cancel stale motion and settle at the active surface", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const { form, input } = await ready(fixture, "inline-reopen");
      await recordMotion(form, "rapid");
      const { frames } = await finishMotion(form);
      expect(frames.slice(1, 5).some(frame => !frame.idle)).toBe(true);
      expect(frames.slice(2, 7).some(frame => frame.idle)).toBe(true);
      const active = frames.at(-1)!;
      expect(active.idle).toBe(false);
      expect(active.focused).toBe(true);
      expect(active.height).toBeGreaterThan(frames[0].height + 10);
      const span = active.height - frames[0].height;
      const changes = frames.slice(1).map((frame, index) => ({ previous: frames[index], frame }))
        .filter(({ previous, frame }) => previous.idle !== frame.idle);
      expect(changes).toHaveLength(3);
      // A retarget must continue from its visible progress. Jumping to either
      // endpoint on blur/reopen would move by almost the full surface span.
      for (const { previous, frame } of changes.slice(1)) {
        expect(Math.abs(frame.height - previous.height)).toBeLessThan(span * 0.5);
      }
      expect(frames.slice(5, 12).some(frame => frame.height > frames[0].height + 1 && frame.height < active.height - 1)).toBe(true);
      expect(frames.every(frame => frame.height >= frames[0].height - 0.5 && frame.height <= active.height + 0.5)).toBe(true);
      expectSettled(frames);
      await expect(input).toBeFocused();
    } finally { await fixture.close(); }
    expectClean(fixture);
  });

  test("resizing the pane during motion preserves editing and clears old geometry", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 844 }, baseURL: test.info().project.use.baseURL });
    const fixture = await nativeSettingsFixture(context);
    try {
      const { page, pane, form, input } = await ready(fixture, "inline-resize", true);
      const original = await input.elementHandle();
      await recordMotion(form, "resize");
      await page.keyboard.insertText("Draft across resize");
      await input.evaluate(node => node.setSelectionRange(2, 7));
      const { frames } = await finishMotion(form);
      await expect(pane).toHaveAttribute("data-pane-width", "regular");
      expectSettled(frames);
      expect(frames.slice(1).every(frame => frame.sameInput && frame.focused)).toBe(true);
      await expect(input).toHaveValue("Draft across resize");
      expect(await input.evaluate(node => [node.selectionStart, node.selectionEnd])).toEqual([2, 7]);
      expect(await original!.evaluate(node => node === document.activeElement)).toBe(true);
      const surface = form.locator(".kodex-composer-surface");
      if (await surface.count()) {
        expect((await surface.boundingBox())!.height).toBeCloseTo((await form.boundingBox())!.height, 0);
      }
    } finally { await fixture.close(); await context.close(); }
    expectClean(fixture);
  });

  test("reduced motion opens immediately without intermediate surface or control positions", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const { page, form, input } = await ready(fixture, "inline-reduced");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await recordMotion(form);
      const { frames } = await finishMotion(form);
      const active = frames.at(-1)!;
      expect(active.height).toBeGreaterThan(frames[0].height + 10);
      expect(frames.filter(frame => !frame.idle).every(frame => Math.abs(frame.height - active.height) < 0.5 &&
        Math.abs(frame.modelX - active.modelX) < 0.5 && !frame.movingControls && frame.runningAnimations === 0)).toBe(true);
      await expect(input).toBeFocused();
      expectSettled(frames);
    } finally { await fixture.close(); }
    expectClean(fixture);
  });
});

test("a real narrow touch opening goes straight to fullscreen without inline morph", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
  const fixture = await nativeSettingsFixture(context);
  try {
    const { page, pane, form, input } = await ready(fixture, "touch-fullscreen");
    const original = await input.elementHandle();
    await recordMotion(form, "none");
    await input.tap();
    await expect(pane.getByRole("dialog", { name: "Compose", exact: true })).toBeVisible();
    const { frames } = await finishMotion(form);
    const expanded = frames.filter(frame => frame.expanded);
    expect(expanded.length).toBeGreaterThan(0);
    expect(expanded.every(frame => !frame.movingControls && frame.runningAnimations === 0 && !frame.inputScaled)).toBe(true);
    expectSettled(frames);
    await page.keyboard.insertText("Touch draft");
    await expect(input).toHaveValue("Touch draft");
    expect(await original!.evaluate(node => node === document.activeElement)).toBe(true);
  } finally { await fixture.close(); await context.close(); }
  expectClean(fixture);
});

test("a wide touch workspace with fullscreen disabled animates its idle composer inline", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
  await context.addInitScript(() => {
    if (location.protocol === "http:") {
      localStorage.setItem("kodex-color-scheme", "dracula");
      localStorage.setItem("kodex-interface", JSON.stringify({ fullscreenComposerOnTouch: false }));
    }
  });
  const fixture = await nativeSettingsFixture(context);
  try {
    const page = await fixture.page("wide-touch-inline");
    const pane = page.locator(".kodex-thread-pane-existing");
    const form = pane.locator("form.kodex-composer");
    const input = pane.getByRole("textbox", { name: "Message composer", exact: true });
    await expect(pane).toHaveAttribute("data-pane-width", "regular");
    await expect(form).toHaveAttribute("data-idle-compact", "true");
    await expect(pane.getByRole("button", { name: "Model: gpt-5.4, medium", exact: true })).toBeEnabled();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: test.info().outputPath("idle-dark-inline.png") });
    await recordMotion(form, "none");
    await input.tap();
    await page.screenshot({ path: test.info().outputPath("opening-dark-inline.png") });
    const { frames } = await finishMotion(form);
    await page.screenshot({ path: test.info().outputPath("active-dark-inline.png") });
    expectInlineMorph(frames);
    await expect(pane.getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(0);
    await expect(input).toBeFocused();
  } finally { await fixture.close(); await context.close(); }
  expectClean(fixture);
});
