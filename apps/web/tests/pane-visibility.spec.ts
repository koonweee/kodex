import { expect, test } from "@playwright/test";
import { nativeSettingsFixture } from "./native-settings.fixture";

test("hidden mounted panes contain animated and explicitly visible descendants", async ({ page }) => {
  await page.route("**/pane-visibility-test", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
      <div class="kodex-workspace-dock">
        <div id="hidden-pane" class="dv-render-overlay" style="visibility: hidden; pointer-events: none">
          <span id="forced-visible" style="position: fixed; visibility: visible; z-index: 99999">escaped control</span>
        </div>
      </div>
      <div id="hidden-animation" style="visibility: hidden"><div id="animation-root"></div></div>
      <script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => type => type;
        window.__vite_plugin_react_preamble_installed__ = true;
        const { default: React } = await import('/node_modules/.vite/deps/react.js');
        const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
        const { default: { flushSync } } = await import('/node_modules/.vite/deps/react-dom.js');
        await import('/src/styles/workspace.css');
        const { AnimatedNumber } = await import('/src/ui/AnimatedNumber.tsx');
        const root = createRoot(document.getElementById('animation-root'));
        window.setAnimatedValue = value => flushSync(() => root.render(React.createElement(AnimatedNumber, { value })));
        window.setAnimatedValue(1);
      </script>
    </body></html>`,
  }));

  await page.goto("/pane-visibility-test");
  await page.waitForFunction(() => typeof Reflect.get(window, "setAnimatedValue") === "function");
  await page.evaluate(() => Reflect.get(window, "setAnimatedValue")(2));

  // The pane is composited away as a unit, even when a fixed, high-z child
  // explicitly overrides inherited visibility.
  await expect(page.locator("#hidden-pane")).toHaveCSS("opacity", "0");
  await expect(page.locator("#forced-visible")).toHaveCSS("visibility", "visible");
  // The outgoing animated value no longer overrides a hidden ancestor itself.
  await expect(page.locator("#hidden-animation .kodex-animated-number-old")).toHaveCSS("visibility", "hidden");

  await page.locator("#hidden-pane").evaluate(element => { (element as HTMLElement).style.visibility = ""; });
  await page.locator("#hidden-animation").evaluate(element => { (element as HTMLElement).style.visibility = ""; });
  await expect(page.locator("#hidden-pane")).toHaveCSS("opacity", "1");
  await expect(page.locator("#hidden-animation .kodex-animated-number-old")).toHaveCSS("visibility", "visible");
});

test("a hidden mobile pane cannot paint its running duration over the selected pane", async ({ context }) => {
  const fixture = await nativeSettingsFixture(context);
  const startedAt = Math.floor(Date.now() / 1_000) - 10;
  fixture.detail.thread.status = "active";
  fixture.detail.liveState = "streaming";
  fixture.detail.timeline = {
    ...fixture.detail.timeline,
    activeTurnId: "turn-running",
    liveState: "streaming",
    turns: [{ id: "turn-running", status: "inProgress", startedAt }],
    rows: [{
      id: "work-running",
      kind: "work",
      turnId: "turn-running",
      status: "running",
      displayOrder: 1,
      work: { state: "running", startedAt, completedAt: null, errorMessage: null },
    }],
  };
  try {
    const page = await fixture.page("pane-visibility");
    await page.setViewportSize({ width: 390, height: 844 });
    const selectedPane = page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
    await expect(selectedPane.locator(".kodex-work-row")).toContainText(/Working for \d/);

    await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
    await page.getByRole("navigation", { name: "Workspace", exact: true })
      .getByRole("button", { name: "Chats", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(selectedPane.getByRole("textbox", { name: "Message composer", exact: true })).toBeVisible();
    await expect(selectedPane.locator(".kodex-work-row")).toHaveCount(0);

    const hiddenPane = page.locator('.dv-render-overlay[style*="visibility: hidden"]');
    await expect(hiddenPane.locator(".kodex-work-row")).toContainText(/Working for \d/);
    const outgoingDigit = hiddenPane.locator(".kodex-animated-number-old");
    await expect(outgoingDigit).toBeAttached({ timeout: 2_500 });
    await expect(outgoingDigit).toBeHidden();
  } finally {
    await fixture.close();
  }
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});
