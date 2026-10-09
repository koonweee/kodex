import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { GatewayRouter } from '../../../spikes/mastra-code-sdk/src/gateway-router';
import { pane, startBackend, stopBackend } from './fixtures/mastra';

// Chromium's touch emulation omits fine hover. A hybrid machine exposes both.
test.beforeEach(async ({ context }, testInfo) => {
  if (testInfo.project.name !== 'hybrid') return;
  await context.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = matchMedia(query);
      if (query === '(hover: hover) and (pointer: fine)') Object.defineProperty(result, 'matches', { value: true });
      return result;
    };
  });
});

test('native draft stays centered and explicit sidebar navigation survives reload and Back', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-native-navigation-'));
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  const errors: string[] = [], legacy: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) legacy.push(request.url()); });
  try {
    backend = await startBackend(root);
    await page.goto('/');
    await expect(pane(page).getByLabel('Message composer', { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const frame = await pane(page).boundingBox(), composer = await pane(page).locator('.kodex-composer-shell').boundingBox();
      return frame && composer ? Math.abs(composer.y + composer.height / 2 - frame.y - frame.height / 2) : Infinity;
    }).toBeLessThan(12);
    await page.screenshot({ path: testInfo.outputPath('native-centered-draft.png'), fullPage: true, animations: 'disabled' });
    const api: RouterClient<GatewayRouter> = createORPCClient(new RPCLink({ url: 'http://127.0.0.1:18789/rpc' }));
    const chat = await api.createChat({ projectId: (await api.listChats()).projects[0]!.id });
    await page.goto(`/threads/${chat.id}`);
    await expect(pane(page).getByLabel('Message composer', { exact: true })).toBeVisible();
    if (await page.getByRole('button', { name: 'Show sidebar', exact: true }).isVisible()) {
      await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/threads/${chat.id}\\?panel=threads$`));
      await page.reload();
      await expect(page.getByRole('button', { name: 'Show thread', exact: true })).toBeVisible();
      await expect(pane(page)).toBeHidden();
      await page.getByRole('button', { name: 'Show thread', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/threads/${chat.id}$`));
      await expect(pane(page)).toBeVisible();
      await page.goBack();
      await expect(page.getByRole('button', { name: 'Show thread', exact: true })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/threads/${chat.id}\\?panel=threads$`));
      await page.goForward();
      await expect(pane(page)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/threads/${chat.id}$`));
    }
    expect(errors).toEqual([]); expect(legacy).toEqual([]);
  } finally {
    await context.close().catch(() => {});
    if (backend) await stopBackend(backend);
    await rm(root, { recursive: true, force: true });
  }
});


test('native composer preserves editing through pane resize and touch expansion', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-native-responsive-'));
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  const errors: string[] = [], legacy: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) legacy.push(request.url()); });
  try {
    backend = await startBackend(root);
    await page.goto('/');
    const composer = pane(page).getByLabel('Message composer', { exact: true });
    await expect(composer).toBeVisible();
    await composer.fill('Keep this draft while resizing');
    await composer.focus();
    await composer.evaluate(node => node.setSelectionRange(5, 9));
    const original = await composer.elementHandle();
    for (const width of [390, 1280, 600]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(composer).toHaveValue('Keep this draft while resizing');
      await expect(composer).toBeFocused();
      expect(await composer.evaluate((node, previous) => node === previous, original)).toBe(true);
      expect(await composer.evaluate(node => [node.selectionStart, node.selectionEnd])).toEqual([5, 9]);
      await expect(page.getByRole('button', { name: 'Collapse composer', exact: true })).toBeHidden();
    }
    if (testInfo.project.use.hasTouch) {
      await composer.tap();
      const collapse = page.getByRole('button', { name: 'Collapse composer', exact: true });
      await expect(collapse).toBeVisible();
      await page.setViewportSize({ width: 1280, height: 844 });
      await expect(collapse).toBeVisible();
      await expect(composer).toHaveValue('Keep this draft while resizing');
      expect(await composer.evaluate((node, previous) => node === previous, original)).toBe(true);
      await collapse.click();
      await expect(collapse).toBeHidden();
      await expect(composer).toHaveValue('Keep this draft while resizing');
    }
    expect(errors).toEqual([]); expect(legacy).toEqual([]);
  } finally {
    await context.close().catch(() => {});
    if (backend) await stopBackend(backend);
    await rm(root, { recursive: true, force: true });
  }
});
