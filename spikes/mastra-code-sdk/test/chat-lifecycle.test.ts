import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatLifecycle } from '../src/chat-lifecycle.js';

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

test('root retirement drains an admitted descendant chain and synchronously rejects new chains', { timeout: 2_000 }, async () => {
  const lifecycle = createChatLifecycle(), held = gate();
  let started = false, retired = false;
  const command = lifecycle.admitMany(['root', 'fork', 'child'], async () => { started = true; await held.promise; return 'accepted'; });
  assert.equal(started, true, 'all leases and callback admission happen in the calling tick');
  const retirement = lifecycle.retire('root', async () => { retired = true; });
  await assert.rejects(lifecycle.admitMany(['root', 'new-child'], async () => 'must not run'), { code: 'CONFLICT' });
  await Promise.resolve(); assert.equal(retired, false);
  assert.equal(await lifecycle.admitMany(['other-root', 'peer'], async () => 'independent'), 'independent');
  held.release(); assert.equal(await command, 'accepted'); await retirement;
  assert.equal(retired, true);
  await assert.rejects(lifecycle.admit('root', async () => undefined), { code: 'CONFLICT' });
});

test('retiring one child leaves sibling admission independent and releases every ancestor on failure', { timeout: 2_000 }, async () => {
  const lifecycle = createChatLifecycle(), held = gate();
  let retired = false;
  const command = lifecycle.admitMany(['root', 'child-a'], async () => { await held.promise; throw new Error('native admission failed'); });
  const failed = assert.rejects(command, /native admission failed/);
  const retirement = lifecycle.retire('child-a', async () => { retired = true; });
  assert.equal(await lifecycle.admitMany(['root', 'child-b'], async () => 'sibling accepted'), 'sibling accepted');
  await assert.rejects(lifecycle.admitMany(['root', 'child-a'], async () => undefined), { code: 'CONFLICT' });
  assert.equal(retired, false);
  held.release(); await failed; await retirement; assert.equal(retired, true);
  let rootRetired = false;
  await lifecycle.retire('root', async () => { rootRetired = true; });
  assert.equal(rootRetired, true, 'failed callback cannot leak an ancestor lease');
});

test('closed ancestors reject the whole unique chain without leaking any partial lease', { timeout: 2_000 }, async () => {
  const lifecycle = createChatLifecycle();
  await lifecycle.retire('closed-root', async () => undefined);
  let called = false;
  await assert.rejects(lifecycle.admitMany(['free', 'closed-root', 'leaf', 'free'], async () => { called = true; }), { code: 'CONFLICT' });
  assert.equal(called, false);
  for (const id of ['free', 'leaf']) {
    let retired = false;
    const retirement = lifecycle.retire(id, async () => { retired = true; });
    await Promise.resolve(); assert.equal(retired, true, 'a rejected chain never acquired a partial lease');
    await retirement;
  }
  const held = gate();
  const command = lifecycle.admitMany(['unique-root', 'unique-root', 'unique-leaf', 'unique-leaf'], async () => { await held.promise; return 42; });
  let ended = 0;
  const root = lifecycle.retire('unique-root', async () => { ended++; });
  const leaf = lifecycle.retire('unique-leaf', async () => { ended++; });
  await Promise.resolve(); assert.equal(ended, 0);
  held.release(); assert.equal(await command, 42); await Promise.all([root, leaf]); assert.equal(ended, 2);
});

test('retirement shares its promise, stays closed on failure, and permits explicit cleanup retry', async () => {
  const lifecycle = createChatLifecycle();
  let attempts = 0;
  const first = lifecycle.retire('chat', async () => { attempts++; throw new Error('native cleanup failed'); });
  assert.equal(lifecycle.retire('chat', async () => { attempts++; }), first);
  await assert.rejects(first, /native cleanup failed/);
  await assert.rejects(lifecycle.admit('chat', async () => undefined), { code: 'CONFLICT' });
  await lifecycle.retire('chat', async () => { attempts++; });
  assert.equal(attempts, 2);
});
