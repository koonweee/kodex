import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBackend, stopBackend } from './fixtures/mastra';

const terminal = (page: Page) => page.getByRole('region', { name: 'Terminal pane', exact: true });
async function command(page: Page, text: string) {
  const screen = terminal(page).locator('.xterm-screen');
  if (test.info().project.use.hasTouch) await screen.tap(); else await screen.click();
  await expect(terminal(page).getByRole('textbox', { name: 'Terminal input', exact: true })).toBeFocused();
  await page.keyboard.type(text); await page.keyboard.press('Enter');
}

test('main terminal UI shares a real shell across tabs, reload and resize until Stop', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-terminal-'));
  const backend = await startBackend(root);
  const errors: string[] = [], legacy: string[] = [];
  const output = new Map<Page, string>();
  const sizes = new Map<Page, { rows: number; cols: number }>();
  const observe = (tab: Page) => {
    output.set(tab, '');
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    tab.on('websocket', socket => {
      if (!socket.url().includes('/v1/terminals/')) return;
      socket.on('framereceived', event => output.set(tab, (output.get(tab) ?? '') + event.payload.toString()));
      socket.on('framesent', event => {
        const bytes = Buffer.isBuffer(event.payload) ? event.payload : Buffer.from(event.payload);
        if (bytes.at(-1) === 255) sizes.set(tab, JSON.parse(bytes.subarray(0, -1).toString()));
      });
    });
  };
  observe(page); context.on('page', observe);
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) legacy.push(request.url()); });
  try {
    await page.goto('/'); await expect(page.locator('.kodex-shell')).toBeVisible();
    const showSidebar = page.getByRole('button', { name: 'Show sidebar', exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();
    await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(terminal(page)).toBeVisible();
    await command(page, "stty -echo; KODEX_PROOF=retained; printf 'NATIVE-%s:%s:%s\\n' 'PID' \"$$\" \"$KODEX_PROOF\"");
    await expect.poll(() => output.get(page)).toMatch(/NATIVE-PID:\d+:retained/);
    const pid = /NATIVE-PID:(\d+):retained/.exec(output.get(page)!)![1];
    const peer = await context.newPage(); await peer.goto(page.url());
    await expect(terminal(peer)).toBeVisible();
    await expect.poll(() => output.get(peer)).toContain(`NATIVE-PID:${pid}:retained`);
    await command(peer, "printf 'NATIVE-%s:%s:%s\\n' 'PEER' \"$$\" \"$KODEX_PROOF\"");
    for (const tab of [page, peer]) await expect.poll(() => output.get(tab)).toContain(`NATIVE-PEER:${pid}:retained`);
    await expect.poll(() => sizes.has(page)).toBe(true);
    const oldSize = sizes.get(page);
    await page.setViewportSize({ width: testInfo.project.name === 'chromium' ? 1000 : 500, height: 700 });
    await expect.poll(() => sizes.get(page)).not.toEqual(oldSize);
    const size = sizes.get(page)!;
    await command(page, "printf 'NATIVE-%s:' 'SIZE'; stty size");
    await expect.poll(() => output.get(page)).toContain(`NATIVE-SIZE:${size.rows} ${size.cols}`);
    await page.reload(); await expect(terminal(page)).toBeVisible();
    await command(page, "printf 'NATIVE-%s:%s:%s\\n' 'RELOAD' \"$$\" \"$KODEX_PROOF\"");
    await expect.poll(() => output.get(page)).toContain(`NATIVE-RELOAD:${pid}:retained`);
    await expect(terminal(page).locator('.xterm-rows')).toContainText(`NATIVE-RELOAD:${pid}:retained`);
    await page.screenshot({ path: testInfo.outputPath('native-terminal-retained.png'), fullPage: true });
    await peer.getByRole('button', { name: 'Stop terminal', exact: true }).click();
    await expect(terminal(page).getByText('Terminal connection closed.', { exact: true })).toBeVisible();
    await expect(peer.getByRole('button', { name: 'Stop terminal', exact: true })).toHaveCount(0);
    expect(legacy).toEqual([]); expect(errors).toEqual([]);
  } finally { await context.close(); await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
