import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpInitResult } from '@mastra/code-sdk/mcp/manager';
import type { McpServerStatus } from '@mastra/code-sdk/mcp/types';
import { createRuntimeMcp } from '../src/runtime-mcp.js';

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function nativeManager() {
  let statuses: McpServerStatus[] = [{ name: 'local', connected: false, connecting: true, toolCount: 0, toolNames: [], transport: 'stdio' }];
  const initial = gate(), calls: string[] = [], reloads: Array<ReturnType<typeof gate>> = [], mutations: Array<ReturnType<typeof gate>> = [];
  const disableArguments: Array<[string, boolean, { global?: boolean } | undefined]> = [];
  let initError: Error | undefined, reloadError: Error | undefined, mutationError: Error | undefined;
  const manager = {
    async initInBackground(): Promise<McpInitResult> {
      calls.push('init'); await initial.promise; if (initError) throw initError;
      return { connected: statuses.filter(server => server.connected), failed: statuses.filter(server => !server.connected), skipped: [], totalTools: 0 };
    },
    async reload() {
      calls.push('reload'); const held = reloads.shift(); if (held) await held.promise; if (reloadError) throw reloadError;
    },
    async setServerDisabled(name: string, disabled: boolean, options?: { global?: boolean }) {
      calls.push(`disable:${name}:${disabled}`); disableArguments.push([name, disabled, options]);
      const held = mutations.shift(); if (held) await held.promise; if (mutationError) throw mutationError;
      return statuses.find(server => server.name === name)!;
    },
    async inheritServer(name: string) {
      calls.push(`inherit:${name}`); const held = mutations.shift(); if (held) await held.promise; if (mutationError) throw mutationError;
      return statuses.find(server => server.name === name)!;
    },
    async disconnect() { calls.push('disconnect'); },
    getServerStatuses: () => statuses,
    getSkippedServers: () => [{ name: 'invalid', reason: 'Secret endpoint token=TEST_SECRET' }],
    getConfigPaths: () => ({ project: '/project/.kodex-mastra-spike/mcp.json', global: '/home/.kodex-mastra-spike/mcp.json', claude: '/project/.claude/settings.local.json' }),
  };
  return { manager, initial, calls, reloads, mutations, disableArguments,
    setStatuses(value: McpServerStatus[]) { statuses = value; },
    rejectInit(error: Error) { initError = error; },
    rejectReload(error: Error | undefined) { reloadError = error; },
    rejectMutation(error: Error | undefined) { mutationError = error; },
  };
}

test('MCP inventory stays responsive during initialization and reloads serialize behind setup and each other', async () => {
  const native = nativeManager(), mcp = createRuntimeMcp(native.manager);
  assert.equal(mcp.snapshot().phase, 'initializing');
  assert.equal(mcp.snapshot().servers[0]?.connecting, true);
  assert.equal(mcp.snapshot().servers[0]?.connected, false);
  const firstHeld = gate(), secondHeld = gate(); native.reloads.push(firstHeld, secondHeld);
  const first = mcp.reload(), second = mcp.reload();
  await Promise.resolve(); assert.deepEqual(native.calls, ['init']);
  assert.equal(mcp.snapshot().phase, 'initializing', 'waiting reloads do not override native initialization presentation');
  native.setStatuses([{ name: 'local', connected: true, toolCount: 1, toolNames: ['local_probe'], transport: 'stdio' }]);
  native.initial.release(); await mcp.ready;
  await Promise.resolve();
  assert.deepEqual(native.calls, ['init', 'reload']); assert.equal(mcp.snapshot().phase, 'reloading');
  firstHeld.release(); await first; await Promise.resolve();
  assert.deepEqual(native.calls, ['init', 'reload', 'reload']);
  secondHeld.release(); await second;
  assert.equal(mcp.snapshot().phase, 'ready'); assert.equal(mcp.snapshot().servers[0]?.connected, true);
  native.setStatuses([{ name: 'local', connected: false, toolCount: 0, toolNames: [], transport: 'stdio', error: 'Connection token=TEST_SECRET' }]);
  const current = mcp.snapshot();
  assert.equal(current.servers[0]?.connected, false, 'native current inventory owns status, not the initial result');
  assert.ok(current.servers[0]?.error); assert.doesNotMatch(JSON.stringify(current), /TEST_SECRET/);
  assert.equal(current.phase, 'ready', 'native per-server failure remains a settled native operation');
  await mcp.dispose();
});

test('thrown setup/reload failures are safe overall phases and a subsequent explicit native reload can recover', async () => {
  const native = nativeManager(); native.rejectInit(new Error('Bearer TEST_SECRET'));
  const mcp = createRuntimeMcp(native.manager); native.initial.release(); await mcp.ready;
  assert.equal(mcp.snapshot().phase, 'failed'); assert.doesNotMatch(JSON.stringify(mcp.snapshot()), /TEST_SECRET/);
  native.rejectReload(new Error('Bearer TEST_SECRET'));
  await assert.rejects(mcp.reload(), error => error instanceof Error && !error.message.includes('TEST_SECRET'));
  assert.equal(mcp.snapshot().phase, 'failed');
  native.rejectReload(undefined); await mcp.reload();
  assert.equal(mcp.snapshot().phase, 'ready');
  await mcp.dispose();
});

test('disposal disconnects without joining unfinished initialization and fences admitted or new reloads', async () => {
  const native = nativeManager(), mcp = createRuntimeMcp(native.manager);
  let initialized = false; void mcp.ready.then(() => { initialized = true; });
  const queued = mcp.reload(); void queued.catch(() => {});
  await mcp.dispose();
  assert.equal(initialized, false, 'native initialization is not a shutdown barrier');
  assert.deepEqual(native.calls, ['init', 'disconnect']);
  await assert.rejects(mcp.reload(), /disposed/i);
  assert.throws(() => mcp.snapshot(), /disposed/i);
  native.initial.release(); await mcp.ready; await assert.rejects(queued, /disposed/i);
  await mcp.dispose(); assert.deepEqual(native.calls, ['init', 'disconnect'], 'queued reload cannot start after admission closes');
});


test('enable and inherit share reload exclusion and validate the server after the preceding native reload', async () => {
  const native = nativeManager(), mcp = createRuntimeMcp(native.manager);
  const reloadHeld = gate(), disableHeld = gate(); native.reloads.push(reloadHeld); native.mutations.push(disableHeld);
  const reloaded = mcp.reload();
  const disabled = mcp.setServerEnabled('added', false), inherited = mcp.inheritServer('added'), enabled = mcp.setServerEnabled('added', true);
  native.initial.release(); await mcp.ready; await Promise.resolve();
  assert.deepEqual(native.calls, ['init', 'reload']);
  native.setStatuses([{ name: 'added', connected: true, toolCount: 1, toolNames: ['added_tool'], transport: 'stdio' }]);
  reloadHeld.release(); await reloaded; await Promise.resolve();
  assert.deepEqual(native.calls, ['init', 'reload', 'disable:added:true']);
  assert.equal(mcp.snapshot().phase, 'reloading');
  disableHeld.release(); await Promise.all([disabled, inherited, enabled]);
  assert.deepEqual(native.calls, ['init', 'reload', 'disable:added:true', 'inherit:added', 'disable:added:false']);
  assert.deepEqual(native.disableArguments, [['added', true, undefined], ['added', false, undefined]], 'native writes use project overrides without the global option');
  assert.equal(mcp.snapshot().phase, 'ready');
  await mcp.dispose();
});

test('unknown or removed server mutations fail safely before native writes and do not poison later operations', async () => {
  const native = nativeManager(), mcp = createRuntimeMcp(native.manager); native.initial.release(); await mcp.ready;
  const held = gate(); native.reloads.push(held);
  const reloaded = mcp.reload(), removed = mcp.setServerEnabled('local', false); void removed.catch(() => {});
  native.setStatuses([]); held.release(); await reloaded;
  await assert.rejects(removed, /not found/i);
  for (const operation of [mcp.setServerEnabled('TEST_SECRET', true), mcp.inheritServer('TEST_SECRET')]) {
    await assert.rejects(operation, error => error instanceof Error && !error.message.includes('TEST_SECRET'));
  }
  assert.deepEqual(native.calls, ['init', 'reload']); assert.equal(mcp.snapshot().phase, 'ready');
  native.setStatuses([{ name: 'local', connected: false, toolCount: 0, toolNames: [], transport: 'stdio', error: 'TEST_SECRET' }]);
  await mcp.setServerEnabled('local', true);
  assert.equal(mcp.snapshot().phase, 'ready', 'a native resolved mutation can report an individual server failure');
  assert.equal(mcp.snapshot().servers[0]?.connected, false); assert.ok(mcp.snapshot().servers[0]?.error);
  await mcp.dispose();
});

test('failed native mutations recover serially while disposal fences queued enable and inherit', async () => {
  const native = nativeManager(), mcp = createRuntimeMcp(native.manager); native.initial.release(); await mcp.ready;
  native.rejectMutation(new Error('TEST_SECRET'));
  await assert.rejects(mcp.inheritServer('local'), error => error instanceof Error && !error.message.includes('TEST_SECRET'));
  assert.equal(mcp.snapshot().phase, 'failed');
  native.rejectMutation(undefined); await mcp.setServerEnabled('local', false); assert.equal(mcp.snapshot().phase, 'ready');
  const held = gate(); native.reloads.push(held);
  const reloaded = mcp.reload(), queued = [mcp.setServerEnabled('local', true), mcp.inheritServer('local')];
  for (const pending of queued) void pending.catch(() => {});
  await Promise.resolve(); await mcp.dispose();
  const callsAtDisposal = [...native.calls];
  await assert.rejects(mcp.setServerEnabled('local', true), /disposed/i); await assert.rejects(mcp.inheritServer('local'), /disposed/i);
  held.release(); await reloaded; await Promise.all(queued.map(pending => assert.rejects(pending, /disposed/i)));
  assert.deepEqual(native.calls, callsAtDisposal, 'no queued server mutation begins after native disconnect');
});
