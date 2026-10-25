import { expect, test } from "@playwright/test";
import { nativeProjectsFixture } from "./native-projects.fixture";
import { DesktopRfbFixture } from "./desktop-rfb.fixture";
import { openDesktop } from "./desktop-pane.fixture";

test("a native wake refreshes a stalled picture on the same connection", async ({ context }) => {
  const app = await nativeProjectsFixture(context, { desktopEnabled: true });
  const remote = new DesktopRfbFixture();remote.nativeDesktop = true;
  await remote.install(context);
  try {
    const page = await app.page("native-wake", "/threads/history");
    const frame = await openDesktop(page);
    await expect(page.getByRole("button", { name: "Paste into Mac" })).toBeEnabled();
    const canvas = frame.locator("#screen canvas");
    const blue = () => canvas.evaluate((node: HTMLCanvasElement) => node.getContext("2d")!.getImageData(0, 0, 1, 1).data[2]);
    await expect.poll(blue).toBe(0xcc);
    const fullRequests = remote.updateRequests.length;
    const subscriptions = remote.connections[0].messages.filter((type) => type === 9).length;
    remote.frameBlue = 61;
    // Cursor-visible is unrelated to stream renewal; Tickle re-arms the
    // subscription, and Wake must request the fresh picture without metadata.
    remote.sendNativeStates([12, 4, 6], true);
    await expect.poll(blue).toBe(61);
    expect(remote.updateRequests.length).toBe(fullRequests + 1);
    await expect.poll(() => remote.connections[0].messages.filter((type) => type === 9).length).toBe(subscriptions + 2);
    expect(remote.connections).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Paste into Mac" })).toBeEnabled();
    expect(remote.errors).toEqual([]);expect(app.errors).toEqual([]);
  } finally { await app.close(); }
});

test("wake before inventory never requests the combined desktop", async ({ context }) => {
  const app = await nativeProjectsFixture(context, { desktopEnabled: true });
  const remote = new DesktopRfbFixture();remote.nativeDesktop = true;remote.holdDisplayInfo = true;
  remote.framebuffer = { width: 600, height: 200 };
  remote.nativeDisplays = [
    { id: 92, main: true, x: 0, y: 0, width: 200, height: 200, fbX: 0, fbY: 0 },
    { id: 93, main: false, x: 200, y: 0, width: 400, height: 200, fbX: 200, fbY: 0 },
  ];
  await remote.install(context);
  try {
    const page = await app.page("wake-before-inventory", "/threads/history");await openDesktop(page);
    await expect.poll(() => remote.updateRequests.length).toBeGreaterThan(0);
    remote.sendNativeStates([4, 6], true);
    remote.holdDisplayInfo = false;remote.releaseDisplayInfo();
    await expect(page.getByRole("button", { name: /^Desktop display: Main/ })).toBeEnabled();
    expect(remote.updateRequests.some((request) => request.width === 600)).toBe(false);
    expect(remote.automaticRequests.some((request) => request.width === 600)).toBe(false);
    expect(remote.automaticRequests.some((request) => request.width === 200)).toBe(true);
    expect(remote.connections).toHaveLength(1);expect(remote.errors).toEqual([]);
  } finally { await app.close(); }
});
