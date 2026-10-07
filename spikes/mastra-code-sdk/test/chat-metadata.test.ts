import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { openProductRegistry } from '../src/product-registry.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { createChatService, type ChatService, type ChatSnapshot, type CatalogSnapshot } from '../src/chat-service.js';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { serveRouter } from '../src/server.js';
import { startModelFixture } from './fixtures/model-server.js';

let root: string, profile: SpikeProfile, fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-chat-metadata-')));
  profile = activateProfile(resolveProfile(join(root, 'sdk-profile')));
  fixture = await startModelFixture();
  await writeFile(profile.settingsPath, JSON.stringify({ models: { observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fake-local-key', models: ['chat'] }], lsp: false, observability: { enabled: false } }));
});
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function setup(name: string) {
  const home = join(root, name); await mkdir(home);
  const projects = await Promise.all(['a', 'b'].map(async id => { const path = join(home, id); await mkdir(path); return { id, name: id, path, runtimeRoot: join(home, `${id}-runtime`) }; }));
  const registryProfile = resolveProfile(join(home, 'product-profile'));
  const runtimes: ProjectRuntime[] = [];
  const makeService = () => createChatService({ profile, projects, instanceId: 'metadata-fixture', directoryHome: home,
    registryFactory: () => openProductRegistry(registryProfile, { standaloneCwd: home }),
    runtimeFactory: async options => { const runtime = await createProjectRuntime({ ...options, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] }); runtimes.push(runtime); return runtime; },
  });
  return { home, projects, registryProfile, runtimes, makeService };
}
async function serve(service: ChatService) {
  const server = await serveRouter(createChatRouter(service), 0);
  const client = (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  return { first: client(), second: client(), close: server.close };
}
async function until<T>(watch: AsyncIterator<T>, predicate: (snapshot: T) => boolean): Promise<T> {
  const signal = AbortSignal.timeout(15_000);
  for (;;) {
    signal.throwIfAborted(); let expire!: () => void;
    const deadline = new Promise<never>((_, reject) => { expire = () => reject(new Error('Metadata watch timeout')); });
    signal.addEventListener('abort', expire, { once: true });
    try { const next = await Promise.race([watch.next(), deadline]); assert.equal(next.done, false); if (predicate(next.value!)) return next.value!; }
    finally { signal.removeEventListener('abort', expire); }
  }
}

test('two clients observe global pins across project/standalone chats, repeat pin preserves order and invalid targets are atomic', { timeout: 60_000 }, async t => {
  const env = await setup('pins'); const service = env.makeService(); const server = await serve(service);
  const abort = new AbortController(); t.after(async () => { abort.abort(); await server.close(); await service.dispose(); });
  const [a, b, c] = [await server.first.createChat({ projectId: 'a' }), await server.first.createChat({ projectId: 'b' }), await server.first.createChat({})];
  const catalog = await server.second.watchCatalog(undefined, { signal: abort.signal }); await catalog.next();
  const watch = await server.second.watchChat({ chatId: c.id }, { signal: abort.signal }); await watch.next();
  for (const chat of [a, b, c]) assert.deepEqual(await server.first.setChatPinned({ chatId: chat.id, pinned: true }), { accepted: true });
  const pinned = await until<CatalogSnapshot>(catalog, value => value.pinnedChatIds.length === 3);
  assert.deepEqual(pinned.pinnedChatIds, [a.id, b.id, c.id]);
  assert.ok(pinned.chats.every(chat => chat.pinned));
  await server.second.setChatPinned({ chatId: b.id, pinned: true });
  assert.deepEqual((await server.first.listChats()).pinnedChatIds, pinned.pinnedChatIds);
  await server.first.setChatPinned({ chatId: c.id, pinned: true, beforeChatId: b.id });
  assert.deepEqual((await server.second.listChats()).pinnedChatIds, [a.id, c.id, b.id]);
  const before = await server.second.listChats();
  await assert.rejects(server.first.setChatPinned({ chatId: a.id, pinned: true, beforeChatId: 'missing-native-chat' }), { code: 'NOT_FOUND' });
  assert.deepEqual(await server.second.listChats(), before);
  await assert.rejects(server.first.setChatPinned({ chatId: a.id, pinned: false, beforeChatId: null }), { code: 'BAD_REQUEST' });
  await server.first.setChatPinned({ chatId: c.id, pinned: false });
  await until<ChatSnapshot>(watch, value => !value.chat.pinned);
  const unpinned = await until<CatalogSnapshot>(catalog, value => value.pinnedChatIds.length === 2);
  assert.deepEqual(unpinned.pinnedChatIds, [a.id, b.id]);
  await assert.rejects(server.second.setChatPinned({ chatId: b.id, pinned: true, beforeChatId: c.id }), { code: 'CONFLICT' });
  assert.deepEqual((await server.first.listChats()).pinnedChatIds, [a.id, b.id]);
  await assert.rejects(server.second.setChatNotifications({ chatId: 'missing-native-chat', enabled: false }), { code: 'NOT_FOUND' });
  assert.equal((await server.first.listChats()).chats.length, 3, 'metadata mutations never fabricate native chats');
});

test('per-chat notification defaults and live refills persist independently from native settings writers and restart', { timeout: 60_000 }, async t => {
  const env = await setup('notifications'); let service = env.makeService(); let server = await serve(service);
  const abort = new AbortController(); t.after(async () => { abort.abort(); await server.close(); await service.dispose(); });
  const chat = await server.first.createChat({ projectId: 'a' });
  assert.equal(chat.notificationsEnabled, true); assert.equal(chat.pinned, false);
  const watch = await server.second.watchChat({ chatId: chat.id }, { signal: abort.signal }); await watch.next();
  await Promise.all([
    server.first.setChatNotifications({ chatId: chat.id, enabled: false }),
    server.second.updateChatSettings({ chatId: chat.id, patch: { thinkingLevel: 'high' } }),
    server.second.setChatPinned({ chatId: chat.id, pinned: true }),
  ]);
  const changed = await until<ChatSnapshot>(watch, value => !value.chat.notificationsEnabled && value.chat.pinned && value.settings.thinkingLevel === 'high');
  assert.equal(changed.chat.id, chat.id);
  const row = await env.runtimes[0]!.controller.queryThreadById({ threadId: chat.id });
  const session = (await env.runtimes[0]!.controller.getSessionByResource(row!.resourceId))!;
  await session.thread.setSetting({ key: 'nativeWriterMarker', value: 'whole-row-native-write' });
  const afterNativeWrite = await server.second.openChat({ chatId: chat.id });
  assert.equal(afterNativeWrite.chat.notificationsEnabled, false); assert.equal(afterNativeWrite.chat.pinned, true);
  await assert.rejects(server.first.setChatNotifications({ chatId: chat.id, enabled: 'yes' } as never), { code: 'BAD_REQUEST' });
  abort.abort(); await server.close(); await service.dispose();
  const requests = fixture.requests.length;
  service = env.makeService(); server = await serve(service);
  const reopened = await server.second.openChat({ chatId: chat.id });
  assert.equal(reopened.chat.notificationsEnabled, false); assert.equal(reopened.chat.pinned, true);
  assert.deepEqual((await server.first.listChats()).pinnedChatIds, [chat.id]);
  assert.equal(fixture.requests.length, requests, 'metadata reads and startup do not run the model');
});

test('project deletion/recreation keeps old pin and notification flags with the retained native binding only', { timeout: 60_000 }, async t => {
  const env = await setup('ownership'); const service = env.makeService(); const server = await serve(service);
  t.after(async () => { await server.close(); await service.dispose(); });
  const old = await server.first.createChat({ projectId: 'a' });
  await server.first.setChatPinned({ chatId: old.id, pinned: true });
  await server.second.setChatNotifications({ chatId: old.id, enabled: false });
  await server.first.deleteProject({ projectId: 'a' });
  const recreated = await server.second.createProject({ createKey: 'fresh-directory-owner', path: env.projects[0]!.path });
  const fresh = await server.first.createChat({ projectId: recreated.id });
  const catalog = await server.second.listChats();
  assert.deepEqual(catalog.pinnedChatIds, [old.id]);
  assert.equal(catalog.chats.find(row => row.id === old.id)!.projectId, null);
  assert.equal(catalog.chats.find(row => row.id === old.id)!.notificationsEnabled, false);
  assert.equal(catalog.chats.find(row => row.id === fresh.id)!.pinned, false);
  assert.equal(catalog.chats.find(row => row.id === fresh.id)!.notificationsEnabled, true);
  const registry = await openProductRegistry(env.registryProfile); t.after(() => registry.close());
  const oldBinding = (await registry.listBindings()).find(binding => binding.cwd === old.cwd && binding.projectId === null)!;
  // A stale metadata identity must not pin a different native row merely because
  // the textual thread ID matches in another binding's database.
  await registry.setChatPinned({ bindingId: oldBinding.id, threadId: fresh.id, pinned: true });
  const joined = await server.second.listChats();
  assert.deepEqual(joined.pinnedChatIds, [old.id]);
  assert.equal(joined.chats.find(row => row.id === fresh.id)!.pinned, false);
  const before = await registry.chatMetadataSnapshot();
  await assert.rejects(server.first.setChatPinned({ chatId: 'missing-native-thread', pinned: true }), { code: 'NOT_FOUND' });
  assert.deepEqual(await registry.chatMetadataSnapshot(), before, 'missing native input produces no metadata row');
});


test('canonical inventory fences a native read overlapping pin and notification mutations', { timeout: 60_000 }, async t => {
  const env = await setup('overlap'); const service = env.makeService(); const server = await serve(service);
  t.after(async () => { await server.close(); await service.dispose(); });
  const chat = await server.first.createChat({ projectId: 'a' });
  const controller = env.runtimes[0]!.controller;
  const original = controller.queryThreads.bind(controller);
  let reached!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  controller.queryThreads = async input => {
    const rows = await original(input);
    if (first) { first = false; reached(); await gate; }
    return rows;
  };
  t.after(() => { release(); controller.queryThreads = original; });
  const overlapping = server.second.listChats(); await held;
  await server.first.setChatNotifications({ chatId: chat.id, enabled: false });
  await server.first.setChatPinned({ chatId: chat.id, pinned: true });
  release(); const joined = await overlapping;
  assert.deepEqual(joined.pinnedChatIds, [chat.id]);
  assert.equal(joined.chats[0]!.pinned, true);
  assert.equal(joined.chats[0]!.notificationsEnabled, false);
  assert.equal(joined.revision, (await server.first.listChats()).revision);
});
