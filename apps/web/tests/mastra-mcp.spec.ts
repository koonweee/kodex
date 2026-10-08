import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { GatewayRouter } from '../../../spikes/mastra-code-sdk/src/gateway-router';
import { pane, send, startBackend, stopBackend } from './fixtures/mastra';

async function preferences(page: Page, label: string) {
  await expect(page.locator('.kodex-shell')).toBeVisible();
  const show = page.getByRole('button', { name: 'Show sidebar', exact: true });
  if (await show.isVisible()) await show.click();
  await page.getByRole('button', { name: 'Account settings', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Preferences', exact: true });
  await dialog.getByRole('button', { name: 'MCP', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Runtime', exact: true }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
  return dialog;
}

test('native MCP file reload updates both preference panels and subsequent agent tools', async ({ page, context }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mcp-browser-'));
  const backend = await startBackend(root, 'mcp');
  const api: RouterClient<GatewayRouter> = createORPCClient(new RPCLink({ url: 'http://127.0.0.1:18789/rpc' }));
  const errors: string[] = [], legacy: string[] = [];
  const observe = (tab: Page) => { tab.on('pageerror', error => errors.push(error.message)); tab.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); };
  observe(page); context.on('page', observe);
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) legacy.push(request.url()); });
  try {
    const project = (await api.listChats()).projects[0]!;
    await expect.poll(async () => (await api.nativeMcpList()).find(row => row.projectId === project.id)?.servers[0]?.connected).toBe(true);
    const binding = (await api.nativeMcpList()).find(row => row.projectId === project.id)!;
    const label = `${binding.projectName} · ${binding.cwd}`;
    const chat = await api.createChat({ projectId: project.id });
    await page.goto(`/threads/${chat.id}`); await send(page, 'BROWSER_MCP:first');
    await expect(pane(page).getByText('BROWSER_MCP_RESULT_first', { exact: true })).toBeVisible();
    const peer = await context.newPage(); await peer.goto(`/threads/${chat.id}`);
    const first = await preferences(page, label), second = await preferences(peer, label);
    for (const dialog of [first, second]) await expect(dialog.getByText('local_probe_first', { exact: true })).toBeVisible();
    const configPath = binding.paths!.project;
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.mcpServers.local.args[config.mcpServers.local.args.length - 1] = 'second';
    await writeFile(configPath, JSON.stringify(config));
    await first.getByRole('button', { name: 'Reload MCP servers', exact: true }).click();
    for (const dialog of [first, second]) {
      await expect(dialog.getByText('local_probe_second', { exact: true })).toBeVisible();
      await expect(dialog.getByText('local_probe_first', { exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('alert')).toHaveCount(0);
    }
    await second.getByText('local_probe_second', { exact: true }).scrollIntoViewIfNeeded();
    await expect(second.getByText('local_probe_second', { exact: true })).toBeInViewport();
    await peer.screenshot({ path: testInfo.outputPath('native-mcp-preferences.png'), fullPage: true, animations: 'disabled' });
    await page.goto(`/threads/${chat.id}`); await send(page, 'BROWSER_MCP:second');
    await expect(pane(page).getByText('BROWSER_MCP_RESULT_second', { exact: true })).toBeVisible();
    await peer.reload();
    await expect((await preferences(peer, label)).getByText('local_probe_second', { exact: true })).toBeVisible();
    expect(errors).toEqual([]); expect(legacy).toEqual([]);
  } finally { await context.close(); await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
