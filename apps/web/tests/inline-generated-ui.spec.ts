import { expect, test, type Page } from "@playwright/test";
import type { AppSurfaceSession, GeneratedAppReference, ThreadTimelineRow } from "../src/api/client";
import { nativeSettingsFixture } from "./native-settings.fixture";

async function setup(context: Parameters<typeof nativeSettingsFixture>[0], tallCard?: string, tallHeight=1600) {
  const fixture=await nativeSettingsFixture(context);
  const cards=new Map<string,AppSurfaceSession>();
  const messages:string[]=[];
  const create=(id:string):ThreadTimelineRow=> {
    const card:AppSurfaceSession={id,threadId:"settings-chat",title:`Card ${id}`,provider:"generated",revision:1,status:"active",bridgeToken:`token-${id}`,resourceUri:`ui://cards/${id}`,resourceMimeType:"text/html;profile=mcp-app",documentUrl:`/v1/app-surfaces/${id}/document?revision=1`,fallbackContent:`Fallback ${id}`,csp:{connectDomains:[],resourceDomains:[]},permissions:{},displayModes:["inline"],grants:{canSendMessage:true,canOpenLinks:false,canUpdateModelContext:false,resources:[],tools:[]},provenance:{},createdAt:"2026-10-22T00:00:00Z",updatedAt:"2026-10-22T00:00:00Z",archivedAt:null};
    cards.set(id,card);
    const ref:GeneratedAppReference={id,title:card.title,fallbackContent:card.fallbackContent};
    return {id:`generated-${id}`,kind:"generated_app",turnId:"turn-card",displayOrder:cards.size*100,status:"completed",item:{id:`generated-${id}`,threadId:"settings-chat",turnId:"turn-card",itemId:`generated-${id}`,itemType:"generatedApp",displayOrder:cards.size*100,status:"completed",codexMethod:"thread_view/generated_app",payload:{item:{generatedApp:ref}}}};
  };
  const publish=(id:string,client?:string)=>fixture.publishTimeline({...fixture.detail.timeline,rows:[...fixture.detail.timeline.rows,create(id)],viewRevision:fixture.detail.timeline.viewRevision+1},client);
  fixture.detail.timeline={...fixture.detail.timeline,activeTurnId:"turn-card",liveState:"streaming",turns:[{id:"turn-card",status:"inProgress"}],rows:[create("A")]};
  await context.route(/\/v1\/app-surfaces\/[^/?]+(?:\/(?:document|bridge))?(?:\?.*)?$/,async route=>{
    const url=new URL(route.request().url());const id=url.pathname.split('/')[3];const card=cards.get(id);
    if(!card)return route.fallback();
    if(url.pathname.endsWith('/document'))return route.fulfill({contentType:'text/html',body:documentHtml(id,id===tallCard,tallHeight)});
    if(url.pathname.endsWith('/bridge')){
      const body=route.request().postDataJSON();
      expect(body.bridgeToken).toBe(card.bridgeToken);
      if(body.method==='ui/message'){
        messages.push(body.params.content.text);
        return route.fulfill({json:{id:body.id,result:{input:{payload:{turn:{id:'next',status:'inProgress'}}}}}});
      }
      return route.fulfill({json:{id:body.id,result:{}}});
    }
    return route.fulfill({json:{session:card}});
  });
  return {...fixture,publish,messages};
}
function app(page:Page,id:string){return page.frameLocator(`iframe[title="App surface: Card ${id}"]`).frameLocator('iframe[title="App surface content"]');}
function documentHtml(id:string,tall=false,tallHeight=1600){return `<!doctype html><html><head><style>body{padding:16px;overflow-wrap:anywhere}button,input{font:inherit;min-height:44px;margin:6px;max-width:100%;box-sizing:border-box}p{margin:8px 0}</style></head><body><h3>Interactive ${id}</h3><input autofocus aria-label="Card draft" placeholder="Try a local draft"><button id="toggle" onclick="const e=document.getElementById('extra');e.hidden=!e.hidden;this.textContent=e.hidden?'Show details':'Hide details'">Show details</button><button onclick="window.kodex.submitMessage('Choose ${id}')">Send choice ${id}</button><div id="extra" ${tall ? "" : "hidden"} style="height:${tallHeight}px"><p>Details for ${id}</p></div><script>document.querySelector("input").focus()</script></body></html>`;}

for(const shape of [
  {name:'wide fine pointer',width:1280,hasTouch:false},
  {name:'narrow fine pointer',width:390,hasTouch:false},
  {name:'narrow touch',width:390,hasTouch:true},
  {name:'wide touch',width:1280,hasTouch:true},
]){
  test.describe(shape.name,()=>{
    test.use({viewport:{width:shape.width,height:900},hasTouch:shape.hasTouch});
    test('cards size naturally, coexist, retain old actions and converge after missed events',async({context})=>{
      const fixture=await setup(context);
      try{
        const first=await fixture.page('first');const second=await fixture.page('second');
        for(const page of [first,second])await expect(app(page,'A').getByRole('heading',{name:'Interactive A'})).toBeVisible();
        const frame=first.getByTitle('App surface: Card A',{exact:true});
        const initial=(await frame.boundingBox())!.height;
        await app(first,'A').getByRole('button',{name:'Show details',exact:true}).click();
        await expect.poll(async()=> (await frame.boundingBox())?.height ?? 0).toBeGreaterThan(1600);
        await expect.poll(async()=>app(first,'A').locator('html').evaluate(e=>e.scrollHeight-e.clientHeight)).toBeLessThanOrEqual(1);
        await app(first,'A').getByRole('button',{name:'Hide details',exact:true}).click();
        await expect.poll(async()=> (await frame.boundingBox())?.height ?? 2000).toBeLessThan(initial+5);
        const composer = first.getByRole('textbox',{name:'Message composer',exact:true}).last();
        await composer.focus();
        fixture.publish('B','first');
        await expect(app(first,'B').getByRole('heading',{name:'Interactive B'})).toBeVisible();
        await expect(composer).toBeFocused();
        await expect(second.getByTitle('App surface: Card B',{exact:true})).toHaveCount(0);
        const previous=fixture.connections.get('second')??0;
        fixture.disconnect('second');
        await expect.poll(()=>fixture.connections.get('second')??0).toBeGreaterThan(previous);
        await expect(app(second,'B').getByRole('heading',{name:'Interactive B'})).toBeVisible();
        await app(first,'A').getByRole('button',{name:'Send choice A',exact:true}).click();
        await expect.poll(()=>fixture.messages.length).toBe(1);
        await app(second,'A').getByRole('button',{name:'Send choice A',exact:true}).click();
        await expect.poll(()=>fixture.messages).toEqual(['Choose A','Choose A']);
        await first.reload();
        await expect(app(first,'A').getByRole('heading',{name:'Interactive A'})).toBeVisible();
        await expect(app(first,'B').getByRole('heading',{name:'Interactive B'})).toBeVisible();
        expect(await first.locator('.kodex-generated-app-card').getByRole('button',{name:/Expand|Collapse/}).count()).toBe(0);
        expect(await first.getByRole('button',{name:'Open app surface',exact:true}).count()).toBe(0);
      }finally{await fixture.close();}
      // Chromium reports its own cross-origin autofocus rejection for the adversarial fixture.
      expect(fixture.errors.filter(error=>error!=="Blocked autofocusing on a <input> element in a cross-origin subframe.")).toEqual([]);expect(fixture.unexpected).toEqual([]);
    });
  });
}

for(const tallHeight of [1600,350]) {
test(`late resize above a paused reader (${tallHeight}) preserves position without submitting`,async({context})=>{
  const fixture=await setup(context,'B',tallHeight);
  try {
    const page=await fixture.page('reader');
    await expect(app(page,'A').getByRole('heading',{name:'Interactive A'})).toBeVisible();
    const firstFrame=page.getByTitle('App surface: Card A',{exact:true});
    await expect.poll(async()=>(await firstFrame.boundingBox())?.height??0).toBeGreaterThan(160);
    const initialHeight=(await firstFrame.boundingBox())!.height;
    fixture.publish('B');
    const b=page.getByTitle('App surface: Card B',{exact:true});
    await expect.poll(async()=>(await b.boundingBox())?.height??0).toBeGreaterThan(tallHeight);
    const scroller=page.locator('.kodex-thread-pane-scroll').last();
    await expect(page.locator('[data-initial-bottom-aligned="true"]')).toBeVisible();
    await expect.poll(()=>scroller.evaluate(element=>element.scrollHeight-element.clientHeight-element.scrollTop)).toBeLessThan(3);
    await scroller.hover();
    await page.mouse.wheel(0,-1600);
    await expect(page.getByRole('button',{name:'Scroll to bottom',exact:true})).toBeVisible();
    await scroller.evaluate(element=>{element.scrollTop=0;});
    await expect.poll(()=>scroller.evaluate(element=>element.scrollTop)).toBeLessThan(2);
    await expect.poll(async()=>(await firstFrame.boundingBox())?.height??0).toBe(initialHeight);
    const aCard=page.locator('.kodex-generated-app-card[aria-label="Card A"]');
    await aCard.evaluate(element=>{const scroll=element.closest('.kodex-thread-pane-scroll')!;scroll.scrollTop+=element.getBoundingClientRect().bottom-scroll.getBoundingClientRect().top+8;});
    await expect.poll(()=>aCard.evaluate(element=>element.getBoundingClientRect().bottom-element.closest('.kodex-thread-pane-scroll')!.getBoundingClientRect().top)).toBeLessThan(-1);
    await expect.poll(()=>aCard.evaluate(element=>element.getBoundingClientRect().bottom-element.closest('.kodex-thread-pane-scroll')!.getBoundingClientRect().top)).toBeGreaterThan(-40);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const outer=await page.getByTitle('App surface: Card A',{exact:true}).elementHandle();
    const proxy=await outer!.contentFrame();
    if(tallHeight===350)await expect.poll(()=>scroller.evaluate(element=>element.scrollHeight-element.clientHeight-element.scrollTop)).toBeLessThan(60);
    const before=(await b.boundingBox())!.y;
    // Exercise the host/virtualizer boundary directly: browsers may suspend
    // requestAnimationFrame in a fully offscreen child document. Real document
    // measurement is covered by the grow/shrink cases above.
    await outer!.evaluate(frame=>{new MutationObserver(()=>{if(frame.style.height==='900px')document.documentElement.dataset.cardResized='true';}).observe(frame,{attributes:true,attributeFilter:['style']});});
    await proxy!.evaluate(()=>window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:900}},'*'));
    await expect(page.locator('html')).toHaveAttribute('data-card-resized','true');
    await page.evaluate(()=>new Promise<void>(resolve=>{let frames=6;const next=()=>{if(--frames)requestAnimationFrame(next);else resolve();};requestAnimationFrame(next);}));
    await expect.poll(async()=>Math.abs((await b.boundingBox())!.y-before)).toBeLessThan(3);
    expect(fixture.messages).toEqual([]);
  }finally{await fixture.close();}
});

}

if (process.env.KODEX_INLINE_BROWSER_REVIEW) {
  test.use({launchOptions:{args:["--remote-debugging-port=9337"]}});
  test('browser inspection',async({context})=>{
    test.setTimeout(120_000);
    const fixture=await setup(context);
    try {
      const page=await fixture.page('inspection');fixture.publish('B');
      await expect(app(page,'B').getByRole('heading',{name:'Interactive B'})).toBeVisible();
      await page.waitForTimeout(90_000);
    }finally{await fixture.close();}
  });
}
