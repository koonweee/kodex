import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

async function startBackend(root: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/browser-server.ts', root, '18789'], {
    cwd: resolve('../../spikes/mastra-code-sdk'), stdio: 'pipe',
  });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-8000); });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Fixture startup timed out: ${diagnostics}`)); }, 40_000);
    child.stdout.on('data', chunk => {
      diagnostics = (diagnostics + String(chunk)).slice(-8000);
      if (diagnostics.includes('BROWSER_FIXTURE_READY')) { clearTimeout(timer); done(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${diagnostics}`)); });
  });
  return child;
}
async function stopBackend(child: ChildProcessWithoutNullStreams, crash = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(crash ? 'SIGKILL' : 'SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try { await exited; } finally { clearTimeout(timer); }
}
const pane = (page: Page) => page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
async function send(page: Page, text: string, queue = false) {
  const composer = pane(page).getByLabel('Message composer', { exact: true });
  if (test.info().project.use.hasTouch) await composer.tap();
  await composer.fill(text);
  if (queue) {
    await pane(page).getByRole('button', { name: 'Open attachment menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Queue message', exact: true }).click();
  } else await pane(page).getByRole('button', { name: 'Send message', exact: true }).click();
}

test('existing Kodex UI shares native streaming, queue/stop, tool history and restart state across two tabs', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const browserErrors: string[] = [];
  context.on('page', opened => opened.on('pageerror', error => browserErrors.push(error.message)));
  page.on('pageerror', error => browserErrors.push(error.message));
  const legacyStreams: string[] = [];
  context.on('request', request => { if (new URL(request.url()).pathname === '/v1/events') legacyStreams.push(request.url()); });
  try {
    backend = await startBackend(root);
    await page.goto('/');
    if (test.info().project.name === 'chromium') await page.getByRole('button', { name: 'Create thread in project', exact: true }).click();
    await send(page, 'BROWSER_HELLO');
    await expect(pane(page).getByText('fixture:BROWSER_HELLO', { exact: true })).toBeVisible();
    await expect(pane(page).locator('.kodex-user-message-bubble').filter({ hasText: 'BROWSER_HELLO' })).toHaveCount(1);
    const second = await context.newPage();
    await second.goto(page.url());
    await expect(pane(second).getByText('fixture:BROWSER_HELLO', { exact: true })).toBeVisible();
    await send(page, 'HOLD_STOP');
    for (const tab of [page, second]) {
      await expect(pane(tab).getByText('started:HOLD_STOP', { exact: true })).toBeVisible();
      await expect(pane(tab).getByRole('button', { name: 'Stop turn', exact: true })).toBeVisible();
    }
    await send(second, 'AFTER_STOP', true);
    for (const tab of [page, second]) await expect(pane(tab).getByText('1 queued follow-up', { exact: true })).toBeVisible();
    await pane(page).getByRole('button', { name: 'Stop turn', exact: true }).click();
    for (const tab of [page, second]) await expect(pane(tab).getByText('fixture:AFTER_STOP', { exact: true })).toBeVisible();
    await send(page, 'READ_MARKER');
    for (const tab of [page, second]) await expect(pane(tab).getByText('fixture:READ_MARKER', { exact: true })).toBeVisible();
    await expect(pane(page).getByText('view', { exact: true })).toBeVisible();
    await second.reload();
    await expect(pane(second).getByText('fixture:READ_MARKER', { exact: true })).toBeVisible();
    await send(page, 'HOLD_RESTART');
    await expect(pane(second).getByText('started:HOLD_RESTART', { exact: true })).toBeVisible();
    await send(second, 'DROP_ON_RESTART', true);
    for (const tab of [page, second]) await expect(pane(tab).getByText('1 queued follow-up', { exact: true })).toBeVisible();
    await stopBackend(backend, true);
    backend = await startBackend(root);
    for (const tab of [page, second]) {
      await expect(pane(tab).getByRole('button', { name: 'Stop turn', exact: true })).toHaveCount(0);
      await expect(pane(tab).getByText('fixture:READ_MARKER', { exact: true })).toBeVisible();
      await expect(pane(tab).locator('.kodex-user-message-bubble').filter({ hasText: 'READ_MARKER' })).toHaveCount(1);
      await expect(pane(tab).getByText('fixture:DROP_ON_RESTART', { exact: true })).toHaveCount(0);
    }
    await send(second, 'AFTER_RESTART');
    for (const tab of [page, second]) await expect(pane(tab).getByText('fixture:AFTER_RESTART', { exact: true })).toBeVisible();
    for (const tab of [page, second]) await expect(pane(tab).getByText('fixture:DROP_ON_RESTART', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('mastra-existing-kodex-ui.png'), fullPage: true });
    expect(legacyStreams).toEqual([]);
    expect(browserErrors).toEqual([]);
  } finally {
    if (backend) await stopBackend(backend);
    await rm(root, { recursive: true, force: true });
  }
});
