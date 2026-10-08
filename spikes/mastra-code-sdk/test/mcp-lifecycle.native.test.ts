import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

interface Evidence { event: string; [key: string]: unknown }
async function characterize(mode: string) {
  const root = await mkdtemp(join(tmpdir(), `kodex-mcp-lifecycle-${mode}-`));
  await mkdir(join(root, 'synthetic-home'));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/mcp-lifecycle-child.ts', import.meta.url)), mode, root], {
    env: { ...process.env, HOME: join(root, 'synthetic-home') },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  // A private POSIX process group owns this child, tsx workers and stdio server.
  // No name matching or unrelated PID enumeration is used for watchdog cleanup.
  function killOwnGroup() {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  const watchdog = setTimeout(() => { timedOut = true; killOwnGroup(); }, 8_000);
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const events: Evidence[] = stdout.split('\n').flatMap(line => {
      try { const value: unknown = JSON.parse(line); return typeof value === 'object' && value !== null && 'event' in value ? [value as Evidence] : []; }
      catch { return []; }
    });
    const trace = await readFile(join(root, 'server-trace.jsonl'), 'utf8').catch(() => '');
    function ownGroupAlive() {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; return false; }
    }
    const groupAliveImmediately = ownGroupAlive();
    // Whole-process exit closes pipes asynchronously. This one fixture-only
    // observation allows EOF cleanup before classifying a surviving child.
    if (mode.endsWith('-exit')) {
      for (let attempt = 0; attempt < 100 && ownGroupAlive(); attempt++) await delay(10);
    }
    const groupAlive = ownGroupAlive();
    let groupMembers: string[] = [];
    if (mode.endsWith('-exit') && groupAlive) {
      const listing = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { timeout: 1_000 });
      groupMembers = listing.stdout.split('\n').filter(line => line.trim().split(/\s+/)[2] === String(child.pid));
    }
    const serverPids = [...new Set(trace.split('\n').filter(Boolean).map(line => Number((JSON.parse(line) as Evidence).pid)))];
    const serverPidsAlive = serverPids.filter(pid => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; return false; }
    });
    return { mode, ...exit, timedOut, groupAliveImmediately, groupAlive, groupMembers, serverPidsAlive, events, trace, stderr };
  } finally {
    clearTimeout(watchdog);
    // Also collect any group member left after an assertion/error exits its owner.
    killOwnGroup();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

for (const mode of ['success', 'runtime-success', 'missing', 'silent-initialize', 'disconnect-during-init', 'runtime-disconnect-during-init', 'disconnect-during-discovery', 'runtime-disconnect-during-init-exit']) {
  test(`native MCP lifecycle characterization: ${mode}`, { timeout: 15_000 }, async t => {
    const evidence = await characterize(mode);
    t.diagnostic(JSON.stringify(evidence));
    const serverEvents = evidence.trace.split('\n').filter(Boolean).map(line => JSON.parse(line) as Evidence);
    const initialize = serverEvents.filter(event => event.method === 'initialize');
    if (['success', 'runtime-success', 'missing'].includes(mode)) {
      assert.equal(evidence.timedOut, false, 'completed native cleanup permits natural process exit');
      assert.equal(evidence.code, 0, evidence.stderr);
      assert.equal(evidence.groupAlive, false, 'healthy native cleanup leaves no fixture-group child before final cleanup');
      assert.deepEqual(evidence.serverPidsAlive, []);
      assert.ok(evidence.events.some(event => event.event === 'finished'));
      assert.ok(evidence.events.some(event => event.event === 'disconnect-settled'));
      if (mode !== 'missing') {
        assert.equal(initialize.length, 1);
        assert.ok(serverEvents.some(event => event.pid === initialize[0]!.pid && event.event === 'exit' && event.code === 0), 'responsive initialized stdio server exits before fixture-group cleanup');
      }
    } else if (mode === 'silent-initialize') {
      assert.equal(evidence.timedOut, true, 'native initialization remains pending for the bounded observation window');
      assert.match(evidence.trace, /"method":"initialize"/);
      assert.ok(!evidence.events.some(event => event.event === 'init-settled'));
    } else if (mode.endsWith('-exit')) {
      assert.equal(evidence.timedOut, false);
      assert.equal(evidence.groupAlive, false, 'entrypoint exit leaves no fixture-group member after EOF settling and before forced cleanup');
      assert.deepEqual(evidence.serverPidsAlive, []);
      assert.equal(evidence.code, 0, evidence.stderr);
      assert.ok(evidence.events.some(event => event.event === 'init-pending' && event.initSettled === false));
      assert.ok(evidence.events.some(event => event.event === 'disconnect-settled'));
      assert.ok(evidence.events.some(event => event.event === 'entrypoint-exit'));
      assert.ok(!evidence.events.some(event => event.event === 'init-settled'));
    } else {
      assert.match(evidence.trace, mode.includes('discovery') ? /"method":"server\/discover"/ : /"method":"initialize"/);
      assert.ok(evidence.events.some(event => event.event === 'init-pending' && event.initSettled === false));
      assert.ok(evidence.events.some(event => event.event === 'disconnect-start'));
      const disconnected = evidence.events.find(event => event.event === 'disconnect-settled');
      assert.ok(disconnected, 'native disconnect/disposal returns before the unfinished init producer');
      assert.equal(evidence.timedOut, true, 'native disconnect does not settle or join unfinished initialization');
      assert.ok(!evidence.events.some(event => event.event === 'init-settled' || event.event === 'finished'));
      if (mode.includes('discovery')) {
        assert.equal(initialize.length, 0, 'the completely silent server remains in native discovery');
        assert.ok(!serverEvents.some(event => event.event === 'stdin-closed' || event.event === 'exit'), 'disconnect does not close the unfinished discovery transport');
      } else {
        assert.ok(initialize.length >= 2, 'closing initialize triggers native discovery retry and another initialized stdio process');
        assert.notEqual(initialize[0]!.pid, initialize.at(-1)!.pid);
        assert.ok(serverEvents.some(event => event.pid === initialize[0]!.pid && event.event === 'exit' && event.code === 0), 'disconnect closes the original initialize transport');
        assert.ok(Number(initialize.at(-1)!.at) >= Number(disconnected.at), 'the native producer starts a new initialize after awaited cleanup returns');
      }
    }
  });
}
