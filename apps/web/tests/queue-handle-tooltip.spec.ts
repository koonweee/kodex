import { expect, test } from "@playwright/test";

import { nativeSettingsFixture } from "./native-settings.fixture";

for (const shape of [
  { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
  { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
  { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
]) {
  test.describe(shape.name, () => {
    test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });
    test("stale browser hover flags do not highlight handles away from the pointer", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.queuedInputs.push(...["First", "Second"].map((text, index) => ({
        id: `stale-${index}`, threadId: "settings-chat", input: [{ type: "text" as const, text }],
        clientUserMessageId: `stale-client-${index}`, attachments: [], canSteer: false,
      })));
      try {
        const page = await fixture.page("stale-hover");
        const handles = page.getByRole("button", { name: "Reorder queued message", exact: true });
        await expect(handles).toHaveCount(2);
        await page.mouse.move(1, 1);
        const backgrounds = () => handles.evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).backgroundColor));
        const resting = await backgrounds();
        const session = await context.newCDPSession(page);
        await session.send("DOM.enable");
        await session.send("CSS.enable");
        const { root } = await session.send("DOM.getDocument");
        const { nodeIds } = await session.send("DOM.querySelectorAll", { nodeId: root.nodeId,
          selector: 'button[aria-label="Reorder queued message"]' });
        // Model browser pseudo-state that survives a layout change or captured gesture.
        // The physical pointer stays outside both handles.
        for (const nodeId of nodeIds) await session.send("CSS.forcePseudoState", { nodeId,
          forcedPseudoClasses: [shape.hasTouch ? "active" : "hover"] });
        await expect.poll(backgrounds).toEqual(resting);
        if (!shape.hasTouch) {
          await handles.first().hover();
          await expect.poll(async () => (await backgrounds())[0]).toBe(resting[0]);
          await expect.poll(async () => (await backgrounds())[1]).toBe(resting[1]);
          await handles.last().hover();
          await expect.poll(async () => (await backgrounds())[0]).toBe(resting[0]);
          await expect.poll(async () => (await backgrounds())[1]).toBe(resting[1]);
          await page.mouse.move(1, 1);
          await expect.poll(backgrounds).toEqual(resting);
        }
        await page.screenshot({ path: test.info().outputPath("queue-handles-stale-hover.png") });
        await session.detach();
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });

    test("queue handle has no hover highlight and clears its tooltip after captured gestures", async ({ context }) => {
      const fixture = await nativeSettingsFixture(context);
      fixture.queuedInputs.push(...["First", "Second"].map((text, index) => ({
        id: `tooltip-${index}`, threadId: "settings-chat", input: [{ type: "text" as const, text }],
        clientUserMessageId: `tooltip-client-${index}`, attachments: [], canSteer: false,
      })));
      try {
        const page = await fixture.page("first");
        const pane = page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
        const rows = pane.getByRole("group", { name: "Queued message", exact: true });
        await expect(rows).toHaveCount(2);
        const handle = rows.first().getByRole("button", { name: "Reorder queued message", exact: true });
        const tooltip = page.getByRole("tooltip", { name: "Drag to reorder · ↑/↓ to move" });
        const background = () => handle.evaluate((element) => getComputedStyle(element).backgroundColor);
        const restingBackground = await background();
        const rowBackground = () => rows.first().evaluate((element) => getComputedStyle(element).backgroundColor);
        const restingRowBackground = await rowBackground();
        if (shape.hasTouch) {
          await handle.tap();
          await expect(tooltip).toBeHidden();
          await expect.poll(background).toBe(restingBackground);
        } else {
          await handle.hover();
          await expect(tooltip).toBeVisible();
          await expect.poll(background).toBe(restingBackground);
          await rows.first().getByText("First", { exact: true }).hover();
          await expect(tooltip).toBeHidden();
          await expect.poll(background).toBe(restingBackground);

          // Hover dismissal must work even while keyboard focus stays elsewhere.
          await pane.getByLabel("Message composer", { exact: true }).focus();
          await handle.hover();
          await expect(tooltip).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(tooltip).toBeHidden();
          await rows.first().getByText("First", { exact: true }).hover();

          await handle.hover();
          await expect(tooltip).toBeVisible();
          const bounds = await handle.boundingBox();
          if (!bounds) throw new Error("Expected a visible queue handle");
          await page.mouse.down();
          // Pointer capture suppresses hover-exit events until the button is released.
          await page.mouse.move(bounds.x + bounds.width + 30, bounds.y + bounds.height / 2);
          await expect(handle).toBeFocused();
          await expect(tooltip).toBeHidden();
          await expect.poll(background).toBe(restingBackground);
          await page.mouse.up();
          await expect(tooltip).toBeHidden();
          await expect.poll(background).toBe(restingBackground);

          await handle.hover();
          await expect(tooltip).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(tooltip).toBeHidden();

          await rows.first().getByText("First", { exact: true }).hover();
          await handle.hover();
          await expect(tooltip).toBeVisible();
          await page.mouse.down();
          const target = await rows.last().boundingBox();
          if (!target) throw new Error("Expected a visible drop target");
          await page.mouse.move(bounds.x + bounds.width + 30, target.y + target.height / 2, { steps: 8 });
          await expect(tooltip).toBeHidden();
          await expect.poll(rowBackground).not.toBe(restingRowBackground);
          await page.keyboard.press("Escape");
          await page.mouse.up();
          await expect(tooltip).toBeHidden();
          await expect.poll(rowBackground).toBe(restingRowBackground);
          await handle.hover();
          await expect(tooltip).toBeVisible();
          await expect.poll(background).toBe(restingBackground);
          await rows.first().getByText("First", { exact: true }).hover();
          await expect(tooltip).toBeHidden();
          await expect.poll(background).toBe(restingBackground);
        }
        await page.screenshot({ path: test.info().outputPath("queue-handle-resting.png") });
        await expect(rows).toHaveText(["First", "Second"]);
        expect(fixture.requests.filter((request) => request.key.endsWith("/reorder"))).toEqual([]);
      } finally { await fixture.close(); }
      expect(fixture.unexpected).toEqual([]);
      expect(fixture.errors).toEqual([]);
    });
  });
}

// Desktop keeps neighboring panes visible while the draft receives focus.
test("inactive-pane queue handles stay unboxed and regain reorder on focus", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  fixture.queuedInputs.push(...["First", "Second"].map((text, index) => ({
    id: `inactive-${index}`, threadId: "settings-chat", input: [{ type: "text" as const, text }],
    clientUserMessageId: `inactive-client-${index}`, attachments: [], canSteer: false,
  })));
  try {
    const page = await fixture.page("inactive-handles", "/threads/settings-chat");
    await page.setViewportSize({ width: 1440, height: 900 });
    const pane = page.locator(".kodex-thread-pane-existing");
    const handle = pane.getByRole("button", { name: "Reorder queued message", exact: true }).first();
    await expect(handle).toBeEnabled();
    const paint = () => handle.evaluate(element => {
      const css = getComputedStyle(element);
      return { background: css.backgroundColor, border: css.borderTopColor, color: getComputedStyle(element.querySelector("svg")!).color };
    });
    const enabled = await paint();
    await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: "Chats", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page.locator('.kodex-thread-pane-empty[data-workspace-pane-active="true"]')).toBeVisible();
    await expect(handle).toBeDisabled();
    await expect.poll(async () => (await paint()).background).toBe(enabled.background);
    await expect.poll(async () => (await paint()).border).toBe(enabled.border);
    await expect.poll(async () => (await paint()).color).not.toBe(enabled.color);
    await handle.hover();
    await expect.poll(async () => (await paint()).background).toBe(enabled.background);
    await page.screenshot({ path: test.info().outputPath("inactive-queue-handles.png"), animations: "disabled" });
    await pane.getByRole("textbox", { name: "Message composer", exact: true }).click();
    await expect(handle).toBeEnabled();
    await expect.poll(paint).toEqual(enabled);
    expect(fixture.requests.filter(request => request.key.endsWith("/reorder"))).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});
