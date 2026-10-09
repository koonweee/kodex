import { test, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pane, send, startBackend, stopBackend } from './fixtures/mastra';

test('idle send stays above new native activity while its canonical user row is delayed', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-input-order-'));
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    backend = await startBackend(root, 'optimistic-order');
    await page.goto('/');
    await send(page, 'BROWSER_HELLO');
    await expect(pane(page).getByText('fixture:BROWSER_HELLO', { exact: true })).toBeVisible();
    await expect(pane(page).getByRole('button', { name: 'Stop turn', exact: true })).toHaveCount(0);
    const peer = await context.newPage();
    peer.on('pageerror', error => errors.push(error.message));
    await peer.goto(page.url());
    await expect(pane(peer).getByText('fixture:BROWSER_HELLO', { exact: true })).toBeVisible();
    await send(page, 'RUN_HELD_SHELL');
    const bubble = (tab: typeof page) => pane(tab).locator('.kodex-user-message-bubble').filter({ hasText: 'RUN_HELD_SHELL' });
    for (const tab of [page, peer]) await expect(pane(tab).locator('.kodex-activity-group > summary').getByText('Running', { exact: true })).toBeVisible();
    // The sender still has its optimistic row; the peer intentionally has no
    // browser-local placeholder until native history supplies the saved signal.
    await expect(bubble(page)).toHaveCount(1);
    await expect(bubble(peer)).toHaveCount(0);
    const userPrecedesActivity = (tab: typeof page) => pane(tab).evaluate(element => {
      const user = [...element.querySelectorAll('.kodex-user-message-bubble')].find(node => node.textContent?.includes('RUN_HELD_SHELL'));
      const activity = element.querySelector('.kodex-activity-group, .kodex-work-row[data-state=completed]');
      return Boolean(user && activity && (user.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    expect(await userPrecedesActivity(page)).toBe(true);
    await Promise.all([writeFile(join(root, 'project', '.release-tool'), 'done'), writeFile(join(root, '.release-tool'), 'done')]);
    for (const tab of [page, peer]) {
      await expect(pane(tab).getByText('fixture:RUN_HELD_SHELL', { exact: true })).toBeVisible();
      await expect(bubble(tab)).toHaveCount(1);
      expect(await userPrecedesActivity(tab)).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally { await context.close(); if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
