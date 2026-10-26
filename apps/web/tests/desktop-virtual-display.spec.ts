import { expect, test } from "@playwright/test";
import { nativeProjectsFixture } from "./native-projects.fixture";
import { DesktopRfbFixture } from "./desktop-rfb.fixture";
import { openDesktop, sidebar } from "./desktop-pane.fixture";

function remote(virtualMain = false) {
  const fixture=new DesktopRfbFixture();fixture.nativeDesktop=true;
  fixture.framebuffer={width:2720,height:900};
  fixture.nativeDisplays=[
    {id:92,main:true,x:0,y:0,width:320,height:200,fbX:0,fbY:0},
    {id:93,main:false,x:320,y:0,width:1200,height:900,fbX:320,fbY:0},
    {id:94,main:false,x:1520,y:0,width:1200,height:900,fbX:1520,fbY:0},
  ];
  if (virtualMain) for (const display of fixture.nativeDisplays) {display.main=display.id===93;display.x-=320;}
  fixture.preferredDisplay={x:virtualMain?0:320,y:0,width:1200,height:900};return fixture;
}

for (const virtualMain of [false,true]) test(`new viewers select the virtual display and retain individual choices on reconnect (macOS main: ${virtualMain})`,async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote(virtualMain);await fixture.install(context);
  try {
    const first=await app.page("virtual-first","/threads/history");const frame=await openDesktop(first);
    const selector=first.getByRole("button",{name:/^Desktop display:/});
    await expect(selector).toHaveAccessibleName("Desktop display: Kodex display (1200 × 900)");await expect(selector).toBeEnabled();
    await expect(frame.locator("#screen canvas")).toHaveJSProperty("width",1200);
    expect(fixture.displaySelections).toEqual([93]);
    const physicalName=virtualMain?"Display 2 (320 × 200)":"Main display (320 × 200)";
    await selector.click();await first.getByRole("menuitem",{name:physicalName,exact:true}).click();
    await expect(selector).toBeEnabled();await expect(frame.locator("#screen canvas")).toHaveJSProperty("width",320);
    const second=await app.page("virtual-second","/threads/history");const other=await openDesktop(second);
    await expect(second.getByRole("button",{name:/^Desktop display:/})).toHaveAccessibleName("Desktop display: Kodex display (1200 × 900)");
    await expect(other.locator("#screen canvas")).toHaveJSProperty("width",1200);
    await expect(frame.locator("#screen canvas")).toHaveJSProperty("width",320);
    await first.getByRole("button",{name:"Reconnect desktop"}).click();
    await expect.poll(()=>fixture.connections.length).toBe(3);
    await expect(selector).toHaveAccessibleName(`Desktop display: ${physicalName}`);await expect(selector).toBeEnabled();
    expect(fixture.errors).toEqual([]);expect(app.errors).toEqual([]);
  } finally {await app.close();}
});

test("unresolved virtual-display identity gates input and pixels until the current target arrives",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();fixture.holdDisplayTarget=true;await fixture.install(context);
  try {
    const page=await app.page("virtual-target-pending","/threads/history");const frame=await openDesktop(page);
    await expect.poll(()=>fixture.connections[0]?.messages.includes(33)).toBe(true);
    await expect(page.getByRole("button",{name:"Paste into Mac"})).toBeDisabled();
    expect(fixture.displaySelections).toEqual([]);
    expect(fixture.updateRequests.every(request=>request.width<=64&&request.height<=64)).toBe(true);
    fixture.holdDisplayTarget=false;await fixture.releaseDisplayTarget();
    await expect(page.getByRole("button",{name:/^Desktop display: Kodex/})).toBeEnabled();
    await expect(frame.locator("#screen canvas")).toHaveJSProperty("width",1200);
    expect(fixture.displaySelections).toEqual([93]);expect(fixture.errors).toEqual([]);
  } finally {await app.close();}
});

test("a missing authoritative virtual target reconnects instead of exposing another monitor",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();fixture.displayTargetFailure=true;await fixture.install(context);
  try {
    const page=await app.page("virtual-target-failed","/threads/history");
    await (await sidebar(page)).getByRole("button",{name:"Desktop",exact:true}).click();
    await expect.poll(()=>fixture.connections[0]?.closed).toBe(true);
    expect(fixture.displaySelections).toEqual([]);
    fixture.displayTargetFailure=false;
    await expect.poll(()=>fixture.connections.length).toBe(2);
    await expect(page.getByRole("button",{name:/^Desktop display: Kodex/})).toBeEnabled();
    expect(fixture.errors).toEqual([]);
  } finally {await app.close();}
});


test("a late target response from a closed connection cannot select or enable the replacement",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();fixture.holdDisplayTarget=true;await fixture.install(context);
  try {
    const page=await app.page("virtual-stale-target","/threads/history");await openDesktop(page);
    await expect.poll(()=>fixture.displayTargetRequests.length).toBe(1);
    await expect.poll(()=>fixture.connections[0]?.messages.includes(33)).toBe(true);
    await expect(page.getByRole("button",{name:"Paste into Mac"})).toBeDisabled();
    fixture.preferredDisplay={x:1520,y:0,width:1200,height:900};fixture.holdDisplayTarget=false;
    await page.getByRole("button",{name:"Reconnect desktop"}).click();
    await expect.poll(()=>fixture.connections.length).toBe(2);
    await expect(page.getByRole("button",{name:/^Desktop display: Kodex/})).toBeEnabled();
    await expect.poll(()=>fixture.displaySelections.at(-1)).toBe(94);
    await fixture.releaseDisplayTarget();
    expect(fixture.displayTargetRequests.slice(0,2)).toEqual([{x:320,y:0,width:1200,height:900},{x:1520,y:0,width:1200,height:900}]);
    await expect(page.getByRole("button",{name:/^Desktop display: Kodex/})).toBeEnabled();
    expect(fixture.connections[0].closed).toBe(true);expect(fixture.connections[1].closed).toBe(false);
    expect(fixture.displaySelections).toEqual([94]);expect(fixture.errors).toEqual([]);
  } finally {await app.close();}
});

test("a virtual target absent from native inventory times out without selecting a physical monitor",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();fixture.preferredDisplay={x:9999,y:0,width:1200,height:900};await fixture.install(context);
  try {
    const page=await app.page("virtual-inventory-missing","/threads/history");await openDesktop(page);
    await expect.poll(()=>fixture.connections[0]?.closed,{timeout:7500}).toBe(true);
    expect(fixture.displaySelections).toEqual([]);
    expect(fixture.updateRequests.every(request=>request.width<=64&&request.height<=64)).toBe(true);
    fixture.preferredDisplay={x:320,y:0,width:1200,height:900};
    await expect.poll(()=>fixture.connections.length).toBe(2);
    await expect(page.getByRole("button",{name:/^Desktop display: Kodex/})).toBeEnabled();
    expect(fixture.displaySelections).toEqual([93]);expect(fixture.errors).toEqual([]);
  } finally {await app.close();}
});
