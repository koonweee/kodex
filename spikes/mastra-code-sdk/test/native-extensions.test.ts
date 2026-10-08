import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('native mounted extensions preserve concurrent tool origins; reload and hooks retain native semantics', { timeout: 50_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-native-extensions-')));
  await mkdir(join(root, 'outside-home'));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/native-extensions-child.ts', import.meta.url)), root], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: join(root, 'outside-home') },
  });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const collectOwnGroup = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  const watchdog = setTimeout(() => { timedOut = true; collectOwnGroup(); }, 40_000);
  t.after(async () => { clearTimeout(watchdog); collectOwnGroup(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  process.stdout.write(stdout);
  assert.equal(timedOut, false, `${stdout}\n${stderr}`);
  assert.equal(exit.code, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /EXTENSION_PROOF_COMPLETE/);
  assert.doesNotMatch(stderr, /CLIENT_CLOSED|Failed to load plugin|failed to start/);
  // The fixture exits explicitly after awaited native cleanup. Final collection
  // is isolated watchdog hygiene, not proof of natural exit or arbitrary joins.
});
