import { expect, test, type Page } from "@playwright/test";

test("live pane updates preserve only the current row-owned selection", async ({ page }) => {
  await page.route("**/text-selection-preservation-test", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { useTextSelectionPreservation } = await import('/src/shared/useTextSelectionPreservation.ts');
      const root = createRoot(document.getElementById('root'));
      function Pane({ id, prefix, revision }) {
        const ref = React.useRef(null);
        useTextSelectionPreservation(ref, revision);
        return React.createElement('section', { ref, 'data-pane': id, 'data-executor-id': id },
          prefix ? React.createElement('div', { 'data-row-key': id + '-prefix' }, 'Inserted before the selected row.') : null,
          React.createElement('div', { key: revision, 'data-row-key': id + '-answer' }, 'Alpha selected suffix omega'));
      }
      window.renderState = (firstPrefix = false, firstRevision = 0) => root.render(
        React.createElement(React.Fragment, null,
          React.createElement(Pane, { id: 'executor-a', prefix: firstPrefix, revision: firstRevision }),
          React.createElement(Pane, { id: 'executor-b', prefix: false, revision: 0 })));
      window.renderState();
    </script></body></html>`,
  }));
  await page.goto("/text-selection-preservation-test");
  await page.waitForFunction(() => typeof Reflect.get(window, "renderState") === "function");
  await expect(page.locator('[data-row-key="executor-a-answer"]')).toBeAttached();
  await expect(page.locator('[data-row-key="executor-b-answer"]')).toBeAttached();

  const originalFirstRow = await page.locator('[data-row-key="executor-a-answer"]').elementHandle();
  await selectSuffix(page, "executor-a");
  await page.evaluate(() => Reflect.get(window, "renderState")(true, 1));
  await expect.poll(async () => await originalFirstRow?.evaluate((row) => row.isConnected)).toBe(false);
  await expect.poll(() => selectedText(page)).toBe("selected suffix");
  await expect.poll(() => selectedPane(page)).toBe("executor-a");

  await selectSuffix(page, "executor-b");
  await page.evaluate(() => Reflect.get(window, "renderState")(false, 2));
  await expect.poll(() => selectedText(page)).toBe("selected suffix");
  await expect.poll(() => selectedPane(page)).toBe("executor-b");

  await selectSuffix(page, "executor-a");
  await page.keyboard.press("ArrowRight");
  await page.evaluate(() => {
    window.getSelection()?.collapseToEnd();
    document.dispatchEvent(new Event("selectionchange"));
    Reflect.get(window, "renderState")(true, 3);
  });
  await expect.poll(() => selectedText(page)).toBe("");
});

async function selectSuffix(page: Page, pane: string) {
  await page.evaluate((paneId) => {
    const node = document.querySelector(`[data-row-key="${paneId}-answer"]`)!.firstChild!;
    const range = document.createRange();
    range.setStart(node, 6);
    range.setEnd(node, 21);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, pane);
}

async function selectedText(page: Page) {
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

async function selectedPane(page: Page) {
  return page.evaluate(() => (window.getSelection()?.anchorNode?.parentElement?.closest("[data-pane]") as HTMLElement | null)?.dataset.pane ?? null);
}
