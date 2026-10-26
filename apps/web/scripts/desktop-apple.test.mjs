import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { prepareDesktopViewer } from "./prepare-desktop-viewer.mjs";
const { sourceRoot } = prepareDesktopViewer();
const { parseAppleDisplayInfo, appleViewerInfo } = await import(pathToFileURL(join(sourceRoot, "core/apple-desktop.js")));

function layout() {
  const bytes=Buffer.alloc(20+3*56);bytes.writeUInt16BE(5,0);bytes.writeUInt16BE(5120,6);bytes.writeUInt16BE(2880,8);bytes.writeUInt32BE(95,10);bytes.writeUInt16BE(3,18);
  for(const [i,d] of [
    {id:95,x:0,y:0,fbX:2560,fbY:0,w:5120,h:2880,main:true},
    {id:94,x:-1280,y:0,fbX:0,fbY:0,w:2560,h:1600},
    {id:96,x:2560,y:696,fbX:7680,fbY:696,w:2266,h:1488},
  ].entries()) {
    const p=20+i*56;bytes.writeDoubleBE(2,p);bytes.writeDoubleBE(1,p+8);bytes.writeUInt32BE(d.id,p+16);bytes.writeInt16BE(d.y+d.h/2,p+24);bytes.writeInt16BE(d.x+d.w/2,p+26);bytes.writeInt16BE(d.y,p+20);bytes.writeInt16BE(d.x,p+22);
    bytes.writeInt16BE(d.fbY,p+28);bytes.writeInt16BE(d.fbX,p+30);bytes.writeInt16BE(d.fbY+d.h,p+32);bytes.writeInt16BE(d.fbX+d.w,p+34);bytes.writeUInt32BE(d.main?1:0,p+36);
  }
  return bytes;
}
test("native selection has its own framebuffer and opaque inventory IDs",()=>{
  const info=parseAppleDisplayInfo(layout());
  assert.equal(info.selectedDisplay,95);assert.equal(info.width,5120);assert.equal(info.height,2880);
  assert.deepEqual(info.displays.at(-1),{id:96,main:false,x:2560,y:696,width:2266,height:1488});
});
test("bounded native metadata rejects unsupported, truncated, duplicate and invalid geometry",()=>{
  const original=layout();
  for(const count of [0,1,19,20,original.length-1])assert.equal(parseAppleDisplayInfo(original.subarray(0,count)),null);
  for(const change of [b=>b.writeUInt16BE(99,0),b=>b.writeUInt16BE(33,18),b=>b.writeUInt16BE(0,6),b=>b.writeUInt32BE(95,92),b=>b.writeInt16BE(7680,166)]) {
    const bytes=Buffer.from(original);change(bytes);assert.equal(parseAppleDisplayInfo(bytes),null);
  }
});
test("a header-only selection acknowledgment is valid and all is only a bootstrap sentinel",()=>{
  const bytes=layout().subarray(0,20);bytes.writeUInt16BE(0,18);bytes.writeUInt32BE(0xffffffff,10);
  assert.deepEqual(parseAppleDisplayInfo(bytes),{width:5120,height:2880,selectedDisplay:null,displays:[],scale:undefined});
});
test("ViewerInfo declares its exact bounded body and supported native metadata command",()=>{
  const bytes=appleViewerInfo();const view=new DataView(bytes.buffer);
  assert.equal(bytes.length,66);assert.equal(bytes[0],33);assert.equal(view.getUint16(2),62);
  assert.equal(view.getUint16(4),1);assert.equal(view.getUint32(6),2);assert.equal(bytes[44],0x40);
});

test("native scaled layouts retain physical monitor dimensions without rounding drift",()=>{
  const bytes=layout();bytes.writeUInt16BE(1920,6);bytes.writeUInt16BE(1080,8);
  for(let i=0;i<3;i++){
    const p=20+i*56;bytes.writeDoubleBE(0.375,p+8);
    for(const offset of [28,30,32,34])bytes.writeInt16BE(Math.round(bytes.readInt16BE(p+offset)*0.375),p+offset);
  }
  const info=parseAppleDisplayInfo(bytes);
  assert.equal(info.width,1920);assert.equal(info.height,1080);assert.equal(info.scale,0.375);
  assert.deepEqual(info.displays,parseAppleDisplayInfo(layout()).displays);
  for(const value of [0,-1,NaN,Infinity,2]){
    const invalid=Buffer.from(bytes);invalid.writeDoubleBE(value,28);assert.equal(parseAppleDisplayInfo(invalid),null);
  }
});
