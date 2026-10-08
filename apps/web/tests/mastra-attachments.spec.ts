import { test, expect, type Page } from '@playwright/test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pane, send, startBackend, stopBackend } from './fixtures/mastra';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const markdown = '# Native attachment review\n\nRead **native** file bytes.\n';
const image = (name: string) => ({ name, mimeType: 'image/png', buffer: png });
const attach = async (page: Page, file: { name: string; mimeType: string; buffer: Buffer }) => {
  const input = pane(page).locator('input[type="file"]');
  await expect(input).toBeEnabled();
  await input.setInputFiles(file);
};
const thumbnail = (page: Page, name: string) => pane(page).getByRole('button', { name: `Open ${name}`, exact: true });
const expectHealthy = async (page: Page) => {
  await expect(page.getByRole('alert', { name: 'Could not load sidebar', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert', { name: 'Chat settings error', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: /AsyncIdQueue/ })).toHaveCount(0);
};

const verifyFileCards = async (page: Page) => {
  await expect(pane(page).getByRole('link', { name: 'Download notes.txt', exact: true })).toBeVisible();
  await expect(pane(page).getByRole('button', { name: 'Preview review.md', exact: true })).toBeVisible();
  await expect(pane(page).locator('.kodex-user-message-bubble').filter({ hasText: /kodex-attachments|\.kodex\/uploads\// })).toHaveCount(0);
};
const downloadNotes = async (page: Page) => {
  const pending = page.waitForEvent('download');
  await pane(page).getByRole('link', { name: 'Download notes.txt', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('notes.txt');
  const path = await download.path(); expect(path).not.toBeNull();
  expect(await readFile(path!, 'utf8')).toBe('BROWSER_GENERIC_FILE_BYTES');
};
const previewMarkdown = async (page: Page) => {
  await pane(page).getByRole('button', { name: 'Preview review.md', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'review.md', exact: true });
  await expect(preview.getByRole('heading', { name: 'Native attachment review', exact: true })).toBeVisible();
  await expect(preview.getByText('native', { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('native-markdown-preview.png'), fullPage: true });
  await preview.getByText('Source', { exact: true }).click();
  await expect(preview.getByRole('radio', { name: 'Source', exact: true })).toBeChecked();
  const source = preview.getByRole('region', { name: 'Markdown source', exact: true });
  await expect(source.getByText('# Native attachment review', { exact: true })).toBeVisible();
  await expect(source.getByText('Read **native** file bytes.', { exact: true })).toBeVisible();
  await preview.getByText('Preview', { exact: true }).click();
  await expect(preview.getByRole('radio', { name: 'Preview', exact: true })).toBeChecked();
  await expect(preview.getByRole('heading', { name: 'Native attachment review', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(preview).toHaveCount(0);
};

test('native uploads, file previews and edited queued images converge across peers and restart', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-attachments-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const errors: string[] = [], legacy: string[] = [];
  const uploads: Array<{ route: string; status: number }> = [];
  const observe = (tab: Page) => {
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('console', message => {
      // The deliberate invalid PNG produces exactly one actual upload 400.
      if (message.type() === 'error' && !(message.location().url.includes('/rpc/uploadImage') && /400/.test(message.text()))) errors.push(message.text());
    });
  };
  observe(page); context.on('page', observe);
  context.on('request', request => {
    const url = new URL(request.url());
    const nativePreview = request.method() === 'GET' && /^\/v1\/threads\/[^/]+\/files\/preview$/.test(url.pathname)
      && url.searchParams.has('path') && [...url.searchParams.keys()].every(key => key === 'path');
    if (url.pathname.startsWith('/v1/') && !nativePreview) legacy.push(request.url());
  });
  context.on('response', response => {
    const route = new URL(response.url()).pathname;
    if (/\/rpc\/upload(Image|File)$/.test(route)) uploads.push({ route, status: response.status() });
  });
  try {
    backend = await startBackend(root, 'attachments');
    await page.goto('/'); await expect(page.locator('.kodex-shell')).toBeVisible();
    await attach(page, image('submitted.png'));
    await pane(page).getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(pane(page).getByText('BROWSER_UPLOADED_IMAGE_RECEIVED:image-only', { exact: true })).toBeVisible();
    await expect(thumbnail(page, 'submitted.png')).toBeVisible();
    await expect.poll(() => thumbnail(page, 'submitted.png').locator('img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
    const peer = await context.newPage(); await peer.goto(page.url());
    await expect(thumbnail(peer, 'submitted.png')).toBeVisible();
    for (const tab of [page, peer]) await expectHealthy(tab);

    await attach(page, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('BROWSER_GENERIC_FILE_BYTES') });
    await send(page, 'BROWSER_FILE_SEND');
    for (const tab of [page, peer]) await expect(pane(tab).getByText('BROWSER_FILE_REFERENCE_RECEIVED', { exact: true })).toBeVisible();
    for (const tab of [page, peer]) await expect(pane(tab).getByRole('link', { name: 'Download notes.txt', exact: true })).toBeVisible();
    await downloadNotes(page);
    await attach(page, { name: 'review.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown) });
    await send(page, 'BROWSER_MARKDOWN_SEND');
    for (const tab of [page, peer]) {
      await expect(pane(tab).getByText('BROWSER_MARKDOWN_REFERENCE_RECEIVED', { exact: true })).toBeVisible();
      await verifyFileCards(tab);
    }
    await page.screenshot({ path: test.info().outputPath('native-file-cards.png'), fullPage: true });
    await previewMarkdown(page);

    await attach(page, { name: 'retry.png', mimeType: 'image/png', buffer: Buffer.from('invalid PNG') });
    await send(page, 'BROWSER_RETRY_IMAGE');
    await expect(pane(page).getByRole('alert').filter({ hasText: /Invalid PNG image/ })).toBeVisible();
    await expect(pane(page).locator('.kodex-attachment-tray').getByText('Failed', { exact: true })).toBeVisible();
    await expect(pane(page).getByLabel('Message composer', { exact: true })).toHaveValue('BROWSER_RETRY_IMAGE');
    expect(uploads.filter(value => value.route.endsWith('/uploadImage') && value.status === 400)).toHaveLength(1);
    await pane(page).getByRole('button', { name: 'Remove retry.png', exact: true }).click();
    await attach(page, image('retry.png'));
    await pane(page).getByRole('button', { name: 'Send message', exact: true }).click();
    for (const tab of [page, peer]) {
      await expect(pane(tab).getByText('BROWSER_UPLOADED_IMAGE_RECEIVED:BROWSER_RETRY_IMAGE', { exact: true })).toBeVisible();
      await expect(thumbnail(tab, 'retry.png')).toBeVisible();
    }

    await send(page, 'HOLD_STOP');
    for (const tab of [page, peer]) await expect(pane(tab).getByText('started:HOLD_STOP', { exact: true })).toBeVisible();
    await attach(page, image('queued.png'));
    await send(page, 'QUEUED_IMAGE_ORIGINAL', true);
    const row = (tab: Page) => pane(tab).getByRole('region', { name: 'Queued messages', exact: true }).getByRole('group', { name: 'Queued message', exact: true });
    for (const tab of [page, peer]) { await expect(row(tab)).toContainText('QUEUED_IMAGE_ORIGINAL'); await expect(row(tab)).toContainText('1 attached file(s)'); }
    await row(peer).getByRole('button', { name: 'Edit', exact: true }).click();
    await peer.getByLabel('Queued message text', { exact: true }).fill('QUEUED_IMAGE_EDITED');
    await peer.getByRole('button', { name: 'Save queued message', exact: true }).click();
    await expect(peer.getByRole('dialog', { name: 'Edit queued message' })).toHaveCount(0);
    for (const tab of [page, peer]) { await expect(row(tab)).toContainText('QUEUED_IMAGE_EDITED'); await expect(row(tab)).toContainText('1 attached file(s)'); }
    await pane(page).getByRole('button', { name: 'Stop turn', exact: true }).click();
    for (const tab of [page, peer]) await expect(pane(tab).getByRole('button', { name: 'Stop turn', exact: true })).toHaveCount(0);
    // Native Stop releases the queued row; preserve its native continuation.
    for (const tab of [page, peer]) {
      await expect(pane(tab).getByText('BROWSER_UPLOADED_IMAGE_RECEIVED:QUEUED_IMAGE_EDITED', { exact: true })).toBeVisible();
      await expect(thumbnail(tab, 'queued.png')).toBeVisible(); await expect(row(tab)).toHaveCount(0);
    }
    const verify = async (tab: Page) => {
      for (const name of ['submitted.png', 'retry.png', 'queued.png']) {
        await expect(thumbnail(tab, name)).toBeVisible();
        await expect(thumbnail(tab, name).locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
        await expect.poll(() => thumbnail(tab, name).locator('img').evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
      }
      await expect(pane(tab).getByText('BROWSER_FILE_REFERENCE_RECEIVED', { exact: true })).toBeVisible();
      await verifyFileCards(tab);
      await expectHealthy(tab);
    };
    for (const tab of [page, peer]) await expectHealthy(tab);
    await page.screenshot({ path: test.info().outputPath('native-attachment-submissions.png'), fullPage: true });
    await peer.reload(); await verify(peer);
    const urls = [page.url(), peer.url()]; await Promise.all([page.goto('about:blank'), peer.goto('about:blank')]);
    await stopBackend(backend, true); backend = await startBackend(root, 'attachments');
    for (const [index, tab] of [page, peer].entries()) { await tab.goto(urls[index]); await verify(tab); }
    await previewMarkdown(peer); await downloadNotes(peer);
    await thumbnail(peer, 'submitted.png').click(); await expect(peer.getByRole('dialog').locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await peer.getByRole('button', { name: 'Close image preview', exact: true }).click();
    expect(uploads.filter(value => value.route.endsWith('/uploadImage') && value.status === 200)).toHaveLength(3);
    expect(uploads.filter(value => value.route.endsWith('/uploadFile') && value.status === 200)).toHaveLength(2);
    expect(uploads.filter(value => value.route.endsWith('/uploadImage') && value.status === 400)).toHaveLength(1);
    expect(legacy).toEqual([]); expect(errors).toEqual([]);
  } finally { if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
