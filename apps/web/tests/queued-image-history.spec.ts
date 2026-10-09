import { expect, test, type Page } from "@playwright/test";

import { nativeSettingsFixture } from "./native-settings.fixture";

// A valid image above the gateway's ordinary text-preview limit.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><!--${"x".repeat(16_384)}--><rect width="32" height="32" fill="purple"/></svg>`;
const imageUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

async function expectDecodedImage(page: Page) {
  const image = page.locator(".kodex-user-image-grid img");
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("src", imageUrl);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) =>
    element.complete && element.naturalWidth === 32 && element.naturalHeight === 32,
  )).toBe(true);
}

test("queued images decode after a native receipt, missed events and reload in another tab", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context, { queuedSteerClient: "first" });
  fixture.detail.thread.status = "active";
  fixture.detail.liveState = "streaming";
  fixture.detail.timeline = {
    ...fixture.detail.timeline, activeTurnId: "turn-1", liveState: "streaming",
    turns: [{ id: "turn-1", status: "inProgress" }],
  };
  fixture.queuedInputs.push({
    id: "image-queue", threadId: "settings-chat", clientUserMessageId: "image-client",
    input: [{ type: "text", text: "Inspect this image" }, { type: "image", url: imageUrl }],
    attachments: [], canSteer: true,
  });
  try {
    const first = await fixture.page("first");
    const second = await fixture.page("second");
    await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
    await first.getByRole("group", { name: "Queued message", exact: true }).filter({ hasText: "Inspect this image" })
      .getByRole("button", { name: "Steer", exact: true }).click();
    await expectDecodedImage(first);
    await first.setViewportSize({ width: 1920, height: 900 });
    const image = first.locator(".kodex-user-image-grid img");
    const imagePane = first.locator('.kodex-thread-pane-existing');
    await expect(imagePane).toHaveAttribute("data-pane-width", "regular");
    const regularWidth = (await image.boundingBox())!.width;
    await imagePane.evaluate(el => { el.style.maxWidth = "360px"; });
    await expect.poll(async () => (await image.boundingBox())!.width).toBeLessThan(regularWidth);
    expect(await imagePane.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await imagePane.evaluate(el => { el.style.maxWidth = ""; });
    await expect.poll(async () => (await image.boundingBox())!.width).toBe(regularWidth);
    await expect.poll(() => fixture.transfers.length).toBe(1);
    fixture.receiveQueuedTransfer(fixture.transfers[0].id, "native-image-message", "first");
    await expectDecodedImage(first);
    const connections = fixture.connections.get("second") ?? 0;
    fixture.disconnect("second");
    await expect.poll(() => fixture.connections.get("second") ?? 0).toBeGreaterThan(connections);
    await expectDecodedImage(second);
    await second.reload();
    await expectDecodedImage(second);
  } finally {
    await fixture.close();
  }
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
