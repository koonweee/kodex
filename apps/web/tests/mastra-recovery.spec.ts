import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pane, startBackend, stopBackend } from './fixtures/mastra';

test('an unavailable native chat reuses main browse and close recovery controls', async ({ context, page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-recovery-'));
  const backend = await startBackend(root);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('/threads/missing-native-chat');
    await expect(pane(page).getByRole('button', { name: 'Browse threads', exact: true })).toBeVisible();
    await expect(pane(page).getByLabel('Loading chat')).toHaveCount(0);
    await expect(pane(page).getByLabel('Message composer', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('native-unavailable-chat.png'), fullPage: true, animations: 'disabled' });
    await pane(page).getByRole('button', { name: 'Browse threads', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace', exact: true })).toBeVisible();
    await page.goto('/threads/missing-native-chat');
    await pane(page).getByRole('button', { name: 'Close pane', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Browse threads', exact: true })).toHaveCount(0);
    await expect(page.locator('.kodex-thread-pane[data-thread-id="missing-native-chat"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
