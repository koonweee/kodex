import { test, expect, type Page } from '@playwright/test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pane, send, startBackend, stopBackend } from './fixtures/mastra';

test('native async questions keep main cards and canonical replies across peers and restart', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-async-questions-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const errors: string[] = [], legacy: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  context.on('request', request => { if (/^\/v1\/threads\/[^/]+\/input$/.test(new URL(request.url()).pathname)) legacy.push(request.url()); });
  async function verifyAnswered(tab: Page) {
    await expect(pane(tab).getByRole('textbox', { name: /^Reply to question/ })).toHaveCount(0);
    const questions = pane(tab).getByRole('region', { name: /^Question [12]$/ });
    await expect(questions).toHaveCount(2);
    for (const question of await questions.all()) {
      const summary = question.locator('summary');
      if (await question.locator('details').getAttribute('open') === null) await summary.click();
    }
    await expect(questions.nth(0).getByRole('blockquote')).toHaveText('Use native history');
    await expect(questions.nth(1).getByRole('blockquote')).toHaveText('Keep <this> & "that"');
  }
  try {
    backend = await startBackend(root); await page.goto('/');
    await send(page, 'BROWSER_ASK_ASYNC');
    await expect(pane(page).getByText('BROWSER_WORK_CONTINUED', { exact: true })).toBeVisible();
    await expect(pane(page).getByRole('textbox', { name: 'Reply to question 1', exact: true })).toBeVisible();
    const peer = await context.newPage(); peer.on('pageerror', error => errors.push(error.message));
    await peer.goto(page.url());
    await expect(pane(peer).getByRole('button', { name: 'Use native history', exact: true })).toBeVisible();
    await pane(page).getByRole('button', { name: 'Use native history', exact: true }).click();
    await expect(pane(peer).getByRole('textbox', { name: 'Reply to question 1', exact: true })).toHaveCount(0);
    const reply = pane(peer).getByRole('textbox', { name: 'Reply to question 2', exact: true });
    await reply.fill('Keep <this> & "that"'); await reply.press('Enter');
    await expect(pane(page).getByText('BROWSER_REPLY_TEXT_RECEIVED', { exact: true })).toBeVisible();
    await verifyAnswered(page); await verifyAnswered(peer);
    await peer.reload(); await verifyAnswered(peer);
    await stopBackend(backend, true); backend = await startBackend(root);
    await peer.reload(); await verifyAnswered(peer);
    await peer.screenshot({ path: test.info().outputPath('native-async-questions.png') });
    expect(legacy).toEqual([]); expect(errors).toEqual([]);
  } finally { if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});

test('native parent and child prompts resume once through main approval chrome across two tabs', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-live-prompts-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const errors: string[] = [], legacy: string[] = [];
  let unexpectedSocketCloses = 0;
  page.on('websocket', socket => socket.on('close', () => { unexpectedSocketCloses++; }));
  page.on('pageerror', error => errors.push(error.message));
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/approvals')) legacy.push(request.url()); });
  try {
    backend = await startBackend(root, 'prompts'); await page.goto('/');
    await send(page, 'BROWSER_NATIVE_QUESTION');
    await expect(pane(page).getByRole('button', { name: 'Use repository evidence', exact: true })).toBeVisible();
    const peer = await context.newPage(); peer.on('pageerror', error => errors.push(error.message));
    await peer.goto(page.url());
    await peer.getByRole('button', { name: 'Use repository evidence', exact: true }).click();
    for (const tab of [page, peer]) {
      await expect(pane(tab).getByText('BROWSER_NATIVE_QUESTION_RESULT', { exact: true })).toBeVisible();
      await expect(pane(tab).getByRole('button', { name: 'Use repository evidence', exact: true })).toHaveCount(0);
    }
    await send(page, 'BROWSER_DELEGATE_QUESTION');
    await expect(pane(page).getByText('BROWSER_PARENT_WORK_CONTINUES', { exact: true })).toBeVisible();
    await expect(pane(peer).getByRole('checkbox', { name: 'Alpha', exact: true })).toBeVisible();
    await expect(pane(peer).getByText(/^From BROWSER_INTERACTIVE_CHILD/)).toBeVisible();
    await pane(peer).getByRole('button', { name: 'Send reply', exact: true }).scrollIntoViewIfNeeded();
    await peer.screenshot({ path: test.info().outputPath('native-child-prompt.png') });
    await pane(peer).getByRole('checkbox', { name: 'Alpha', exact: true }).check();
    await pane(peer).getByRole('checkbox', { name: 'Beta', exact: true }).check();
    await pane(peer).getByRole('button', { name: 'Send reply', exact: true }).click();
    for (const tab of [page, peer]) {
      await expect(pane(tab).getByText('BROWSER_PARENT_INTERACTION_RESULT', { exact: true })).toBeVisible();
      await expect(pane(tab).getByRole('checkbox', { name: 'Alpha', exact: true })).toHaveCount(0);
    }
    await peer.reload();
    await expect(pane(peer).getByText('BROWSER_PARENT_INTERACTION_RESULT', { exact: true })).toBeVisible();
    await expect(pane(peer).getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]); expect(legacy).toEqual([]);
    expect(unexpectedSocketCloses).toBe(0);
  } finally { if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});


test('native tool approval is shared across tabs and never executes before acceptance', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-native-approval-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  try {
    backend = await startBackend(root, 'approvals'); await page.goto('/');
    await send(page, 'BROWSER_NATIVE_APPROVAL');
    await expect(pane(page).getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    const peer = await context.newPage(); await peer.goto(page.url());
    await expect(pane(peer).getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await expect(pane(page).getByText('BROWSER_NATIVE_APPROVAL_RESULT', { exact: true })).toHaveCount(0);
    await pane(peer).getByRole('button', { name: 'Approve', exact: true }).click();
    for (const tab of [page, peer]) {
      await expect(pane(tab).getByText('BROWSER_NATIVE_APPROVAL_RESULT', { exact: true })).toBeVisible();
      await expect(pane(tab).getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    }
    await peer.reload();
    await expect(pane(peer).getByText('BROWSER_NATIVE_APPROVAL_RESULT', { exact: true })).toBeVisible();
    await expect(pane(peer).getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  } finally { if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});


test('native plan previews reject stale approval and reload reviewed contents across two tabs', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-native-plan-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  try {
    backend = await startBackend(root, 'plans'); await page.goto('/');
    await send(page, 'BROWSER_NATIVE_PLAN');
    await expect(pane(page).getByText('Browser review', { exact: true })).toBeVisible();
    await expect(pane(page).getByRole('button', { name: 'Approve plan' })).toBeEnabled();
    await expect(pane(page).getByText(/^failed$/i)).toHaveCount(0);
    const peer = await context.newPage(); await peer.goto(page.url());
    await expect(pane(peer).getByText('Browser review', { exact: true })).toBeVisible();
    await pane(peer).getByRole('textbox', { name: 'Plan feedback' }).fill('Keep my review notes');
    const paths = JSON.parse(await readFile(join(root, 'fixture-plan-paths.json'), 'utf8')) as string[];
    for (const path of paths) await writeFile(path, '# Revised browser review\nInspect revised **native** evidence.');
    await pane(peer).getByRole('button', { name: 'Approve plan' }).click();
    await expect(pane(peer).getByRole('alert')).toContainText('The plan changed');
    await expect(pane(page).getByText('BROWSER_NATIVE_PLAN_RESULT', { exact: true })).toHaveCount(0);
    await pane(peer).getByRole('button', { name: 'Reload plan' }).click();
    await expect(pane(peer).getByText('Revised browser review', { exact: true })).toBeVisible();
    await expect(pane(peer).getByRole('textbox', { name: 'Plan feedback' })).toHaveValue('Keep my review notes');
    await pane(peer).getByRole('button', { name: 'Approve plan' }).scrollIntoViewIfNeeded();
    await peer.screenshot({ path: test.info().outputPath('native-plan-preview.png') });
    await pane(peer).getByRole('button', { name: 'Approve plan' }).click();
    for (const tab of [page, peer]) {
      await expect(pane(tab).getByText('BROWSER_NATIVE_PLAN_RESULT', { exact: true })).toBeVisible();
      await expect(pane(tab).getByRole('button', { name: 'Approve plan' })).toHaveCount(0);
    }
    await peer.reload();
    await expect(pane(peer).getByText('BROWSER_NATIVE_PLAN_RESULT', { exact: true })).toBeVisible();
  } finally { if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
