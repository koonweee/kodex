import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBackend, stopBackend } from './fixtures/mastra';

test('native Execution preferences describe the active policy without legacy requests', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-preferences-'));
  const backend = await startBackend(root);
  const errors: string[] = [], legacy: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) legacy.push(request.url()); });
  try {
    await page.goto('/');
    await expect(page.locator('.kodex-shell')).toBeVisible();
    const show = page.getByRole('button', { name: 'Show sidebar', exact: true });
    if (await show.isVisible()) await show.click();
    await page.getByRole('button', { name: 'Account settings', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Preferences', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Preferences', exact: true });
    await dialog.getByRole('button', { name: 'Execution', exact: true }).click();
    await expect(dialog.getByText('Runs on the gateway machine without a sandbox.', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Ordinary tools run without per-action approval.', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Auto review', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('native-execution-preferences.png'), fullPage: true, animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Appearance', exact: true }).click();
    await expect(dialog.getByText('Ordinary tools run without per-action approval.', { exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Execution', exact: true }).click();
    await expect(dialog.getByText('Ordinary tools run without per-action approval.', { exact: true })).toBeVisible();
    expect(errors).toEqual([]); expect(legacy).toEqual([]);
  } finally { await context.close(); await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
