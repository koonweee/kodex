import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { GatewayRouter } from '../../../spikes/mastra-code-sdk/src/gateway-router';
import { startBackend, stopBackend } from './fixtures/mastra';

const client = (): RouterClient<GatewayRouter> => createORPCClient(new RPCLink({ url: 'http://127.0.0.1:18789/rpc' }));
const dialog = (page: Page) => page.getByRole('dialog');
async function prompt(page: Page, text: string) {
  const tab = dialog(page).getByRole('tab', { name: 'Prompt', exact: true });
  if (await tab.isVisible()) await tab.click();
  await dialog(page).getByRole('textbox', { name: 'Automation prompt', exact: true }).fill(text);
}
async function details(page: Page) {
  const tab = dialog(page).getByRole('tab', { name: 'Details', exact: true });
  if (await tab.isVisible()) await tab.click();
}
async function target(page: Page, name: string) {
  await details(page);
  const field = dialog(page).getByRole('textbox', { name: 'Target thread', exact: true });
  if (await field.inputValue() === name) return;
  await field.click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(field).toHaveValue(name);
}

test('main automation controls use native calendars and converge across tabs without discarding open drafts', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-automations-'));
  const backend = await startBackend(root);
  const api = client(), errors: string[] = [], legacy: string[] = [];
  const observe = (tab: Page) => {
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  };
  observe(page); context.on('page', observe);
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) legacy.push(request.url()); });
  try {
    const catalog = await api.listChats();
    const a = await api.createChat({ projectId: catalog.projects[0]!.id }), b = await api.createChat({});
    await api.renameChat({ chatId: a.id, title: 'Schedule target A' });
    await api.renameChat({ chatId: b.id, title: 'Schedule target B' });
    await page.goto('/automations');
    const peer = await context.newPage(); await peer.goto('/automations');
    await page.getByRole('button', { name: 'Add automation', exact: true }).click();
    await dialog(page).getByRole('textbox', { name: 'Name', exact: true }).fill('Native calendar');
    await target(page, 'Schedule target A');
    await dialog(page).getByRole('textbox', { name: 'Schedule', exact: true }).click();
    await page.getByRole('option', { name: 'Custom cron', exact: true }).click();
    await dialog(page).getByRole('textbox', { name: 'Cron expression' }).fill('0 0 1 1 *');
    await dialog(page).getByRole('textbox', { name: 'Timezone', exact: true }).fill('UTC');
    await prompt(page, 'Original scheduled prompt');
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
    for (const tab of [page, peer]) await expect(tab.getByRole('row', { name: /Native calendar/ })).toBeVisible();
    const automation = (await api.listAutomations())[0]!;
    for (const tab of [page, peer]) await tab.getByRole('row', { name: /Native calendar/ }).click();
    await dialog(page).getByRole('textbox', { name: 'Name', exact: true }).fill('Renamed calendar');
    await prompt(peer, 'Peer edited prompt');
    await dialog(peer).getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await api.listAutomations())[0]?.prompt).toBe('Peer edited prompt');
    await expect(dialog(page).getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Renamed calendar');
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await api.listAutomations()).map(row => [row.name, row.prompt])).toEqual([['Renamed calendar', 'Peer edited prompt']]);
    await peer.getByRole('row', { name: /Renamed calendar/ }).click();
    await target(peer, 'Schedule target B');
    await dialog(peer).getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await api.listAutomations())[0]?.targetThreadId).toBe(b.id);
    await expect(page.getByRole('row', { name: /Renamed calendar/ })).toContainText('Schedule target B');
    await page.getByRole('row', { name: /Renamed calendar/ }).click();
    await expect(dialog(page).getByRole('textbox', { name: 'Target thread', exact: true })).toHaveValue('Schedule target B');
    await dialog(page).getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(peer.getByRole('row', { name: /Renamed calendar/ })).toContainText(/paused/i);
    await expect(dialog(page).getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('native-calendar-editor.png'), fullPage: true, animations: 'disabled' });
    await dialog(page).getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(peer.getByRole('row', { name: /Renamed calendar/ })).toContainText(/active/i);
    await page.reload();
    await page.getByRole('row', { name: /Renamed calendar/ }).click();
    await expect(dialog(page).getByRole('textbox', { name: 'Cron expression' })).toHaveValue('0 0 1 1 *');
    expect((await api.listAutomations())[0]?.id).toBe(automation.id);
    await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Confirm delete', exact: true }).click();
    for (const tab of [page, peer]) await expect(tab.getByRole('row', { name: /Renamed calendar/ })).toHaveCount(0);
    expect(legacy).toEqual([]); expect(errors).toEqual([]);
  } finally { await context.close(); await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});

test('an overdue native calendar runs after a cold backend restart without opening its chat', async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Cold-process scheduling is independent of input modality.');
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-automation-restart-'));
  let backend = await startBackend(root);
  const api = client();
  try {
    const catalog = await api.listChats();
    const chat = await api.createChat({ projectId: catalog.projects[0]!.id });
    await api.renameChat({ chatId: chat.id, title: 'Restart target' });
    const fireAt = new Date(Date.now() + 4000);
    const cron = `${fireAt.getUTCSeconds()} ${fireAt.getUTCMinutes()} ${fireAt.getUTCHours()} ${fireAt.getUTCDate()} ${fireAt.getUTCMonth() + 1} *`;
    const automation = await api.createAutomation({ name: 'Restart calendar', targetThreadId: chat.id,
      prompt: 'READ_MARKER SCHEDULE_COLD_RESTART', cron, timezone: 'UTC' });
    await stopBackend(backend);
    // Cross the native fire time while no backend exists; no browser or host
    // polling activates the chat before native startup delivery is observed.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, fireAt.getTime() - Date.now() + 100)));
    backend = await startBackend(root);
    await expect.poll(async () => (await api.listAutomationRuns({ id: automation.id }))[0]?.deliveryStatus).toBe('success');
    const runs = await api.listAutomationRuns({ id: automation.id });
    expect(runs).toHaveLength(1); expect(runs[0]?.outcome).toBe('published');
    await expect.poll(async () => JSON.stringify((await api.openChat({ chatId: chat.id })).messages)).toContain('fixture:READ_MARKER SCHEDULE_COLD_RESTART');
    await page.goto('/automations');
    await expect(page.getByRole('row', { name: /Restart calendar/ }).getByRole('cell', { name: 'Restart target', exact: true })).toBeVisible();
    await page.getByRole('row', { name: /Restart calendar/ }).click();
    await expect(dialog(page).getByRole('region', { name: 'Automation runs' })).toContainText('Published');
    await expect(dialog(page).getByRole('region', { name: 'Automation runs' })).toContainText('Input accepted');
    await dialog(page).getByText('Input accepted', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('native-calendar-restored-history.png'), fullPage: true, animations: 'disabled' });
  } finally { await context.close(); await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
