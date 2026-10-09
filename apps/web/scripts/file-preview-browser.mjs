import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.KODEX_FILE_PREVIEW_TEST_URL;
const root = process.env.KODEX_FILE_PREVIEW_TEST_ROOT;
assert(base && root, "Run through file_preview_browser_enforces_headers_and_plays_relative_video");
const browser = await chromium.launch();
const context = await browser.newContext();
try {
  // Produce a real WebM in bundled Chromium, without checked-in binary fixtures
  // or dependence on the user's ignored gallery recordings.
  const recording = await context.newPage();
  const bytes = await recording.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160; canvas.height = 90;
    const drawing = canvas.getContext("2d");
    const stream = canvas.captureStream(20);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const chunks = [];
    recorder.ondataavailable = ({ data }) => chunks.push(data);
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    let frame = 0;
    const timer = setInterval(() => {
      drawing.fillStyle = frame++ % 2 ? "blue" : "green";
      drawing.fillRect(0, 0, 160, 90);
    }, 50);
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    recorder.stop();
    await stopped;
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  await writeFile(join(root, "clip.webm"), Buffer.from(bytes));
  await writeFile(join(root, "theme.css"), "body { background: rgb(12, 34, 56); color: white; }");
  await writeFile(join(root, "controls.js"), "window.externalControlsLoaded = true;");
  await writeFile(join(root, "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>');
  await writeFile(join(root, "active.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40">
    <text y="20">Vector report</text><script>window.svgScriptRan = true; localStorage.getItem("preview-secret"); fetch("/v1/preview-probe", {method:"POST"});</script></svg>`);
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "details.html"), '<!doctype html><h1 id="section">Nested report</h1><video src="../clip.webm" controls muted></video>');
  await writeFile(join(root, "index.html"), `<!doctype html>
    <link rel="stylesheet" href="theme.css"><script src="controls.js"></script>
    <h1>Local report</h1><img src="image.svg" alt="Local image">
    <video src="clip.webm" muted playsinline controls preload="metadata"></video>
    <button id="play">Play</button><a href="nested/details.html#section">Details</a><a href="active.svg">Vector</a>
    <form method="post" action="/v1/preview-probe"><button id="submit">Submit</button></form>
    <script>document.querySelector('#play').onclick=()=>document.querySelector('video').play();</script>`);
  await recording.close();

  const parent = await context.newPage();
  await parent.goto(base + "/v1/health");
  await parent.evaluate(() => localStorage.setItem("preview-secret", "kodex-private"));
  const preview = base + "/v1/threads/thread-1/files/preview?path=" + encodeURIComponent(join(root, "index.html"));
  await parent.setContent(`<a href="${preview}" target="_blank" rel="noreferrer">Open report</a>`);
  const popupReady = parent.waitForEvent("popup");
  await parent.getByRole("link", { name: "Open report" }).click();
  const page = await popupReady;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForURL("**/files/content/**/index.html");
  await expect(page.getByRole("heading", { name: "Local report" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.externalControlsLoaded)).toBe(true);
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(12, 34, 56)");
  await expect.poll(() => page.locator("img").evaluate((image) => image.complete && image.naturalWidth)).toBe(16);
  await expect.poll(() => page.locator("video").evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => page.locator("video").evaluate((video) => video.currentTime)).toBeGreaterThan(0.1);
  await page.locator("video").evaluate((video) => { video.pause(); video.currentTime = 0.8; });
  await expect.poll(() => page.locator("video").evaluate((video) => video.seeking)).toBe(false);
  await expect.poll(() => page.locator("video").evaluate((video) => video.currentTime)).toBeGreaterThan(0.7);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.opener), null);
  const permissions = await page.evaluate(async () => {
    let storageBlocked = false;
    try { localStorage.getItem("preview-secret"); } catch { storageBlocked = true; }
    let fetchBlocked = false;
    try { await fetch("/v1/preview-probe", { method: "POST", body: "test" }); } catch { fetchBlocked = true; }
    const websocketBlocked = await new Promise((resolve) => {
      try {
        const socket = new WebSocket(location.origin.replace("http", "ws") + "/v1/preview-probe");
        socket.onerror = () => resolve(true);
        socket.onopen = () => { socket.close(); resolve(false); };
      } catch { resolve(true); }
    });
    return { storageBlocked, fetchBlocked, websocketBlocked };
  });
  assert.deepEqual(permissions, { storageBlocked: true, fetchBlocked: true, websocketBlocked: true });
  await page.evaluate(async () => {
    const violations = [];
    document.addEventListener("securitypolicyviolation", (event) => violations.push(event.effectiveDirective));
    const image = new Image();
    const imageBlocked = new Promise((resolve) => { image.onerror = resolve; });
    image.src = "../../../../../../../../v1/preview-probe";
    document.body.append(image);
    const script = document.createElement("script");
    const scriptBlocked = new Promise((resolve) => { script.onerror = resolve; });
    script.src = "/v1/preview-probe";
    document.body.append(script);
    await Promise.all([imageBlocked, scriptBlocked]);
    if (!violations.includes("img-src") || !violations.includes("script-src-elem")) {
      throw new Error("non-preview image/script requests must be rejected by CSP");
    }
    if (window.open("/v1/preview-probe") !== null) throw new Error("popup must be blocked");
  });
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Local report" })).toBeVisible();
  await page.getByRole("link", { name: "Details" }).click();
  await expect(page.getByRole("heading", { name: "Nested report" })).toBeVisible();
  assert(page.url().endsWith("/nested/details.html#section"));
  await expect.poll(() => page.locator("video").evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(1);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Nested report" })).toBeVisible();

  await page.goto(preview);
  await page.getByRole("link", { name: "Vector", exact: true }).click();
  for (const direct of [false, true]) {
    if (direct) await page.goto(base + "/v1/threads/thread-1/files/preview?path=" + encodeURIComponent(join(root, "active.svg")));
    await expect.poll(() => page.evaluate(() => document.contentType)).toBe("image/svg+xml");
    const vector = await page.evaluate(() => {
      let storageBlocked = false;
      try { localStorage.getItem("preview-secret"); } catch { storageBlocked = true; }
      return { scriptRan: Boolean(window.svgScriptRan), storageBlocked };
    });
    assert.deepEqual(vector, { scriptRan: false, storageBlocked: true });
  }

  // Local-only smoke for already-generated ignored artifacts; CI uses the
  // deterministic report above. No artifact files are rewritten.
  if (process.env.KODEX_EXISTING_GALLERY_PATH) {
    await page.goto(base + "/v1/threads/thread-1/files/preview?path=" + encodeURIComponent(process.env.KODEX_EXISTING_GALLERY_PATH));
    await expect.poll(() => page.locator("video").count()).toBeGreaterThan(0);
    await expect.poll(() => page.locator("video").evaluateAll((videos) => videos.every((video) => video.readyState >= 1))).toBe(true);
    await page.locator(".start").first().click();
    await expect.poll(() => page.locator("video").first().evaluate((video) => video.currentTime)).toBeGreaterThan(0.1);
    console.log("Existing gallery: all video metadata loaded; playback controls work.");
  }
  console.log("HTML preview: new tab, relative CSS/JS/image/video, playback, seek, nested navigation/reload and storage/API restrictions passed.");
} finally {
  await context.close();
  await browser.close();
}
