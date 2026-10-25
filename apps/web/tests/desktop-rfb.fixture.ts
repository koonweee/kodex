import type { BrowserContext, Page } from "@playwright/test";
import { WebSocketServer } from "ws";
import { constants, inflateSync } from "node:zlib";

// Downstream-only fixture: the gateway's dedicated-password adapter has separate
// real WebSocket tests. This exercises the exact pinned browser RFB client.
export class DesktopRfbFixture {
  sockets: { close(options: { code: number; reason: string }): void }[] = [];
  connections: { shared?: number; keys: { down: boolean; keysym: number }[]; pointers: number[]; clipboard: string[]; messages: number[]; closed: boolean }[] = [];
  errors: string[] = [];
  private paused: { pause(): void; resume(): void }[] = [];
  pause(index = 0) { this.paused[index].pause(); }
  resume(index = 0) { this.paused[index].resume(); }
  constructor(private extendedClipboard = false) {}
  requestClipboard(index = 0) {
    this.requesters[index]();
  }
  private requesters: (() => void)[] = [];
  async install(page: Page | BrowserContext) {
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
      if (request.url !== "/v1/desktop/ws") this.errors.push("Unexpected target");
      this.sockets.push({ close: ({ code, reason }) => socket.close(code, reason) });
      this.requesters.push(() => {
        const request = Buffer.from([3, 0, 0, 0, 255, 255, 255, 252, 2, 0, 0, 1]);
        socket.send(request);
      });
      const connection = { shared: undefined as number | undefined, keys: [] as { down: boolean; keysym: number }[], pointers: [] as number[], clipboard: [] as string[], messages: [] as number[], closed: false };
      this.connections.push(connection);
      let pending = Buffer.alloc(0);
      let stage = 0;
      let painted = false;
      socket.on("close", () => { connection.closed = true; });
      socket.on("message", (data, binary) => {
        if (!binary) { this.errors.push("Unexpected text frame"); return; }
        pending = Buffer.concat([pending, data as Buffer]);
        while (pending.length) {
          if (stage === 0) {
            if (pending.length < 12) return;
            if (pending.subarray(0, 12).toString() !== "RFB 003.008\n") this.errors.push("Wrong client version");
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
            const init = Buffer.alloc(28);
            init.writeUInt16BE(320, 0); init.writeUInt16BE(200, 2);
            Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
            init.writeUInt32BE(4, 20); init.write("Mock", 24);
            socket.send(init);
            if (this.extendedClipboard) socket.send(Buffer.from([3, 0, 0, 0, 255, 255, 255, 248, 31, 0, 0, 1, 0, 0, 0, 0]));
          } else {
            const type = pending[0];
            let length = ({ 0: 20, 3: 10, 4: 8, 5: 6, 150: 10 } as Record<number, number>)[type];
            if (type === 2) { if (pending.length < 4) return; length = 4 + pending.readUInt16BE(2) * 4; }
            if (type === 6) { if (pending.length < 8) return; length = 8 + Math.abs(pending.readInt32BE(4)); }
            if (!length) { this.errors.push(`Unexpected RFB message ${type}`); pending = Buffer.alloc(0); return; }
            if (pending.length < length) return;
            const message = pending.subarray(0, length);
            pending = pending.subarray(length);
            connection.messages.push(type);
            if (type === 4) connection.keys.push({ down: message[1] === 1, keysym: message.readUInt32BE(4) });
            if (type === 5) connection.pointers.push(message[1]);
            if (type === 6) {
              if (message.readInt32BE(4) >= 0) connection.clipboard.push(message.subarray(8).toString("latin1"));
              else if (message.readUInt32BE(8) === 0x10000001) {
                const inflated = inflateSync(message.subarray(12), { finishFlush: constants.Z_SYNC_FLUSH });
                connection.clipboard.push(inflated.subarray(4, 4 + inflated.readUInt32BE(0) - 1).toString("utf8"));
              }
            }
            if (type === 3 && !painted) {
              painted = true;
              const frame = Buffer.alloc(16 + 320 * 200 * 4);
              frame.writeUInt16BE(1, 2); frame.writeUInt16BE(320, 8); frame.writeUInt16BE(200, 10);
              for (let offset = 16; offset < frame.length; offset += 4) {
                frame[offset] = 0x11; frame[offset + 1] = 0x22; frame[offset + 2] = 0xcc;
              }
              socket.send(frame);
            }
          }
        }
      });
      // Fragment the gateway's synthesized version banner.
      socket.send(Buffer.from("RFB "));
      socket.send(Buffer.from("003.008\n"));
    });
  }
}
