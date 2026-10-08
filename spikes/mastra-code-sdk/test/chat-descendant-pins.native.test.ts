import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, test, type TestContext } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { createChatService } from '../src/chat-service.js';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { openProductRegistry } from '../src/product-registry.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { serveRouter } from '../src/server.js';
import { startModelFixture } from './fixtures/model-server.js';

let profileRoot: string, profile: SpikeProfile;
before(async () => {
  profileRoot = await realpath(await mkdtemp(join(tmpdir(), 'kodex-descendant-pins-')));
  profile = activateProfile(resolveProfile(join(profileRoot, 'sdk-profile')));
});
after(async () => { await rm(profileRoot, { recursive: true, force: true }); });
async function setup(t: TestContext) {
  const root = await mkdtemp(join(profileRoot, 'case-'));
  const fixture = await startModelFixture();
  await writeFile(profile.settingsPath, JSON.stringify({
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fake-local-key', models: ['chat'] }],
    models: { observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: null },
    lsp: false, observability: { enabled: false },
  }));
  const registryProfile = resolveProfile(join(root, 'product'));
  const runtimes: ProjectRuntime[] = [];
  let mounts = 0;
  const make = () => createChatService({ profile, instanceId: 'descendant-pins', directoryHome: root,
    registryFactory: () => openProductRegistry(registryProfile, { standaloneCwd: root }),
    runtimeFactory: async options => {
      const runtime = await createProjectRuntime({ ...options, subagents: [] });
      runtime.controller.onSessionCreated(() => { mounts++; });
      runtimes.push(runtime); return runtime;
    },
  });
  let service = make();
  let server = await serveRouter(createChatRouter(service), 0);
  const client = (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  await service.listModels({ projectId: null });
  const runtime = runtimes.at(-1)!, store = await runtime.storage.getStore('memory'); assert.ok(store);
  const now = new Date();
  const save = (id: string, resourceId: string, metadata: Record<string, unknown>) => store.saveThread({ thread: { id, resourceId, title: id, createdAt: now, updatedAt: now, metadata } });
  await save('parent', 'parent-resource', { projectPath: root });
  await save('peer', 'peer-resource', { projectPath: root });
  const child = (parentThreadId = 'parent', parentResourceId = 'parent-resource') => ({ projectPath: root, kodexChild: '1', parentThreadId, parentResourceId, parentSessionScope: '', parentTaskId: 'task' });
  await save('child', 'child-resource', child());
  await save('fork', 'child-resource', { forkedSubagent: true, parentThreadId: 'child' });
  await save('leaf', 'leaf-resource', child('fork', 'child-resource'));
  await save('foreign', 'foreign-resource', child('parent', 'wrong-resource'));
  await save('malformed', 'malformed-resource', { ...child(), kodexChild: 'future-version' });
  await save('cycle-a', 'cycle-resource', { forkedSubagent: true, parentThreadId: 'cycle-b' });
  await save('cycle-b', 'cycle-resource', { forkedSubagent: true, parentThreadId: 'cycle-a' });
  t.after(async () => { await server.close(); await service.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  return { client, fixture, save, root, registryProfile, get service() { return service; }, get runtime() { return runtimes.at(-1)!; }, get mounts() { return mounts; },
    async restart() { await server.close(); await service.dispose(); service = make(); server = await serveRouter(createChatRouter(service), 0); },
  };
}

async function until<T>(iterator: AsyncIterator<T>, matches: (value: T) => boolean) {
  for (;;) { const next = await iterator.next(); assert.equal(next.done, false); if (matches(next.value)) return next.value; }
}

test('two typed clients share descendant pin/reorder/unpin, restart and parent archive without changing ordinary inventory', { timeout: 30_000 }, async t => {
  const env = await setup(t), a = env.client(), b = env.client();
  const abort = new AbortController(); t.after(() => abort.abort());
  const watch = await b.watchCatalog(undefined, { signal: abort.signal }); await watch.next();
  assert.deepEqual(new Set((await a.listChats()).chats.map(chat => chat.id)), new Set(['parent', 'peer']));
  await a.setChatPinned({ chatId: 'parent', pinned: true });
  await b.setChatPinned({ chatId: 'child', pinned: true });
  await a.setChatPinned({ chatId: 'fork', pinned: true, beforeChatId: 'child' });
  const observed = await until(watch, snapshot => snapshot.pinnedChatIds.join(',') === 'parent,fork,child');
  assert.deepEqual(observed.pinnedDescendants.map(chat => [chat.id, chat.kind, chat.rootChatId, chat.parentThreadId]),
    [['fork', 'fork', 'parent', 'child'], ['child', 'child', 'parent', 'parent']]);
  for (const row of observed.pinnedDescendants) {
    assert.equal(row.pinned, true); assert.equal(row.cwd, env.root); assert.equal(row.projectId, null);
  }
  await b.setChatPinned({ chatId: 'child', pinned: true, beforeChatId: 'parent' });
  await a.setChatPinned({ chatId: 'leaf', pinned: true, beforeChatId: 'fork' });
  assert.deepEqual((await b.listChats()).pinnedChatIds, ['child', 'parent', 'leaf', 'fork']);
  await b.setChatPinned({ chatId: 'child', pinned: false });
  assert.deepEqual((await a.listChats()).pinnedChatIds, ['parent', 'leaf', 'fork']);
  await a.setChatPinned({ chatId: 'fork', pinned: true });
  assert.deepEqual((await b.listChats()).pinnedChatIds, ['parent', 'leaf', 'fork'], 'repeat pin preserves shared order');
  const before = await b.listChats();
  assert.deepEqual(new Set(before.chats.map(chat => chat.id)), new Set(['parent', 'peer']));
  assert.deepEqual(before.pinnedDescendants.map(row => [row.id, row.kind, row.parentThreadId]), [['leaf', 'child', 'fork'], ['fork', 'fork', 'child']]);
  abort.abort(); await watch.return();
  await env.restart();
  const reopened = await env.client().listChats();
  assert.deepEqual(reopened.pinnedChatIds, before.pinnedChatIds);
  assert.deepEqual(reopened.pinnedDescendants, before.pinnedDescendants);
  const peerAbort = new AbortController(); t.after(() => peerAbort.abort());
  const peer = await env.client().watchCatalog(undefined, { signal: peerAbort.signal }); await peer.next();
  await env.client().archiveChat({ chatId: 'parent' });
  const retired = await until(peer, snapshot => snapshot.archivedChatIds.includes('parent'));
  assert.deepEqual(retired.pinnedChatIds, []); assert.deepEqual(retired.pinnedDescendants, []);
  assert.deepEqual(retired.chats.map(chat => chat.id), ['peer']);
  for (const chatId of ['child', 'fork', 'leaf']) await assert.rejects(env.client().setChatPinned({ chatId, pinned: true }), { code: 'CONFLICT' });
  peerAbort.abort(); await peer.return();
  await env.restart();
  assert.deepEqual((await env.client().listChats()).pinnedDescendants, []);
  assert.equal(env.mounts, 0); assert.equal(env.fixture.requests.length, 0);
});

test('malformed, foreign and cyclic native relations cannot create pin metadata or appear through forged metadata', { timeout: 30_000 }, async t => {
  const env = await setup(t), a = env.client(), b = env.client();
  await a.setChatPinned({ chatId: 'parent', pinned: true });
  await env.save('foreign-fork', 'parent-resource', { forkedSubagent: true, parentThreadId: 'parent', projectPath: '/foreign' });
  const registry = await openProductRegistry(env.registryProfile); t.after(() => registry.close());
  const before = await registry.chatMetadataSnapshot();
  for (const id of ['foreign', 'malformed', 'cycle-a', 'foreign-fork', 'missing']) {
    await assert.rejects(a.setChatPinned({ chatId: id, pinned: true }), { code: 'NOT_FOUND' });
    await assert.rejects(b.setChatPinned({ chatId: 'parent', pinned: true, beforeChatId: id }), { code: 'NOT_FOUND' });
  }
  assert.deepEqual(await registry.chatMetadataSnapshot(), before);
  const binding = (await registry.listBindings())[0]!;
  for (const threadId of ['foreign', 'malformed', 'cycle-a', 'foreign-fork']) await registry.setChatPinned({ bindingId: binding.id, threadId, pinned: true });
  const catalog = await b.listChats();
  assert.deepEqual(catalog.pinnedChatIds, ['parent']); assert.deepEqual(catalog.pinnedDescendants, []);
  assert.deepEqual(new Set(catalog.chats.map(chat => chat.id)), new Set(['parent', 'peer']));
  assert.equal(env.mounts, 0); assert.equal(env.fixture.requests.length, 0);
});

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
test('a pinned descendant title read overlapping ancestor archive refills without stale rows', { timeout: 30_000 }, async t => {
  const env = await setup(t);
  await env.client().setChatPinned({ chatId: 'fork', pinned: true });
  const store = await env.runtime.storage.getStore('memory'); assert.ok(store);
  const fork = await env.runtime.controller.queryThreadById({ threadId: 'fork' }); assert.ok(fork);
  await store.saveThread({ thread: { ...fork, title: '' } });
  const entered = gate(), resume = gate(); t.after(resume.release);
  const read = env.runtime.controller.queryThreadMessages.bind(env.runtime.controller);
  let once = true;
  t.mock.method(env.runtime.controller, 'queryThreadMessages', async (...args: Parameters<typeof read>) => {
    const rows = await read(...args);
    if (once) { once = false; entered.release(); await resume.promise; }
    return rows;
  });
  const pending = env.client().listChats();
  await entered.promise;
  await env.client().archiveChat({ chatId: 'parent' }); resume.release();
  const catalog = await pending;
  assert.deepEqual(catalog.pinnedChatIds, []); assert.deepEqual(catalog.pinnedDescendants, []);
  assert.deepEqual(catalog.chats.map(chat => chat.id), ['peer']);
  assert.equal(env.mounts, 0); assert.equal(env.fixture.requests.length, 0);
});


test('parent archive waits for an admitted child pin command before hiding the completed pin', { timeout: 30_000 }, async t => {
  const env = await setup(t);
  await env.client().setChatPinned({ chatId: 'peer', pinned: true });
  const store = await env.runtime.storage.getStore('memory'); assert.ok(store);
  const peer = await env.runtime.controller.queryThreadById({ threadId: 'peer' }); assert.ok(peer);
  await store.saveThread({ thread: { ...peer, title: '' } });
  const entered = gate(), resume = gate(); t.after(resume.release);
  const query = env.runtime.controller.queryThreadMessages.bind(env.runtime.controller);
  let once = true;
  t.mock.method(env.runtime.controller, 'queryThreadMessages', async (...args: Parameters<typeof query>) => {
    const result = await query(...args);
    if (once) { once = false; entered.release(); await resume.promise; }
    return result;
  });
  const command = env.client().setChatPinned({ chatId: 'child', pinned: true, beforeChatId: 'peer' });
  await entered.promise;
  let archived = false;
  const retirement = env.client().archiveChat({ chatId: 'parent' }).then(() => { archived = true; });
  let fenced = false;
  for (let attempt = 0; attempt < 20 && !fenced; attempt++) {
    try { await env.client().readChatRoute({ chatId: 'parent' }); }
    catch (error) { assert.equal((error as { code: string }).code, 'CONFLICT'); fenced = true; }
  }
  assert.equal(fenced, true, 'the parent has closed new admission');
  assert.equal(archived, false, 'retirement waits for already admitted short metadata work');
  resume.release(); await command; await retirement;
  const registry = await openProductRegistry(env.registryProfile); t.after(() => registry.close());
  const metadata = await registry.chatMetadataSnapshot();
  assert.equal(metadata.entries.find(entry => entry.threadId === 'child')?.archived, true);
  assert.deepEqual((await env.client().listChats()).pinnedChatIds, ['peer']);
  assert.equal(env.mounts, 0); assert.equal(env.fixture.requests.length, 0);
});
