import { expect, test } from "@playwright/test";

for (const touch of [false, true]) {
  test.describe(touch ? "touch" : "mouse", () => {
  test.use({ hasTouch: touch, viewport: { width: touch ? 390 : 1280, height: 844 } });
  test("terminal detects wrapped URLs, loads bundled symbols, and redraws after delayed font loading", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let releaseFont!: () => void;
    const fontGate = new Promise<void>(resolve => { releaseFont = resolve; });
    await page.route("**/*.woff2", async route => { await fontGate; await route.continue(); });
    await page.routeWebSocket("**/terminal-test-socket", socket => {
      socket.onMessage(() => {});
      socket.send("Nerd icons: \ue0b0 \uf07b \uf418\r\nhttps://example.com/a-long-terminal-link\r\n");
    });
    await page.route("**/terminal-presentation-test", route => route.fulfill({ contentType: "text/html", body: `
      <div id="root" style="width:260px;height:240px"></div>
      <script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => type => type;
        window.__vite_plugin_react_preamble_installed__ = true;
        const { default: React } = await import('/node_modules/.vite/deps/react.js');
        const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
        const { XtermTerminal } = await import('/src/terminal/XtermTerminal.tsx');
        createRoot(document.getElementById('root')).render(React.createElement(XtermTerminal, { webSocketUrl: 'ws://127.0.0.1:5174/terminal-test-socket' }));
      </script>` }));
    await page.goto("/terminal-presentation-test");
    await expect(page.locator(".xterm-rows")).toContainText("Nerd icons:");
    releaseFont();
    await expect.poll(() => page.evaluate(() => document.fonts.check('16px "Kodex Nerd Symbols"', "\ue0b0"))).toBe(true);
    await expect(page.locator(".xterm-rows")).toHaveCSS("font-family", /Kodex Nerd Symbols/);
    const line = page.locator(".xterm-rows > div").filter({ hasText: "https://example.com" }).first();
    const box = (await line.boundingBox())!;
    if (!touch) {
      await page.mouse.move(box.x + 40, box.y + box.height / 2);
      await expect(page.locator(".xterm-screen")).toHaveCSS("cursor", "pointer");
    }
    const opened: string[] = [];
    await page.exposeFunction("recordTerminalLink", (uri: string) => opened.push(uri));
    await page.evaluate(() => { window.open = ((uri: string) => { (window as unknown as { recordTerminalLink(uri: string): void }).recordTerminalLink(uri); return null; }) as typeof window.open; });
    if (touch) await page.touchscreen.tap(box.x + 40, box.y + box.height / 2);
    else await page.mouse.click(box.x + 40, box.y + box.height / 2);
    await expect.poll(() => opened).toEqual(["https://example.com/a-long-terminal-link"]);
    expect(errors).toEqual([]);
  });

  });
}
