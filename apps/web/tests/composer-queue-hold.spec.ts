import { expect, test, type CDPSession, type Locator } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function startTouch(cdp: CDPSession, button: Locator) {
  const bounds = await button.boundingBox();
  const point = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2, id: 1 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  return point;
}

test("touch hold explicitly queues once, clears the draft and converges in another tab", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  try {
    const first = await fixture.page("first");
    const second = await fixture.page("second");
    await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
    const composer = first.getByRole("textbox", { name: "Message composer", exact: true });
    await composer.fill("Queue this from touch");
    await expect(first.getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(0);
    const cdp = await context.newCDPSession(first);
    await startTouch(cdp, first.getByRole("button", { name: "Send message", exact: true }));
    await expect.poll(() => fixture.queuedInputs.length).toBe(1);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(composer).toHaveValue("");
    for (const page of [first, second]) await expect(page.getByText("Queue this from touch", { exact: true })).toBeVisible();
    expect(fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/queued-inputs")).toHaveLength(1);
    expect(fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/input")).toHaveLength(0);
    await first.screenshot({ path: test.info().outputPath("touch-held-queued.png") });
    await cdp.detach();
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("moving a touch cancels the hold and a fresh short tap retains ordinary Send", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  try {
    const page = await fixture.page("touch");
    const composer = page.getByRole("textbox", { name: "Message composer", exact: true });
    await composer.fill("Keep this draft after dragging");
    await expect(page.getByRole("dialog", { name: "Compose", exact: true })).toHaveCount(0);
    const send = page.getByRole("button", { name: "Send message", exact: true });
    const cdp = await context.newCDPSession(page);
    const point = await startTouch(cdp, send);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, x: point.x - 40 }] });
    await page.waitForTimeout(600);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(composer).toHaveValue("Keep this draft after dragging");
    expect(fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/queued-inputs" || request.key === "POST /v1/threads/settings-chat/input")).toHaveLength(0);
    await send.tap();
    await expect.poll(() => fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/input").length).toBe(1);
    expect(fixture.queuedInputs).toHaveLength(0);
    await cdp.detach();
  } finally { await fixture.close(); }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});


test.describe("desktop mouse hold", () => {
  test.use({ viewport: { width: 1100, height: 700 }, hasTouch: false, isMobile: false });

  test("hold queues once across two tabs and the tooltip applies to mouse input", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const first = await fixture.page("mouse-first");
      const second = await fixture.page("mouse-second");
      await expect.poll(() => fixture.connected("mouse-first") && fixture.connected("mouse-second")).toBe(true);
      const pane = first.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
      const composer = pane.getByRole("textbox", { name: "Message composer", exact: true });
      await composer.fill("Queue this from mouse");
      const send = pane.getByRole("button", { name: "Send message", exact: true });
      await send.hover();
      await expect(first.getByRole("tooltip")).toHaveText("Send message · Hold to queue");
      await first.mouse.down();
      await expect.poll(() => fixture.queuedInputs.length).toBe(1);
      await first.mouse.up();
      await expect(composer).toHaveValue("");
      for (const page of [first, second]) await expect(page.getByText("Queue this from mouse", { exact: true })).toBeVisible();
      expect(fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/queued-inputs")).toHaveLength(1);
      expect(fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/input")).toHaveLength(0);
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });

  test("moving cancels a mouse hold and a fresh short click retains Send", async ({ context }) => {
    const fixture = await nativeSettingsFixture(context);
    try {
      const page = await fixture.page("mouse-cancel");
      const pane = page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
      const composer = pane.getByRole("textbox", { name: "Message composer", exact: true });
      await composer.fill("Keep this draft after moving");
      const send = pane.getByRole("button", { name: "Send message", exact: true });
      const bounds = (await send.boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x - 40, bounds.y + bounds.height / 2);
      await page.waitForTimeout(600);
      await page.mouse.up();
      await expect(composer).toHaveValue("Keep this draft after moving");
      expect(fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/queued-inputs" || request.key === "POST /v1/threads/settings-chat/input")).toHaveLength(0);
      await send.click();
      await expect.poll(() => fixture.requests.filter(request => request.key === "POST /v1/threads/settings-chat/input").length).toBe(1);
      expect(fixture.queuedInputs).toHaveLength(0);
    } finally { await fixture.close(); }
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
});
