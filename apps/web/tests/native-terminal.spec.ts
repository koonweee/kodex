import { expect, test, type Locator, type Page } from "@playwright/test";

import { nativeTerminalEnabled, nativeTerminalFixture } from "./native-terminal.fixture";

// Full Chromium supplies the production service worker's BadgeService;
// Playwright's separate headless shell does not implement that binding.
test.use({ channel: "chromium" });

test.describe("real native gateway terminals", () => {
  test.skip(!nativeTerminalEnabled, "requires KODEX_TEST_GATEWAY_BINARY, KODEX_TEST_CODEX_BINARY and a current production web build");
  test.describe.configure({ mode: "serial" });

  for (const shape of [
    { name: "desktop", width: 1280, hasTouch: false, isMobile: false },
    { name: "narrow fine pointer", width: 390, hasTouch: false, isMobile: false },
    { name: "narrow touch", width: 390, hasTouch: true, isMobile: true },
  ]) {
    test.describe(shape.name, () => {
      test.use({ viewport: { width: shape.width, height: 844 }, hasTouch: shape.hasTouch, isMobile: shape.isMobile });

      test("two tabs retain one real shell across resize, disconnect, reload and view close until explicit Stop", async ({ context }, testInfo) => {
        test.setTimeout(90_000);
        const fixture = await nativeTerminalFixture(context);
        try {
          const first = await fixture.page();
          await expect(first.getByRole("button", { name: "Esc", exact: true })).toHaveCount(shape.hasTouch ? 1 : 0);
          await command(first, "KODEX_PROOF_VALUE=retained; printf 'NATIVE-%s:%s:%s\\n' 'PID' \"$$\" \"$KODEX_PROOF_VALUE\"", shape.hasTouch);
          await expect.poll(() => fixture.output(first)).toMatch(/NATIVE-PID:\d+:retained/);
          const pid = /NATIVE-PID:(\d+):retained/.exec(fixture.output(first))![1];
          await command(first, `test "$CODEX_HOME" = ${shellQuote(fixture.codexHome)} && test "$PWD" = ${shellQuote(fixture.workspace)} && printf 'NATIVE-%s\\n' 'HOME-OWNED'`, shape.hasTouch);
          await expect.poll(() => fixture.output(first)).toContain("NATIVE-HOME-OWNED");
          await expect(terminal(first).locator(".xterm-rows")).toContainText("NATIVE-HOME-OWNED");

          const second = await fixture.page();
          await expect.poll(() => fixture.output(second)).toContain(`NATIVE-PID:${pid}:retained`);
          await command(second, "printf 'NATIVE-%s:%s:%s\\n' 'SECOND' \"$$\" \"$KODEX_PROOF_VALUE\"", shape.hasTouch);
          for (const page of [first, second]) await expect.poll(() => fixture.output(page)).toContain(`NATIVE-SECOND:${pid}:retained`);
          expect((await fixture.sessions()).map((session) => session.id)).toEqual([fixture.terminal.id]);

          // Real xterm resize frames must reach the PTY, not merely change CSS.
          const original = fixture.activeSocket(first)!.sizes.at(-1)!;
          await first.setViewportSize({ width: shape.width === 1280 ? 1000 : 500, height: 720 });
          await expect.poll(() => {
            const size = fixture.activeSocket(first)?.sizes.at(-1);
            return size && (size.cols !== original.cols || size.rows !== original.rows);
          }).toBe(true);
          const resized = fixture.activeSocket(first)!.sizes.at(-1)!;
          expect(resized.cols).toBeGreaterThan(0);
          expect(resized.rows).toBeGreaterThan(0);
          await command(first, "printf 'NATIVE-%s:' 'SIZE'; stty size", shape.hasTouch);
          await expect.poll(() => fixture.output(first)).toContain(`NATIVE-SIZE:${resized.rows} ${resized.cols}`);

          const oldSocket = fixture.activeSocket(first)!;
          const connections = fixture.sockets.get(first)!.length;
          await fixture.disconnect(first);
          await expect.poll(() => oldSocket.closed).toBe(true);
          await expect(terminal(first).getByText("Terminal connection closed.", { exact: true })).toBeVisible();
          await command(second, "printf 'NATIVE-%s:%s\\n' 'DETACHED' \"$KODEX_PROOF_VALUE\"", shape.hasTouch);
          await expect.poll(() => fixture.output(second)).toContain("NATIVE-DETACHED:retained");
          await activate(terminal(first).getByRole("button", { name: "Reconnect terminal", exact: true }), shape.hasTouch);
          await expect.poll(() => fixture.sockets.get(first)!.length).toBeGreaterThan(connections);
          await expect.poll(() => fixture.activeSocket(first)?.output).toContain("NATIVE-DETACHED:retained");
          expect((await fixture.sessions()).map((session) => session.id)).toEqual([fixture.terminal.id]);

          await first.reload();
          await expect(terminal(first)).toBeVisible();
          await expect.poll(() => fixture.activeSocket(first)?.sizes.length ?? 0).toBeGreaterThan(0);
          await command(first, "printf 'NATIVE-%s:%s:%s\\n' 'RELOAD' \"$$\" \"$KODEX_PROOF_VALUE\"", shape.hasTouch);
          await expect.poll(() => fixture.output(first)).toContain(`NATIVE-RELOAD:${pid}:retained`);
          await first.setViewportSize({ width: shape.width, height: 844 });

          // A tab-close action only detaches this view. The other real socket
          // remains attached, and ordinary Open terminal reuses gateway state.
          await closeTerminalView(first, shape.hasTouch);
          await expect(terminal(first)).toHaveCount(0);
          expect((await fixture.sessions()).map((session) => session.id)).toEqual([fixture.terminal.id]);
          await command(second, "printf 'NATIVE-%s:%s\\n' 'PANE-CLOSED' \"$KODEX_PROOF_VALUE\"", shape.hasTouch);
          await expect.poll(() => fixture.output(second)).toContain("NATIVE-PANE-CLOSED:retained");
          const showSidebar = first.getByRole("button", { name: "Show sidebar", exact: true });
          if (await showSidebar.isVisible()) await activate(showSidebar, shape.hasTouch);
          await activate(first.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: "Terminal", exact: true }), shape.hasTouch);
          await expect(terminal(first)).toBeVisible();
          await expect.poll(() => fixture.activeSocket(first)?.output).toContain("NATIVE-PANE-CLOSED:retained");
          expect(fixture.terminalRequests.filter((request) => ["POST", "DELETE"].includes(request.method))).toEqual([]);
          await first.screenshot({ path: testInfo.outputPath("real-terminal-retained.png"), fullPage: true });

          await activate(second.getByRole("button", { name: "Stop terminal", exact: true }), shape.hasTouch);
          await expect.poll(() => fixture.sessions()).toEqual([]);
          await expect(terminal(first).getByText("Terminal connection closed.", { exact: true })).toBeVisible();
          await expect(second.getByRole("button", { name: "Stop terminal", exact: true })).toHaveCount(0);
          expect(fixture.terminalRequests.filter((request) => request.method === "DELETE")).toEqual([
            { method: "DELETE", path: `/v1/terminals/${fixture.terminal.id}` },
          ]);
          expect(fixture.terminalRequests.filter((request) => request.method === "POST")).toEqual([]);
          await fixture.assertClean();
        } finally {
          await fixture.close();
        }
      });
    });
  }
});

function terminal(page: Page) {
  return page.getByRole("region", { name: "Terminal pane", exact: true });
}

async function activate(control: Locator, touch: boolean) {
  if (touch) await control.tap(); else await control.click();
}

async function command(page: Page, text: string, touch: boolean) {
  await activate(terminal(page).locator(".xterm-screen"), touch);
  const input = terminal(page).getByRole("textbox", { name: "Terminal input", exact: true });
  await expect(input).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

async function closeTerminalView(page: Page, touch: boolean) {
  const switchPane = page.getByRole("button", { name: "Switch workspace pane", exact: true });
  if (await switchPane.isVisible()) {
    await activate(switchPane, touch);
    await activate(page.getByRole("button", { name: "Close pane Native terminal proof", exact: true }), touch);
    const overlay = page.locator(".mantine-Drawer-overlay");
    if (await overlay.isVisible()) await activate(overlay, touch);
    return;
  }
  await activate(page.getByTestId("dockview-dv-default-tab").filter({ hasText: "Native terminal proof" }).locator(".dv-default-tab-action"), touch);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
