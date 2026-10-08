import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { GatewayRouter } from '../../../spikes/mastra-code-sdk/src/gateway-router';
import { pane, startBackend, stopBackend } from './fixtures/mastra';

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
    if (testInfo.project.name !== 'chromium') {
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
