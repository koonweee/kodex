import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatPush } from '../src/chat-push.js';
import type { SpikeProfile } from '../src/profile.js';
import type { PushService } from '../src/push-service.js';

function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release }; }
const event = { bindingId: 'binding', threadId: 'thread', runId: 'run', reason: 'complete' as const };
test('disabled notification capture opens no store; shutdown joins a previously admitted capture before closing storage', async () => {
  const held = gate(), calls: string[] = [];
  const service = { async enqueueTerminal() { calls.push('enqueue'); return 'delivery'; }, async dispose() { calls.push('dispose'); } } as unknown as PushService;
  const open = async () => { calls.push('open'); await held.promise; return service; };
  const profile = {} as SpikeProfile;
  const disabled = createChatPush({ profile, prepare: async () => null, open });
  disabled.capture(event); await disabled.dispose(); assert.deepEqual(calls, []);
  const owner = createChatPush({ profile, options: { config: { publicKey: 'fixture', privateKey: 'fixture', subject: 'mailto:fixture@example.test', recheckDelayMs: 2000 } }, prepare: async () => null, open });
  owner.capture(event);
  const closed = owner.dispose();
  owner.capture({ ...event, runId: 'too-late' });
  await assert.rejects(owner.get(), { code: 'SERVICE_UNAVAILABLE' });
  assert.deepEqual(calls, ['open']); held.release(); await closed;
  assert.deepEqual(calls, ['open', 'enqueue', 'dispose']);
  await owner.dispose(); assert.deepEqual(calls, ['open', 'enqueue', 'dispose']);
});
