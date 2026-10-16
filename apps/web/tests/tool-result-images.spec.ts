import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";
import { compactCanonicalPayload } from "../src/test/canonicalPayloadFixture";
import type { ThreadTimelineRow } from "../src/api/client";

const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

test("tool screenshots appear live and survive missed events and reload in another tab", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  try {
    const first = await fixture.page("first");
    const second = await fixture.page("second");
    await expect.poll(() => fixture.connected("first") && fixture.connected("second")).toBe(true);
    const row: ThreadTimelineRow = {
      id: "screenshot", kind: "mcp_tool_call", displayOrder: 100, status: "completed", turnId: "capture-turn",
      item: {
        id: "screenshot", itemId: "native-screenshot", itemType: "mcpToolCall", displayOrder: 100,
        status: "completed", threadId: "settings-chat", turnId: "capture-turn", codexMethod: "item/completed",
        payload: compactCanonicalPayload({tool: "capture", result: "Screenshot captured", images: [{url}]}),
      },
    };
    fixture.publishTimeline({...fixture.detail.timeline, rows:[row], turns:[{id:"capture-turn",status:"completed"}]}, "first");
    const screenshot = first.getByRole("img", {name:"Tool result image 1"});
    await expect(screenshot).toBeVisible();
    await expect.poll(() => screenshot.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    await first.getByRole("button", {name:"Open image",exact:true}).click();
    await expect(first.getByRole("dialog")).toBeVisible();
    await first.keyboard.press("Escape");
    // The second tab receives no image patch; foreground/reconnect or this
    // explicit invalidation must converge from the authoritative snapshot.
    fixture.refreshRequired("second");
    await expect(second.getByRole("img", {name:"Tool result image 1"})).toBeVisible();
    await second.reload();
    await expect(second.getByRole("img", {name:"Tool result image 1"})).toBeVisible();
    await first.screenshot({path:"/tmp/kodex-tool-images.png"});
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});
