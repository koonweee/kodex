import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shutdownBackend } from '../src/shutdown.js';

test('shutdown attempts transport, terminal and native storage cleanup even when earlier stages fail', async () => {
  const calls: string[] = [];
  await assert.rejects(shutdownBackend({ close: async () => { calls.push('transport'); throw new Error('secret-transport-details'); } },
    { dispose: async () => { calls.push('terminal'); throw new Error('secret-terminal-details'); } },
    { dispose: async () => { calls.push('native'); } }), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /Shutdown failed/);
      assert.ok(!error.message.includes('secret')); return true;
    });
  assert.deepEqual(calls, ['transport', 'terminal', 'native']);
});
test('successful cleanup retains transport-before-native teardown ordering', async () => {
  const calls: string[] = [];
  await shutdownBackend({ close: async () => { calls.push('transport'); } },
    { dispose: async () => { calls.push('terminal'); } }, { dispose: async () => { calls.push('native'); } });
  assert.deepEqual(calls, ['transport', 'terminal', 'native']);
});
