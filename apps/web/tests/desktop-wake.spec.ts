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

test("an unanswered native wake automatically reconnects instead of leaving an enabled stale lock picture",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const remote=new DesktopRfbFixture();remote.nativeDesktop=true;await remote.install(context);
  try {
    const page=await app.page("wake-timeout","/threads/history");const frame=await openDesktop(page);
    const paste=page.getByRole("button",{name:"Paste into Mac"});await expect(paste).toBeEnabled();
    const requests=remote.updateRequests.length;remote.holdFramebuffer=true;remote.frameBlue=61;
    remote.sendNativeStates([6],true);
    await expect.poll(()=>remote.updateRequests.length).toBe(requests+1);await expect(paste).toBeDisabled();
    // A duplicate Wake cannot extend the recovery deadline or flood requests.
    const subscriptions=remote.automaticRequests.length;
    remote.sendNativeStates([6,4],true);
    await expect.poll(()=>remote.automaticRequests.length).toBe(subscriptions+1);
    expect(remote.updateRequests.length).toBe(requests+1);
    await expect.poll(()=>remote.connections[0].closed,{timeout:7500}).toBe(true);
    remote.holdFramebuffer=false;remote.releaseFramebuffer();
    await expect.poll(()=>remote.connections.length).toBe(2);await expect(paste).toBeEnabled();
    await expect.poll(()=>frame.locator("#screen canvas").evaluate((node:HTMLCanvasElement)=>node.getContext("2d")!.getImageData(0,0,1,1).data[2])).toBe(61);
    expect(remote.errors).toEqual([]);expect(app.errors).toEqual([]);
  } finally {await app.close();}
});

test("a completed wake refresh cancels its recovery deadline on the same connection",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const remote=new DesktopRfbFixture();remote.nativeDesktop=true;await remote.install(context);
  try {
    const page=await app.page("wake-deadline-cancel","/threads/history");const frame=await openDesktop(page);
    const paste=page.getByRole("button",{name:"Paste into Mac"});await expect(paste).toBeEnabled();
    await page.clock.install();
    const requests=remote.updateRequests.length;remote.holdFramebuffer=true;remote.sendNativeStates([6],true);
    await expect.poll(()=>remote.updateRequests.length).toBe(requests+1);await expect(paste).toBeDisabled();
    remote.sendNativeStates([6],true);
    remote.holdFramebuffer=false;remote.releaseFramebuffer();await expect(paste).toBeEnabled();
    await page.clock.fastForward(7000);
    expect(remote.connections).toHaveLength(1);expect(remote.connections[0].closed).toBe(false);
    expect(remote.updateRequests.length).toBe(requests+1);
    await expect(frame.locator("#screen canvas")).toBeVisible();expect(remote.errors).toEqual([]);expect(app.errors).toEqual([]);
  } finally {await app.close();}
});

function scaledRemote() {
  const remote=new DesktopRfbFixture();remote.nativeDesktop=true;remote.nativeDensity=2;
  remote.framebuffer={width:5120,height:2880};
  remote.nativeDisplays=[{id:92,main:true,x:0,y:0,width:5120,height:2880,fbX:0,fbY:0}];return remote;
}

test("a resize without monitor metadata cannot strand enabled controls or request stale dimensions",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const remote=scaledRemote();await remote.install(context);
  try {
    const page=await app.page("wake-incomplete-geometry","/threads/history");const frame=await openDesktop(page);
    const paste=page.getByRole("button",{name:"Paste into Mac"});await expect(paste).toBeEnabled();
    const requests=remote.connections[0].messages.filter(type=>type===3).length,subscriptions=remote.connections[0].messages.filter(type=>type===9).length;
    remote.holdDisplayInfo=true;remote.resizeFramebuffer(1600,900);
    await expect(frame.locator("#screen canvas")).toHaveJSProperty("width",1600);await expect(paste).toBeDisabled();
    remote.sendNativeStates([6,6,4],true);
    await expect.poll(()=>remote.connections[0].closed,{timeout:7500}).toBe(true);
    // No request may use the unconfirmed resized geometry.
    expect(remote.connections[0].messages.filter(type=>type===3).length).toBe(requests);
    expect(remote.connections[0].messages.filter(type=>type===9).length).toBe(subscriptions);
    remote.holdDisplayInfo=false;remote.releaseDisplayInfo();
    await expect.poll(()=>remote.connections.length).toBe(2);await expect(paste).toBeEnabled();
    expect(remote.errors).toEqual([]);expect(app.errors).toEqual([]);
  } finally {await app.close();}
});

test("a native metadata query repairs an incomplete resize on the same selected 1080p connection",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const remote=scaledRemote();await remote.install(context);
  try {
    const page=await app.page("wake-resize-refill","/threads/history");const frame=await openDesktop(page);
    const paste=page.getByRole("button",{name:"Paste into Mac"});await expect(paste).toBeEnabled();await page.clock.install();
    const encodings=remote.connections[0].messages.filter(type=>type===2).length;
    remote.holdDisplayInfo=true;remote.resizeFramebuffer(1600,900);
    await expect(paste).toBeDisabled();
    await expect.poll(()=>remote.connections[0].messages.filter(type=>type===2).length).toBe(encodings+1);
    remote.sendNativeStates([6],true);remote.frameBlue=61;remote.holdDisplayInfo=false;remote.releaseDisplayInfo();
    await expect(paste).toBeEnabled();await expect(frame.locator("#screen canvas")).toHaveJSProperty("width",1920);
    await expect.poll(()=>frame.locator("#screen canvas").evaluate((node:HTMLCanvasElement)=>node.getContext("2d")!.getImageData(0,0,1,1).data[2])).toBe(61);
    await page.clock.fastForward(7000);expect(remote.connections).toHaveLength(1);expect(remote.connections[0].closed).toBe(false);
    expect(remote.displaySelections.every(id=>id===92)).toBe(true);
    expect(remote.updateRequests.every(r=>r.width<=1920&&r.height<=1080)).toBe(true);expect(remote.errors).toEqual([]);expect(app.errors).toEqual([]);
  } finally {await app.close();}
});
