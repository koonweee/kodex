// Opt-in native proof invoked by routes::desktop_tests::native_virtual_display_lifecycle.
// Temporarily makes the fixed virtual display main, then verifies restoration.
// No keys/pointer/clipboard.
import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {readFile, readdir} from "node:fs/promises";
import {dirname, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {createInterface} from "node:readline";
import {chromium} from "@playwright/test";

const [base, helper, owner] = process.argv.slice(2);
assert.match(base ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
const web=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const dist=resolve(web,"dist");const revisions=await readdir(resolve(dist,"assets/desktop-viewer"));assert.equal(revisions.length,1);
const geometryScript=fileURLToPath(new URL("desktop-native-geometry.py",import.meta.url));
const geometry=()=>JSON.parse(execFileSync("/usr/bin/python3",[geometryScript],{encoding:"utf8"}));
const before=geometry();assert(before.length>0);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,accept,timeout=10000){const end=Date.now()+timeout;let value;do{value=await read();if(accept(value))return value;await delay(100);}while(Date.now()<end);assert.fail("Native lifecycle condition timed out");}
function active(){
  const online=geometry(), extra=online.filter(d=>!before.some(b=>b.id===d.id));
  assert.equal(extra.length,1);const virtual=extra[0];
  assert.deepEqual(virtual.pixels,[1200,900]);assert.deepEqual(virtual.logical,[1200,900]);assert.equal(virtual.hz,60);
  assert.equal(virtual.main,true,"virtual display must be the macOS main display");assert.deepEqual(virtual.bounds,[0,0,1200,900]);
  const originals=online.filter(d=>before.some(b=>b.id===d.id));assert.equal(originals.length,before.length);
  const dx=originals[0].bounds[0]-before[0].bounds[0],dy=originals[0].bounds[1]-before[0].bounds[1];
  for(let i=0;i<before.length;i++)assert.deepEqual(originals[i],{...before[i],main:false,bounds:[before[i].bounds[0]+dx,before[i].bounds[1]+dy,...before[i].bounds.slice(2)]});
  return virtual;
}
function helperPid(){const lines=execFileSync("/bin/ps",["-axo","pid=,ppid=,args="],{encoding:"utf8"}).split("\n");const matches=lines.map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(m=>m&&m[2]===owner&&m[3]===helper+" --desktop-virtual-display-helper");assert.equal(matches.length,1);return Number(matches[0][1]);}
const browser=await chromium.launch();const errors=[],steps=[];let parent, created, primary;
try {
  const context=await browser.newContext({viewport:{width:1024,height:768}});
  await context.route("**/assets/**",async route=>{const path=resolve(dist,"."+new URL(route.request().url()).pathname);if(!path.startsWith(dist+sep))return route.fulfill({status:403});try{await route.fulfill({contentType:path.endsWith(".html")?"text/html":path.endsWith(".css")?"text/css":"text/javascript",body:await readFile(path)});}catch{await route.fulfill({status:404});}});
  await context.addInitScript(()=>{const Native=window.WebSocket;window.wire={connections:[],input:0,requests:[]};function Wrapped(...args){const socket=new Native(...args),entry={closed:false};window.wire.connections.push(entry);socket.addEventListener("close",()=>entry.closed=true);const send=socket.send.bind(socket);socket.send=bytes=>{const b=new Uint8Array(bytes.buffer??bytes,bytes.byteOffset??0,bytes.byteLength),d=new DataView(b.buffer,b.byteOffset,b.byteLength);if([4,5,6,251].includes(b[0]))window.wire.input++;if(b[0]===3)window.wire.requests.push([d.getUint16(6),d.getUint16(8)]);send(bytes);};return socket;}Object.assign(Wrapped,{CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3});window.WebSocket=Wrapped;});
  const ready=(page,selected=null)=>page.waitForFunction(id=>window.viewerState?.status==="connected"&&!window.viewerState.displayLoading&&(id===null||window.viewerState.selectedDisplay===id),selected,{timeout:20000});
  const sample=page=>page.evaluate(()=>{const c=document.querySelector("#screen canvas");return{width:c?.width,height:c?.height,selected:window.viewerState.displays?.find(d=>d.id===window.viewerState.selectedDisplay),...window.wire};});
  const open=async()=>{const page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));await page.goto(base+"/assets/desktop-viewer/"+revisions[0]+"/index.html");await page.waitForFunction(()=>window.kodexDesktop);await page.evaluate(()=>{window.kodexDesktop.subscribe(state=>window.viewerState=state);window.kodexDesktop.setActive(false);window.kodexDesktop.connect();});await until(async()=>{const response=await fetch(base+"/v1/desktop/display");return response.ok?(await response.json()).preferredDisplay:null;},Boolean);active();await ready(page);return page;};
  const disconnect=async page=>{await page.evaluate(()=>window.kodexDesktop.disconnect());await page.waitForFunction(()=>window.wire.connections.at(-1).closed);};
  const virtual=async page=>{const state=await sample(page);assert.equal(state.width,1200);assert.equal(state.height,900);assert.equal(state.selected.name,"Kodex display (1200 × 900)");assert.equal(state.input,0);assert(state.requests.every(([w,h])=>w<=1920&&h<=1080));};
  const a=await open();await virtual(a);const firstDisplay=active(), firstPid=helperPid();
  const b=await open();await virtual(b);assert.equal(active().id,firstDisplay.id);assert.equal(helperPid(),firstPid);steps.push("two viewers share one1200x900 macOS main display");
  const physical=await a.evaluate(()=>window.viewerState.displays.find(d=>!d.isMain).id);await a.evaluate(id=>window.kodexDesktop.setDisplay(id),physical);await ready(a,physical);await virtual(b);assert.equal((await sample(a)).selected.isMain,false);active();assert.equal(helperPid(),firstPid);steps.push("independent monitor selection preserves shared display");
  const target=await a.evaluate(()=>window.viewerState.displays.find(d=>d.name.startsWith("Kodex display")).id);await a.evaluate(id=>window.kodexDesktop.setDisplay(id),target);await ready(a,target);await virtual(a);
  await disconnect(b);assert.equal(helperPid(),firstPid);await disconnect(a);await delay(1000);assert.equal(active().id,firstDisplay.id);
  await a.evaluate(()=>window.kodexDesktop.connect());await ready(a);await virtual(a);assert.equal(helperPid(),firstPid);steps.push("last-close grace retains helper through reconnect");
  process.kill(firstPid,"SIGKILL");await until(geometry,displays=>JSON.stringify(displays)===JSON.stringify(before));
  await a.waitForFunction(()=>window.wire.connections.at(-1).closed);
  assert.deepEqual(await a.evaluate(()=>({failure:window.viewerState.failure,retryable:window.viewerState.retryable})),{failure:"connection",retryable:true});
  await disconnect(a);await a.evaluate(()=>window.kodexDesktop.connect());await ready(a);await virtual(a);active();assert.notEqual(helperPid(),firstPid);steps.push("dead helper is removed and replaced while old lease existed");
  await disconnect(a);await until(geometry,displays=>JSON.stringify(displays)===JSON.stringify(before));steps.push("final close removes display and preserves physical configuration");
  const wrapper="import subprocess,sys,time,json,os,select\nowner=os.getppid()\np=subprocess.Popen([sys.argv[1],'--desktop-virtual-display-helper'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)\nend=time.monotonic()+15\nbuffer=b''\nreported=False\ntry:\n while os.getppid()==owner and time.monotonic()<end and p.poll() is None:\n  if not reported and select.select([p.stdout],[],[],.1)[0]:\n   buffer+=os.read(p.stdout.fileno(),512)\n   if b'\\n' in buffer:\n    print(json.dumps({'pid':p.pid,'target':json.loads(buffer.split(b'\\n')[0])}),flush=True)\n    reported=True\n  else:time.sleep(.1)\nfinally:\n p.stdin.close()\n try:p.wait(timeout=2)\n except subprocess.TimeoutExpired:\n  p.kill()\n  p.wait(timeout=1)\n";
  parent=spawn("/usr/bin/python3",["-u","-c",wrapper,helper],{stdio:["ignore","pipe","pipe"]});
  const lines=createInterface({input:parent.stdout});created=await Promise.race([lines[Symbol.asyncIterator]().next().then(({value,done})=>{assert.equal(done,false);return JSON.parse(value);}),delay(8000).then(()=>{throw new Error("Parent-loss helper failed to start");})]);
  active();parent.kill("SIGKILL");await until(geometry,displays=>JSON.stringify(displays)===JSON.stringify(before));
  await until(()=>{try{process.kill(created.pid,0);return false;}catch{return true;}},Boolean,5000);steps.push("forced parent death removes and reaps helper without physical changes");
  for(const page of [a,b])assert.equal((await sample(page)).input,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({revision:revisions[0],steps,physicalModesAndRelativeArrangementPreserved:true,originalMainAndOriginsRestored:true,hostInputMessages:0,errors}));
} catch(error) { primary=error; } finally {
  if(parent?.exitCode===null)parent.kill("SIGKILL");
  try { await browser.close(); } catch(error) { primary ??= error; }
  try {
    try { await until(geometry,displays=>JSON.stringify(displays)===JSON.stringify(before)); }
    catch {
      // Only kill a known proof helper, verified by exact argv and ownership.
      const lines=execFileSync("/bin/ps",["-axo","pid=,ppid=,args="],{encoding:"utf8"}).split("\n");
      for(const line of lines) {
        const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if(!match || match[3]!==helper+" --desktop-virtual-display-helper")continue;
        const pid=Number(match[1]);
        if(match[2]===owner || pid===created?.pid) { try {process.kill(pid,"SIGKILL");}catch{} }
      }
      await until(geometry,displays=>JSON.stringify(displays)===JSON.stringify(before));
    }
    if(created?.pid) await until(()=>{try{process.kill(created.pid,0);return false;}catch{return true;}},Boolean,5000);
  } catch(error) { if(primary)console.error("Native proof cleanup also failed:",error); else primary=error; }
}
if(primary)throw primary;
