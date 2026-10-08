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
const targetRow = (page: Page) => page.locator('.kodex-thread-list-button[data-pinned="true"]').filter({ has: page.getByRole('button', { name: 'Read target', exact: true }) }).first();
const unread = (page: Page) => targetRow(page).getByRole('img', { name: 'Unread completed agent turn', exact: true });

test('native read heads converge across tabs and stale acknowledgments cannot consume newer work', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-native-read-browser-'));
  let backend = await startBackend(root);
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
    await api.renameChat({ chatId: target.id, title: 'Read target' });
    await api.setChatPinned({ chatId: target.id, pinned: true });
    await page.goto(`/threads/${idle.id}`); await showSidebar(page);
    const peer = await context.newPage(); await peer.goto(`/threads/${idle.id}`); await showSidebar(peer);
    for (const tab of [page, peer]) { await expect(targetRow(tab)).toBeVisible(); await expect(unread(tab)).toHaveCount(0); }
    await api.send({ chatId: target.id, text: 'READ_FIRST' });
    for (const tab of [page, peer]) await expect(unread(tab)).toBeVisible();
    const first = (await api.listChats()).chats.find(chat => chat.id === target.id)!.readState;
    expect(first.head?.reason).toBe('complete'); expect(first.seen).toBe(false);
    const staleReceipt = { chatId: target.id, epoch: first.epoch, revision: first.revision, runId: first.head!.runId };
    await page.screenshot({ path: testInfo.outputPath('native-unread-sidebar.png'), fullPage: true, animations: 'disabled' });
    await peer.goto(`/threads/${target.id}`);
    await expect(pane(peer).getByText('fixture:READ_FIRST', { exact: true })).toBeVisible();
    await expect.poll(async () => (await api.listChats()).chats.find(chat => chat.id === target.id)?.readState.seen).toBe(true);
    await expect(unread(page)).toHaveCount(0);
    await page.reload(); await showSidebar(page); await expect(unread(page)).toHaveCount(0);
    await peer.goto(`/threads/${idle.id}`); await showSidebar(peer);
    // Desktop can retain both panes side by side; close the target before
    // asserting that the next completion was not visible to either client.
    for (const tab of [page, peer]) {
      const targetTab = tab.getByTestId('dockview-dv-default-tab').filter({ hasText: 'Read target' });
      if (await targetTab.isVisible()) await targetTab.locator('.dv-default-tab-action').click();
      await expect(tab.locator(`.kodex-thread-pane[data-thread-id="${target.id}"]`)).toBeHidden();
    }
    await api.send({ chatId: target.id, text: 'READ_SECOND' });
    for (const tab of [page, peer]) await expect(unread(tab)).toBeVisible();
    const second = (await api.listChats()).chats.find(chat => chat.id === target.id)!.readState;
    expect(second.head?.runId).not.toBe(first.head?.runId);
    const rejected = await api.markChatSeen(staleReceipt);
    expect(rejected.outcome).toBe('conflict'); expect(rejected.state).toEqual(second);
    for (const tab of [page, peer]) await expect(unread(tab)).toBeVisible();
    // Close clients before restarting the disposable backend. Saved history
    // survives, but volatile completion/read knowledge intentionally does not.
    await page.close(); await peer.close(); await stopBackend(backend);
    backend = await startBackend(root);
    const restarted = (await api.listChats()).chats.find(chat => chat.id === target.id)!.readState;
    expect(restarted.epoch).not.toBe(second.epoch); expect(restarted.head).toBeNull(); expect(restarted.seen).toBeNull();
    const cold = await context.newPage(); await cold.goto(`/threads/${target.id}`);
    await expect(pane(cold).getByText('fixture:READ_SECOND', { exact: true })).toBeVisible();
    await showSidebar(cold); await expect(unread(cold)).toHaveCount(0);
    expect((await api.openChat({ chatId: target.id })).readState).toEqual(restarted);
    expect(errors).toEqual([]); expect(legacy).toEqual([]);
  } finally { await context.close(); await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
