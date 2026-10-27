import { expect, test } from "@playwright/test";
import { nativeProjectsFixture } from "./native-projects.fixture";
import { DesktopRfbFixture } from "./desktop-rfb.fixture";
import { openDesktop } from "./desktop-pane.fixture";

test("a pending browser clipboard read immediately clears and disables password entry", async ({context}) => {
  const app=await nativeProjectsFixture(context,{desktopEnabled:true});
  try {
    const page=await app.page("clipboard-prompt","/threads/history");
    const remote=new DesktopRfbFixture();remote.consoleState="locked";
    await remote.install(page);await openDesktop(page);
    const field=page.getByLabel("Mac login password",{exact:true});
    const confirmation=page.getByRole("checkbox",{name:"The Mac password field is selected and empty"});
    await field.fill("fixture-before-paste");await confirmation.check();
    await page.evaluate(()=>{
      const held=window as Window & {releaseClipboard?:()=>void};
      Object.defineProperty(navigator,"clipboard",{configurable:true,value:{readText:()=>new Promise<string>(resolve=>{
        held.releaseClipboard=()=>resolve("fixture-paste");
      })}});
    });
    await page.getByRole("button",{name:"Paste into Mac",exact:true}).click();
    await expect(field).toHaveValue("");await expect(field).toBeDisabled();
    await expect(confirmation).not.toBeChecked();await expect(confirmation).toBeDisabled();
    await expect(page.getByRole("button",{name:"Unlock Mac",exact:true})).toBeDisabled();
    expect(remote.connections[0].keys).toEqual([]);expect(remote.clipboardWrites).toEqual([]);
    await page.evaluate(()=>(window as Window & {releaseClipboard?:()=>void}).releaseClipboard!());
    await expect.poll(()=>remote.clipboardWrites).toEqual(["fixture-paste"]);
    await expect(field).toBeEnabled();await expect(field).toHaveValue("");
    await expect(confirmation).not.toBeChecked();
    expect(remote.connections[0].keys.filter(key=>key.down&&key.keysym===0xff0d)).toEqual([]);
    expect(app.errors).toEqual([]);expect(app.unexpected).toEqual([]);
  } finally {await app.close();}
});

test.describe("password keyboard viewport",()=>{
  test.use({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  test("local password editing keeps preview and controls above the software keyboard",async({context})=>{
    const app=await nativeProjectsFixture(context,{desktopEnabled:true});
    await context.addInitScript(()=>{
      const viewport=new EventTarget();
      Object.assign(viewport,{height:844,width:390,offsetTop:0,offsetLeft:0,pageTop:0,pageLeft:0,scale:1});
      Object.defineProperty(window,"visualViewport",{configurable:true,value:viewport});
    });
    try {
      const page=await app.page("password-viewport","/threads/history");
      const remote=new DesktopRfbFixture();remote.consoleState="locked";
      await remote.install(page);await openDesktop(page);
      const field=page.getByLabel("Mac login password",{exact:true});await field.fill("fixture-keyboard-draft");
      await page.evaluate(()=>{Object.assign(visualViewport!,{height:544});visualViewport!.dispatchEvent(new Event("resize"));});
      const preview=page.getByTitle("Mac desktop viewer",{exact:true});
      await expect.poll(async()=>{const b=(await preview.boundingBox())!;return Math.round(b.y+b.height);}).toBeLessThanOrEqual(544);
      await expect(field).toBeFocused();await expect(field).toHaveValue("fixture-keyboard-draft");
      const fieldBox=(await field.boundingBox())!;expect(fieldBox.y+fieldBox.height).toBeLessThan(544);
      expect((await preview.boundingBox())!.height).toBeGreaterThan(80);
      await page.getByRole("button",{name:"Unlock Mac",exact:true}).scrollIntoViewIfNeeded();
      const button=(await page.getByRole("button",{name:"Unlock Mac",exact:true}).boundingBox())!;
      expect(button.y+button.height).toBeLessThan(544);
      await page.screenshot({path:test.info().outputPath("password-keyboard-viewport.png"),clip:{x:0,y:0,width:390,height:544}});
      expect(remote.connections).toHaveLength(1);expect(remote.connections[0].keys).toEqual([]);
      expect(app.errors).toEqual([]);expect(app.unexpected).toEqual([]);
    }finally{await app.close();}
  });
});
