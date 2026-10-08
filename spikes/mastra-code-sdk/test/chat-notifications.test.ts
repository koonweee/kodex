import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatNotifications } from '../src/chat-notifications.js';
import type { Chat, PinnedDescendant } from '../src/chat-projects.js';
import type { ChatReadState } from '../src/chat-read-state.js';

const chat = (id: string, bindingId = 'binding'): Chat => ({ id, bindingId, projectId: null, title: id, name: id, cwd: '/fixture', pinned: false, notificationsEnabled: false });
const state = (seen: boolean | null, epoch = 'epoch'): ChatReadState => ({ epoch, revision: 1, seen,
  head: seen === null ? null : { runId: 'run', messageId: 'answer', reason: 'complete' } });
function gate() { let release!: () => void; return { promise: new Promise<void>(done => { release = done; }), release }; }
function fixture() {
  let revision = 0, chats: Chat[] = [], pinnedDescendants: PinnedDescendant[] = [];
  const reads = new Map<string, ChatReadState>(), lifetime = new AbortController();
  const options: Parameters<typeof createChatNotifications>[0] = {
    epoch: 'epoch', revision: () => revision, signal: lifetime.signal, assertActive: () => {},
    async inventory() { return { projects: [], chats, pinnedDescendants, pinnedChatIds: [], archivedChatIds: [] }; },
    projectActivity: rows => rows.map(row => ({ ...row, isRunning: false })),
    readState: (binding, thread) => reads.get(`${binding}:${thread}`) ?? state(null),
    resolveVisible: async (_ids, apply) => apply([]),
  };
  return { options, reads, lifetime, set(rows: Chat[], descendants: PinnedDescendant[] = []) { chats = rows; pinnedDescendants = descendants; revision++; }, changed() { revision++; } };
}

test('badge uses the full ordinary inventory, preserves unknown, and counts neither pins nor notification preferences', async () => {
  const f = fixture(), owner = createChatNotifications(f.options);
  assert.deepEqual(await owner.getUnreadBadge(), { epoch: 'epoch', revision: 0, count: 0 });
  f.set([chat('a'), chat('b')]); assert.equal((await owner.getUnreadBadge()).count, null);
  f.reads.set('binding:a', state(false)); assert.equal((await owner.getUnreadBadge()).count, null);
  f.reads.set('binding:b', state(true)); assert.equal((await owner.getUnreadBadge()).count, 1);
  f.set([chat('a'), chat('b')], [{ ...chat('child'), kind: 'child', rootChatId: 'a', parentThreadId: 'a' }]);
  assert.equal((await owner.getUnreadBadge()).count, 1, 'a pinned descendant with unknown head is outside the ordinary inventory');
  f.reads.set('binding:a', state(true)); f.changed(); assert.equal((await owner.getUnreadBadge()).count, 0);
  f.reads.set('binding:b', state(null)); f.changed(); assert.equal((await owner.getUnreadBadge()).count, null, 'newer unknown cannot preserve an old zero');
  f.set([]); assert.equal((await owner.getUnreadBadge()).count, 0, 'archived/removed rows leave the eligible inventory');
});

test('identical thread IDs in separate bindings count independently and wrong-epoch heads are unknown', async () => {
  const f = fixture(), owner = createChatNotifications(f.options);
  f.set([chat('same', 'one'), chat('same', 'two')]); f.reads.set('one:same', state(false)); f.reads.set('two:same', state(false));
  assert.equal((await owner.getUnreadBadge()).count, 2);
  f.reads.set('two:same', state(true, 'previous')); assert.equal((await owner.getUnreadBadge()).count, null);
});

test('catalog coverage retries an overlapping native inventory before returning the aggregate', async () => {
  const f = fixture(), reached = gate(), release = gate();
  f.set([chat('a')]); f.reads.set('binding:a', state(false));
  const read = f.options.inventory; let calls = 0;
  f.options.inventory = async () => {
    const inventory = await read(); calls++;
    if (calls === 1) { reached.release(); await release.promise; }
    return inventory;
  };
  const owner = createChatNotifications(f.options), badge = owner.getUnreadBadge(); await reached.promise;
  f.set([]); release.release();
  assert.deepEqual(await badge, { epoch: 'epoch', revision: 2, count: 0 }); assert.equal(calls, 2);
});

test('failed or cancelled inventory is not reported as a successful empty badge', async () => {
  const f = fixture(), reached = gate(), release = gate();
  f.options.inventory = async () => { reached.release(); await release.promise; throw new Error('native read failed'); };
  const owner = createChatNotifications(f.options), failure = owner.getUnreadBadge(); await reached.promise; release.release();
  await assert.rejects(failure, /native read failed/);
  const g = fixture(); const waiting = gate(); g.options.inventory = async () => { await waiting.promise; return { projects: [], chats: [], pinnedDescendants: [], pinnedChatIds: [], archivedChatIds: [] }; };
  const reader = createChatNotifications(g.options), abort = new AbortController(), pending = reader.getUnreadBadge(abort.signal);
  abort.abort(); waiting.release(); await assert.rejects(pending, { name: 'AbortError' });
  g.lifetime.abort(); await assert.rejects(reader.getUnreadBadge(), { name: 'AbortError' });
});
