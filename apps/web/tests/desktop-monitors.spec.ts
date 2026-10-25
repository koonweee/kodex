import { expect, test, type Page } from "@playwright/test";
import { nativeProjectsFixture } from "./native-projects.fixture";
import { DesktopRfbFixture } from "./desktop-rfb.fixture";
import { openDesktop } from "./desktop-pane.fixture";

async function selectDisplay(page: Page, name: string) {
  await page.getByRole("button", { name: /^Desktop display:/ }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
function remote() {
  const fixture = new DesktopRfbFixture(); fixture.nativeDesktop=true;
  fixture.framebuffer={width:600,height:200};
  fixture.nativeDisplays=[
    {id:91,main:false,x:-100,y:0,width:200,height:200,fbX:0,fbY:0},
    {id:92,main:true,x:0,y:0,width:200,height:200,fbX:200,fbY:0},
    {id:93,main:false,x:100,y:25,width:200,height:100,fbX:400,fbY:25},
  ];return fixture;
}
test("native main default and one-socket monitor switching change the server framebuffer and keep input local",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true}); const fixture=remote();await fixture.install(context);
  try {
    const page=await app.page("native-monitor","/threads/history");const frame=await openDesktop(page);
    const selector=page.getByRole("button",{name:/^Desktop display:/});const canvas=frame.locator("#screen canvas");
    await expect(selector).toHaveAccessibleName(/Main display/);await expect(canvas).toHaveJSProperty("width",200);await expect(canvas).toHaveJSProperty("height",200);
    expect(fixture.displaySelections).toEqual([92]);
    await selectDisplay(page,"Display 3 (200 × 100)");
    await expect(canvas).toHaveJSProperty("height",100);expect(fixture.displaySelections).toEqual([92,93]);expect(fixture.connections).toHaveLength(1);
    await canvas.click({position:{x:10,y:10}});
    await expect.poll(()=>fixture.connections[0].pointerPositions.some(p=>p.mask===1&&p.x>=0&&p.x<200&&p.y>=0&&p.y<100)).toBe(true);
    expect(fixture.connections[0].messages.includes(251)).toBe(false);expect(fixture.errors).toEqual([]);
  } finally {await app.close();}
});

test("a native selection acknowledgment keeps input and paste gated until its pixels arrive",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true}); const fixture=remote();await fixture.install(context);
  try {
    const page=await app.page("native-pending-pixels","/threads/history");const frame=await openDesktop(page);
    fixture.holdFramebuffer=true;
    await selectDisplay(page,"Display 3 (200 × 100)");
    const selector=page.getByRole("button",{name:/^Desktop display:/});
    await expect.poll(()=>fixture.displaySelections.at(-1)).toBe(93);
    await expect(selector).toBeDisabled();await expect(page.getByRole("button",{name:"Paste into Mac"})).toBeDisabled();
    fixture.holdFramebuffer=false;fixture.releaseFramebuffer();
    await expect(selector).toBeEnabled();await expect(frame.locator("#screen canvas")).toHaveJSProperty("height",100);
  } finally {await app.close();}
});

test("a fresh inventory reusing an old ID for another display preserves the selected monitor identity",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true}); const fixture=remote();await fixture.install(context);
  try {
    const page=await app.page("native-id-reuse","/threads/history");const frame=await openDesktop(page);
    await selectDisplay(page,"Display 3 (200 × 100)");
    fixture.nativeDisplays=fixture.nativeDisplays.map(d=>({...d,id:d.id===92?93:d.id===93?92:d.id}));fixture.resize(600,200);
    await expect(page.getByRole("button",{name:/^Desktop display:/})).toHaveAccessibleName("Desktop display: Display 3 (200 × 100)");
    await expect(frame.locator("#screen canvas")).toHaveJSProperty("height",100);
    await expect.poll(()=>fixture.displaySelections.at(-1)).toBe(92);
  } finally {await app.close();}
});

for (const standalone of [false, true]) {
  test(`fragmented ${standalone ? "standalone" : "framebuffer"} native metadata selects main and rejects malformed updates`, async ({context}) => {
    const app=await nativeProjectsFixture(context,{desktopEnabled:true}); const fixture=remote();
    fixture.fragmentDisplayInfo=true;fixture.standaloneDisplayInfo=standalone;fixture.headerOnlySelectionAck=true;await fixture.install(context);
    try {
      const page=await app.page(`native-fragment-${standalone}`,"/threads/history");await openDesktop(page);
      await expect(page.getByRole("button",{name:/^Desktop display: Main/})).toBeEnabled();
      fixture.displayFailure=true;fixture.resize(600,200);
      await expect(page.getByText("The Desktop viewer could not negotiate Screen Sharing.", {exact:true})).toBeVisible();
      await expect.poll(()=>fixture.connections[0].closed).toBe(true);
      expect(fixture.connections).toHaveLength(1);expect(fixture.errors).toEqual([]);
    } finally {await app.close();}
  });
}

test("reconnect keeps the selected monitor and removal falls back to main",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();await fixture.install(context);
  try {
    const page=await app.page("native-reconnect","/threads/history");await openDesktop(page);
    const selector=page.getByRole("button",{name:/^Desktop display:/});
    await expect(selector).toBeEnabled();await selectDisplay(page,"Display 3 (200 × 100)");await expect(selector).toBeEnabled();
    await page.getByRole("button",{name:"Reconnect desktop"}).click();
    await expect.poll(()=>fixture.connections.length).toBe(2);
    await expect(selector).toHaveAccessibleName(/Display 3/);await expect(selector).toBeEnabled();
    fixture.nativeDisplays=fixture.nativeDisplays.filter(d=>d.id!==93);fixture.resize(400,200);
    await expect(selector).toHaveAccessibleName(/Main display/);await expect(selector).toBeEnabled();
    expect(fixture.displaySelections.at(-1)).toBe(92);
  } finally {await app.close();}
});

test("native inventory changes release virtual-keyboard modifiers before input is gated",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();await fixture.install(context);
  try {
    const page=await app.page("native-key-release","/threads/history");const frame=await openDesktop(page);
    await expect(page.getByRole("button",{name:/^Desktop display:/})).toBeEnabled();
    const keyboard=frame.locator("#keyboard");
    await frame.locator("body").evaluate(()=>window.kodexDesktop!.setKeyboard(true));
    await keyboard.dispatchEvent("keydown",{key:"Control",code:"ControlLeft",keyCode:17,ctrlKey:true});
    await expect.poll(()=>fixture.connections[0].keys).toContainEqual({down:true,keysym:0xffe3});
    fixture.holdFramebuffer=true;fixture.resize(600,200);
    await expect.poll(()=>fixture.connections[0].keys).toContainEqual({down:false,keysym:0xffe3});
    await expect(page.getByRole("button",{name:"Paste into Mac"})).toBeDisabled();
    fixture.holdFramebuffer=false;fixture.releaseFramebuffer();
    await expect(page.getByRole("button",{name:/^Desktop display:/})).toBeEnabled();
  } finally {await app.close();}
});

test.describe("native monitor menu with touch input",()=>{
  test.use({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  test("menu fits, trackpad taps stay in the selected framebuffer, and switching resets local zoom",async({context})=>{
    const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();await fixture.install(context);
    try {
      const page=await app.page("native-touch-menu","/threads/history");const frame=await openDesktop(page);
      await expect(page.getByRole("button",{name:/^Desktop display:/})).toBeEnabled();
      await page.getByRole("button",{name:/^Desktop display:/}).click();
      const menu=page.getByRole("menu");const bounds=(await menu.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(390);
      await page.getByRole("menuitem",{name:"Display 3 (200 × 100)",exact:true}).click();
      await expect(page.getByRole("button",{name:/^Desktop display:/})).toBeEnabled();
      const canvas=frame.locator("#screen canvas");const box=(await canvas.boundingBox())!;
      const session=await context.newCDPSession(page);
      const point=(x:number,y:number,id:number)=>({x:box.x+x,y:box.y+y,id});
      const pair=[point(box.width/2-15,box.height/2,1),point(box.width/2+15,box.height/2,2)];
      await session.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:pair});
      await session.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{...pair[0],x:pair[0].x-30},{...pair[1],x:pair[1].x+30}]});
      await session.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
      await expect.poll(async()=>(await canvas.boundingBox())!.width).toBeGreaterThan(box.width*1.5);
      await selectDisplay(page,"Main display (200 × 200)");await expect(page.getByRole("button",{name:/^Desktop display:/})).toBeEnabled();
      await expect(canvas).toHaveJSProperty("height",200);
      const main=(await canvas.boundingBox())!;
      await session.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:main.x+main.width/2,y:main.y+main.height/2,id:1}]});
      await session.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
      await expect.poll(()=>fixture.connections[0].pointerPositions.filter(p=>p.mask===1).at(-1)).toEqual({mask:1,x:100,y:100});
      expect(fixture.connections[0].messages).not.toContain(251);expect(fixture.errors).toEqual([]);expect(app.errors).toEqual([]);
      await session.detach();
    } finally {await app.close();}
  });
});


test("a same-selection inventory update without new pixels times out instead of leaving input stuck",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();await fixture.install(context);
  try {
    const page=await app.page("native-layout-timeout","/threads/history");await openDesktop(page);
    await expect(page.getByRole("button",{name:/^Desktop display:/})).toBeEnabled();
    fixture.holdFramebuffer=true;fixture.resize(600,200);
    await expect(page.getByRole("button",{name:/^Desktop display:/})).toBeDisabled();
    await expect(page.getByRole("button",{name:"Reconnect desktop"})).toBeVisible({timeout:7000});
    await expect.poll(()=>fixture.connections[0].closed,{timeout:7000}).toBe(true);
  } finally {await app.close();}
});
