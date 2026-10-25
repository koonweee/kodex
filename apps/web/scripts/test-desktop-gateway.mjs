// Invoked by the opt-in Rust socket test. Uses the actual built iframe and a
// disposable Rust VNC peer; it never connects to the Mac's Screen Sharing port.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const gateway = process.argv[2];
assert.match(gateway ?? "", /^ws:\/\/127\.0\.0\.1:\d+\/$/);
const revisions = await readdir(resolve(dist, "assets/desktop-viewer"));
assert.equal(revisions.length, 1, "Build the current frontend before this proof");
const entry = `/assets/desktop-viewer/${revisions[0]}/index.html`;
const clipboardWrites = [];
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (request.method === "POST" && pathname === "/v1/desktop/clipboard") {
    let body = "";
    for await (const chunk of request) body += chunk;
    clipboardWrites.push(JSON.parse(body).text);
    response.writeHead(204).end();
    return;
  }
  const path = resolve(dist, "." + pathname);
  if (!path.startsWith(dist + sep)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html");
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((gateway) => {
    const Native = window.WebSocket;
    window.wire = { inbound: [], outbound: [], targets: [], prematurePasteKeys: false };
    const nativeFetch = window.fetch;
    let clipboardWritten = false;
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      if (response.url.endsWith("/v1/desktop/clipboard") && response.status === 204) clipboardWritten = true;
      return response;
    };
    function Routed(url, protocols) {
      window.wire.targets.push(new URL(url).pathname);
      const socket = new Native(gateway, protocols);
      socket.addEventListener("message", (event) => window.wire.inbound.push(...new Uint8Array(event.data)));
      const send = socket.send.bind(socket);
      socket.send = (bytes) => {
        const message = new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
        if (message[0] === 4 && message.length === 8 && [0xffeb, 0x76].includes(new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(4)) && !clipboardWritten) window.wire.prematurePasteKeys = true;
        window.wire.outbound.push(...new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength));
        send(bytes);
      };
      return socket;
    }
    Object.assign(Routed, { CONNECTING: Native.CONNECTING, OPEN: Native.OPEN, CLOSING: Native.CLOSING, CLOSED: Native.CLOSED });
    window.WebSocket = Routed;
  }, gateway);
  await page.goto(`http://127.0.0.1:${server.address().port}${entry}`);
  await page.waitForFunction(() => window.kodexDesktop);
  await page.evaluate(() => {
    window.kodexDesktop.subscribe((state) => { window.viewerState = state; });
    window.kodexDesktop.setActive(true);
    window.kodexDesktop.connect();
  });
  await page.waitForFunction(() => window.viewerState.status === "connected");
  await page.waitForFunction(() => {
    const canvas = document.querySelector("#screen canvas");
    const pixel = canvas?.getContext("2d").getImageData(0, 0, 1, 1).data;
    return pixel?.[0] === 0x11 && pixel[1] === 0x22 && pixel[2] === 0xcc;
  });
  await page.locator("#screen canvas").click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.kodexDesktop.paste("combined proof 你好 👋\nline 2"));
  const wire = await page.evaluate(() => window.wire);
  const version = Array.from(Buffer.from("RFB 003.008\n"));
  assert.deepEqual(wire.targets, ["/v1/desktop/ws"]);
  // The browser sees None, never the native type-2 offer/challenge/response.
  assert.deepEqual(wire.inbound.slice(0, 18), [...version, 1, 1, 0, 0, 0, 0]);
  assert.deepEqual(wire.outbound.slice(0, 14), [...version, 1, 1]);
  assert.deepEqual(clipboardWrites, ["combined proof 你好 👋\nline 2"]);
  assert.equal(wire.prematurePasteKeys, false);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.kodexDesktop.disconnect());
  console.log("Built pinned iframe crossed gateway-only VNC auth: shared framebuffer, Escape, ordered paste, clean close");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
