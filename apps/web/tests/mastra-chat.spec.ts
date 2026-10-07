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
  const unauthenticatedUsageReads: string[] = [];
  const connections = new Map<Page, number>();
  const observeSocket = (tab: Page) => tab.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/rpc') return;
    connections.set(tab, (connections.get(tab) ?? 0) + 1);
    socket.on('framesent', frame => {
      if (String(frame.payload).includes('/getAccountUsage')) unauthenticatedUsageReads.push('websocket/getAccountUsage');
    });
  });
  observeSocket(page);
  context.on('page', observeSocket);
  context.on('request', request => { const route = new URL(request.url()).pathname; if (route.startsWith('/v1/account') || route.endsWith('/rpc/getAccountUsage')) unauthenticatedUsageReads.push(route); });
  context.on('request', request => { if (new URL(request.url()).pathname === '/v1/events') legacyStreams.push(request.url()); });
  try {
    backend = await startBackend(root);
    await page.goto('/');
    if (test.info().project.name !== 'chromium') await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
    await page.getByRole('button', { name: 'Account settings', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Sign in with ChatGPT', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Sign in with ChatGPT', exact: true })).toBeVisible();
    await page.getByRole('dialog', { name: 'Sign in with ChatGPT' }).getByRole('button', { name: 'Close', exact: true }).click();
    if (test.info().project.name !== 'chromium') await page.getByRole('button', { name: 'Show thread', exact: true }).click();
    if (test.info().project.name === 'chromium') await page.getByRole('button', { name: 'Create thread in project', exact: true }).click();
    await pane(page).getByRole('button', { name: /^Model:/ }).click();
    await page.getByRole('menuitem', { name: 'Reasoning', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Low', exact: true }).click();
    await expect(pane(page).getByRole('button', { name: /^Model:.*low$/ })).toBeVisible();
    await send(page, 'BROWSER_HELLO');
    await expect(pane(page).getByText('fixture:BROWSER_HELLO', { exact: true })).toBeVisible();
    await expect(pane(page).locator('.kodex-user-message-bubble').filter({ hasText: 'BROWSER_HELLO' })).toHaveCount(1);
    const second = await context.newPage();
    await second.goto(page.url());
    await expect(pane(second).getByText('fixture:BROWSER_HELLO', { exact: true })).toBeVisible();
    for (const tab of [page, second]) await expect(pane(tab).getByRole('button', { name: /^Model:.*low$/ })).toBeVisible();
    // Catalog, account, chat and picker RPC share one connection per tab.
    expect(connections.get(page)).toBe(1);
    expect(connections.get(second)).toBe(1);
    await pane(second).getByRole('button', { name: /^Model:/ }).click();
    await second.getByRole('menuitem', { name: 'Reasoning', exact: true }).click();
    await second.getByRole('menuitem', { name: 'High', exact: true }).click();
    for (const tab of [page, second]) await expect(pane(tab).getByRole('button', { name: /^Model:.*high$/ })).toBeVisible();
    await send(page, 'HOLD_STOP');
    for (const tab of [page, second]) {
      await expect(pane(tab).getByText('started:HOLD_STOP', { exact: true })).toBeVisible();
      await expect(pane(tab).getByRole('button', { name: 'Stop turn', exact: true })).toBeVisible();
    }
    await send(second, 'AFTER_STOP', true);
    for (const tab of [page, second]) await expect(pane(tab).getByRole('region', { name: 'Queued messages', exact: true }).getByRole('group', { name: 'Queued message', exact: true })).toHaveCount(1);
    await send(second, 'REMOVE_ME', true);
    const queueRows = (tab: Page) => pane(tab).getByRole('region', { name: 'Queued messages', exact: true }).getByRole('group', { name: 'Queued message', exact: true });
    for (const tab of [page, second]) await expect(queueRows(tab)).toHaveCount(2);
    await queueRows(page).filter({ hasText: 'REMOVE_ME' }).getByRole('button', { name: 'Reorder queued message' }).press('ArrowUp');
    for (const tab of [page, second]) await expect(queueRows(tab).first()).toContainText('REMOVE_ME');
    await queueRows(second).filter({ hasText: 'REMOVE_ME' }).getByRole('button', { name: 'Remove', exact: true }).click();
    for (const tab of [page, second]) await expect(queueRows(tab)).toHaveCount(1);
    // Both editors capture the displayed native queue version. The stale tab
    // must preserve its draft and cannot overwrite the other tab's accepted edit.
    for (const tab of [page, second]) await queueRows(tab).getByRole('button', { name: 'Edit', exact: true }).click();
    await second.getByLabel('Queued message text', { exact: true }).fill('AFTER_STOP_EDITED');
    await second.getByRole('button', { name: 'Save queued message', exact: true }).click();
    await expect(second.getByRole('dialog', { name: 'Edit queued message' })).toHaveCount(0);
    await expect(queueRows(page)).toContainText('AFTER_STOP_EDITED');
    await page.getByLabel('Queued message text', { exact: true }).fill('STALE_EDIT');
    await page.getByRole('button', { name: 'Save queued message', exact: true }).click();
    await expect(page.getByText(/The queue changed\. Review the current queue before trying again\./)).toBeVisible();
    await expect(page.getByLabel('Queued message text', { exact: true })).toHaveValue('STALE_EDIT');
    await page.getByRole('dialog', { name: 'Edit queued message' }).getByRole('button', { name: 'Close', exact: true }).click();
    await pane(page).getByRole('button', { name: 'Reload queue', exact: true }).click();
    await pane(page).getByRole('button', { name: 'Stop turn', exact: true }).click();
    for (const tab of [page, second]) await expect(pane(tab).getByText('fixture:AFTER_STOP_EDITED', { exact: true })).toBeVisible();
    await send(page, 'READ_MARKER');
    for (const tab of [page, second]) await expect(pane(tab).getByText('fixture:READ_MARKER', { exact: true })).toBeVisible();
    await expect(pane(page).getByText('view', { exact: true })).toBeVisible();
    await second.reload();
    await expect(pane(second).getByText('fixture:READ_MARKER', { exact: true })).toBeVisible();
    await send(page, 'HOLD_RESTART');
    await expect(pane(second).getByText('started:HOLD_RESTART', { exact: true })).toBeVisible();
    await send(second, 'DROP_ON_RESTART', true);
    for (const tab of [page, second]) await expect(pane(tab).getByRole('region', { name: 'Queued messages', exact: true }).getByRole('group', { name: 'Queued message', exact: true })).toHaveCount(1);
    await stopBackend(backend, true);
    backend = await startBackend(root);
    for (const tab of [page, second]) {
      await expect(pane(tab).getByRole('button', { name: 'Stop turn', exact: true })).toHaveCount(0);
      await expect(pane(tab).getByRole('button', { name: /^Model:.*high$/ })).toBeVisible();
      await expect(pane(tab).getByText('fixture:READ_MARKER', { exact: true })).toBeVisible();
      await expect(pane(tab).locator('.kodex-user-message-bubble').filter({ hasText: 'READ_MARKER' })).toHaveCount(1);
      await expect(pane(tab).getByText('fixture:DROP_ON_RESTART', { exact: true })).toHaveCount(0);
    }
    await send(second, 'AFTER_RESTART');
    for (const tab of [page, second]) await expect(pane(tab).getByText('fixture:AFTER_RESTART', { exact: true })).toBeVisible();
    for (const tab of [page, second]) await expect(pane(tab).getByText('fixture:DROP_ON_RESTART', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('mastra-existing-kodex-ui.png'), fullPage: true });
    expect(legacyStreams).toEqual([]);
    expect(unauthenticatedUsageReads).toEqual([]);
    expect(browserErrors).toEqual([]);
  } finally {
    if (backend) await stopBackend(backend);
    await rm(root, { recursive: true, force: true });
  }
});

async function showSidebar(page: Page) {
  await expect(page.locator('.kodex-shell')).toBeVisible();
  const button = page.getByRole('button', { name: 'Show sidebar', exact: true });
  if (await button.isVisible()) await button.click();
}

test('project controls share canonical membership while retained chats survive deletion and restart', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-project-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const legacyProjects: string[] = [];
  const browserErrors: string[] = [];
  context.on('request', request => {
    if (/^\/v1\/(projects|directories)(\/|$)/.test(new URL(request.url()).pathname)) legacyProjects.push(request.url());
  });
  page.on('pageerror', error => browserErrors.push(error.message));
  context.on('page', tab => tab.on('pageerror', error => browserErrors.push(error.message)));
  try {
    backend = await startBackend(root);
    await page.goto('/');
    const second = await context.newPage();
    await second.goto('/');
    await showSidebar(page);
    await showSidebar(second);
    await page.getByRole('button', { name: 'Add project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add project', exact: true });
    await dialog.getByRole('button', { name: 'added-project', exact: true }).click();
    await dialog.getByRole('button', { name: 'Use this directory', exact: true }).click();
    await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(second.getByRole('button', { name: 'Project settings for added-project', exact: true })).toBeVisible();
    await send(page, 'PROJECT_CHAT');
    await expect(pane(page).getByText('fixture:PROJECT_CHAT', { exact: true })).toBeVisible();
    const chatUrl = page.url();
    await second.getByRole('button', { name: 'Project settings for added-project', exact: true }).click();
    const roots = second.getByRole('textbox', { name: 'Root directories', exact: true });
    const originalRoot = await roots.inputValue();
    await second.getByRole('textbox', { name: 'Project name', exact: true }).fill('Renamed project');
    await second.getByRole('button', { name: 'Save project', exact: true }).click();
    await expect(second.getByRole('heading', { name: 'Renamed project', exact: true })).toBeVisible();
    await showSidebar(page);
    await expect(page.getByRole('button', { name: 'Project settings for Renamed project', exact: true })).toBeVisible();
    await roots.fill(originalRoot.replace(/added-project$/, 'changed-root'));
    await second.getByRole('button', { name: 'Save project', exact: true }).click();
    await expect(second.getByRole('button', { name: 'Save project', exact: true })).toBeDisabled();
    await second.getByRole('button', { name: 'Delete project', exact: true }).click();
    await second.getByRole('dialog', { name: 'Delete Renamed project?', exact: true }).getByRole('button', { name: 'Delete project', exact: true }).click();
    for (const tab of [page, second]) {
      await showSidebar(tab);
      await expect(tab.getByRole('button', { name: 'Project settings for Renamed project', exact: true })).toHaveCount(0);
    }
    await second.goto(chatUrl);
    await expect(pane(second).getByText('fixture:PROJECT_CHAT', { exact: true })).toBeVisible();
    await send(second, 'DETACHED_CHAT');
    await expect(pane(second).getByText('fixture:DETACHED_CHAT', { exact: true })).toBeVisible();
    await stopBackend(backend, true);
    backend = await startBackend(root);
    await expect(pane(second).getByText('fixture:DETACHED_CHAT', { exact: true })).toBeVisible();
    await send(second, 'DETACHED_AFTER_RESTART');
    await expect(pane(second).getByText('fixture:DETACHED_AFTER_RESTART', { exact: true })).toBeVisible();
    await showSidebar(second);
    await expect(second.getByRole('button', { name: 'Project settings for Renamed project', exact: true })).toHaveCount(0);
    expect(legacyProjects).toEqual([]);
    expect(browserErrors).toEqual([]);
  } finally {
    if (backend) await stopBackend(backend);
    await rm(root, { recursive: true, force: true });
  }
});
