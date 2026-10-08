import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { GatewayRouter } from '../../../spikes/mastra-code-sdk/src/gateway-router';
import { pane, send, startBackend, stopBackend } from './fixtures/mastra';

test('native agent Control mutations reach the target pane in another tab and survive reload', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-control-browser-'));
  const backend = await startBackend(root, 'control');
  const api: RouterClient<GatewayRouter> = createORPCClient(new RPCLink({ url: 'http://127.0.0.1:18789/rpc' }));
  const errors: string[] = [], legacy: string[] = [];
  const observe = (tab: typeof page) => {
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  };
  observe(page); context.on('page', observe);
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) legacy.push(request.url()); });
  try {
    const project = (await api.listChats()).projects[0]!;
    const parent = await api.createChat({ projectId: project.id }), target = await api.createChat({ projectId: project.id });
    await api.renameChat({ chatId: parent.id, title: 'Control parent' });
    await api.renameChat({ chatId: target.id, title: 'Control target' });
    await page.goto(`/threads/${parent.id}`);
    const peer = await context.newPage(); await peer.goto(`/threads/${target.id}`);
    await expect(pane(peer)).toHaveAttribute('aria-label', 'Control target');
    await send(page, `CONTROL_NATIVE:${JSON.stringify({ name: 'rename_thread', arguments: { threadId: target.id, name: 'Agent renamed target' } })}`);
    await expect(pane(page).getByText('CONTROL_DONE:rename_thread', { exact: true })).toBeVisible();
    await expect(pane(peer)).toHaveAttribute('aria-label', 'Agent renamed target');
    await send(page, `CONTROL_NATIVE:${JSON.stringify({ name: 'send_thread_input', arguments: { threadId: target.id, text: 'AGENT_CONTROL_QUEUED' } })}`);
    await expect(pane(page).getByText('CONTROL_DONE:send_thread_input', { exact: true })).toBeVisible();
    await expect(pane(peer).getByText('fixture:AGENT_CONTROL_QUEUED', { exact: true })).toBeVisible();
    await peer.reload();
    await expect(pane(peer)).toHaveAttribute('aria-label', 'Agent renamed target');
    await expect(pane(peer).getByText('fixture:AGENT_CONTROL_QUEUED', { exact: true })).toBeVisible();
    await peer.screenshot({ path: testInfo.outputPath('native-control-target.png'), fullPage: true, animations: 'disabled' });
    expect(errors).toEqual([]); expect(legacy).toEqual([]);
  } finally { await context.close(); await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
