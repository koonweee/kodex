import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { GatewayRouter } from '../../../spikes/mastra-code-sdk/src/gateway-router';
import { pane, startBackend, stopBackend } from './fixtures/mastra';
import { observeNativeHistoryReads, setNativeMenuPreference } from './fixtures/mastra-preferences';

test('four native tool steps and commentary share one Worked section across peers and reload', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-four-work-'));
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  const api: RouterClient<GatewayRouter> = createORPCClient(new RPCLink({ url: 'http://127.0.0.1:18789/rpc' }));
  try {
    backend = await startBackend(root);
    const project = (await api.listChats()).projects[0]!;
    const chat = await api.createChat({ projectId: project.id });
    const peer = await context.newPage();
    for (const tab of [page, peer]) {
      await tab.goto(`/threads/${chat.id}`);
      await expect(pane(tab).getByLabel('Message composer', { exact: true })).toBeVisible();
    }
    await api.send({ chatId: chat.id, text: 'RUN_FOUR_WORK_STEPS' });
    for (const tab of [page, peer]) {
      await expect(pane(tab).getByRole('status').filter({ hasText: 'Working' })).toBeVisible();
      await expect(pane(tab).getByText('Progress before call 4.', { exact: true })).toBeVisible();
    }
    await writeFile(join(root, 'project', '.release-four'), 'done');
    for (const [tab, reload] of [[page, false], [peer, false], [peer, true]] as const) {
      if (reload) await tab.reload();
      await expect(pane(tab).getByText('FOUR_WORK_STEPS_DONE', { exact: true })).toBeVisible();
      const worked = pane(tab).locator('details.kodex-work-row');
      await expect(worked).toHaveCount(1);
      await expect(worked).not.toHaveAttribute('open', '');
      await expect(pane(tab).locator('.kodex-activity-group')).toHaveCount(0);
      await worked.locator(':scope > summary').click();
      const groups = worked.locator('.kodex-activity-group');
      await expect(groups.first()).toBeVisible();
      for (const group of await groups.all()) await group.locator(':scope > summary').click();
      const items = worked.locator('.kodex-activity-item');
      await expect(items).toHaveCount(7);
      await expect(items.locator(':scope > summary').filter({ hasText: 'Assistant' })).toHaveCount(3);
      for (const item of await items.all()) await item.locator(':scope > summary').click();
      for (const index of [1, 2, 4]) await expect(worked.getByText(`Progress before call ${index}.`, { exact: true })).toBeVisible();
      await expect(worked.getByText('Progress before call 3.', { exact: true })).toHaveCount(0);
      for (const index of [1, 3, 4]) await expect(worked.locator('.kodex-command-panel').filter({ hasText: `WORK_STEP_${index}` })).toHaveCount(1);
      await expect(worked.getByText('file_stat', { exact: true }).first()).toBeVisible();
    }
    await peer.screenshot({ path: testInfo.outputPath('four-step-worked.png'), fullPage: true });
  } finally { await context.close(); if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});

test('native saved tool groups and debug payloads remain inspectable across peers and reload', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-timeline-browser-'));
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  const api: RouterClient<GatewayRouter> = createORPCClient(new RPCLink({ url: 'http://127.0.0.1:18789/rpc' }));
  const errors: string[] = [], legacy: string[] = [];
  const historyReads = new Map<Page, ReturnType<typeof observeNativeHistoryReads>>();
  const observe = (tab: Page) => {
    historyReads.set(tab, observeNativeHistoryReads(tab));
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  };
  observe(page); context.on('page', observe);
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) legacy.push(request.url()); });
  try {
    backend = await startBackend(root);
    const project = (await api.listChats()).projects[0]!;
    const chat = await api.createChat({ projectId: project.id });
    await api.renameChat({ chatId: chat.id, title: 'Timeline debug' });
    const peer = await context.newPage();
    for (const tab of [page, peer]) await tab.goto(`/threads/${chat.id}`);
    await api.send({ chatId: chat.id, text: 'RUN_SHELL_FAILURE' });
    for (const tab of [page, peer]) {
      await expect(pane(tab).getByText('fixture:RUN_SHELL_FAILURE', { exact: true })).toBeVisible();
      const worked = pane(tab).locator('details.kodex-work-row');
      await expect(worked).toHaveCount(1);
      await expect(worked).not.toHaveAttribute('open', '');
      await expect(pane(tab).locator('.kodex-activity-group')).toHaveCount(0);
      await worked.locator(':scope > summary').click();
      const group = pane(tab).locator('.kodex-activity-group');
      await expect(group).toHaveCount(1);
      await expect(group).not.toHaveAttribute('open', '');
      await expect(pane(tab).getByText('Inspecting the shell failure.', { exact: true })).toHaveCount(0);
      await group.locator(':scope > summary').click();
      await group.getByText('Assistant', { exact: true }).click();
      await expect(group.getByText('Inspecting the shell failure.', { exact: true })).toBeVisible();
      await group.locator('.kodex-activity-item > summary').filter({ hasNotText: 'Assistant' }).click();
      await expect(group.locator('.kodex-timeline-output')).toHaveCount(0);
    }
    const reads = () => [historyReads.get(page)!(), historyReads.get(peer)!()];
    const beforeToggle = reads();
    expect(beforeToggle.every(count => count > 0)).toBe(true);
    await setNativeMenuPreference(page, 'Show command outputs', true);
    await expect(pane(page).locator('.kodex-timeline-output')).toContainText('NATIVE_SHELL_OUTPUT');
    await expect(pane(peer).locator('.kodex-timeline-output')).toHaveCount(0);
    expect(reads()).toEqual(beforeToggle);
    await setNativeMenuPreference(page, 'Show command outputs', false);
    await expect(pane(page).locator('.kodex-timeline-output')).toHaveCount(0);
    expect(reads()).toEqual(beforeToggle);
    for (const tab of [page, peer]) await setNativeMenuPreference(tab, 'Show command outputs', true);
    for (const tab of [page, peer]) await expect(pane(tab).locator('.kodex-timeline-output')).toBeVisible();
    expect(reads()).toEqual(beforeToggle);
    await peer.reload();
    const worked = pane(peer).locator('details.kodex-work-row');
    await expect(worked).not.toHaveAttribute('open', '');
    await expect(pane(peer).locator('.kodex-activity-group')).toHaveCount(0);
    await worked.locator(':scope > summary').click();
    const group = pane(peer).locator('.kodex-activity-group');
    await expect(group).toHaveCount(1);
    await expect(pane(peer).getByText('fixture:RUN_SHELL_FAILURE', { exact: true })).toBeVisible();
    await expect(pane(peer).getByText('Inspecting the shell failure.', { exact: true })).toHaveCount(0);
    await group.locator(':scope > summary').click();
    await group.getByText('Assistant', { exact: true }).click();
    await expect(group.getByText('Inspecting the shell failure.', { exact: true })).toBeVisible();
    await group.locator('.kodex-activity-item > summary').filter({ hasNotText: 'Assistant' }).click();
    await expect(group.locator('.kodex-timeline-output')).toHaveCount(0);
    const afterReload = historyReads.get(peer)!();
    expect(afterReload).toBeGreaterThan(beforeToggle[1]);
    await setNativeMenuPreference(peer, 'Show command outputs', true);
    await expect(group.locator('.kodex-timeline-output')).toBeVisible();
    expect(historyReads.get(peer)!()).toBe(afterReload);
    await setNativeMenuPreference(peer, 'Show debug events', true);
    const debug = group.locator('.kodex-activity-item').filter({ has: peer.locator('.kodex-command-panel') }).locator('.kodex-timeline-debug');
    await debug.locator(':scope > summary').click();
    await expect(debug.locator('pre')).toContainText('execute_command');
    await expect(debug.locator('pre')).toContainText('NATIVE_SHELL_OUTPUT');
    await peer.screenshot({ path: testInfo.outputPath('native-tool-group-debug.png'), fullPage: true, animations: 'disabled' });
    expect(errors).toEqual([]); expect(legacy).toEqual([]);
  } finally { await context.close(); if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});


test('live tool groups stay collapsed by default and preserve each tab inspection through completion', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-live-tool-'));
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  const api: RouterClient<GatewayRouter> = createORPCClient(new RPCLink({ url: 'http://127.0.0.1:18789/rpc' }));
  const errors: string[] = [];
  context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  try {
    backend = await startBackend(root);
    const project = (await api.listChats()).projects[0]!;
    const chat = await api.createChat({ projectId: project.id });
    const peer = await context.newPage();
    for (const tab of [page, peer]) {
      await tab.goto(`/threads/${chat.id}`);
      await expect(pane(tab).getByLabel('Message composer', { exact: true })).toBeVisible();
    }
    await api.send({ chatId: chat.id, text: 'RUN_HELD_SHELL' });
    for (const tab of [page, peer]) {
      const group = pane(tab).locator('.kodex-activity-group');
      await expect(group).toHaveCount(1);
      await expect(group).not.toHaveAttribute('open', '');
      await expect(group.locator(':scope > summary').getByText('Running', { exact: true })).toBeVisible();
      await expect(pane(tab).getByRole('status').filter({ hasText: 'Working' })).toBeVisible();
      expect(await pane(tab).locator('.kodex-work-row').evaluate((header) => Boolean(header.compareDocumentPosition(document.querySelector('.kodex-activity-group')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath('native-live-tool-collapsed.png'), fullPage: true, animations: 'disabled' });
    const inspected = pane(page).locator('.kodex-activity-group');
    await inspected.locator(':scope > summary').click();
    await inspected.locator('.kodex-activity-item > summary').click();
    await expect(inspected.locator('.kodex-command-panel')).toBeVisible();
    await writeFile(join(root, 'project', '.release-tool'), 'done');
    for (const tab of [page, peer]) {
      await expect(pane(tab).getByText('fixture:RUN_HELD_SHELL', { exact: true })).toBeVisible();
      const worked = pane(tab).locator('details.kodex-work-row');
      await expect(worked).not.toHaveAttribute('open', '');
      await expect(pane(tab).locator('.kodex-activity-group')).toHaveCount(0);
      await worked.locator(':scope > summary').click();
      await expect(pane(tab).locator('.kodex-activity-group > summary').getByText('Running', { exact: true })).toHaveCount(0);
    }
    await expect(inspected).toHaveAttribute('open', '');
    await expect(inspected.locator('.kodex-command-panel')).toBeVisible();
    await expect(pane(peer).locator('.kodex-activity-group')).not.toHaveAttribute('open', '');
    expect(errors).toEqual([]);
  } finally { await context.close(); if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
