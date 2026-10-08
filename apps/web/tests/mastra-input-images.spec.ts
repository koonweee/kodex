import { test, expect, type Page } from '@playwright/test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pane, startBackend, stopBackend } from './fixtures/mastra';

// Rendering proof from actual native persisted file parts. Submission transport
// remains a separate slice; this test never injects browser responses or images.
test('native saved input images use shared thumbnails and lightbox across peers, reload and backend restart', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-input-images-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const errors: string[] = [], legacy: string[] = [];
  const observe = (tab: Page) => {
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  };
  observe(page); context.on('page', observe);
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) legacy.push(request.url()); });
  const thumbnail = (tab: Page, filename: string) => pane(tab).getByRole('button', { name: `Open ${filename}`, exact: true });
  const verify = async (tab: Page) => {
    await expect(pane(tab).getByText('Inspect this image <pixel> & preserve the text.', { exact: true })).toBeVisible();
    await expect(pane(tab).locator('.kodex-user-message-row')).toHaveCount(2);
    await expect(pane(tab).locator('.kodex-user-message-bubble')).toHaveCount(1);
    await expect(pane(tab).getByRole('button', { name: /^Open (pixel\.png|motion\.gif|only\.png)$/ })).toHaveCount(3);
    for (const filename of ['pixel.png', 'motion.gif', 'only.png']) {
      await expect(thumbnail(tab, filename)).toBeVisible();
      await expect(thumbnail(tab, filename).locator('img')).toHaveAttribute('src', /^data:image\/(png|gif);base64,/);
      await expect.poll(() => thumbnail(tab, filename).locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
    }
  };
  try {
    backend = await startBackend(root, 'input-images');
    await page.goto('/');
    await expect(page.locator('.kodex-shell')).toBeVisible();
    const sidebar = page.getByRole('button', { name: 'Show sidebar', exact: true });
    if (await sidebar.isVisible()) await sidebar.click();
    await page.getByText('Native input image fixture', { exact: true }).click();
    await verify(page);
    await page.screenshot({ path: test.info().outputPath('native-input-image-history.png'), fullPage: true });
    const peer = await context.newPage(); await peer.goto(page.url()); await verify(peer);
    await thumbnail(page, 'motion.gif').click();
    const viewer = page.getByRole('dialog'); await expect(viewer).toBeVisible();
    await expect(viewer.locator('img')).toHaveAttribute('src', /^data:image\/gif;base64,/);
    await page.screenshot({ path: test.info().outputPath('native-input-image-lightbox.png'), fullPage: true });
    await page.keyboard.press('Escape'); await expect(viewer).toHaveCount(0);
    await peer.reload(); await verify(peer);
    // The fixture is deliberately unavailable during SIGKILL/restart. This
    // proves cold saved rendering; live reconnect behavior has separate tests.
    const selected = [page.url(), peer.url()];
    await Promise.all([page.goto('about:blank'), peer.goto('about:blank')]);
    await stopBackend(backend, true); backend = await startBackend(root, 'input-images');
    for (const [index, tab] of [page, peer].entries()) { await tab.goto(selected[index]); await verify(tab); }
    await thumbnail(peer, 'only.png').click();
    await expect(peer.getByRole('dialog').locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await peer.getByRole('button', { name: 'Close image preview', exact: true }).click();
    await expect(peer.getByRole('dialog')).toHaveCount(0);
    expect(legacy).toEqual([]); expect(errors).toEqual([]);
  } finally { if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
