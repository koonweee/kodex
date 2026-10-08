import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "small fine pointer", width: 320, hasTouch: false },
  { name: "small touch", width: 320, hasTouch: true },
  { name: "hybrid", width: 390, hasTouch: true },
  { name: "compact fine pointer", width: 640, hasTouch: false },
  { name: "wide touch with compact pane", width: 1280, hasTouch: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch });
    test("idle row fits, keeps menus reachable and preserves editing through activation", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      try {
        const page = await fixture.page("idle");
        const pane = page.locator(".kodex-thread-pane-existing");
        if (shape.width > 900) await pane.evaluate(el => { el.style.maxWidth = "360px"; });
        const input = pane.getByRole("textbox", { name: "Message composer", exact: true });
        const form = pane.locator("form.kodex-composer");
        const add = pane.getByRole("button", { name: "Open attachment menu", exact: true });
        const model = pane.getByRole("button", { name: "Model: gpt-5.4, medium", exact: true });
        await expect(pane).toHaveAttribute("data-pane-width", "compact");
        await expect(form).toHaveAttribute("data-idle-compact", "true");
        await expect(model).toBeEnabled();
        const original = await input.elementHandle();
        const measure = () => form.evaluate(el => {
          const bounds = (selector: string) => el.querySelector(selector)!.getBoundingClientRect();
          const style = getComputedStyle(el);
          const input = bounds("textarea");
          const add = bounds(".kodex-composer-secondary-action");
          const context = bounds(".kodex-context-usage");
          const model = bounds(".kodex-composer-model-control");
          return { height: el.getBoundingClientRect().height, padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
            inputHeight: input.height, inputWidth: input.width, fieldBetween: input.left >= add.right && input.right <= context.left,
            contextWidth: context.width, contextModelGap: model.left - context.right,
            controlHeight: add.height, modelWidth: model.width, modelHeight: model.height, overflow: el.scrollWidth - el.clientWidth };
        });
        await expect.poll(async () => (await measure()).overflow).toBeLessThanOrEqual(1);
        const idle = await measure();
        expect(idle.height).toBeCloseTo(idle.controlHeight + idle.padding, 0);
        expect(idle.inputWidth).toBeGreaterThan(40);
        expect(idle.inputHeight).toBeLessThanOrEqual(idle.controlHeight + 1);
        expect(idle.fieldBetween).toBe(true);
        expect(idle.contextWidth).toBeCloseTo(idle.modelWidth, 0);
        expect(idle.contextModelGap).toBeCloseTo(4, 0);
        expect(idle.modelWidth).toBeCloseTo(idle.controlHeight, 0);
        expect(idle.modelHeight).toBeCloseTo(idle.controlHeight, 0);
        await page.screenshot({ path: test.info().outputPath("idle-row.png") });
        await add.click();
        await expect(page.getByRole("menuitem", { name: "Add attachment", exact: true })).toBeVisible();
        await expect(form).toHaveAttribute("data-idle-compact", "true");
        await expect.poll(() => page.getByRole("menu").evaluate(el => el.contains(document.activeElement))).toBe(true);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toBeHidden();
        await model.click();
        await expect(page.getByRole("menuitem", { name: "Reasoning", exact: true })).toBeVisible();
        await expect(form).toHaveAttribute("data-idle-compact", "true");
        await expect.poll(() => page.getByRole("menu").evaluate(el => el.contains(document.activeElement))).toBe(true);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toBeHidden();
        // Keyboard opening on touch-capable hardware stays inline.
        await input.focus();
        await expect(input).toBeFocused();
        await expect(form).toHaveAttribute("data-idle-compact", "false");
        await expect(pane.getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(0);
        const active = await measure();
        expect(active.height).toBeGreaterThan(idle.height);
        expect(active.contextWidth).toBeCloseTo(active.modelWidth, 0);
        expect(active.contextModelGap).toBeCloseTo(4, 0);
        await input.fill(" ");
        await page.mouse.click(shape.width - 20, 150);
        await expect(form).toHaveAttribute("data-idle-compact", "false");
        await input.fill("");
        await input.focus();
        await model.click();
        await page.getByRole("menuitem", { name: "Reasoning", exact: true }).click();
        await expect(page.getByRole("menuitem", { name: "Medium", exact: true })).toBeFocused();
        await expect(form).toHaveAttribute("data-idle-compact", "false");
        await expect.poll(() => page.getByRole("menu").evaluate(el => el.contains(document.activeElement))).toBe(true);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toBeHidden();
        await expect(model).toBeFocused();
        await expect(form).toHaveAttribute("data-idle-compact", "false");
        await model.click();
        await page.getByRole("menuitem", { name: "Reasoning", exact: true }).click();
        await page.getByRole("menuitem", { name: "Medium", exact: true }).click();
        await expect.poll(() => fixture.pending).toEqual([{ effort: "medium" }]);
        await expect(model).toBeEnabled();
        expect(await original!.evaluate(el => el.isConnected)).toBe(true);
        // Saving native settings can disable the trigger and end its focus.
        await input.focus();
        await expect(form).toHaveAttribute("data-idle-compact", "false");
        await model.click();
        if (shape.hasTouch && shape.width <= 700) {
          await page.getByRole("button", { name: "Close Run settings", exact: true }).click();
          await expect(model).toBeFocused();
          await expect(form).toHaveAttribute("data-idle-compact", "false");
        } else {
          await expect.poll(() => page.getByRole("menu").evaluate(el => el.contains(document.activeElement))).toBe(true);
          await page.keyboard.press("Escape");
          await expect(page.getByRole("menu")).toBeHidden();
        }
        await model.click();
        await expect(page.getByRole("menu", { name: "Model and speed controls" })).toBeVisible();
        await expect.poll(() => page.getByRole("menu").evaluate(el => el.contains(document.activeElement))).toBe(true);
        if (shape.width <= 900) {
          await page.locator(".kodex-workspace-single-pane-header").click({ position: { x: 2, y: 2 } });
        } else {
          await page.mouse.click(shape.width - 20, 150);
        }
        await expect(page.getByRole("menu", { name: "Model and speed controls" })).toBeHidden();
        await input.click();
        await expect(input).toBeFocused();
        await expect(page.getByRole("menu", { name: "Model and speed controls" })).toBeHidden();
        await expect(form).toHaveAttribute("data-idle-compact", "false");
        await input.press("Tab");
        await expect(form).toHaveAttribute("data-idle-compact", "false");
        await page.mouse.click(shape.width - 20, 150);
        await expect(form).toHaveAttribute("data-idle-compact", "true");
        if (shape.hasTouch) await input.tap();
        else await input.click();
        await expect(input).toBeFocused();
        await expect(form).toHaveAttribute("data-idle-compact", "false");
        await expect(pane.getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(shape.hasTouch && shape.width <= 900 ? 1 : 0);
        expect(await original!.evaluate(el => el.isConnected && el === document.activeElement)).toBe(true);
        await input.fill("Draft survives resize");
        await input.evaluate(el => el.setSelectionRange(2, 7));
        await page.setViewportSize({ width: 1280, height: 500 });
        await expect(pane.getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(0);
        await expect(input).toHaveValue("Draft survives resize");
        await expect(input).toBeFocused();
        expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([2, 7]);
        expect(await original!.evaluate(el => el.isConnected && el === document.activeElement)).toBe(true);
      } finally { await fixture.close(); }
      expect(fixture.errors).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    });
  });
}

test("compact new conversation retains its normal greeting and textarea", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  try {
    const page = await fixture.page("new-idle", "/");
    await page.setViewportSize({ width: 390, height: 844 });
    const pane = page.locator(".kodex-thread-pane-empty");
    await expect(pane).toHaveAttribute("data-pane-width", "compact");
    await expect(pane.locator("form.kodex-composer")).toHaveAttribute("data-idle-compact", "false");
    await expect(pane.locator(".kodex-composer-hero")).toBeVisible();
    const rows = await pane.getByRole("textbox", { name: "Message composer", exact: true }).evaluate(el => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
    expect(rows).toBeCloseTo(2, 0);
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const settingsError of [false, true]) {
  test(`small touch pane keeps goal and ${settingsError ? "settings error" : "Fast"} controls usable`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 844 }, hasTouch: true, baseURL: test.info().project.use.baseURL });
    const fixture = await nativeSettingsFixture(context);
    fixture.settings.serviceTier = "fast";
    fixture.setGoal({ threadId: fixture.detail.thread.id, objective: "Finish work", status: "active", tokenBudget: null,
      tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 });
    if (settingsError) await context.route("**/v1/threads/settings-chat/settings", route => route.fulfill({ status: 400, json: { code: "bad_request", message: "Could not load settings", retryable: false } }));
    try {
      const page = await fixture.page("auxiliary-idle");
      const pane = page.locator(".kodex-thread-pane-existing");
      await expect(pane.getByRole("button", { name: "Manage goal: Active" })).toBeVisible();
      if (settingsError) await expect(pane.getByRole("button", { name: "Chat settings unavailable", exact: true })).toBeVisible();
      else await expect(pane.getByRole("img", { name: "Fast responses enabled" })).toBeVisible();
      const form = pane.locator("form.kodex-composer");
      await expect(form).toHaveAttribute("data-idle-compact", settingsError ? "false" : "true");
      expect(await form.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      const input = pane.getByRole("textbox", { name: "Message composer", exact: true });
      expect((await input.boundingBox())!.width).toBeGreaterThan(20);
      if (!settingsError) {
        const controls = await form.evaluate(el => [
          ".kodex-composer-fast-indicator",
          ".kodex-composer-model-control",
          ".kodex-goal-icon",
          ".kodex-composer-action",
        ].map(selector => el.querySelector(selector)!.getBoundingClientRect()).map(box => ({ left: box.left, right: box.right, width: box.width })));
        for (const control of controls) expect(control.width).toBeCloseTo(44, 0);
        for (let index = 1; index < controls.length; index += 1) {
          expect(controls[index].left - controls[index - 1].right).toBeCloseTo(4, 0);
        }
      }
      await page.screenshot({ path: test.info().outputPath("auxiliary-controls.png") });
      await input.tap();
      await expect(input).toBeFocused();
      await expect(pane.getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(1);
    } finally { await fixture.close(); await context.close(); }
    expect(fixture.errors).toEqual(settingsError ? ["Failed to load resource: the server responded with a status of 400 (Bad Request)"] : []);
    expect(fixture.unexpected).toEqual([]);
  });
}

for (const hasTouch of [false, true]) {
  test(`compact ${hasTouch ? "touch" : "fine pointer"} loading keeps the idle row through native attachment and settings`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch, baseURL: test.info().project.use.baseURL });
    const fixture = await nativeSettingsFixture(context);
    const client = "loading-idle";
    // Strict Mode and reconnects may replace initial requests. Delay every
    // response until release so an aborted request cannot consume the gate.
    let releaseAttachment!: () => void;
    let releaseSettings!: () => void;
    let attachmentStarted = false;
    let settingsStarted = false;
    const attachmentGate = new Promise<void>(resolve => { releaseAttachment = resolve; });
    const settingsGate = new Promise<void>(resolve => { releaseSettings = resolve; });
    await context.route("**/v1/threads/settings-chat/attach", async route => {
      attachmentStarted = true;
      await attachmentGate;
      await route.fallback();
    });
    await context.route("**/v1/threads/settings-chat/settings", async route => {
      settingsStarted = true;
      await settingsGate;
      await route.fallback();
    });
    try {
      const page = await fixture.page(client);
      await expect.poll(() => attachmentStarted).toBe(true);
      const pane = page.locator(".kodex-thread-pane-existing");
      const input = pane.getByRole("textbox", { name: "Message composer", exact: true });
      const form = pane.locator("form.kodex-composer");
      const add = pane.getByRole("button", { name: "Open attachment menu", exact: true });
      await expect(pane).toHaveAttribute("data-pane-width", "compact");
      await expect(form).toHaveAttribute("data-idle-compact", "true");
      await expect(pane.locator(".kodex-composer-shell")).toHaveAttribute("data-entry-ready", "false");
      await expect(add).toBeDisabled();
      const original = await input.elementHandle();
      const height = (await form.boundingBox())!.height;
      const footerHeight = await add.evaluate(el => el.getBoundingClientRect().height);
      const padding = await form.evaluate(el => {
        const style = getComputedStyle(el);
        return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      });
      expect(height).toBeCloseTo(footerHeight + padding, 0);
      await page.screenshot({ path: test.info().outputPath("loading-idle.png") });
      releaseAttachment();
      await expect.poll(() => settingsStarted).toBe(true);
      await expect(pane.locator(".kodex-composer-shell")).toHaveAttribute("data-entry-ready", "true");
      await expect(form).toHaveAttribute("data-idle-compact", "true");
      await expect(add).toBeEnabled();
      await expect(pane.getByRole("button", { name: "Loading chat settings", exact: true })).toBeDisabled();
      expect((await form.boundingBox())!.height).toBeCloseTo(height, 0);
      releaseSettings();
      await expect(pane.getByRole("button", { name: "Model: gpt-5.4, medium", exact: true })).toBeEnabled();
      await expect(form).toHaveAttribute("data-idle-compact", "true");
      expect((await form.boundingBox())!.height).toBeCloseTo(height, 0);
      expect(await original!.evaluate(el => el.isConnected)).toBe(true);
      await page.screenshot({ path: test.info().outputPath("ready-idle.png") });
      await input.click();
      await expect(input).toBeFocused();
      expect(await original!.evaluate(el => el === document.activeElement)).toBe(true);
      await expect(form).toHaveAttribute("data-idle-compact", "false");
    } finally {
      releaseAttachment();
      releaseSettings();
      await fixture.close();
      await context.close();
    }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
