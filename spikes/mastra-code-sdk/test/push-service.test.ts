import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveProfile } from '../src/profile.js';
import { openPushService } from '../src/push-service.js';
import webPush from 'web-push';

const event = { bindingId: 'binding', threadId: 'chat', runId: 'run', reason: 'complete' as const };
const config = { ...webPush.generateVAPIDKeys(), subject: 'mailto:test@example.com', recheckDelayMs: 2_000 };
const subscription = (name: string) => ({ endpoint: `https://push.example.com/${name}`, keys: { p256dh: 'key', auth: 'auth' } });

test('unconfigured service retains endpoint-idempotent device state without pretending to deliver', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-push-'));
  const service = await openPushService(resolveProfile(root), { prepare: async () => ({ title: 'Chat' }), pollIntervalMs: 0 });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  const first = await service.upsert(subscription('a'));
  const again = await service.upsert({ ...subscription('a'), userAgent: 'Browser' });
  assert.equal(first.subscription.id, again.subscription.id);
  assert.equal((await service.current({ endpoint: subscription('a').endpoint })).subscribed, true);
  assert.deepEqual(await service.status(), { configured: false, subscriptionsEnabled: false, vapidPublicKey: null });
  assert.deepEqual(await service.test(), { configured: false, activeSubscriptionCount: 1, enqueued: false, deliveryIds: [] });
  assert.equal(await service.enqueueTerminal(event), null);
  await service.disable({ endpoint: subscription('a').endpoint });
  assert.equal((await service.current({ endpoint: subscription('a').endpoint })).subscribed, false);
  await service.upsert(subscription('a'));
  assert.equal((await service.current({ endpoint: subscription('a').endpoint })).subscribed, true);
});

test('temporary retry persists delivered device IDs across restart and disables stale endpoints', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-push-'));
  const profile = resolveProfile(root);
  let now = 0;
  const calls: string[] = [];
  let service = await openPushService(profile, { config, prepare: async () => ({ title: 'Native title' }), now: () => now, pollIntervalMs: 0,
    sender: async sub => { calls.push(sub.endpoint); return sub.endpoint.endsWith('/a') ? 'sent' : sub.endpoint.endsWith('/stale') ? 'stale' : 'temporary'; } });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(await service.status(), { configured: true, subscriptionsEnabled: true, vapidPublicKey: config.publicKey });
  for (const name of ['a', 'b', 'stale']) await service.upsert(subscription(name));
  const id = await service.enqueueTerminal(event);
  assert.equal(await service.enqueueTerminal(event), id);
  await service.processDue();
  assert.equal(calls.length, 0);
  now = 2_000;
  await service.processDue();
  assert.equal(calls.length, 3);
  assert.equal((await service.current({ endpoint: subscription('stale').endpoint })).subscribed, false);
  await service.dispose();
  service = await openPushService(profile, { config, prepare: async () => ({ title: 'Native title' }), now: () => now, pollIntervalMs: 0,
    sender: async (sub, payload) => { calls.push(sub.endpoint); assert.equal(payload.title, 'Native title'); assert.equal(payload.route, '/threads/chat'); return 'sent'; } });
  now = 3_999;
  await service.processDue();
  assert.equal(calls.length, 3);
  now = 4_000;
  await service.processDue();
  assert.deepEqual(calls.slice(3), [subscription('b').endpoint]);
  await service.processDue();
  assert.equal(calls.length, 4);
  assert.equal(await service.enqueueTerminal(event), id);
});

test('delivery rechecks native eligibility and caps temporary failures at three attempts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-push-'));
  let now = 0;
  let eligible = false;
  let calls = 0;
  const service = await openPushService(resolveProfile(root), { config, now: () => now, pollIntervalMs: 0, prepare: async () => eligible ? { title: 'Chat' } : null,
    sender: async () => { calls++; return 'temporary'; } });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.upsert(subscription('a'));
  await service.enqueueTerminal(event);
  now = 2_000; await service.processDue();
  assert.equal(calls, 0);
  eligible = true;
  await service.enqueueTerminal({ ...event, runId: 'next' });
  for (const time of [4_000, 6_000, 10_000, 99_000]) { now = time; await service.processDue(); }
  assert.equal(calls, 3);
});

test('dispose joins in-flight sends and rejects later admissions', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-push-'));
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const service = await openPushService(resolveProfile(root), { config: { ...config, recheckDelayMs: 0 }, prepare: async () => ({ title: 'Chat' }), pollIntervalMs: 0,
    sender: async () => { started(); await pending; return 'sent'; } });
  t.after(async () => { release(); await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.upsert(subscription('a'));
  await service.enqueueTerminal(event);
  const processing = service.processDue();
  await entered;
  let closed = false;
  const closing = service.dispose().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  await assert.rejects(service.upsert(subscription('late')), /closed/);
  release();
  await Promise.all([processing, closing]);
  assert.equal(closed, true);
});
