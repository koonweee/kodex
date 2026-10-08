import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import webPush from 'web-push';
import { resolveProfile } from '../src/profile.js';
import { openPushService } from '../src/push-service.js';
import { createPushRouter } from '../src/push-router.js';
import { serveRouter } from '../src/server.js';

test('two typed HTTP clients converge on shared endpoint state without exposing encryption keys', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-push-http-'));
  const config = { ...webPush.generateVAPIDKeys(), subject: 'mailto:test@example.com', recheckDelayMs: 2_000 };
  const service = await openPushService(resolveProfile(root), { config, prepare: async () => null, pollIntervalMs: 0 });
  let gets = 0;
  const router = { push: createPushRouter(async () => { gets++; return service; }) };
  const server = await serveRouter(router, 0);
  t.after(async () => { await server.close(); await service.dispose(); await rm(root, { recursive: true, force: true }); });
  const client = () => createORPCClient<RouterClient<typeof router>>(new RPCLink({ url: `${server.url}/rpc` }));
  const first = client(), peer = client();
  assert.equal(gets, 0);
  assert.deepEqual(await first.push.status(), { configured: true, subscriptionsEnabled: true, vapidPublicKey: config.publicKey });
  const input = { endpoint: 'https://push.example.com/device', keys: { p256dh: 'public-encryption-key', auth: 'secret-auth' } };
  const original = await first.push.upsert(input);
  const duplicate = await peer.push.upsert(input);
  assert.equal(original.subscription.id, duplicate.subscription.id);
  assert.equal('keys' in original.subscription, false);
  assert.equal(JSON.stringify(original).includes('secret-auth'), false);
  assert.equal((await peer.push.current({ endpoint: input.endpoint })).subscribed, true);
  const delivery = await first.push.test();
  assert.equal(delivery.enqueued, true);
  assert.equal(delivery.deliveryIds.length, 1);
  await first.push.disable({ endpoint: input.endpoint });
  assert.equal((await peer.push.current({ endpoint: input.endpoint })).subscribed, false);
  await peer.push.remove({ subscriptionId: original.subscription.id });
  assert.equal((await first.push.current({ endpoint: input.endpoint })).subscription, null);
  for (const invalid of [ { ...input, endpoint: 'http://push.example.com/device' }, { ...input, keys: { ...input.keys, privateKey: 'hidden' } }, { ...input, enabled: true } ]) {
    await assert.rejects(first.push.upsert(invalid), { code: 'BAD_REQUEST' });
  }
});
