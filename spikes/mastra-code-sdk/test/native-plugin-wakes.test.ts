import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

async function proof(t: TestContext, fixture: string, marker: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-plugin-wakes-')));
  await mkdir(join(root, 'outside-home'));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url)), root], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: join(root, 'outside-home') },
  });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const collect = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
  const watchdog = setTimeout(() => { timedOut = true; collect(); }, 50_000);
  t.after(async () => { clearTimeout(watchdog); collect(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  process.stdout.write(stdout);
  assert.equal(timedOut, false, `${stdout}\n${stderr}`);
  assert.equal(exit, 0, `${stdout}\n${stderr}`);
  assert.ok(stdout.includes(marker), stdout);
  assert.doesNotMatch(stderr, /CLIENT_CLOSED|Failed to load plugin/);
}

test('native plugin wakes characterize mounted and released child execution boundaries', { timeout: 60_000 }, t =>
  proof(t, 'native-plugin-wakes-child.ts', 'PLUGIN_WAKE_PROOF_COMPLETE'));

test('native pre-finalize provider stop retains plugin tools and reload across two Sessions', { timeout: 60_000 }, t =>
  proof(t, 'native-plugin-wakes-tools-only.ts', 'PLUGIN_TOOLS_ONLY_PROOF_COMPLETE'));
