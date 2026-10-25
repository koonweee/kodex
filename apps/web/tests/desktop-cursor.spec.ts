import { expect, test, type FrameLocator } from "@playwright/test";
import { nativeProjectsFixture } from "./native-projects.fixture";
import { DesktopRfbFixture } from "./desktop-rfb.fixture";
import { openDesktop } from "./desktop-pane.fixture";

test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

async function cursorErrorRatio(frame: FrameLocator, remote: DesktopRfbFixture) {
  const pointer = remote.connections[0].pointerPositions.at(-1)!;
  const selected=remote.nativeDisplays.find(d=>d.id===remote.displaySelections.at(-1))!;
  const canvas = frame.locator("#screen canvas");
  const image = (await canvas.boundingBox())!;
  const cursor = (await frame.locator("body > canvas").boundingBox())!;
  const size = await canvas.evaluate((node: HTMLCanvasElement) => ({ width: node.width, height: node.height, dpr: devicePixelRatio }));
  // RFB coordinates are integer framebuffer pixels. Allow that quantization
  // plus one physical display pixel when checking a magnified cursor.
  const tolerance = Math.max(image.width / size.width, image.height / size.height) + 1 / size.dpr;
  return Math.max(
    Math.abs(cursor.x + remote.cursor!.hotx - (image.x + pointer.x * image.width / selected.width)),
    Math.abs(cursor.y + remote.cursor!.hoty - (image.y + pointer.y * image.height / selected.height)),
  ) / tolerance;
}

async function tap(frame: FrameLocator) {
  // Playwright waits for the fitted canvas to settle after monitor/scale changes.
  await frame.locator("#screen canvas").tap();
}

test("the touch cursor hotspot matches the transmitted click through cursor changes and native monitor switches", async ({ context }) => {
  const app = await nativeProjectsFixture(context, { desktopEnabled: true });
  const remote = new DesktopRfbFixture();
  remote.nativeDesktop = true;
  remote.framebuffer = { width: 4294, height: 2160 };
  remote.nativeDisplays = [
    { id: 92, main: true, x: 0, y: 0, width: 3840, height: 2160, fbX: 0, fbY: 0 },
    { id: 93, main: false, x: 512, y: 100, width: 454, height: 298, fbX: 3840, fbY: 100 },
  ];
  remote.cursor = { width: 32, height: 48, hotx: 8, hoty: 16 };
  await remote.install(context);
  try {
    const page = await app.page("cursor-hotspot", "/threads/history");
    const frame = await openDesktop(page);
    const selector = page.getByRole("button", { name: /^Desktop display:/ });
    await expect(selector).toBeEnabled();
    await expect(frame.locator("body > canvas")).toHaveJSProperty("width", 32);
    await tap(frame);
    await expect.poll(() => remote.connections[0].pointerPositions.some((p) => p.mask === 1)).toBe(true);
    await expect.poll(() => cursorErrorRatio(frame, remote)).toBeLessThan(1);
    const box = (await frame.locator("#screen canvas").boundingBox())!;
    const session = await context.newCDPSession(page);
    const pair = [{ x: box.x + box.width / 2 - 20, y: box.y + box.height / 2, id: 1 },
      { x: box.x + box.width / 2 + 20, y: box.y + box.height / 2, id: 2 }];
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pair });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...pair[0], x: pair[0].x - 40 }, { ...pair[1], x: pair[1].x + 40 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await frame.locator("#screen canvas").boundingBox())!.width).toBeGreaterThan(box.width * 1.5);
    await tap(frame);
    await expect.poll(() => cursorErrorRatio(frame, remote)).toBeLessThan(1);
    await session.detach();
    remote.setCursor({ width: 24, height: 32, hotx: 4, hoty: 6 });
    await expect(frame.locator("body > canvas")).toHaveJSProperty("width", 24);
    await expect.poll(() => cursorErrorRatio(frame, remote)).toBeLessThan(1);
    await selector.click();
    await page.getByRole("menuitem", { name: "Display 2 (454 × 298)", exact: true }).click();
    await expect(selector).toBeEnabled();
    await tap(frame);
    await expect.poll(() => cursorErrorRatio(frame, remote)).toBeLessThan(1);
    expect(remote.errors).toEqual([]);expect(app.errors).toEqual([]);
  } finally { await app.close(); }
});
