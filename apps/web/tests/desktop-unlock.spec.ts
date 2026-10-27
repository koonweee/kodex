import { expect, test } from "@playwright/test";
import { nativeProjectsFixture } from "./native-projects.fixture";
import { DesktopRfbFixture } from "./desktop-rfb.fixture";
import { openDesktop } from "./desktop-pane.fixture";

test("locked Mac form needs field confirmation and sends password once through VNC without clipboard or storage", async ({ context }) => {
  const app = await nativeProjectsFixture(context, {desktopEnabled:true});
  try {
    const page = await app.page("unlock", "/threads/history");
    const remote = new DesktopRfbFixture(); remote.consoleState="locked"; remote.unlockOnReturn=true;
    await remote.install(page);
    await openDesktop(page);
    const field = page.getByLabel("Mac login password", {exact:true});
    await expect(field).toBeVisible();
    await expect(field).toHaveAttribute("type", "password");
    await field.fill("fixture-Å🔑");
    const send=page.getByRole("button",{name:"Unlock Mac",exact:true});
    await expect(send).toBeDisabled();
    await page.getByRole("checkbox",{name:"The Mac password field is selected and empty"}).check();
    await send.click();
    await expect(page.getByText("Mac unlocked",{exact:true})).toBeVisible();
    await expect(field).toHaveCount(0);
    const keys=remote.connections[0].keys;
    expect(keys.filter(key=>key.down).map(key=>key.keysym)).toEqual([...Array.from("fixture-Å",c=>c.codePointAt(0)!),0x0101f511,0xff0d]);
    expect(keys.filter(key=>!key.down)).toHaveLength(keys.filter(key=>key.down).length);
    expect(remote.clipboardWrites).toEqual([]);
    expect(await page.evaluate(()=>JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]))).not.toContain("fixture-Å");
    expect(app.errors).toEqual([]); expect(app.unexpected).toEqual([]); expect(remote.errors).toEqual([]);
  } finally {await app.close();}
});

test("fresh native preflight blocks a stale confirmed form and clears its password",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});
  try{
    const page=await app.page("stale","/threads/history");
    const remote=new DesktopRfbFixture();remote.consoleState="locked";await remote.install(page);await openDesktop(page);
    const field=page.getByLabel("Mac login password",{exact:true});await field.fill("fixture-stale");
    await page.getByRole("checkbox",{name:"The Mac password field is selected and empty"}).check();
    remote.consoleState="unknown";
    await page.getByRole("button",{name:"Unlock Mac",exact:true}).click();
    await expect.poll(()=>remote.sessionReads).toBeGreaterThan(1);
    await expect(page.getByRole("button",{name:"Unlock Mac",exact:true})).toHaveCount(0);
    expect(remote.connections[0].keys).toEqual([]);expect(remote.clipboardWrites).toEqual([]);
    remote.consoleState="locked";await expect(field).toBeVisible();await expect(field).toHaveValue("");
    await expect(page.getByRole("checkbox",{name:"The Mac password field is selected and empty"})).not.toBeChecked();
    expect(app.errors).toEqual([]);expect(app.unexpected).toEqual([]);
  }finally{await app.close();}
});

test("preview input cancels delayed entry and reconnect cannot replay a password",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});
  try{
    const page=await app.page("cancel","/threads/history");const remote=new DesktopRfbFixture();remote.consoleState="locked";
    await remote.install(page);const frame=await openDesktop(page);
    const field=page.getByLabel("Mac login password",{exact:true});await field.fill("fixture-cancel");
    await page.getByRole("checkbox",{name:"The Mac password field is selected and empty"}).check();
    remote.holdSession=true;
    await page.getByRole("button",{name:"Unlock Mac",exact:true}).click();
    await expect(page.getByText("Sending password once…",{exact:true})).toBeVisible();
    await frame.locator("#screen canvas").click({position:{x:20,y:20}});
    await expect(field).toBeVisible();await expect(field).toHaveValue("");
    remote.holdSession=false;await remote.releaseSession();
    expect(remote.connections[0].keys).toEqual([]);
    await page.getByRole("button",{name:"Reconnect desktop",exact:true}).click();
    await expect.poll(()=>remote.connections.length).toBe(2);
    await expect(field).toBeVisible();await expect(field).toHaveValue("");
    expect(remote.connections.flatMap(connection=>connection.keys)).toEqual([]);
    expect(remote.clipboardWrites).toEqual([]);expect(app.errors).toEqual([]);expect(app.unexpected).toEqual([]);
  }finally{await app.close();}
});

for (const action of ["touch keyboard", "paste"] as const) {
  test(`${action} invalidates the confirmed empty field before password entry`, async ({context}) => {
    const app=await nativeProjectsFixture(context,{desktopEnabled:true});
    try {
      const page=await app.page("remote-input","/threads/history");
      const remote=new DesktopRfbFixture();remote.consoleState="locked";
      await remote.install(page);const frame=await openDesktop(page);
      const field=page.getByLabel("Mac login password",{exact:true});
      const confirmation=page.getByRole("checkbox",{name:"The Mac password field is selected and empty"});
      await field.fill("fixture-must-not-send");await confirmation.check();
      if(action==="touch keyboard") {
        await frame.locator("#keyboard").evaluate((element:HTMLTextAreaElement)=>{
          window.kodexDesktop!.setKeyboard(true);
          element.value+="z";element.dispatchEvent(new InputEvent("input",{data:"z",inputType:"insertText",bubbles:true}));
        });
        await expect.poll(()=>remote.connections[0].keys.filter(key=>key.down).map(key=>key.keysym)).toEqual([0x7a]);
      } else {
        await page.evaluate(()=>Object.defineProperty(navigator,"clipboard",{configurable:true,value:{readText:async()=>"fixture-paste"}}));
        await page.getByRole("button",{name:"Paste into Mac",exact:true}).click();
        await expect.poll(()=>remote.clipboardWrites).toEqual(["fixture-paste"]);
      }
      await expect(field).toHaveValue("");await expect(confirmation).not.toBeChecked();
      await field.fill("fixture-fresh");
      await expect(page.getByRole("button",{name:"Unlock Mac",exact:true})).toBeDisabled();
      expect(remote.connections[0].keys.filter(key=>key.down&&key.keysym===0xff0d)).toEqual([]);
      expect(app.errors).toEqual([]);expect(app.unexpected).toEqual([]);expect(remote.errors).toEqual([]);
    } finally {await app.close();}
  });
}

test("two tabs converge on native unlock and clear the other tab's unsent draft",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});
  try{
    const remote=new DesktopRfbFixture();remote.consoleState="locked";remote.unlockOnReturn=true;await remote.install(context);
    const first=await app.page("first","/threads/history");const second=await app.page("second","/threads/history");
    await openDesktop(first);await openDesktop(second);
    await second.getByLabel("Mac login password",{exact:true}).fill("other-unsent-password");
    await first.getByLabel("Mac login password",{exact:true}).fill("fixture-unlock");
    await first.getByRole("checkbox",{name:"The Mac password field is selected and empty"}).check();
    await first.getByRole("button",{name:"Unlock Mac",exact:true}).click();
    await expect(first.getByText("Mac unlocked",{exact:true})).toBeVisible();
    await expect(second.getByLabel("Mac login password",{exact:true})).toHaveCount(0);
    expect(remote.connections[1].keys).toEqual([]);
    remote.consoleState="locked";
    for(const page of [first,second]){
      await expect(page.getByLabel("Mac login password",{exact:true})).toBeVisible();
      await expect(page.getByLabel("Mac login password",{exact:true})).toHaveValue("");
      await expect(page.getByRole("checkbox",{name:"The Mac password field is selected and empty"})).not.toBeChecked();
    }
    expect(remote.connections[1].keys).toEqual([]);expect(app.errors).toEqual([]);expect(app.unexpected).toEqual([]);
  }finally{await app.close();}
});

test("unconfirmed unlock times out with an empty form and no automatic password retry",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});
  try{
    const page=await app.page("timeout","/threads/history");const remote=new DesktopRfbFixture();remote.consoleState="locked";
    await remote.install(page);await openDesktop(page);
    const field=page.getByLabel("Mac login password",{exact:true});await field.fill("fixture-wrong");
    await page.getByRole("checkbox",{name:"The Mac password field is selected and empty"}).check();
    await page.getByRole("button",{name:"Unlock Mac",exact:true}).click();
    await expect(page.getByText("Checking that the Mac unlocked…",{exact:true})).toBeVisible();
    const keys=remote.connections[0].keys.length;
    await expect(page.getByText("Unlock was not confirmed. Check the Mac password field and try again.",{exact:true})).toBeVisible({timeout:15000});
    await expect(field).toHaveValue("");await expect(page.getByRole("button",{name:"Unlock Mac",exact:true})).toBeDisabled();
    expect(remote.connections[0].keys).toHaveLength(keys);
    expect(remote.connections[0].keys.filter(key=>key.down&&key.keysym===0xff0d)).toHaveLength(1);
    expect(remote.clipboardWrites).toEqual([]);expect(app.errors).toEqual([]);expect(app.unexpected).toEqual([]);
  }finally{await app.close();}
});

test("browser visibility and bfcache events clear password drafts and confirmation",async({context})=>{
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});
  try{
    const page=await app.page("hidden-browser","/threads/history");const remote=new DesktopRfbFixture();remote.consoleState="locked";
    await remote.install(page);await openDesktop(page);
    const field=page.getByLabel("Mac login password",{exact:true});
    const confirmation=page.getByRole("checkbox",{name:"The Mac password field is selected and empty"});
    await field.fill("fixture-hidden-tab");await confirmation.check();
    await page.evaluate(()=>{Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>"hidden"});document.dispatchEvent(new Event("visibilitychange"));});
    await expect(field).toHaveValue("");await expect(confirmation).not.toBeChecked();
    await page.evaluate(()=>{Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>"visible"});document.dispatchEvent(new Event("visibilitychange"));});
    await field.fill("fixture-before-cache");await confirmation.check();
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true})));
    await expect(field).toHaveValue("");await expect(confirmation).not.toBeChecked();
    expect(remote.connections[0].keys).toEqual([]);expect(app.errors).toEqual([]);expect(app.unexpected).toEqual([]);
  }finally{await app.close();}
});

for(const shape of [
  {name:"narrow fine",width:390,height:844,hasTouch:false},
  {name:"narrow touch",width:390,height:844,hasTouch:true},
  {name:"wide touch",width:1280,height:844,hasTouch:true},
]){
  test.describe(shape.name,()=>{
    test.use({viewport:{width:shape.width,height:shape.height},hasTouch:shape.hasTouch});
    test("form and preview both fit and password clears when pane hides",async({context})=>{
      const app=await nativeProjectsFixture(context,{desktopEnabled:true});
      try{
        const page=await app.page("layout","/threads/history");const remote=new DesktopRfbFixture();remote.consoleState="locked";
        await remote.install(page);await openDesktop(page);
        const field=page.getByLabel("Mac login password",{exact:true});await expect(field).toBeVisible();
        const pane=page.locator(".kodex-desktop-pane");
        const form=page.getByRole("region",{name:"Unlock Mac with preview",exact:true});
        const frame=page.getByTitle("Mac desktop viewer",{exact:true});
        await expect(form).toBeVisible();
        expect((await frame.boundingBox())!.height).toBeGreaterThan(100);
        expect(await pane.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
        await page.screenshot({path:test.info().outputPath("unlock-preview.png")});
        await field.fill("fixture-hidden");await page.getByRole("checkbox",{name:"The Mac password field is selected and empty"}).check();
        await page.setViewportSize({width:390,height:844});
        await page.getByRole("button",{name:"Switch workspace pane"}).click();
        await page.getByRole("dialog").getByRole("button",{name:"History chat",exact:true}).click();
        await openDesktop(page);await expect(field).toHaveValue("");
        await expect(page.getByRole("checkbox",{name:"The Mac password field is selected and empty"})).not.toBeChecked();
        expect(remote.connections[0].closed).toBe(false);expect(remote.connections[0].keys).toEqual([]);
        expect(app.errors).toEqual([]);expect(app.unexpected).toEqual([]);
      }finally{await app.close();}
    });
  });
}
