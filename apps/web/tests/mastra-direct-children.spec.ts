import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { GatewayRouter } from '../../../spikes/mastra-code-sdk/src/gateway-router';
import { pane, send, startBackend, stopBackend } from './fixtures/mastra';

async function showSidebar(page: Page) {
  await expect(page.locator('.kodex-shell')).toBeVisible();
  const button = page.getByRole('button', { name: 'Show sidebar', exact: true });
  if (await button.isVisible()) await button.click();
}
const pinnedRows = (page: Page) => page.getByRole('group', { name: 'Pinned', exact: true }).locator('.kodex-thread-list-button');
async function pinnedOrder(page: Page, titles: string[]) {
  await showSidebar(page);
  await expect(pinnedRows(page)).toHaveCount(titles.length);
  for (const [index, title] of titles.entries()) await expect(pinnedRows(page).nth(index).getByRole('button', { name: title, exact: true })).toBeVisible();
}
async function selectPinned(page: Page, title: string, id: string) {
  await showSidebar(page);
  await page.getByRole('group', { name: 'Pinned', exact: true }).getByRole('button', { name: title, exact: true }).click();
  await expect(pane(page)).toHaveAttribute('data-thread-id', id);
  await expect(pane(page).getByLabel('Message composer', { exact: true })).toBeEnabled();
}
async function rename(page: Page, title: string) {
  const showThread = page.getByRole('button', { name: 'Show thread', exact: true });
  if (await showThread.isVisible()) await showThread.click();
  await page.locator('.dv-groupview.dv-active-group:visible, .kodex-workspace-single-pane-header:visible').getByRole('button', { name: 'Thread actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename thread', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename thread', exact: true });
  await dialog.getByRole('textbox', { name: 'Thread name', exact: true }).fill(title);
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test('native child and fork direct routes retain editable history, shared pins and subtree archive across tabs', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-direct-children-browser-'));
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
    await api.updateProject({ projectId: project.id, patch: { name: 'Descendant workspace' } });
    const parent = await api.createChat({ projectId: project.id });
    await api.renameChat({ chatId: parent.id, title: 'Delegation parent' });
    await page.goto(`/threads/${parent.id}`); await send(page, 'BROWSER_DELEGATE');
    await expect(pane(page).getByText('BROWSER_DELEGATED_PARENT_RESULT', { exact: true })).toBeVisible();
    await expect.poll(async () => (await api.listSubagents({ chatId: parent.id })).children.length).toBe(1);
    const child = (await api.listSubagents({ chatId: parent.id })).children[0]!;
    await api.renameChat({ chatId: child.id, title: 'Direct child' });
    await page.goto(`/threads/${child.id}`);
    await expect(pane(page)).toHaveAttribute('aria-label', 'Direct child');
    await showSidebar(page);
    await expect(page.getByRole('group', { name: 'Descendant workspace', exact: true }).getByRole('button', { name: 'New thread', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create thread in Descendant workspace', exact: true })).toHaveCount(0);
    expect((await api.listChats()).pinnedDescendants).toEqual([]);
    await api.setChatPinned({ chatId: parent.id, pinned: true });
    await api.setChatPinned({ chatId: child.id, pinned: true });

    const forkParent = await api.createChat({ projectId: project.id });
    await api.renameChat({ chatId: forkParent.id, title: 'Fork parent' });
    await page.goto(`/threads/${forkParent.id}`); await send(page, 'BROWSER_PARENT_FORKED');
    await expect(pane(page).getByText('BROWSER_PARENT_RESULT_FORKED', { exact: true })).toBeVisible();
    await expect.poll(async () => (await api.listSubagents({ chatId: forkParent.id })).forks.length).toBe(1);
    const fork = (await api.listSubagents({ chatId: forkParent.id })).forks[0]!;
    await api.renameChat({ chatId: fork.id, title: 'Direct fork' });
    await api.setChatPinned({ chatId: fork.id, pinned: true, beforeChatId: child.id });

    const childUrl = `/threads/${encodeURIComponent(child.id)}`;
    await page.goto(childUrl);
    const peer = await context.newPage(); await peer.goto(childUrl);
    for (const tab of [page, peer]) {
      await expect(pane(tab)).toHaveAttribute('aria-label', 'Direct child');
      await expect(pane(tab).getByText('BROWSER_FRESH_RESULT', { exact: true })).toBeVisible();
      await expect(pane(tab).getByLabel('Message composer', { exact: true })).toBeEnabled();
      await expect(pane(tab).locator('.kodex-thread-pane-status').getByRole('alert')).toHaveCount(0);
    }
    await send(page, 'DIRECT_CHILD_FOLLOWUP: inspect the saved evidence');
    for (const tab of [page, peer]) await expect(pane(tab).getByText('DIRECT_NATIVE_RESULT:DIRECT_CHILD_FOLLOWUP: inspect the saved evidence', { exact: true })).toBeVisible();
    await rename(peer, 'Child renamed across tabs');
    for (const tab of [page, peer]) await expect(pane(tab)).toHaveAttribute('aria-label', 'Child renamed across tabs');
    await peer.reload();
    await expect(pane(peer).getByText('BROWSER_FRESH_RESULT', { exact: true })).toBeVisible();
    await expect(pane(peer).getByText('DIRECT_NATIVE_RESULT:DIRECT_CHILD_FOLLOWUP: inspect the saved evidence', { exact: true })).toBeVisible();
    await expect(pane(peer).locator('.kodex-thread-pane-status').getByRole('alert')).toHaveCount(0);
    await pinnedOrder(page, ['Delegation parent', 'Direct fork', 'Child renamed across tabs']);
    await pinnedOrder(peer, ['Delegation parent', 'Direct fork', 'Child renamed across tabs']);
    const moving = pinnedRows(page).last();
    if (!testInfo.project.use.hasTouch) await moving.hover();
    await moving.getByRole('button', { name: 'Thread actions for Child renamed across tabs', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
    for (const tab of [page, peer]) await pinnedOrder(tab, ['Delegation parent', 'Child renamed across tabs', 'Direct fork']);
    await peer.screenshot({ path: testInfo.outputPath('native-direct-child-pins.png'), fullPage: true, animations: 'disabled' });

    await selectPinned(page, 'Direct fork', fork.id);
    await selectPinned(peer, 'Direct fork', fork.id);
    for (const tab of [page, peer]) {
      await expect(pane(tab).getByText('BROWSER_CHILD_RESULT_FORKED', { exact: true })).toBeVisible();
      await expect(pane(tab).locator('.kodex-thread-pane-status').getByRole('alert')).toHaveCount(0);
    }
    await send(peer, 'DIRECT_FORK_FOLLOWUP: retain the fork history');
    for (const tab of [page, peer]) await expect(pane(tab).getByText('DIRECT_NATIVE_RESULT:DIRECT_FORK_FOLLOWUP: retain the fork history', { exact: true })).toBeVisible();
    await page.reload();
    await expect(pane(page)).toHaveAttribute('data-thread-id', fork.id);
    await expect(pane(page).getByText('DIRECT_NATIVE_RESULT:DIRECT_FORK_FOLLOWUP: retain the fork history', { exact: true })).toBeVisible();
    await expect(pane(page).locator('.kodex-thread-pane-status').getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('native-direct-fork.png'), fullPage: true, animations: 'disabled' });
    await selectPinned(page, 'Child renamed across tabs', child.id);
    await send(page, 'HOLD_STOP');
    await expect(pane(page).getByRole('button', { name: 'Stop turn', exact: true })).toBeVisible();
    for (const tab of [page, peer]) {
      await showSidebar(tab);
      await expect(pinnedRows(tab).filter({ hasText: 'Child renamed across tabs' }).getByRole('status', { name: 'Thread in progress', exact: true })).toBeVisible();
      await expect(pinnedRows(tab).filter({ hasText: 'Direct fork' }).getByRole('status', { name: 'Thread in progress', exact: true })).toHaveCount(0);
      const showThread = tab.getByRole('button', { name: 'Show thread', exact: true });
      if (await showThread.isVisible()) await showThread.click();
    }
    await api.archiveChat({ chatId: parent.id });
    await expect(page.locator(`.kodex-thread-pane[data-thread-id="${child.id}"]`)).toHaveCount(0);
    await expect.poll(async () => (await api.listChats()).archivedChatIds.includes(child.id)).toBe(true);
    await expect(pane(peer)).toHaveAttribute('data-thread-id', fork.id);
    await expect(pane(peer).getByText('DIRECT_NATIVE_RESULT:DIRECT_FORK_FOLLOWUP: retain the fork history', { exact: true })).toBeVisible();
    await api.archiveChat({ chatId: forkParent.id });
    await expect(peer.locator(`.kodex-thread-pane[data-thread-id="${fork.id}"]`)).toHaveCount(0);
    for (const tab of [page, peer]) { await showSidebar(tab); await expect(pinnedRows(tab)).toHaveCount(0); }
    expect(errors).toEqual([]); expect(legacy).toEqual([]);
  } catch (failure) {
    await testInfo.attach('direct-child-diagnostics', { body: JSON.stringify({ errors, legacy, tabs: await Promise.all(context.pages().map(tab => tab.locator('body').innerText().catch(() => 'Unavailable'))) }), contentType: 'application/json' });
    throw failure;
  } finally { await context.close(); await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
