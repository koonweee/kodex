import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { GatewayRouter } from '../src/gateway-router.js';
import { serveRouter } from '../src/server.js';

const clientFor = (url: string): RouterClient<GatewayRouter> => createORPCClient(new RPCLink({ url: url + '/rpc' }));
test('host frontend publication reaches two clients and reconnect reads the latest build without activating chats', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kodex-frontend-updates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'index.html'), '<title>First frontend</title>');
  await writeFile(join(directory, 'sw.js'), '/* first worker */');
  const host = await serveRouter({}, 0, undefined, undefined, { frontendDir: directory });
  const lifetime = new AbortController();
  t.after(async () => { lifetime.abort(); await host.close(); });
  const a = clientFor(host.url), b = clientFor(host.url);
  const wa = (await a.watchFrontendUpdates(undefined, { signal: lifetime.signal }))[Symbol.asyncIterator]();
  const wb = (await b.watchFrontendUpdates(undefined, { signal: lifetime.signal }))[Symbol.asyncIterator]();
  const initial = (await wa.next()).value;
  assert.ok(initial); assert.equal(initial.revision, 0); assert.equal(initial.buildRevision, null);
  assert.deepEqual((await wb.next()).value, initial);
  await assert.rejects(a.frontendUpdated({ revision: '' }));
  const pendingA = wa.next(), pendingB = wb.next();
  await writeFile(join(directory, 'sw.js'), '/* second worker with new bytes */');
  assert.deepEqual(await a.frontendUpdated({ revision: 'second-build' }), { accepted: true });
  const updated = (await pendingA).value;
  assert.ok(updated); assert.equal(updated.epoch, initial.epoch); assert.equal(updated.revision, 1); assert.equal(updated.buildRevision, 'second-build');
  assert.deepEqual((await pendingB).value, updated);
  const wc = (await clientFor(host.url).watchFrontendUpdates(undefined, { signal: lifetime.signal }))[Symbol.asyncIterator]();
  assert.deepEqual((await wc.next()).value, updated, 'reconnect recovers missed publication');
  const worker = await fetch(host.url + '/sw.js');
  assert.equal(await worker.text(), '/* second worker with new bytes */');
  assert.equal(worker.headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(host.url + '/v1/frontend-updates', { method: 'POST' })).status, 404, 'native publication uses typed RPC');
  lifetime.abort();
});

test('frontend update ownership retires idle observers and a new host starts without a durable build marker', async () => {
  const { createFrontendUpdates } = await import('../src/frontend-updates.js');
  const first = createFrontendUpdates();
  const watch = first.watch();
  const initial = (await watch.next()).value; assert.ok(initial);
  first.publish('deployed-build');
  assert.equal((await watch.next()).value?.buildRevision, 'deployed-build');
  const pending = watch.next();
  first.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.throws(() => first.publish('late-build'), { name: 'AbortError' });
  const next = createFrontendUpdates();
  try {
    const observer = next.watch();
    const current = (await observer.next()).value; assert.ok(current);
    assert.notEqual(current.epoch, initial.epoch); assert.equal(current.revision, 0); assert.equal(current.buildRevision, null);
    await observer.return();
  } finally { next.dispose(); }
});
