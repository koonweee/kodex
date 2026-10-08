import { test, type Page } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';

export async function startBackend(root: string, seed?: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/browser-server.ts', root, '18789', ...(seed ? [seed] : [])], {
    cwd: resolve('../../spikes/mastra-code-sdk'), stdio: 'pipe',
    ...(seed === 'mcp' && { env: { ...process.env, HOME: root } }),
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
export async function stopBackend(child: ChildProcessWithoutNullStreams, crash = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(crash ? 'SIGKILL' : 'SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try { await exited; } finally { clearTimeout(timer); }
}
export const pane = (page: Page) => page.locator('.kodex-thread-pane[data-workspace-pane-active="true"]');
export async function send(page: Page, text: string, queue = false) {
  const composer = pane(page).getByLabel('Message composer', { exact: true });
  if (test.info().project.use.hasTouch) await composer.tap();
  await composer.fill(text);
  if (queue) {
    await pane(page).getByRole('button', { name: 'Open attachment menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Queue message', exact: true }).click();
  } else await pane(page).getByRole('button', { name: 'Send message', exact: true }).click();
}
