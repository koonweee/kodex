import { expect, test, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { GatewayRouter } from '../../../spikes/mastra-code-sdk/src/gateway-router';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { startOAuthFixture } from '../../../spikes/mastra-code-sdk/test/fixtures/mcp-oauth-server';
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
    const originalConfig = await readFile(binding.paths!.project, 'utf8');
    await first.getByRole('button', { name: 'Disable', exact: true }).click();
    for (const dialog of [first, second]) {
      await expect(dialog.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled();
      await expect(dialog.getByText('local_probe_first', { exact: true })).toHaveCount(0);
    }
    expect(await readFile(binding.paths!.project, 'utf8')).toBe(originalConfig);
    await second.getByRole('button', { name: 'Enable', exact: true }).click();
    for (const dialog of [first, second]) {
      await expect(dialog.getByText('local_probe_first', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Use global default', exact: true })).toBeVisible();
    }
    await first.getByRole('button', { name: 'Use global default', exact: true }).click();
    for (const dialog of [first, second]) await expect(dialog.getByRole('button', { name: 'Use global default', exact: true })).toHaveCount(0);

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


test('native MCP OAuth exposes only the initiating link and both tabs can cancel and observe connected tools', async ({ page, context }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mcp-oauth-browser-'));
  const provider = await startOAuthFixture(); provider.setRevision('oauth');
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  try {
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const callbackPort = (reservation.address() as AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const configDirectory = join(root, 'project', '.kodex-mastra-spike');
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, 'mcp.json');
    const config = JSON.stringify({ mcpServers: { local: { url: `${provider.origin}/mcp`, oauth: { clientId: 'fixture-client', callbackPort, scopes: ['probe'] } } } });
    await writeFile(configPath, config);
    backend = await startBackend(root, 'mcp-oauth');
    const api: RouterClient<GatewayRouter> = createORPCClient(new RPCLink({ url: 'http://127.0.0.1:18789/rpc' }));
    const errors: string[] = [], legacy: string[] = [];
    const observe = (tab: Page) => { tab.on('pageerror', error => errors.push(error.message)); tab.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); };
    observe(page);
    context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) legacy.push(request.url()); });
    const project = (await api.listChats()).projects[0]!;
    await expect.poll(async () => (await api.nativeMcpList()).find(row => row.projectId === project.id)?.servers[0]?.needsAuth).toBe(true);
    const binding = (await api.nativeMcpList()).find(row => row.projectId === project.id)!;
    const label = `${binding.projectName} · ${binding.cwd}`;
    const chat = await api.createChat({ projectId: project.id });
    await page.goto(`/threads/${chat.id}`);
    const peer = await context.newPage(); observe(peer); await peer.goto(`/threads/${chat.id}`);
    const first = await preferences(page, label), second = await preferences(peer, label);
    await first.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(first.getByRole('link', { name: 'Open login', exact: true })).toBeVisible();
    for (const dialog of [first, second]) await expect(dialog.getByRole('button', { name: 'Cancel authentication', exact: true })).toBeVisible();
    await expect(second.getByRole('link', { name: 'Open login', exact: true })).toHaveCount(0);
    await second.getByRole('button', { name: 'Cancel authentication', exact: true }).click();
    for (const dialog of [first, second]) {
      await expect(dialog.getByRole('button', { name: 'Log in', exact: true })).toBeEnabled();
      await expect(dialog.getByRole('link', { name: 'Open login', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('alert')).toHaveCount(0);
    }
    await first.getByRole('button', { name: 'Log in', exact: true }).click();
    const link = first.getByRole('link', { name: 'Open login', exact: true });
    await expect(link).toBeVisible();
    await expect(first.getByRole('button', { name: 'Cancel authentication', exact: true })).toBeVisible();
    await link.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('native-mcp-oauth.png'), fullPage: true, animations: 'disabled' });
    const opened = context.waitForEvent('page'); await link.click();
    const callback = await opened;
    await expect.poll(() => provider.counts.token).toBe(1);
    for (const dialog of [first, second]) {
      await expect(dialog.getByText('local_probe_oauth', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('link', { name: 'Open login', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Cancel authentication', exact: true })).toHaveCount(0);
    }
    await callback.close();
    expect(await readFile(configPath, 'utf8')).toBe(config);
    await page.goto(`/threads/${chat.id}`); await send(page, 'BROWSER_MCP:oauth');
    await expect(pane(page).getByText('BROWSER_MCP_RESULT_oauth', { exact: true })).toBeVisible();
    expect(provider.counts.call).toBeGreaterThan(0);
    await peer.reload(); await expect((await preferences(peer, label)).getByText('local_probe_oauth', { exact: true })).toBeVisible();
    expect(errors).toEqual([]); expect(legacy).toEqual([]);
  } finally { await context.close(); if (backend) await stopBackend(backend); await provider.close(); await rm(root, { recursive: true, force: true }); }
});
