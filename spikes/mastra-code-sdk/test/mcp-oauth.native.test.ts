import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

for (const mode of ['success', 'cancel-retry-duplicate', 'reload-during-auth', 'disable-during-auth', 'cancel-during-connect']) {
  test(`native local MCP OAuth: ${mode}`, { timeout: 20_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'kodex-mcp-oauth-'));
    await mkdir(join(root, 'synthetic-home'));
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/mcp-oauth-child.ts', import.meta.url)), mode, root], {
      env: { ...process.env, HOME: join(root, 'synthetic-home') }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    function killOwnGroup() {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    const watchdog = setTimeout(() => { timedOut = true; killOwnGroup(); }, 15_000);
    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
      });
      const events = stdout.split('\n').flatMap(line => {
        try { const value = JSON.parse(line) as Record<string, unknown>; return value.event ? [value] : []; }
        catch { return []; }
      });
      t.diagnostic(JSON.stringify({ mode, ...exit, timedOut, events, ...(exit.code === 0 ? {} : { stderr }) }));
      assert.equal(timedOut, false, 'native auth/mutation and awaited cleanup settle before fixture watchdog');
      assert.equal(exit.code, 0, stderr);
      assert.ok(events.some(value => value.event === 'finished'));
      assert.ok(events.some(value => value.event === 'cleanup-settled'));
    } finally {
      clearTimeout(watchdog);
      // Private group collection is fixture cleanup, not a native cancellation claim.
      killOwnGroup();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
