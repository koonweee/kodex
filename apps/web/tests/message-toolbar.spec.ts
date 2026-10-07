import { expect, test, type Page } from "@playwright/test";

async function mountMessages(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/message-toolbar-test", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
      <div id="root" style="padding:24px"></div>
      <script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => type => type;
        window.__vite_plugin_react_preamble_installed__ = true;
        const { default: React } = await import('/node_modules/.vite/deps/react.js');
        const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
        const source = await (await fetch('/src/timeline/messageRenderers.tsx')).text();
        const mantineUrl = source.match(/from "([^"]*@mantine_core[^"]*)"/)[1];
        const { MantineProvider } = await import(mantineUrl);
        await import('/node_modules/@mantine/core/styles.css');
        await import('/src/styles/base.css');
        await import('/src/styles/ui.css');
        await import('/src/styles/mantine-theme.css');
        await import('/src/styles/timeline-messages.css');
        const { applyKodexColorScheme, getKodexColorScheme, createKodexMantineTheme } = await import('/src/theme.ts');
        const scheme = getKodexColorScheme('oled-black');
        applyKodexColorScheme(document.documentElement, scheme);
        for (const [name, value] of Object.entries(scheme.rootVariables)) document.documentElement.style.setProperty(name, value);
        const theme = createKodexMantineTheme(scheme);
        const { UserMessageBubble, AssistantMessageMarkdown } = await import('/src/timeline/messageRenderers.tsx');
        const item = (id, text, kind = 'user_message') => ({
          id, text, kind, status: 'completed', turnId: 'turn', displayOrder: 1, payload: {}, debugEvents: [],
        });
        createRoot(document.getElementById('root')).render(
          React.createElement(MantineProvider, { theme, forceColorScheme: scheme.mode },
            React.createElement('div', { style: { display: 'grid', gap: '16px' } },
              React.createElement(UserMessageBubble, {
                imagePreviewUrlsByPath: {}, item: item('user', 'First question'), toolbarTimestampMs: Date.now(),
              }),
              React.createElement(AssistantMessageMarkdown, {
                item: { ...item('answer', 'Assistant answer', 'assistant_message'), messagePhase: 'final_answer' },
                text: 'Assistant answer', toolbarTimestampMs: Date.now(),
              }),
              React.createElement('button', { id: 'outside' }, 'Outside message')
            )
          )
        );
      </script>
    </body></html>`,
  }));
  await page.goto("/message-toolbar-test");
  await expect(page.getByText("Assistant answer", { exact: true })).toBeVisible();
  return errors;
}

for (const width of [1280, 390]) {
  test.describe(`fine pointer at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } });

    test("reveals only the hovered message toolbar while keeping space reserved", async ({ page }, testInfo) => {
      const errors = await mountMessages(page);
      const rows = page.locator(".kodex-user-message-row, .kodex-assistant-message-stack");
      const toolbars = page.locator(".kodex-message-toolbar");
      for (const toolbar of await toolbars.all()) await expect(toolbar).toHaveCSS("opacity", "0");
      const bounds = async () => rows.evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }));
      const before = await bounds();
      await page.screenshot({ path: testInfo.outputPath("hidden.png") });
      for (const [index, text] of ["First question", "Assistant answer"].entries()) {
        const toolbar = toolbars.nth(index);
        const toolbarBefore = await toolbar.boundingBox();
        await rows.nth(index).getByText(text, { exact: true }).hover();
        await expect(toolbar).toHaveCSS("opacity", "1");
        await expect(toolbars.nth(1 - index)).toHaveCSS("opacity", "0");
        await toolbar.hover();
        await expect(toolbar).toHaveCSS("opacity", "1");
        expect(await toolbar.boundingBox()).toEqual(toolbarBefore);
        expect(await bounds()).toEqual(before);
        await page.screenshot({ path: testInfo.outputPath(`hovered-${index}.png`) });
        await page.mouse.move(0, 0);
        await expect(toolbar).toHaveCSS("opacity", "0");
        await rows.nth(index).hover({ position: { x: 4, y: 4 } });
        await expect(toolbar).toHaveCSS("opacity", "1");
        await page.mouse.move(0, 0);
      }
      expect(errors).toEqual([]);
    });

    test("keyboard focus reveals user and assistant toolbars and copy remains usable", async ({ page }) => {
      const errors = await mountMessages(page);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      const rows = page.locator(".kodex-user-message-row, .kodex-assistant-message-stack");
      for (const [index, text] of ["First question", "Assistant answer"].entries()) {
        const row = rows.nth(index);
        await page.keyboard.press("Tab");
        await expect(row.getByRole("button", { name: "Copy message" })).toBeFocused();
        await expect(row.locator(".kodex-message-toolbar")).toHaveCSS("opacity", "1");
        await page.keyboard.press("Enter");
        await expect(row.getByRole("button", { name: "Copied message" })).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
      }
      await page.locator("#outside").focus();
      for (const toolbar of await page.locator(".kodex-message-toolbar").all()) {
        await expect(toolbar).toHaveCSS("opacity", "0");
      }
      expect(errors).toEqual([]);
    });
  });
}

test("hybrid touch plus fine hover can reveal and copy a message", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "maxTouchPoints", { get: () => 1 }));
  const errors = await mountMessages(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  expect(await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches)).toBe(true);
  const row = page.locator(".kodex-user-message-row");
  const toolbar = row.locator(".kodex-message-toolbar");
  await expect(toolbar).toHaveCSS("opacity", "0");
  const session = await page.context().newCDPSession(page);
  const tap = async (selector: string) => {
    const bounds = await page.locator(selector).boundingBox();
    expect(bounds).not.toBeNull();
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 }],
    });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await tap(".kodex-user-message-bubble");
  await expect(toolbar).toHaveCSS("opacity", "1");
  await tap(".kodex-user-message-row .kodex-message-copy-button");
  await expect(row.getByRole("button", { name: "Copied message" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("First question");
  await session.detach();
  expect(errors).toEqual([]);
});

test.describe("touch without hover", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("keeps both message toolbars visible and usable without hover", async ({ page }) => {
    const errors = await mountMessages(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const rows = page.locator(".kodex-user-message-row, .kodex-assistant-message-stack");
    for (const row of await rows.all()) {
      await expect(row.locator(".kodex-message-toolbar")).toHaveCSS("opacity", "1");
      await expect(row.getByLabel(/^Message timestamp/)).toBeVisible();
      await row.getByRole("button", { name: "Copy message" }).tap();
      await expect(row.getByRole("button", { name: "Copied message" })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
});
