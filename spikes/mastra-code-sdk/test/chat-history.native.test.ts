import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime } from '../src/runtime.js';
import { readChatHistory, type NativeHistoryMessage } from '../src/chat-history.js';
import { startModelFixture } from './fixtures/model-server.js';

let root: string;
let profile: SpikeProfile;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-native-history-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(() => ({ text: 'Native history fixture answer' }));
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat' },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    lsp: false, observability: { enabled: false },
  }));
});
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });

async function setup(t: TestContext, name: string) {
  const projectPath = join(root, name);
  await mkdir(projectPath);
  const options = { profile, projectPath, runtimeRoot: join(root, `${name}-runtime`), modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] };
  let runtime = await createProjectRuntime(options);
  t.after(() => runtime.dispose());
  const target = { threadId: `${name}-thread`, resourceId: `${name}-resource` };
  const session = await runtime.createSession(target);
  await session.thread.rename({ title: 'History fixture', pin: true });
  await runtime.releaseSession({ resourceId: target.resourceId });
  return { target, get runtime() { return runtime; }, async save(entries: [string, number][]) {
    const store = await runtime.storage.getStore('memory');
    assert.ok(store);
    const messages: NativeHistoryMessage[] = entries.map(([id, second]) => ({
      ...target, id, role: 'user', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)),
      content: { format: 2, parts: [{ type: 'text', text: id }] },
    }));
    await store.saveMessages({ messages });
  }, async reopen() { await runtime.dispose(); runtime = await createProjectRuntime(options); } };
}
const ids = (messages: NativeHistoryMessage[]) => messages.map(message => message.id).sort();
const timestamp = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

// Exact timestamps come from public native storage writes, not a fake query implementation.
test('native latest and older windows complete boundary ties without deriving chronology from IDs', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'ties');
  await env.save([['z-oldest', 1], ['tie-old-a', 2], ['tie-old-b', 2], ['tie-old-c', 2],
    ['tie-new-a', 3], ['tie-new-b', 3], ['tie-new-c', 3], ['a-newest', 4]]);
  let activations = 0;
  const off = env.runtime.controller.onSessionCreated(() => { activations++; });
  t.after(off);
  const initial = await readChatHistory(env.runtime.controller, env.target, {}, undefined, 2);
  assert.deepEqual(ids(initial.messages), ['a-newest', 'tie-new-a', 'tie-new-b', 'tie-new-c']);
  assert.deepEqual(initial.history, { earliest: timestamp(3), hasOlder: true });
  const older = await readChatHistory(env.runtime.controller, env.target, { earliest: initial.history.earliest!, older: true }, undefined, 2);
  assert.deepEqual(ids(older.messages), ['a-newest', 'tie-new-a', 'tie-new-b', 'tie-new-c', 'tie-old-a', 'tie-old-b', 'tie-old-c']);
  assert.deepEqual(older.history, { earliest: timestamp(2), hasOlder: true });
  const all = await readChatHistory(env.runtime.controller, env.target, { earliest: older.history.earliest!, older: true }, undefined, 2);
  assert.deepEqual(all.history, { earliest: timestamp(1), hasOlder: false });
  assert.equal(all.messages.length, 8);
  assert.ok(all.messages.every((message, index) => index === 0 || all.messages[index - 1]!.createdAt <= message.createdAt));
  assert.equal(activations, 0, 'read-only history never constructs a Session');
});

test('native refill preserves loaded rows after append and includes delayed persistence inside the loaded range', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'refill');
  await env.save([['old', 1], ['loaded-a', 2], ['loaded-b', 3]]);
  const initial = await readChatHistory(env.runtime.controller, env.target, {}, undefined, 2);
  await env.save([['append-a', 5], ['append-b', 6], ['append-c', 7], ['late-loaded', 2]]);
  const refill = await readChatHistory(env.runtime.controller, env.target, { earliest: initial.history.earliest! }, undefined, 2);
  assert.deepEqual(ids(refill.messages), ['append-a', 'append-b', 'append-c', 'late-loaded', 'loaded-a', 'loaded-b']);
  assert.deepEqual(refill.history, initial.history);
  await env.reopen();
  let activations = 0;
  const off = env.runtime.controller.onSessionCreated(() => { activations++; });
  t.after(off);
  const restarted = await readChatHistory(env.runtime.controller, env.target, { earliest: refill.history.earliest! }, undefined, 2);
  assert.deepEqual(ids(restarted.messages), ids(refill.messages));
  assert.deepEqual(restarted.history, refill.history);
  assert.equal(activations, 0, 'persisted history is readable after restart without activation');
});

test('concurrent native append between boundary discovery and refill does not shift or evict the selected range', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'concurrent');
  await env.save([['old', 1], ['loaded-a', 2], ['loaded-b', 3]]);
  const original = env.runtime.controller.queryThreadMessages.bind(env.runtime.controller);
  let discovered = false;
  const controller = { async queryThreadMessages(input: Parameters<typeof original>[0]) {
    const result = await original(input);
    if (!discovered) { discovered = true; await env.save([['concurrent-a', 4], ['concurrent-b', 5], ['late-tie', 2]]); }
    return result;
  } };
  const result = await readChatHistory(controller, env.target, {}, undefined, 2);
  assert.deepEqual(ids(result.messages), ['concurrent-a', 'concurrent-b', 'late-tie', 'loaded-a', 'loaded-b']);
  assert.deepEqual(result.history, { earliest: timestamp(2), hasOlder: true });
});

test('empty history and exhausted older loads converge, and cancelled native replies cannot advance a boundary', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'empty-cancel');
  const empty = await readChatHistory(env.runtime.controller, env.target);
  assert.deepEqual(empty, { messages: [], history: { earliest: null, hasOlder: false } });
  await env.save([['only', 2]]);
  const result = await readChatHistory(env.runtime.controller, env.target, { earliest: timestamp(2), older: true });
  assert.deepEqual(result.history, { earliest: timestamp(2), hasOlder: false });
  assert.deepEqual(ids(result.messages), ['only']);
  const abort = new AbortController();
  const original = env.runtime.controller.queryThreadMessages.bind(env.runtime.controller);
  let reads = 0;
  const controller = { async queryThreadMessages(input: Parameters<typeof original>[0]) {
    reads++; const result = await original(input); abort.abort(); return result;
  } };
  await assert.rejects(readChatHistory(controller, env.target, {}, abort.signal), error => error instanceof Error && error.name === 'AbortError');
  assert.equal(reads, 1, 'the cancelled reply stops the remaining read chain');
});
