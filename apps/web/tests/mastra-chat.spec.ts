import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

async function startBackend(root: string, seed?: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/browser-server.ts', root, '18789', ...(seed ? [seed] : [])], {
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
    for (const tab of [page, second]) await expect(pane(tab).getByText(/BROWSER_TOOL_MARKER/)).toBeVisible();
    await second.reload();
    await expect(pane(second).getByText(/BROWSER_TOOL_MARKER/)).toBeVisible();
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

async function openChatActions(page: Page) {
  const showThread = page.getByRole('button', { name: 'Show thread', exact: true });
  if (await showThread.isVisible()) await showThread.click();
  const activeHost = page.locator('.dv-groupview.dv-active-group:visible, .kodex-workspace-single-pane-shell:visible');
  await activeHost.getByRole('button', { name: 'Thread actions', exact: true }).click();
}

test('pins, order and notification preferences converge across tabs and backend restart', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-pins-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const errors: string[] = [];
  const legacy: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)));
  context.on('request', request => {
    if (/^\/v1\/(pins|pinned-threads|threads\/[^/]+\/(pin|notifications|name))/.test(new URL(request.url()).pathname)) legacy.push(request.url());
  });
  const pinnedRows = (tab: Page) => tab.getByRole('group', { name: 'Pinned', exact: true }).locator('.kodex-thread-list-button');
  try {
    backend = await startBackend(root);
    await page.goto('/');
    await send(page, 'PIN_STANDALONE');
    await expect(pane(page).getByText('fixture:PIN_STANDALONE', { exact: true })).toBeVisible();
    const firstUrl = page.url();
    await openChatActions(page);
    await page.getByRole('menuitem', { name: 'Pin thread', exact: true }).click();
    const second = await context.newPage();
    await second.goto(firstUrl);
    await expect(pane(second).getByText('fixture:PIN_STANDALONE', { exact: true })).toBeVisible();
    await openChatActions(second);
    await expect(second.getByRole('menuitem', { name: 'Unpin thread', exact: true })).toBeVisible();
    await second.getByRole('menuitem', { name: 'Notifications', exact: true }).click();
    await expect(second.getByRole('menuitem', { name: 'Notifications', exact: true })).toHaveAttribute('aria-checked', 'false');
    await second.keyboard.press('Escape');
    await openChatActions(second);
    await second.getByRole('menuitem', { name: 'Rename thread', exact: true }).click();
    const rename = second.getByRole('dialog', { name: 'Rename thread', exact: true });
    await rename.getByRole('textbox', { name: 'Thread name', exact: true }).fill('Pinned standalone renamed');
    await rename.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(rename).not.toBeVisible();
    for (const tab of [page, second]) await expect(pane(tab)).toHaveAttribute('aria-label', 'Pinned standalone renamed');
    await openChatActions(page);
    await expect(page.getByRole('menuitem', { name: 'Notifications', exact: true })).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');
    await showSidebar(page);
    await page.getByRole('button', { name: 'Create thread in project', exact: true }).click();
    await send(page, 'PIN_PROJECT');
    await expect(pane(page).getByText('fixture:PIN_PROJECT', { exact: true })).toBeVisible();
    const secondUrl = page.url();
    expect(secondUrl).not.toBe(firstUrl);
    await openChatActions(page);
    await page.getByRole('menuitem', { name: 'Pin thread', exact: true }).click();
    for (const tab of [page, second]) { await showSidebar(tab); await expect(pinnedRows(tab)).toHaveCount(2); }
    await expect(pinnedRows(page).last()).toHaveAttribute('data-active', 'true');
    const moving = pinnedRows(page).last();
    if (!test.info().project.use.hasTouch) await moving.hover();
    await moving.getByRole('button', { name: /^Thread actions for / }).click();
    await page.getByRole('menuitem', { name: 'Move up', exact: true }).click();
    await expect(pinnedRows(page).first()).toHaveAttribute('data-active', 'true');
    await expect(pinnedRows(second).last()).toHaveAttribute('data-active', 'true');
    await stopBackend(backend, true);
    backend = await startBackend(root);
    // Reopen native history to prove this is persisted metadata, not a retained
    // browser projection surviving the disconnect.
    await page.reload(); await second.reload();
    for (const tab of [page, second]) { await showSidebar(tab); await expect(pinnedRows(tab)).toHaveCount(2); }
    await expect(pinnedRows(page).first()).toHaveAttribute('data-active', 'true');
    await expect(pinnedRows(second).last()).toHaveAttribute('data-active', 'true');
    await expect(pane(second)).toHaveAttribute('aria-label', 'Pinned standalone renamed');
    await expect(pinnedRows(page).last()).toContainText('Pinned standalone renamed');
    await openChatActions(second);
    await expect(second.getByRole('menuitem', { name: 'Notifications', exact: true })).toHaveAttribute('aria-checked', 'false');
    await second.getByRole('menuitem', { name: 'Unpin thread', exact: true }).click();
    for (const tab of [page, second]) { await showSidebar(tab); await expect(pinnedRows(tab)).toHaveCount(1); }
    expect(legacy).toEqual([]); expect(errors).toEqual([]);
  } catch (failure) {
    await test.info().attach('metadata-tab-diagnostics', { body: JSON.stringify({ errors, tabs: await Promise.all(context.pages().map(tab => tab.locator('body').innerText().catch(() => 'Unavailable'))) }), contentType: 'application/json' });
    throw failure;
  } finally {
    if (backend) await stopBackend(backend);
    await rm(root, { recursive: true, force: true });
  }
});

test('archive stops queued work and closes the selected chat across tabs and restart', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-archive-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const errors: string[] = [], legacy: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)));
  context.on('request', request => { if (/^\/v1\/threads\/[^/]+\/archive$/.test(new URL(request.url()).pathname)) legacy.push(request.url()); });
  try {
    backend = await startBackend(root);
    await page.goto('/'); await send(page, 'ARCHIVE_SAVED_HISTORY');
    await expect(pane(page).getByText('fixture:ARCHIVE_SAVED_HISTORY', { exact: true })).toBeVisible();
    const savedUrl = page.url();
    const archivedId = await pane(page).getAttribute('data-thread-id');
    expect(archivedId).toBeTruthy();
    await openChatActions(page);
    await page.getByRole('menuitem', { name: 'Pin thread', exact: true }).click();
    const second = await context.newPage(); await second.goto(savedUrl);
    await expect(pane(second).getByText('fixture:ARCHIVE_SAVED_HISTORY', { exact: true })).toBeVisible();
    await send(page, 'HOLD_STOP');
    await expect(pane(page).getByRole('button', { name: 'Stop turn', exact: true })).toBeVisible();
    await send(second, 'ARCHIVE_WAITING_INPUT', true);
    await openChatActions(page);
    await page.getByRole('menuitem', { name: 'Archive thread', exact: true }).click();
    for (const tab of [page, second]) {
      await expect(tab.locator(`.kodex-thread-pane[data-thread-id="${archivedId}"]`)).toHaveCount(0);
      await showSidebar(tab);
      await expect(tab.getByRole('group', { name: 'Pinned', exact: true }).locator('.kodex-thread-list-button')).toHaveCount(0);
      await expect(tab).not.toHaveURL(savedUrl);
    }
    await stopBackend(backend, true); backend = await startBackend(root);
    await page.reload(); await second.goto(savedUrl);
    for (const tab of [page, second]) {
      await expect(tab.locator('.kodex-shell')).toBeVisible();
      await expect(tab.locator(`.kodex-thread-pane[data-thread-id="${archivedId}"]`)).toHaveCount(0);
      await expect(tab).not.toHaveURL(savedUrl);
      await showSidebar(tab);
      await expect(tab.getByText('ARCHIVE_SAVED_HISTORY', { exact: true })).toHaveCount(0);
    }
    const showThread = page.getByRole('button', { name: 'Show thread', exact: true });
    if (await showThread.isVisible()) await showThread.click();
    await send(page, 'AFTER_ARCHIVE_NEW_CHAT');
    await expect(pane(page).getByText('fixture:AFTER_ARCHIVE_NEW_CHAT', { exact: true })).toBeVisible();
    expect(legacy).toEqual([]); expect(errors).toEqual([]);
  } finally {
    if (backend) await stopBackend(backend);
    await rm(root, { recursive: true, force: true });
  }
});


test('native goals share pause, replacement, resume and clear across tabs and restart', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-goals-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const errors: string[] = [], legacyGoals: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  context.on('page', tab => tab.on('pageerror', error => errors.push(error.message)));
  context.on('request', request => { if (/\/v1\/threads\/[^/]+\/goal/.test(new URL(request.url()).pathname)) legacyGoals.push(request.url()); });
  const manage = (tab: Page, status: string) => tab.getByRole('button', { name: `Manage goal: ${status}`, exact: true });
  const dialog = (tab: Page) => tab.getByRole('dialog', { name: 'Goal', exact: true });
  try {
    backend = await startBackend(root);
    await page.goto('/');
    await send(page, 'GOAL_CHAT');
    await expect(pane(page).getByText('fixture:GOAL_CHAT', { exact: true })).toBeVisible();
    const second = await context.newPage(); await second.goto(page.url());
    await expect(pane(second).getByText('fixture:GOAL_CHAT', { exact: true })).toBeVisible();
    await send(page, 'HOLD_STOP');
    await expect(pane(page).getByText('started:HOLD_STOP', { exact: true })).toBeVisible();
    await send(page, '/goal BROWSER_GOAL_ORIGINAL');
    await expect(manage(second, 'Active')).toBeVisible();
    await manage(second, 'Active').click();
    await expect(dialog(second).getByLabel('Token budget', { exact: true })).toHaveCount(0);
    await dialog(second).getByRole('button', { name: 'Pause goal', exact: true }).click();
    await expect(manage(page, 'Paused')).toBeVisible();
    await dialog(second).getByRole('button', { name: 'Close goal', exact: true }).click();
    await pane(page).getByRole('button', { name: 'Stop turn', exact: true }).click();
    await expect(pane(page).getByRole('button', { name: 'Stop turn', exact: true })).toHaveCount(0);
    await manage(page, 'Paused').click();
    await dialog(page).getByRole('textbox', { name: 'Objective', exact: true }).fill('BROWSER_GOAL_REPLACEMENT');
    await dialog(page).getByRole('button', { name: 'Save goal', exact: true }).click();
    await manage(second, 'Paused').click();
    await expect(dialog(second).getByRole('textbox', { name: 'Objective', exact: true })).toHaveValue('BROWSER_GOAL_REPLACEMENT');
    await expect(dialog(second)).toContainText('0 evaluations');
    await dialog(second).getByRole('button', { name: 'Close goal', exact: true }).click();
    await stopBackend(backend, true); backend = await startBackend(root);
    await second.reload();
    await expect(manage(second, 'Paused')).toBeVisible();
    await manage(second, 'Paused').click();
    await expect(dialog(second).getByRole('textbox', { name: 'Objective', exact: true })).toHaveValue('BROWSER_GOAL_REPLACEMENT');
    await dialog(second).getByRole('button', { name: 'Resume goal', exact: true }).click();
    await expect(manage(page, 'Complete')).toBeVisible();
    await expect(dialog(second)).toContainText('1 evaluation');
    await second.screenshot({ path: test.info().outputPath('mastra-native-goal.png'), fullPage: true });
    await dialog(second).getByRole('button', { name: 'Clear goal', exact: true }).click();
    for (const tab of [page, second]) await expect(tab.getByRole('button', { name: /^Manage goal:/ })).toHaveCount(0);
    expect(legacyGoals).toEqual([]); expect(errors).toEqual([]);
  } finally {
    if (backend) await stopBackend(backend);
    await rm(root, { recursive: true, force: true });
  }
});


test('native history loads older rows independently and retains them after peer sends and restart', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-history-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const rows = (tab: Page) => pane(tab).locator('.kodex-user-message-bubble');
  const scrollTop = async (tab: Page) => {
    const scroller = pane(tab).locator('.kodex-thread-pane-scroll');
    await scroller.hover(); await tab.mouse.wheel(0, -100000);
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeLessThan(2);
  };
  try {
    backend = await startBackend(root, 'history');
    await page.goto('/'); await showSidebar(page);
    await page.getByText('History paging fixture', { exact: true }).click();
    await expect(pane(page).getByText('HISTORY_ROW_99', { exact: true })).toBeVisible();
    const second = await context.newPage(); second.on('pageerror', error => errors.push(error.message));
    await second.goto(page.url()); await expect(pane(second).getByText('HISTORY_ROW_99', { exact: true })).toBeVisible();
    await scrollTop(page);
    await pane(page).getByRole('button', { name: 'Load older history', exact: true }).click();
    await expect(pane(page).getByRole('button', { name: 'Loading older history', exact: true })).toHaveCount(0);
    await scrollTop(page);
    await expect(pane(page).getByText('HISTORY_ROW_20', { exact: true })).toBeVisible();
    await scrollTop(second);
    await expect(pane(second).getByText('HISTORY_ROW_60', { exact: true })).toBeVisible();
    await expect(rows(second).filter({ hasText: /^HISTORY_ROW_20$/ })).toHaveCount(0);
    await pane(second).locator('.kodex-thread-pane-scroll').hover(); await second.mouse.wheel(0, 100000);
    await expect(pane(second).getByText('HISTORY_ROW_99', { exact: true })).toBeVisible();
    await send(second, 'HISTORY_NEW_ARRIVAL');
    await expect(pane(second).getByText('HISTORY_REPLY', { exact: true })).toBeVisible();
    await scrollTop(page);
    await expect(rows(page).filter({ hasText: /^HISTORY_ROW_20$/ })).toHaveCount(1);
    await stopBackend(backend, true); backend = await startBackend(root);
    await expect(pane(page).getByRole('button', { name: /^Model:/ })).toBeVisible();
    await scrollTop(page);
    await pane(page).getByRole('button', { name: 'Load older history', exact: true }).click();
    await expect(pane(page).getByRole('button', { name: 'Load older history', exact: true })).toHaveCount(0);
    await scrollTop(page);
    await expect(rows(page).filter({ hasText: /^HISTORY_ROW_0$/ })).toHaveCount(1);
    await expect(pane(page).getByRole('button', { name: 'Load older history', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});


test('native image tool results open the shared viewer and survive peer reload and restart', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-image-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const legacyPreviews: string[] = [];
  const errors: string[] = [];
  context.on('request', request => { if (new URL(request.url()).pathname.includes('/files/preview')) legacyPreviews.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  const imageButton = (tab: Page) => pane(tab).getByRole('button', { name: 'Open pixel.png', exact: true });
  const imageLoaded = async (tab: Page) => {
    await expect(imageButton(tab)).toBeVisible();
    await expect.poll(() => imageButton(tab).locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
  };
  try {
    backend = await startBackend(root);
    await page.goto('/'); await send(page, 'READ_IMAGE');
    await expect(pane(page).getByText('fixture:READ_IMAGE', { exact: true })).toBeVisible();
    await imageLoaded(page);
    const second = await context.newPage(); second.on('pageerror', error => errors.push(error.message));
    await second.goto(page.url()); await imageLoaded(second);
    await imageButton(page).click();
    await expect(page.getByRole('dialog').locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await page.getByRole('button', { name: 'Close image preview', exact: true }).click();
    await second.reload(); await imageLoaded(second);
    await stopBackend(backend, true); backend = await startBackend(root);
    await second.reload(); await imageLoaded(second);
    await imageButton(second).click();
    await expect(second.getByRole('dialog').locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    expect(legacyPreviews).toEqual([]); expect(errors).toEqual([]);
  } finally { if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});


test('native shell output uses main command rendering without an invented success across tabs and restart', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-shell-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const verify = async (tab: Page) => {
    await expect(pane(tab).getByText('Shell', { exact: true })).toBeVisible();
    await expect(pane(tab).locator('.kodex-command-panel')).toContainText("$ printf 'NATIVE_SHELL_OUTPUT");
    await expect(pane(tab).locator('.kodex-timeline-output')).toContainText('NATIVE_SHELL_OUTPUT');
    await expect(pane(tab).locator('.kodex-timeline-output')).toContainText('Exit code: 7');
    await expect(pane(tab).getByText('Finished', { exact: true })).toBeVisible();
    await expect(pane(tab).getByText('Success', { exact: true })).toHaveCount(0);
  };
  try {
    backend = await startBackend(root);
    await page.goto('/'); await send(page, 'RUN_SHELL_FAILURE');
    await expect(pane(page).getByText('fixture:RUN_SHELL_FAILURE', { exact: true })).toBeVisible();
    await verify(page);
    const second = await context.newPage(); second.on('pageerror', error => errors.push(error.message));
    await second.goto(page.url()); await verify(second);
    await second.reload(); await verify(second);
    await stopBackend(backend, true); backend = await startBackend(root);
    await second.reload(); await verify(second);
    await second.screenshot({ path: test.info().outputPath('native-shell.png') });
    expect(errors).toEqual([]);
  } finally { if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});


test('native subagent inspection reuses main viewer across peers and restart', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-subagents-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const show = async (tab: Page) => {
    await tab.getByRole('button', { name: 'Show subagents', exact: true }).click();
    const viewer = tab.getByRole('complementary', { name: 'Subagent thread viewer' });
    await expect(viewer).toBeVisible();
    return viewer;
  };
  try {
    backend = await startBackend(root);
    await page.goto('/'); await send(page, 'BROWSER_PARENT_DEFAULT');
    await expect(pane(page).getByText('BROWSER_PARENT_RESULT_DEFAULT', { exact: true })).toBeVisible();
    let viewer = await show(page);
    await expect(viewer.getByText('BROWSER_CHILD_RESULT_DEFAULT', { exact: true })).toBeVisible();
    await expect(viewer.getByText('Read-only', { exact: true })).toBeVisible();
    const peer = await context.newPage(); peer.on('pageerror', error => errors.push(error.message));
    await peer.goto(page.url());
    await expect((await show(peer)).getByText('BROWSER_CHILD_RESULT_DEFAULT', { exact: true })).toBeVisible();
    await stopBackend(backend, true); backend = await startBackend(root);
    await peer.reload();
    await expect((await show(peer)).getByText('BROWSER_CHILD_RESULT_DEFAULT', { exact: true })).toBeVisible();
    await page.reload(); await send(page, 'BROWSER_PARENT_FORKED');
    await expect(pane(page).getByText('BROWSER_PARENT_RESULT_FORKED', { exact: true })).toBeVisible();
    viewer = await show(page);
    await viewer.getByRole('textbox', { name: 'Subagent', exact: true }).click();
    await page.getByRole('option', { name: /Fork history/ }).click();
    await expect(viewer.getByText('BROWSER_CHILD_RESULT_FORKED', { exact: true })).toBeVisible();
    await expect(viewer.getByText('BROWSER_TOOL_MARKER', { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('native-subagent-viewer.png') });
    expect(errors).toEqual([]);
  } finally { if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});


test('native file summaries preserve real replacement failures across peers and restart', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-file-operation-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const verify = async (tab: Page) => {
    const operations = pane(tab).locator('.kodex-file-change-block');
    await expect(operations).toHaveCount(2);
    await expect(operations.first()).toContainText('marker.txt');
    await expect(operations.first()).toContainText('Replaced 1 occurrence in marker.txt');
    await expect(operations.last()).toContainText('The specified text was not found.');
    await expect(pane(tab).getByText('Modified', { exact: true })).toHaveCount(0);
    await expect(pane(tab).getByText(/^[0-9]+ files? changed$/)).toHaveCount(0);
    await expect(pane(tab).locator('.kodex-file-change-diff')).toHaveCount(0);
  };
  try {
    backend = await startBackend(root); await page.goto('/');
    await send(page, 'REPLACE_MARKER'); await expect(pane(page).getByText('fixture:REPLACE_MARKER', { exact: true })).toBeVisible();
    await send(page, 'REPLACE_MISSING'); await expect(pane(page).getByText('fixture:REPLACE_MISSING', { exact: true })).toBeVisible();
    await verify(page);
    const peer = await context.newPage(); peer.on('pageerror', error => errors.push(error.message));
    await peer.goto(page.url()); await verify(peer); await peer.reload(); await verify(peer);
    await stopBackend(backend, true); backend = await startBackend(root);
    await peer.reload(); await verify(peer);
    await peer.screenshot({ path: test.info().outputPath('native-file-summaries.png') });
    expect(errors).toEqual([]);
  } finally { if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
