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

class CodecSocket {
  pending = new Uint8Array();
  append(bytes) { this.pending = Uint8Array.from([...this.pending, ...bytes]); }
  rQwait(_name, count) { return this.pending.length < count; }
  rQshift32() { const value = new DataView(this.pending.buffer, this.pending.byteOffset, 4).getUint32(0);this.pending=this.pending.subarray(4);return value; }
  rQshiftBytes(count) { const bytes=this.pending.subarray(0,count);this.pending=this.pending.subarray(count);return bytes; }
}
async function codecFixture() {
  const {default:Decoder}=await import(pathToFileURL(join(sourceRoot,"core/decoders/apple-thousands.js")));
  const {default:Deflator}=await import(pathToFileURL(join(sourceRoot,"core/deflator.js")));
  const deflator=new Deflator();
  return {decoder:new Decoder(),socket:new CodecSocket(),packet(words) {
    const plain=Buffer.alloc(words.length*2);words.forEach((value,i)=>plain.writeUInt16BE(value,i*2));
    const bytes=Buffer.from(deflator.deflate(plain));const header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);
    return Buffer.concat([header,bytes]);
  }};
}
test("native reduced-color pixels remain sharp across fragmented records and one continuous zlib stream",async()=>{
  const {decoder,socket,packet}=await codecFixture();const blits=[];
  const display={blitImage:(x,y,width,height,pixels)=>blits.push({x,y,width,height,pixels:Array.from(pixels)})};
  const first=packet([0x7c00,0x03e0,0x001f]);
  socket.append(first.subarray(0,3));assert.equal(decoder.decodeRect(7,9,3,1,socket,display,24),false);
  socket.append(first.subarray(3,first.length-2));assert.equal(decoder.decodeRect(7,9,3,1,socket,display,24),false);
  assert.equal(blits.length,0);
  socket.append(first.subarray(first.length-2));assert.equal(decoder.decodeRect(7,9,3,1,socket,display,24),true);
  assert.deepEqual(blits[0],{x:7,y:9,width:3,height:1,pixels:[255,0,0,255,0,255,0,255,0,0,255,255]});
  socket.append(packet([0x7fff,0x0000,0x4210]));assert.equal(decoder.decodeRect(0,0,3,1,socket,display,24),true);
  assert.deepEqual(blits[1].pixels,[255,255,255,255,0,0,0,255,132,132,132,255]);
});
test("native reduced-color decoder rejects incomplete pixel data before painting",async()=>{
  const {decoder,socket,packet}=await codecFixture();let painted=false;
  socket.append(packet([0x7c00]));
  assert.throws(()=>decoder.decodeRect(0,0,2,1,socket,{blitImage:()=>{painted=true;}},24),/incomplete|inflate/i);
  assert.equal(painted,false);
});
test("native reduced-color conversion paints every row when a rectangle spans multiple strips",async()=>{
  const {decoder,socket,packet}=await codecFixture();const width=3,height=131;
  const words=Array.from({length:width*height},(_,i)=>[0x7c00,0x03e0,0x001f][Math.floor(i/width)%3]);
  const pixels=new Uint8Array(width*height*4);const seen=new Set();
  const display={blitImage:(x,y,w,h,strip)=>{
    assert.equal(x,5);assert.equal(w,width);
    assert.ok(h<=64);assert.ok(strip.byteLength<=width*64*4);
    for(let row=0;row<h;row++){
      const target=y-7+row;assert.equal(seen.has(target),false);seen.add(target);
      pixels.set(strip.subarray(row*w*4,(row+1)*w*4),target*width*4);
    }
  }};
  socket.append(packet(words));assert.equal(decoder.decodeRect(5,7,width,height,socket,display,24),true);
  assert.equal(seen.size,height);
  const colors=[[255,0,0,255],[0,255,0,255],[0,0,255,255]];
  for(let row=0;row<height;row++)assert.deepEqual(Array.from(pixels.subarray(row*12,row*12+12)),Array(3).fill(colors[row%3]).flat());
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
