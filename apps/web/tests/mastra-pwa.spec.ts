import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { GatewayRouter } from '../../../spikes/mastra-code-sdk/src/gateway-router';
import { startBackend, stopBackend } from './fixtures/mastra';

async function notifications(page: Page) {
  await expect(page.locator('.kodex-shell')).toBeVisible();
  const show = page.getByRole('button', { name: 'Show sidebar', exact: true });
  if (await show.isVisible()) await show.click();
  await page.getByRole('button', { name: 'Account settings', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Preferences', exact: true });
  await dialog.getByRole('button', { name: 'Notifications', exact: true }).click();
  return dialog;
}

test('built native PWA installs its worker and shares Push preferences across tabs', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-native-pwa-'));
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  try {
  backend = await startBackend(root, 'push', resolve('dist'));
  const api: RouterClient<GatewayRouter> = createORPCClient(new RPCLink({ url: 'http://127.0.0.1:18789/rpc' }));
  const errors: string[] = [], legacy: string[] = [];
  const endpoint = 'https://push.example.test/browser-device';
  // Only the provider/device APIs are doubles. Registration, activation, worker
  // execution, bundle assets and all Kodex transports use the real built app.
  await context.addInitScript(({ endpoint }) => {
    if (typeof ServiceWorkerRegistration === 'undefined') return; // New tabs begin on about:blank.
    const observed = window as Window & { fixtureWorkerChecks: number; fixturePendingWorkerChecks: number };
    observed.fixtureWorkerChecks = 0; observed.fixturePendingWorkerChecks = 0;
    const update = ServiceWorkerRegistration.prototype.update;
    ServiceWorkerRegistration.prototype.update = function () {
      observed.fixtureWorkerChecks++;
      observed.fixturePendingWorkerChecks++;
      return update.call(this).finally(() => { observed.fixturePendingWorkerChecks--; }); // Execute the real browser update.
    };
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
    Notification.requestPermission = async () => 'granted';
    const subscription = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'fixture', auth: 'fixture' } }),
      unsubscribe: async () => false };
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { configurable: true, get: () => ({
      getSubscription: async () => localStorage.getItem('fixture-push') ? subscription : null,
      subscribe: async () => { localStorage.setItem('fixture-push', 'yes'); return subscription; },
    }) });
  }, { endpoint });
  const observe = (tab: Page) => {
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  };
  observe(page); context.on('page', observe);
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) legacy.push(request.url()); });
  const deliveries = async () => { try { return (await readFile(join(root, 'push-deliveries.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } };
    await page.goto('/');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain('/sw.js');
    // Prove the installed worker, rather than a page hook, makes typed native RPC.
    const badgeRead = context.waitForEvent('request', request => !!request.serviceWorker() && new URL(request.url()).pathname.endsWith('/getUnreadBadge'));
    await page.evaluate(() => navigator.serviceWorker.controller!.postMessage({ type: 'REFRESH_BADGE' }));
    const workerRequest = await badgeRead;
    expect(workerRequest.method()).toBe('POST');
    expect((await workerRequest.response())?.status()).toBe(200);
    const dialog = await notifications(page);
    await expect(dialog.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect(dialog.getByText('Enabled', { exact: true })).toBeVisible();
    const first = await api.push.current({ endpoint });
    expect(first.subscribed).toBe(true);
    const peer = await context.newPage(); await peer.goto('/');
    const other = await notifications(peer);
    await expect(other.getByText('Enabled', { exact: true })).toBeVisible();
    const checks = (tab: Page) => tab.evaluate(() => (window as Window & { fixtureWorkerChecks: number }).fixtureWorkerChecks);
    for (const tab of [page, peer]) {
      await expect.poll(() => checks(tab)).toBeGreaterThan(0);
      await expect.poll(() => tab.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return (window as Window & { fixturePendingWorkerChecks: number }).fixturePendingWorkerChecks === 0 && !registration.installing;
      })).toBe(true);
    }
    const before = await Promise.all([checks(page), checks(peer)]);
    await api.frontendUpdated({ revision: 'browser-publication-proof' });
    for (const [index, tab] of [page, peer].entries()) await expect.poll(() => checks(tab)).toBeGreaterThan(before[index]);
    // A check alone does not reload the open application or dismiss its UI.
    await expect(dialog).toBeVisible(); await expect(other).toBeVisible();
    await other.getByRole('button', { name: 'Test', exact: true }).click();
    await expect(other.getByText('Test notification sent.', { exact: true })).toBeVisible();
    await expect.poll(async () => (await deliveries()).some(row => row.kind === 'test')).toBe(true);
    await dialog.getByRole('button', { name: 'Disable', exact: true }).click();
    await expect(dialog.getByText('Notifications disabled.', { exact: true })).toBeVisible();
    // Browser unsubscribe deliberately fails: both tabs must follow backend truth.
    await peer.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(other.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled();
    await expect(other.getByText('Enabled', { exact: true })).toHaveCount(0);
    await other.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect(other.getByText('Enabled', { exact: true })).toBeVisible();
    expect((await api.push.current({ endpoint })).subscription?.id).toBe(first.subscription?.id);
    const chat = await api.createChat({ projectId: (await api.listChats()).projects[0]!.id });
    await api.send({ chatId: chat.id, text: 'PWA_PUSH_RESULT' });
    await expect.poll(async () => (await deliveries()).some(row => row.kind === 'unreadAgentMessage' && row.threadId === chat.id)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('native-notifications.png'), fullPage: true, animations: 'disabled' });
    expect(errors).toEqual([]); expect(legacy).toEqual([]);
  } finally {
    await context.close().catch(() => {});
    if (backend) await stopBackend(backend);
    await rm(root, { recursive: true, force: true });
  }
});
