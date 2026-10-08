import { test, expect, type Page } from '@playwright/test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pane, send, startBackend, stopBackend } from './fixtures/mastra';

const originalText = 'BROWSER_SKILL_SEND 🧪 $browser-review';
const editedText = 'BROWSER_SKILL_QUEUE_EDITED without the token';
const userBubble = (page: Page, marker: string) => pane(page).locator('.kodex-user-message-bubble').filter({ hasText: marker });
const queued = (page: Page) => pane(page).getByRole('region', { name: 'Queued messages', exact: true }).getByRole('group', { name: 'Queued message', exact: true });
async function selectSkill(page: Page, prefix: string) {
  const composer = pane(page).getByLabel('Message composer', { exact: true });
  if (test.info().project.use.hasTouch) await composer.tap();
  await composer.fill(`${prefix} $browser-rev`);
  const option = page.getByRole('option', { name: /browser-review/ });
  await expect(option).toBeVisible();
  if (test.info().project.use.hasTouch) await option.tap(); else await option.click();
  await expect(composer).toHaveValue(`${prefix} $browser-review `);
}
async function verify(page: Page) {
  await expect(userBubble(page, 'BROWSER_SKILL_SEND')).toHaveText(originalText);
  await expect(userBubble(page, 'BROWSER_SKILL_SEND').getByLabel('$browser-review skill', { exact: true })).toBeVisible();
  await expect(pane(page).getByText('BROWSER_SKILL_SEND_INSTRUCTIONS_RECEIVED', { exact: true })).toBeVisible();
  await expect(userBubble(page, 'BROWSER_SKILL_QUEUE_EDITED')).toHaveText(editedText);
  await expect(userBubble(page, 'BROWSER_SKILL_QUEUE_EDITED').getByLabel('$browser-review skill', { exact: true })).toHaveCount(0);
  await expect(pane(page).getByText('BROWSER_SKILL_QUEUE_INSTRUCTIONS_RECEIVED', { exact: true })).toBeVisible();
  await expect(pane(page).locator('.kodex-user-message-bubble').filter({ hasText: /BROWSER_SKILL_INSTRUCTIONS_KEEP_NATIVE|<skill name=|references\/notes\.md/ })).toHaveCount(0);
  await expect(page.getByRole('alert', { name: 'Could not load sidebar', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert', { name: 'Chat settings error', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: /AsyncIdQueue/ })).toHaveCount(0);
}

test('native selected skills retain instructions and original chips through peer queue edits and cold history', async ({ context, page }) => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-skills-browser-'));
  let backend: ChildProcessWithoutNullStreams | undefined;
  const errors: string[] = [], legacy: string[] = [];
  const observe = (tab: Page) => {
    tab.on('pageerror', error => errors.push(error.message));
    tab.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  };
  observe(page); context.on('page', observe);
  context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/')) legacy.push(request.url()); });
  try {
    backend = await startBackend(root, 'skills');
    await page.goto('/'); await expect(page.locator('.kodex-shell')).toBeVisible();
    // Pick directly from the real native draft catalog, before materializing a chat.
    await selectSkill(page, 'BROWSER_SKILL_SEND 🧪');
    await pane(page).getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(pane(page).getByText('BROWSER_SKILL_SEND_INSTRUCTIONS_RECEIVED', { exact: true })).toBeVisible();
    await expect(userBubble(page, 'BROWSER_SKILL_SEND')).toHaveText(originalText);
    await expect(userBubble(page, 'BROWSER_SKILL_SEND').getByLabel('$browser-review skill', { exact: true })).toBeVisible();
    const peer = await context.newPage(); await peer.goto(page.url());
    await expect(userBubble(peer, 'BROWSER_SKILL_SEND').getByLabel('$browser-review skill', { exact: true })).toBeVisible();

    await send(page, 'HOLD_STOP');
    for (const tab of [page, peer]) await expect(pane(tab).getByText('started:HOLD_STOP', { exact: true })).toBeVisible();
    await selectSkill(page, 'BROWSER_SKILL_QUEUE_ORIGINAL');
    await pane(page).getByRole('button', { name: 'Open attachment menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Queue message', exact: true }).click();
    for (const tab of [page, peer]) await expect(queued(tab)).toContainText('BROWSER_SKILL_QUEUE_ORIGINAL $browser-review');
    await queued(peer).getByRole('button', { name: 'Edit', exact: true }).click();
    await peer.getByLabel('Queued message text', { exact: true }).fill(editedText);
    await peer.getByRole('button', { name: 'Save queued message', exact: true }).click();
    await expect(peer.getByRole('dialog', { name: 'Edit queued message', exact: true })).toHaveCount(0);
    for (const tab of [page, peer]) await expect(queued(tab)).toContainText(editedText);
    await pane(page).getByRole('button', { name: 'Stop turn', exact: true }).click();
    // The actual native Stop releases queued work; its provider assertion checks
    // complete skill instructions even though the edited text removed the token.
    for (const tab of [page, peer]) { await expect(queued(tab)).toHaveCount(0); await verify(tab); }
    await page.screenshot({ path: test.info().outputPath('native-selected-skills.png'), fullPage: true });
    await peer.reload(); await verify(peer);
    const selected = [page.url(), peer.url()];
    // Cold persisted rendering; there is no live-reconnect claim during outage.
    await Promise.all([page.goto('about:blank'), peer.goto('about:blank')]);
    await stopBackend(backend, true); backend = await startBackend(root, 'skills');
    for (const [index, tab] of [page, peer].entries()) { await tab.goto(selected[index]); await verify(tab); }
    expect(legacy).toEqual([]); expect(errors).toEqual([]);
  } finally { if (backend) await stopBackend(backend); await rm(root, { recursive: true, force: true }); }
});
