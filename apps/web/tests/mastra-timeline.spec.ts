import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { GatewayRouter } from '../../../spikes/mastra-code-sdk/src/gateway-router';
import { pane, startBackend, stopBackend } from './fixtures/mastra';

test('native saved tool groups and debug payloads remain inspectable across peers and reload', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-timeline-browser-'));
  const backend = await startBackend(root);
  const api: RouterClient<GatewayRouter> = createORPCClient(new RPCLink({ url: 'http://127.0.0.1:18789/rpc' }));
  const errors: string[] = [], legacy: string[] = [];
  const observe = (tab: Page) => {
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  };
  observe(page); context.on('page', observe);
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) legacy.push(request.url()); });
  try {
    const project = (await api.listChats()).projects[0]!;
    const chat = await api.createChat({ projectId: project.id });
    await api.renameChat({ chatId: chat.id, title: 'Timeline debug' });
    const peer = await context.newPage();
    for (const tab of [page, peer]) await tab.goto(`/threads/${chat.id}`);
    await api.send({ chatId: chat.id, text: 'RUN_SHELL_FAILURE' });
    for (const tab of [page, peer]) {
      await expect(pane(tab).getByText('fixture:RUN_SHELL_FAILURE', { exact: true })).toBeVisible();
      const group = pane(tab).locator('.kodex-activity-group');
      await expect(group).toHaveCount(1);
      await expect(group).not.toHaveAttribute('open', '');
      await group.locator(':scope > summary').click();
      await group.locator('.kodex-activity-item > summary').click();
      await expect(group.locator('.kodex-timeline-output')).toBeVisible();
    }
    await peer.reload();
    const group = pane(peer).locator('.kodex-activity-group');
    await expect(group).toHaveCount(1);
    await group.locator(':scope > summary').click();
    await group.locator('.kodex-activity-item > summary').click();
    await expect(group.locator('.kodex-timeline-output')).toBeVisible();
    const showSidebar = peer.getByRole('button', { name: 'Show sidebar', exact: true });
    const narrowSidebar = await showSidebar.isVisible();
    if (narrowSidebar) await showSidebar.click();
    await peer.getByRole('button', { name: 'Account settings', exact: true }).click();
    await peer.getByRole('menuitemcheckbox', { name: 'Show debug events', exact: true }).click();
    if (narrowSidebar) await peer.getByRole('button', { name: 'Timeline debug', exact: true }).click();
    const debug = group.locator('.kodex-timeline-debug').first();
    await debug.locator(':scope > summary').click();
    await expect(debug.locator('pre')).toContainText('execute_command');
    await expect(debug.locator('pre')).toContainText('NATIVE_SHELL_OUTPUT');
    await peer.screenshot({ path: testInfo.outputPath('native-tool-group-debug.png'), fullPage: true, animations: 'disabled' });
    expect(errors).toEqual([]); expect(legacy).toEqual([]);
  } finally { await context.close(); await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
