import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProfile } from '../src/profile.js';
import { openPushStore } from '../src/push-store.js';
import { openPushService } from '../src/push-service.js';

const event = { bindingId: 'binding', threadId: 'chat', runId: 'run', reason: 'complete' as const };
test('interrupted outbox restarts with confirmed device IDs and retains a three-attempt cap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-push-outbox-'));
  const profile = resolveProfile(root);
  let store = await openPushStore(profile);
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const id = await store.enqueue(event, 0);
  const first = await store.claim(0); assert.ok(first);
  assert.equal(first.attempts, 1);
  await store.recordDelivered(first, 'delivered-device');
  await store.close();
  store = await openPushStore(profile);
  const second = await store.claim(0); assert.ok(second);
  assert.equal(second.id, id);
  assert.equal(second.attempts, 2);
  assert.deepEqual(second.deliveredIds, ['delivered-device']);
  await store.close();
  store = await openPushStore(profile);
  const third = await store.claim(0); assert.ok(third);
  assert.equal(third.attempts, 3);
  await store.close();
  store = await openPushStore(profile);
  assert.equal(await store.claim(999_000), null);
  assert.equal(await store.enqueue(event, 0), id);
});

test('shutdown joins admitted device writes before closing the dedicated database', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-push-write-'));
  const profile = resolveProfile(root);
  const service = await openPushService(profile, { prepare: async () => null, pollIntervalMs: 0 });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  const writes = Array.from({ length: 20 }, (_, i) => service.upsert({ endpoint: `https://push.example.com/${i}`, keys: { p256dh: 'key', auth: 'auth' } }));
  await service.dispose();
  await Promise.all(writes);
  const reopened = await openPushStore(profile);
  try { assert.equal((await reopened.enabled()).length, 20); } finally { await reopened.close(); }
});
