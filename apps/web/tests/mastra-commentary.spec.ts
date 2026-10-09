import { test, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { GatewayRouter } from '../../../spikes/mastra-code-sdk/src/gateway-router';
import { pane, startBackend, stopBackend } from './fixtures/mastra';

test('commentary remains visible during native work and folds only after completion in both tabs', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-commentary-'));
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
    await api.send({ chatId: chat.id, text: 'RUN_HELD_COMMENTARY' });
    for (const tab of [page, peer]) {
      await expect(pane(tab).locator('.kodex-activity-group > summary').getByText('Running', { exact: true })).toBeVisible();
      await expect(pane(tab).getByText('Inspecting the live workspace.', { exact: true })).toBeVisible();
    }
    await peer.reload();
    await expect(pane(peer).getByText('Inspecting the live workspace.', { exact: true })).toBeVisible();
    await writeFile(join(root, 'project', '.release-tool'), 'done');
    for (const tab of [page, peer]) {
      await expect(pane(tab).getByText('fixture:RUN_HELD_COMMENTARY', { exact: true })).toBeVisible();
      await expect(pane(tab).getByText('Inspecting the live workspace.', { exact: true })).not.toBeVisible();
    }
    expect(errors).toEqual([]);
  } finally { await context.close(); if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
