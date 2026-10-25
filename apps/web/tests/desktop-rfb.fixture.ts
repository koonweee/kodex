import type { BrowserContext, Page } from "@playwright/test";
import { WebSocketServer } from "ws";

// Downstream-only fixture: the gateway's dedicated-password adapter has separate
// real WebSocket tests. This exercises the exact pinned browser RFB client.
export class DesktopRfbFixture {
  sockets: { close(options: { code: number; reason: string }): void }[] = [];
  connections: { shared?: number; keys: { down: boolean; keysym: number }[]; pointers: number[]; pointerPositions: { mask: number; x: number; y: number }[]; messages: number[]; closed: boolean }[] = [];
  errors: string[] = [];
  framebuffer = { width: 320, height: 200 };
  nativeDesktop = false;
  nativeDensity = 1;
  frameBlue = 0xcc;
  private stateSenders: ((statuses: number[], fragmented: boolean) => void)[] = [];
  sendNativeStates(statuses: number[], fragmented = false) {
    for (const send of this.stateSenders) send(statuses, fragmented);
  }
  cursor: { width: number; height: number; hotx: number; hoty: number } | undefined;
  private cursorSenders: (() => void)[] = [];
  setCursor(cursor: NonNullable<DesktopRfbFixture["cursor"]>) {
    this.cursor = cursor;
    for (const send of this.cursorSenders) send();
  }
  nativeDisplays = [{ id: 92, main: true, x: 0, y: 0, width: 320, height: 200, fbX: 0, fbY: 0 }];
  displaySelections: number[] = [];
  scaleRequests: { scale: number; selected: number | null }[] = [];
  ignoreScaling = false;
  echoScaleWithoutResize = false;
  holdBootstrap = false;
  private bootstrapReplies: (() => void)[] = [];
  releaseBootstrap() { for (const reply of this.bootstrapReplies.splice(0)) reply(); }
  holdDisplayInfo = false;
  holdFramebuffer = false;
  fragmentDisplayInfo = false;
  standaloneDisplayInfo = false;
  headerOnlySelectionAck = false;
  private frameReplies: (() => void)[] = [];
  releaseFramebuffer() { for (const reply of this.frameReplies.splice(0)) reply(); }
  private displayReplies: (() => void)[] = [];
  releaseDisplayInfo() { for (const reply of this.displayReplies.splice(0)) reply(); }
  updateRequests: { incremental: boolean; x: number; y: number; width: number; height: number }[] = [];
  automaticRequests: { enabled: boolean; x: number; y: number; width: number; height: number }[] = [];
  continuousRequests: { enabled: boolean; x: number; y: number; width: number; height: number }[] = [];
  continuousUpdates = false;
  displayFailure = false;
  private geometrySenders: ((width: number, height: number, metadata?: boolean) => void)[] = [];
  resize(width: number, height: number) {
    this.framebuffer = { width, height };
    for (const send of this.geometrySenders) send(width, height);
  }
  resizeFramebuffer(width: number, height: number) { for (const send of this.geometrySenders) send(width,height,false); }
  private paused: { pause(): void; resume(): void }[] = [];
  pause(index = 0) { this.paused[index].pause(); }
  resume(index = 0) { this.paused[index].resume(); }
  clipboardWrites: string[] = [];
  holdClipboard = false;
  clipboardFailure = false;
  private clipboardReplies: (() => Promise<void>)[] = [];
  async releaseClipboard() {
    for (const reply of this.clipboardReplies.splice(0)) await reply();
  }
  async install(page: Page | BrowserContext) {
    await page.route("**/v1/desktop/clipboard", async (route) => {
      this.clipboardWrites.push((route.request().postDataJSON() as { text: string }).text);
      const reply = async () => {
        try {
          if (this.clipboardFailure) await route.fulfill({ status: 502, json: { code: "bad_gateway", message: "The Mac clipboard could not be written.", retryable: false } });
          else await route.fulfill({ status: 204 });
        } catch { /* A canceled request or closed page has no response recipient. */ }
      };
      if (this.holdClipboard) this.clipboardReplies.push(reply);
      else await reply();
    });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not listen");
    // Return real native WebSockets. Playwright routeWebSocket wraps a subclass
    // whose prototype layout fails noVNC 1.6's raw-channel property check.
    await page.addInitScript((port) => {
      const Native = window.WebSocket;
      function Routed(url: string | URL, protocols?: string | string[]) {
        const target = new URL(url);
        return new Native(target.pathname === "/v1/desktop/ws" ? `ws://127.0.0.1:${port}/v1/desktop/ws` : url, protocols);
      }
      Object.assign(Routed, { CONNECTING: Native.CONNECTING, OPEN: Native.OPEN, CLOSING: Native.CLOSING, CLOSED: Native.CLOSED });
      window.WebSocket = Routed as unknown as typeof WebSocket;
    }, address.port);
    page.on("close", () => { for (const socket of server.clients) socket.terminate(); server.close(); });
    server.on("connection", (socket, request) => {
      this.paused.push(socket);
      this.stateSenders.push((statuses, fragmented) => {
        if (socket.readyState !== 1) return;
        const bytes=Buffer.concat(statuses.map((status)=>{const body=Buffer.from([20,0,0,4,0,0,0,0]);body.writeUInt16BE(status,6);return body;}));
        if (fragmented) for (const chunk of [bytes.subarray(0,1),bytes.subarray(1,3),bytes.subarray(3)]) socket.send(chunk);
        else socket.send(bytes);
      });
      const sendCursor = () => {
        if (!this.cursor || socket.readyState !== 1) return;
        const {width,height,hotx,hoty}=this.cursor;
        const update=Buffer.alloc(16+width*height*4+Math.ceil(width/8)*height,255);
        update.fill(0,0,16);update.writeUInt16BE(1,2);
        update.writeUInt16BE(hotx,4);update.writeUInt16BE(hoty,6);update.writeUInt16BE(width,8);update.writeUInt16BE(height,10);update.writeInt32BE(-239,12);
        socket.send(update);
      };
      this.cursorSenders.push(sendCursor);
      let selected: number | null = null;
      let scale = 1;
      const dimensions = () => { const d=this.nativeDisplays.find((d)=>d.id===selected); const size=d ?? this.framebuffer; return {width:Math.round(size.width*(this.echoScaleWithoutResize?1:scale)),height:Math.round(size.height*(this.echoScaleWithoutResize?1:scale))}; };
      const nativeInfo = () => {
        if (socket.readyState !== 1) return;
        if (!this.nativeDisplays.some((d)=>d.id===selected)) selected=null;
        const {width,height}=dimensions();
        const records=this.headerOnlySelectionAck && selected !== null ? [] : this.nativeDisplays;
        const body=Buffer.alloc(20+records.length*56);
        body.writeUInt16BE(this.displayFailure ? 99 : 5,0); body.writeUInt16BE(width,2); body.writeUInt16BE(height,4);
        body.writeUInt16BE(width,6);body.writeUInt16BE(height,8);body.writeUInt32BE(selected ?? 0xffffffff,10);body.writeUInt32BE(12,14);body.writeUInt16BE(records.length,18);
        for (const [i,d] of records.entries()) {
          const p=20+i*56;body.writeDoubleBE(this.nativeDensity,p);body.writeDoubleBE(scale,p+8);body.writeUInt32BE(d.id,p+16);
          for (const [n,value] of [d.y,d.x,d.y+d.height/this.nativeDensity,d.x+d.width/this.nativeDensity,...[d.fbY,d.fbX,d.fbY+d.height,d.fbX+d.width].map(v=>Math.round(v*scale))].entries()) body.writeInt16BE(value,p+20+n*2);
          body.writeUInt32BE(d.main?1:0,p+36);Buffer.from([32,24,0,1,0,255,0,255,0,255,16,8,0,0,0,0]).copy(body,p+40);
        }
        let frame: Buffer;
        if(this.standaloneDisplayInfo) {frame=Buffer.alloc(3+body.length);frame[0]=81;frame.writeUInt16BE(body.length,1);body.copy(frame,3);}
        else {frame=Buffer.alloc(18+body.length);frame.writeUInt16BE(1,2);frame.writeInt32BE(1105,12);frame.writeUInt16BE(body.length,16);body.copy(frame,18);}
        if(this.fragmentDisplayInfo) {const a=this.standaloneDisplayInfo?2:17;for(const chunk of [frame.subarray(0,a),frame.subarray(a,a+12),frame.subarray(a+12)])socket.send(chunk);}
        else socket.send(frame);
      };
      const sendNativeInfo = () => this.holdDisplayInfo ? this.displayReplies.push(nativeInfo) : nativeInfo();
      this.geometrySenders.push((width, height, metadata=true) => {
        if (this.nativeDesktop && metadata) { sendNativeInfo(); return; }
        const update = Buffer.alloc(16); update.writeUInt16BE(1, 2);
        update.writeUInt16BE(width, 8); update.writeUInt16BE(height, 10); update.writeInt32BE(-223, 12);
        socket.send(update);
      });
      if (request.url !== "/v1/desktop/ws") this.errors.push("Unexpected target");
      this.sockets.push({ close: ({ code, reason }) => socket.close(code, reason) });
      const connection = { shared: undefined as number | undefined, keys: [] as { down: boolean; keysym: number }[], pointers: [] as number[], pointerPositions: [] as { mask: number; x: number; y: number }[], messages: [] as number[], closed: false };
      this.connections.push(connection);
      let pending = Buffer.alloc(0);
      let stage = 0;
      let painted = false;
      let nativeInfoSent = false;
      socket.on("close", () => { connection.closed = true; });
      socket.on("message", (data, binary) => {
        if (!binary) { this.errors.push("Unexpected text frame"); return; }
        pending = Buffer.concat([pending, data as Buffer]);
        while (pending.length) {
          if (stage === 0) {
            if (pending.length < 12) return;
            if (pending.subarray(0, 12).toString() !== (this.nativeDesktop ? "RFB 003.889\n" : "RFB 003.008\n")) this.errors.push("Wrong client version");
            pending = pending.subarray(12);
            stage++;
            socket.send(Buffer.from([1, 1]));
          } else if (stage === 1) {
            if (pending[0] !== 1) this.errors.push("Browser requested password authentication");
            pending = pending.subarray(1);
            stage++;
            socket.send(Buffer.alloc(4));
          } else if (stage === 2) {
            connection.shared = pending[0];
            pending = pending.subarray(1);
            stage++;
            const init = Buffer.alloc(this.nativeDesktop ? 50 : 28);
            init.writeUInt16BE(this.framebuffer.width, 0); init.writeUInt16BE(this.framebuffer.height, 2);
            Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
            init.writeUInt32BE(this.nativeDesktop ? 26 : 4, 20);
            if (this.nativeDesktop) {init.writeUInt32BE(80,26);init.write("Mock",46);} else init.write("Mock", 24);
            socket.send(init);
          } else {
            const type = pending[0];
            let length = ({ 0: 20, 3: 10, 4: 8, 5: 6, 8: 10, 9: 16, 10: 4, 13: 8, 150: 10 } as Record<number, number>)[type];
            if (type === 2) { if (pending.length < 4) return; length = 4 + pending.readUInt16BE(2) * 4; }
            if (type === 33) { if(pending.length<4)return;length=4+pending.readUInt16BE(2); }
            if (type === 6) { if (pending.length < 8) return; length = 8 + Math.abs(pending.readInt32BE(4)); }
            if (!length) { this.errors.push(`Unexpected RFB message ${type}`); pending = Buffer.alloc(0); return; }
            if (pending.length < length) return;
            const message = pending.subarray(0, length);
            pending = pending.subarray(length);
            connection.messages.push(type);
            if (this.nativeDesktop && type===2 && !nativeInfoSent) { nativeInfoSent=true;sendNativeInfo(); }
            if (this.nativeDesktop && type===13) {
              selected=message[1]?null:message.readUInt32BE(4);
              if(selected!==null&&!this.nativeDisplays.some(d=>d.id===selected))this.errors.push("Unknown native display ID");
              if(selected!==null)this.displaySelections.push(selected);
              painted=false;sendNativeInfo();
            }
            if (type === 8) {
              const requested=message.readDoubleBE(2);
              this.scaleRequests.push({scale:requested,selected});
              if (!this.ignoreScaling) {scale=requested;painted=false;sendNativeInfo();}
            }
            if (type === 4) connection.keys.push({ down: message[1] === 1, keysym: message.readUInt32BE(4) });
            if (type === 5) {
              connection.pointers.push(message[1]);
              connection.pointerPositions.push({ mask: message[1], x: message.readUInt16BE(2), y: message.readUInt16BE(4) });
            }
            if (type === 6) this.errors.push("Paste must use the native clipboard endpoint");
            if (type === 3) this.updateRequests.push({ incremental: message[1] === 1, x: message.readUInt16BE(2), y: message.readUInt16BE(4), width: message.readUInt16BE(6), height: message.readUInt16BE(8) });
            if (type === 9) this.automaticRequests.push({ enabled: message.readUInt16BE(2) !== 0, x: message.readUInt16BE(8), y: message.readUInt16BE(10), width: message.readUInt16BE(12), height: message.readUInt16BE(14) });
            if (type === 150) this.continuousRequests.push({ enabled: message[1] === 1, x: message.readUInt16BE(2), y: message.readUInt16BE(4), width: message.readUInt16BE(6), height: message.readUInt16BE(8) });
            if (type === 3 && (!painted || message[1] === 0)) {
              const first = !painted;
              painted = true;
              const available=this.nativeDesktop?dimensions():this.framebuffer;
              const size={width:Math.min(available.width,message.readUInt16BE(6)),height:Math.min(available.height,message.readUInt16BE(8))};
              const frame = Buffer.alloc(16 + size.width * size.height * 4);
              frame.writeUInt16BE(1, 2); frame.writeUInt16BE(size.width, 8); frame.writeUInt16BE(size.height, 10);
              for (let offset = 16; offset < frame.length; offset += 4) {
                frame[offset] = this.nativeDesktop ? 30*(1+this.nativeDisplays.findIndex(d=>d.id===selected)) : 0x11; frame[offset + 1] = 0x22; frame[offset + 2] = this.frameBlue;
              }
              const reply=()=>{if(socket.readyState===1){socket.send(frame);sendCursor();}};
              if(this.holdBootstrap&&message.readUInt16BE(6)<=64&&message.readUInt16BE(8)<=64)this.bootstrapReplies.push(reply);else if(this.holdFramebuffer)this.frameReplies.push(reply);else reply();
              if (first && this.continuousUpdates) socket.send(Buffer.from([150]));
            }
          }
        }
      });
      // Fragment the gateway's synthesized version banner.
      socket.send(Buffer.from("RFB "));
      socket.send(Buffer.from(this.nativeDesktop ? "003.889\n" : "003.008\n"));
    });
  }
}
