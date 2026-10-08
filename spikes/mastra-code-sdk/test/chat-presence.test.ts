import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatPresence } from '../src/chat-presence.js';
import type { ChatIdentity } from '../src/product-registry.js';

function gate() { let release!: () => void; return { promise: new Promise<void>(done => { release = done; }), release }; }
const identity = (threadId: string): ChatIdentity => ({ bindingId: 'binding', threadId });

test('client snapshots replace independently and foreground leases expire after thirty seconds', async () => {
  let now = 1000;
  const presence = createChatPresence({ now: () => now, resolveVisible: async (ids, apply) => apply(ids.map(identity)) });
  await presence.replace({ clientId: 'one', visibleThreadIds: ['a', 'b', 'a'] });
  await presence.replace({ clientId: 'two', visibleThreadIds: ['a'] });
  await presence.replace({ clientId: 'one', visibleThreadIds: ['c'] });
  assert.equal(presence.isViewed('binding', 'a'), true); assert.equal(presence.isViewed('binding', 'b'), false);
  assert.equal(presence.isViewed('other-binding', 'a'), false);
  now += 30_000; assert.equal(presence.isViewed('binding', 'a'), true);
  await presence.replace({ clientId: 'one', visibleThreadIds: ['c'] });
  now++; assert.equal(presence.isViewed('binding', 'a'), false); assert.equal(presence.isViewed('binding', 'c'), true);
  await presence.replace({ clientId: 'one', visibleThreadIds: [] }); assert.equal(presence.isViewed('binding', 'c'), false);
});

test('a newer clear or replacement wins before older native metadata resolution returns', async () => {
  const reached = gate(), release = gate();
  const presence = createChatPresence({ resolveVisible: async (ids, apply) => {
    if (ids.includes('slow')) { reached.release(); await release.promise; }
    apply(ids.map(identity));
  } });
  const older = presence.replace({ clientId: 'tab', visibleThreadIds: ['slow'] }); await reached.promise;
  assert.deepEqual(await presence.replace({ clientId: 'tab', visibleThreadIds: [] }), { accepted: true });
  await presence.replace({ clientId: 'tab', visibleThreadIds: ['latest'] }); release.release(); await older;
  assert.equal(presence.isViewed('binding', 'slow'), false); assert.equal(presence.isViewed('binding', 'latest'), true);
});

test('invalid or archived resolution is atomic, fences earlier requests and leaves only the previous expiring lease', async () => {
  let now = 0; const reached = gate(), release = gate();
  const presence = createChatPresence({ now: () => now, resolveVisible: async (ids, apply) => {
    if (ids.includes('slow')) { reached.release(); await release.promise; }
    if (ids.includes('archived')) throw new Error('archived');
    apply(ids.map(identity));
  } });
  await presence.replace({ clientId: 'tab', visibleThreadIds: ['old'] });
  const earlier = presence.replace({ clientId: 'tab', visibleThreadIds: ['slow'] }); await reached.promise;
  await assert.rejects(presence.replace({ clientId: 'tab', visibleThreadIds: ['new', 'archived'] }), /archived/);
  release.release(); await earlier;
  assert.equal(presence.isViewed('binding', 'new'), false); assert.equal(presence.isViewed('binding', 'slow'), false);
  assert.equal(presence.isViewed('binding', 'old'), true);
  now = 30_001; assert.equal(presence.isViewed('binding', 'old'), false);
});

test('archive forgetting, fresh ownership and disposal cannot retain or resurrect foreground state', async () => {
  const reached = gate(), release = gate();
  const resolveVisible = async (ids: string[], apply: (identities: ChatIdentity[]) => void) => {
    if (ids.includes('slow')) { reached.release(); await release.promise; }
    apply(ids.map(identity));
  };
  const presence = createChatPresence({ resolveVisible });
  await presence.replace({ clientId: 'tab', visibleThreadIds: ['a', 'b'] });
  presence.forget('binding', ['a']); assert.equal(presence.isViewed('binding', 'a'), false); assert.equal(presence.isViewed('binding', 'b'), true);
  assert.equal(createChatPresence({ resolveVisible }).isViewed('binding', 'b'), false);
  const pending = presence.replace({ clientId: 'tab', visibleThreadIds: ['slow'] }); await reached.promise;
  presence.dispose(); release.release(); await assert.rejects(pending, { code: 'SERVICE_UNAVAILABLE' });
  assert.equal(presence.isViewed('binding', 'b'), false);
  await assert.rejects(presence.replace({ clientId: 'tab', visibleThreadIds: [] }), { code: 'SERVICE_UNAVAILABLE' });
});
