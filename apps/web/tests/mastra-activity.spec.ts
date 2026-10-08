import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { GatewayRouter } from '../../../spikes/mastra-code-sdk/src/gateway-router';
import { pane, startBackend, stopBackend } from './fixtures/mastra';

async function showSidebar(page: Page) {
  await expect(page.locator('.kodex-shell')).toBeVisible();
  const button = page.getByRole('button', { name: 'Show sidebar', exact: true });
  if (await button.isVisible()) await button.click();
}
function row(page: Page, name: string) {
  return page.locator('.kodex-thread-list-button[data-pinned="true"]').filter({ has: page.getByRole('button', { name, exact: true }) }).first();
}
const running = (target: ReturnType<typeof row>) => target.getByRole('status', { name: 'Thread in progress', exact: true });

test('native activity reaches unopened sidebar chats and peer pane tabs, then clears after Stop', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-activity-browser-'));
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
    const target = await api.createChat({ projectId: project.id }), idle = await api.createChat({ projectId: project.id });
    await api.renameChat({ chatId: target.id, title: 'Activity target' });
    await api.renameChat({ chatId: idle.id, title: 'Idle peer' });
    for (const chat of [target, idle]) await api.setChatPinned({ chatId: chat.id, pinned: true });
    await page.goto('/'); await showSidebar(page);
    await expect(row(page, 'Activity target')).toBeVisible();
    await expect(running(row(page, 'Activity target'))).toHaveCount(0);
    const peer = await context.newPage(); await peer.goto(`/threads/${target.id}`);
    await expect(pane(peer)).toHaveAttribute('aria-label', 'Activity target');
    await expect(page.locator(`.kodex-thread-pane[data-thread-id="${target.id}"]`)).toHaveCount(0);
    await api.send({ chatId: target.id, text: 'HOLD_STOP' });
    await expect(pane(peer).getByText('started:HOLD_STOP', { exact: true })).toBeVisible();
    await expect(running(row(page, 'Activity target'))).toBeVisible();
    await expect(running(row(page, 'Idle peer'))).toHaveCount(0);
    const targetTab = peer.locator('.kodex-workspace-tab').filter({ hasText: 'Activity target' }).first();
    if (testInfo.project.name === 'chromium') await expect(running(targetTab)).toBeVisible();
    await page.reload(); await showSidebar(page);
    await expect(running(row(page, 'Activity target'))).toBeVisible();
    await expect(running(row(page, 'Idle peer'))).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('native-sidebar-activity.png'), fullPage: true, animations: 'disabled' });
    if (testInfo.project.name === 'chromium') await peer.screenshot({ path: testInfo.outputPath('native-tab-activity.png'), fullPage: true, animations: 'disabled' });
    await pane(peer).getByRole('button', { name: 'Stop turn', exact: true }).click();
    await expect(running(row(page, 'Activity target'))).toHaveCount(0);
    await expect(pane(peer).getByRole('button', { name: 'Stop turn', exact: true })).toHaveCount(0);
    if (testInfo.project.name === 'chromium') await expect(running(targetTab)).toHaveCount(0);
    await expect.poll(async () => (await api.listChats()).chats.find(chat => chat.id === target.id)?.isRunning).toBe(false);
    await page.reload(); await showSidebar(page);
    await expect(running(row(page, 'Activity target'))).toHaveCount(0);
    expect(errors).toEqual([]); expect(legacy).toEqual([]);
  } finally { await context.close(); await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
