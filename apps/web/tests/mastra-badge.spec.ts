import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { GatewayRouter } from '../../../spikes/mastra-code-sdk/src/gateway-router';
import { pane, startBackend, stopBackend } from './fixtures/mastra';

const badge = (page: Page) => page.evaluate(() => (window as unknown as { nativeBadge: number }).nativeBadge);

test('native badge reads converge across clients and preserve the platform badge when knowledge is unknown', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-native-badge-browser-'));
  let backend = await startBackend(root);
  const api: RouterClient<GatewayRouter> = createORPCClient(new RPCLink({ url: 'http://127.0.0.1:18789/rpc' }));
  const errors: string[] = [], legacy: string[] = [];
  const presenceResponses: number[] = [], presenceBodies: string[] = [];
  await context.addInitScript(() => {
    const state = window as unknown as { nativeBadge: number };
    state.nativeBadge = 7;
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: async (count: number) => { state.nativeBadge = count; } });
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: async () => { state.nativeBadge = 0; } });
  });
  const observe = (tab: Page) => {
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    tab.on('response', response => { if (new URL(response.url()).pathname.endsWith('/replaceChatPresence')) presenceResponses.push(response.status()); });
  };
  observe(page); context.on('page', observe);
  context.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/v1/')) legacy.push(request.url());
    if (path.endsWith('/replaceChatPresence')) presenceBodies.push(request.postData() ?? '');
  });
  try {
    await page.goto('/');
    const peer = await context.newPage(); await peer.goto('/');
    for (const tab of [page, peer]) await expect.poll(() => badge(tab)).toBe(0);
    const project = (await api.listChats()).projects[0]!;
    const chat = await api.createChat({ projectId: project.id });
    expect((await api.getUnreadBadge()).count).toBeNull();
    await api.send({ chatId: chat.id, text: 'BADGE_NATIVE_RESULT' });
    for (const tab of [page, peer]) await expect.poll(() => badge(tab)).toBe(1);
    await api.setChatNotifications({ chatId: chat.id, enabled: false });
    expect((await api.getUnreadBadge()).count).toBe(1);
    const unknown = await api.createChat({ projectId: project.id });
    expect((await api.getUnreadBadge()).count).toBeNull();
    // A canonical unknown response cannot turn a previously known badge into zero.
    for (const tab of [page, peer]) {
      const refreshed = tab.waitForResponse(response => new URL(response.url()).pathname.endsWith('/getUnreadBadge'));
      await tab.evaluate(() => window.dispatchEvent(new Event('focus')));
      expect((await refreshed).status()).toBe(200);
      await expect.poll(() => badge(tab)).toBe(1);
    }
    await api.archiveChat({ chatId: unknown.id });
    expect((await api.getUnreadBadge()).count).toBe(1);
    await peer.goto(`/threads/${chat.id}`);
    await expect(pane(peer).getByText('fixture:BADGE_NATIVE_RESULT', { exact: true })).toBeVisible();
    for (const tab of [page, peer]) await expect.poll(() => badge(tab)).toBe(0);
    await expect.poll(() => presenceBodies.some(body => body.includes(chat.id))).toBe(true);
    await expect.poll(() => presenceResponses.length).toBeGreaterThan(0);
    expect(presenceResponses.every(status => status === 200)).toBe(true);
    await page.close(); await peer.close(); await stopBackend(backend);
    backend = await startBackend(root);
    expect((await api.getUnreadBadge()).count).toBeNull();
    const cold = await context.newPage();
    const read = cold.waitForResponse(response => new URL(response.url()).pathname.endsWith('/getUnreadBadge'));
    await cold.goto('/'); await read;
    await expect(cold.locator('.kodex-shell')).toBeVisible();
    expect(await badge(cold)).toBe(7);
    expect(errors).toEqual([]); expect(legacy).toEqual([]);
  } finally { await context.close(); await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
