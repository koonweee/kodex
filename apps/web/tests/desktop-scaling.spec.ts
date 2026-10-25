import { expect, test } from "@playwright/test";
import { nativeProjectsFixture } from "./native-projects.fixture";
import { DesktopRfbFixture } from "./desktop-rfb.fixture";
import { openDesktop, sidebar } from "./desktop-pane.fixture";

function remote() {
  const fixture=new DesktopRfbFixture();fixture.nativeDesktop=true;
  fixture.framebuffer={width:6400,height:2160};
  fixture.nativeDisplays=[
    {id:92,main:true,x:0,y:0,width:3840,height:2160,fbX:0,fbY:0},
    {id:93,main:false,x:3840,y:0,width:2560,height:1600,fbX:3840,fbY:0},
  ];return fixture;
}

test("native scaling sends only 1080p selected frames and preserves physical monitor identity",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();await fixture.install(context);
  try {
    const page=await app.page("native-scaling","/threads/history");const frame=await openDesktop(page);
    const selector=page.getByRole("button",{name:/^Desktop display:/});const canvas=frame.locator("#screen canvas");
    await expect(selector).toBeEnabled();await expect(canvas).toHaveJSProperty("width",1920);await expect(canvas).toHaveJSProperty("height",1080);
    expect(fixture.scaleRequests).toEqual([{scale:0.5,selected:92}]);
    fixture.frameBlue=61;fixture.sendNativeStates([12,4,6],true);
    await expect.poll(()=>canvas.evaluate((node:HTMLCanvasElement)=>node.getContext("2d")!.getImageData(0,0,1,1).data[2])).toBe(61);
    expect(fixture.connections).toHaveLength(1);
    await selector.click();await page.getByRole("menuitem",{name:"Display 2 (2560 × 1600)",exact:true}).click();
    await expect(selector).toBeEnabled();await expect(canvas).toHaveJSProperty("width",1728);await expect(canvas).toHaveJSProperty("height",1080);
    await expect(selector).toHaveAccessibleName("Desktop display: Display 2 (2560 × 1600)");
    expect(fixture.scaleRequests.at(-1)).toEqual({scale:0.675,selected:93});
    const bounds=(await canvas.boundingBox())!;await page.mouse.click(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
    const click=fixture.connections[0].pointerPositions.filter(p=>p.mask===1).at(-1)!;
    // Browser mouse coordinates are quantized in CSS pixels before conversion.
    expect(Math.abs(click.x-1280)).toBeLessThanOrEqual(Math.ceil(2560/bounds.width)+1);
    expect(Math.abs(click.y-800)).toBeLessThanOrEqual(Math.ceil(1600/bounds.height)+1);
    expect(fixture.updateRequests.every(r=>r.width<=1920&&r.height<=1080)).toBe(true);
    expect(fixture.automaticRequests.every(r=>r.width<=1920&&r.height<=1080)).toBe(true);
    expect(fixture.connections[0].messages).not.toContain(251);expect(fixture.errors).toEqual([]);expect(app.errors).toEqual([]);
  } finally {await app.close();}
});

test("scaling is per connection and reconnect retains the selected monitor",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();await fixture.install(context);
  try {
    const first=await app.page("scale-first","/threads/history");const a=await openDesktop(first);
    const second=await app.page("scale-second","/threads/history");const b=await openDesktop(second);
    const selector=first.getByRole("button",{name:/^Desktop display:/});await expect(selector).toBeEnabled();
    await selector.click();await first.getByRole("menuitem",{name:"Display 2 (2560 × 1600)",exact:true}).click();
    await expect(a.locator("#screen canvas")).toHaveJSProperty("width",1728);
    await expect(b.locator("#screen canvas")).toHaveJSProperty("width",1920);
    await first.getByRole("button",{name:"Reconnect desktop"}).click();
    await expect(selector).toHaveAccessibleName(/Display 2/);await expect(selector).toBeEnabled();
    await expect(a.locator("#screen canvas")).toHaveJSProperty("width",1728);
    expect(fixture.connections).toHaveLength(3);expect(fixture.errors).toEqual([]);expect(app.errors).toEqual([]);
  } finally {await app.close();}
});

test("an ignored scaling command times out without enabling control or streaming full resolution",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();fixture.ignoreScaling=true;await fixture.install(context);
  try {
    const page=await app.page("scale-unavailable","/threads/history");await openDesktop(page);
    await expect(page.getByRole("button",{name:"Paste into Mac"})).toBeDisabled();
    await expect.poll(()=>fixture.connections[0].closed,{timeout:8000}).toBe(true);
    await expect(page.getByRole("button",{name:"Paste into Mac"})).toBeDisabled();
    expect(fixture.updateRequests.every(r=>r.width<=64&&r.height<=64)).toBe(true);
    expect(fixture.connections[0].pointerPositions).toEqual([]);await expect.poll(()=>fixture.connections[0].closed).toBe(true);
  } finally {await app.close();}
});

test.describe("scaled touch input",()=>{
  test.use({viewport:{width:1024,height:768},hasTouch:true,isMobile:true,deviceScaleFactor:2});
  test("portrait frames fit 1080p and a smaller monitor is never upscaled",async({context})=>{
    const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();
    fixture.nativeDisplays[0]={id:92,main:true,x:0,y:0,width:1440,height:2560,fbX:0,fbY:0};
    fixture.nativeDisplays[1]={id:93,main:false,x:1440,y:0,width:1280,height:720,fbX:1440,fbY:0};
    await fixture.install(context);
    try {
      const page=await app.page("scale-touch","/threads/history");const frame=await openDesktop(page);
      const selector=page.getByRole("button",{name:/^Desktop display:/});const canvas=frame.locator("#screen canvas");
      await expect(selector).toBeEnabled();await expect(canvas).toHaveJSProperty("width",608);await expect(canvas).toHaveJSProperty("height",1080);
      const box=(await canvas.boundingBox())!;await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);
      await expect.poll(()=>fixture.connections[0].pointerPositions.filter(p=>p.mask===1).at(-1)).toEqual({mask:1,x:721,y:1280});
      await selector.click();await page.getByRole("menuitem",{name:"Display 2 (1280 × 720)",exact:true}).click();
      await expect(selector).toBeEnabled();await expect(canvas).toHaveJSProperty("width",1280);await expect(canvas).toHaveJSProperty("height",720);
      expect(fixture.scaleRequests.at(-1)).toEqual({scale:1,selected:93});expect(fixture.errors).toEqual([]);expect(app.errors).toEqual([]);
    } finally {await app.close();}
  });
});

test("a delayed bootstrap picture cannot enable input after scale metadata",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();fixture.holdBootstrap=true;fixture.holdFramebuffer=true;await fixture.install(context);
  try {
    const page=await app.page("scale-bootstrap-fence","/threads/history");await openDesktop(page);
    await expect.poll(()=>fixture.updateRequests.some(r=>r.width===1920&&r.height===1080)).toBe(true);
    fixture.releaseBootstrap();
    await expect(page.getByRole("button",{name:"Paste into Mac"})).toBeDisabled();
    await expect(page.getByRole("button",{name:/^Desktop display:/})).toBeDisabled();
    fixture.holdFramebuffer=false;fixture.releaseFramebuffer();
    await expect(page.getByRole("button",{name:/^Desktop display:/})).toBeEnabled();
    expect(fixture.errors).toEqual([]);expect(app.errors).toEqual([]);
  } finally {await app.close();}
});

test("an echoed scale with full-size pixels is rejected before requesting them",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();fixture.echoScaleWithoutResize=true;await fixture.install(context);
  try {
    const page=await app.page("scale-invalid-ack","/threads/history");await (await sidebar(page)).getByRole("button",{name:"Desktop",exact:true}).click();
    await expect(page.getByText("The Desktop viewer could not negotiate Screen Sharing.",{exact:true})).toBeVisible();
    await expect.poll(()=>fixture.connections[0].closed).toBe(true);
    expect(fixture.updateRequests.every(r=>r.width<=64&&r.height<=64)).toBe(true);
    expect(fixture.automaticRequests).toEqual([]);expect(fixture.connections[0].pointerPositions).toEqual([]);
  } finally {await app.close();}
});

test.describe("pointer coordinates after Mac login",()=>{
  test.use({viewport:{width:1024,height:768},hasTouch:true,isMobile:true,deviceScaleFactor:2});
  test("direct touch reaches the full Retina display after its backing geometry changes",async({context})=>{
    const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();fixture.nativeDensity=2;await fixture.install(context);
    try {
      const page=await app.page("scale-login-input","/threads/history");const frame=await openDesktop(page);
      const selector=page.getByRole("button",{name:/^Desktop display:/});const canvas=frame.locator("#screen canvas");
      await expect(selector).toBeEnabled();
      await frame.locator("body").evaluate(()=>window.kodexDesktop!.setTrackpad(false));
      const check=async(width:number,height:number)=>{
        for(const fraction of [0.1,0.9]){
          const box=(await canvas.boundingBox())!;
          await page.touchscreen.tap(box.x+box.width*fraction,box.y+box.height*fraction);
          await expect.poll(()=>fixture.connections[0].pointerPositions.at(-1)?.mask).toBe(0);
          const click=fixture.connections[0].pointerPositions.filter(p=>p.mask===1).at(-1)!;
          expect(Math.abs(click.x-width*fraction)).toBeLessThanOrEqual(Math.ceil(width/box.width)+2);
          expect(Math.abs(click.y-height*fraction)).toBeLessThanOrEqual(Math.ceil(height/box.height)+2);
        }
      };
      await check(3840,2160);
      fixture.nativeDisplays[0]={...fixture.nativeDisplays[0],width:5120,height:2880};fixture.resize(7680,2880);
      await expect.poll(()=>fixture.scaleRequests.at(-1)?.scale).toBe(0.375);
      await expect(selector).toBeEnabled();await expect(canvas).toHaveJSProperty("width",1920);await expect(canvas).toHaveJSProperty("height",1080);
      await check(5120,2880);
      expect(fixture.connections).toHaveLength(1);expect(fixture.errors).toEqual([]);expect(app.errors).toEqual([]);
    } finally {await app.close();}
  });
});

test("a held pointer releases with its last valid mapping during an incomplete login layout",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});const fixture=remote();await fixture.install(context);
  try {
    const page=await app.page("scale-button-release","/threads/history");const frame=await openDesktop(page);
    const canvas=frame.locator("#screen canvas");await expect(page.getByRole("button",{name:/^Desktop display:/})).toBeEnabled();
    const box=(await canvas.boundingBox())!;await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    await expect.poll(()=>fixture.connections[0].pointerPositions.at(-1)?.mask).toBe(1);
    const held=fixture.connections[0].pointerPositions.at(-1)!;
    fixture.resizeFramebuffer(1600,900);await expect(canvas).toHaveJSProperty("width",1600);
    await page.mouse.up();
    await expect.poll(()=>fixture.connections[0].pointerPositions.at(-1)).toEqual({...held,mask:0});
    const start=fixture.connections[0].pointerPositions.length;
    await page.mouse.down();await page.mouse.up();
    await expect.poll(()=>fixture.connections[0].pointerPositions.length).toBeGreaterThan(start);
    expect(fixture.connections[0].pointerPositions.slice(start).every(p=>p.mask===0)).toBe(true);
    fixture.resize(6400,2160);await expect(canvas).toHaveJSProperty("width",1920);
    await expect(page.getByRole("button",{name:/^Desktop display:/})).toBeEnabled();
    await canvas.click();await expect.poll(()=>fixture.connections[0].pointerPositions.slice(start).some(p=>p.mask===1)).toBe(true);
    expect(fixture.errors).toEqual([]);expect(app.errors).toEqual([]);
  } finally {await app.close();}
});
