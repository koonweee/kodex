import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chromium } from "@playwright/test";
import { prepareDesktopViewer } from "./prepare-desktop-viewer.mjs";

const { sourceRoot } = prepareDesktopViewer();
const modules = resolve("node_modules");
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><html><body><div id="mocha"></div>
      <script src="/node_modules/mocha/mocha.js"></script>
      <script>mocha.setup({ui:'bdd',timeout:5000});</script>
      <script type="module">
        await import('/tests/assertions.js');
        await import('/tests/test.rfb.js');
        await import('/tests/test.gesturehandler.js');
        const failures = [];
        mocha.run().on('fail', (test, error) => failures.push({test:test.fullTitle(),error:error.message}))
          .on('end', function() {window.results={...this.stats,failures};});
      </script></body></html>`);
    return;
  }
  const base = pathname.startsWith("/node_modules/") ? modules : sourceRoot;
  const relative = base === modules ? pathname.slice("/node_modules/".length) : pathname.slice(1);
  const path = resolve(base, relative);
  if (!path.startsWith(base + sep)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : "application/octet-stream");
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch(); // Playwright's bundled Chromium, never installed Chrome.
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error));
  const address = server.address();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => window.results, null, { timeout: 120000 });
  const results = await page.evaluate(() => window.results);
  console.log(JSON.stringify(results, null, 2));
  if (results.failures.length || !results.passes) process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
