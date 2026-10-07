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
import { CHAT_PREVIEW_LIMIT, CHAT_PREVIEW_PAGE_SIZE, readChatTitle } from '../src/chat-titles.js';
import { startModelFixture } from './fixtures/model-server.js';

let root: string, profile: SpikeProfile, fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-chat-titles-')));
  profile = activateProfile(resolveProfile(join(root, 'sdk-profile')));
  fixture = await startModelFixture(request => ({ text: request.model === 'title' ? 'Unwanted generated title' : 'Native fixture answer' }));
  await writeFile(profile.settingsPath, JSON.stringify({ models: { observerModelOverride: 'fixture/title', reflectorModelOverride: null, goalJudgeModel: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fake-local-key', models: ['chat', 'title'] }], lsp: false, observability: { enabled: false } }));
});
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function setup(name: string) {
  const home = join(root, name); await mkdir(home);
  const runtimes: ProjectRuntime[] = [];
  const makeService = () => createChatService({ profile, instanceId: 'titles-fixture', projects: [], directoryHome: home,
    registryFactory: () => openProductRegistry(resolveProfile(join(home, 'product-profile')), { standaloneCwd: home }),
    runtimeFactory: async options => { const runtime = await createProjectRuntime({ ...options, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] }); runtimes.push(runtime); return runtime; },
  });
  return { runtimes, makeService };
}
async function serve(service: ChatService) {
  const server = await serveRouter(createChatRouter(service), 0);
  const client = () => createORPCClient(new RPCLink({ url: `${server.url}/rpc` })) as RouterClient<ChatRouter>;
  return { first: client(), second: client(), close: server.close };
}
async function until<T>(watch: AsyncIterator<T>, predicate: (snapshot: T) => boolean): Promise<T> {
  const signal = AbortSignal.timeout(15_000);
  for (;;) {
    signal.throwIfAborted(); let expire!: () => void;
    const deadline = new Promise<never>((_, reject) => { expire = () => reject(new Error('Title watch timeout')); });
    signal.addEventListener('abort', expire, { once: true });
    try { const next = await Promise.race([watch.next(), deadline]); assert.equal(next.done, false); if (predicate(next.value!)) return next.value!; }
    finally { signal.removeEventListener('abort', expire); }
  }
}

test('native creation pins a placeholder before first Send; first-user preview and awaited manual rename converge across clients and restart', { timeout: 60_000 }, async t => {
  const env = await setup('native-title'); let service = env.makeService(); let server = await serve(service);
  const abort = new AbortController(); let release: (() => void) | undefined;
  t.after(async () => { release?.(); abort.abort(); await server.close(); await service.dispose(); });
  const chat = await server.first.createChat({ settings: { thinkingLevel: 'high' } });
  assert.equal(chat.title, 'New thread'); assert.equal(chat.name, null);
  const row = await env.runtimes[0]!.controller.queryThreadById({ threadId: chat.id });
  assert.equal(row!.title, 'New thread'); assert.equal(row!.metadata!.titlePinned, true); assert.equal(row!.metadata!.kodexUnnamedTitle, true);
  const catalog = await server.second.watchCatalog(undefined, { signal: abort.signal }); await catalog.next();
  const watch = await server.second.watchChat({ chatId: chat.id }, { signal: abort.signal }); await watch.next();
  const requestStart = fixture.requests.length;
  await server.first.send({ chatId: chat.id, text: 'FIRST_TITLE_INPUT  spaced\nline' });
  await until<ChatSnapshot>(watch, value => !value.display.isRunning && value.messages.some(message => message.role === 'assistant') && value.chat.title === 'FIRST_TITLE_INPUT spaced line');
  await until<CatalogSnapshot>(catalog, value => value.chats.some(value => value.id === chat.id && value.title === 'FIRST_TITLE_INPUT spaced line'));
  const hold = fixture.holdNext('ACTIVE_TITLE_RENAME'); release = hold.release;
  await server.first.send({ chatId: chat.id, text: 'ACTIVE_TITLE_RENAME must not replace the first preview' }); await hold.reached;
  const running = await until<ChatSnapshot>(watch, value => value.display.isRunning);
  assert.equal(running.chat.title, 'FIRST_TITLE_INPUT spaced line'); assert.equal(running.settings.thinkingLevel, 'high');
  assert.deepEqual(await server.first.renameChat({ chatId: chat.id, title: '  Manual native name  ' }), { accepted: true });
  await until<CatalogSnapshot>(catalog, value => value.chats.some(value => value.id === chat.id && value.title === 'Manual native name'));
  await until<ChatSnapshot>(watch, value => value.chat.title === 'Manual native name');
  hold.release(); release = undefined;
  await until<ChatSnapshot>(watch, value => !value.display.isRunning && value.messages.filter(message => message.role === 'assistant').length >= 2);
  assert.deepEqual(fixture.requests.slice(requestStart).map(request => request.model), ['chat', 'chat'], 'no automatic title request started');
  const native = await env.runtimes[0]!.controller.queryThreadById({ threadId: chat.id });
  assert.equal(native!.title, 'Manual native name'); assert.equal(native!.metadata!.titlePinned, true); assert.equal(native!.metadata!.thinkingLevel, 'high'); assert.equal(native!.metadata!.kodexUnnamedTitle, false);
  abort.abort(); await server.close(); await service.dispose();
  const requests = fixture.requests.length;
  service = env.makeService(); server = await serve(service);
  const restored = await server.second.openChat({ chatId: chat.id });
  assert.equal(restored.chat.title, 'Manual native name'); assert.equal(restored.chat.name, 'Manual native name'); assert.equal(restored.settings.thinkingLevel, 'high');
  assert.equal((await server.first.listChats()).chats[0]!.title, 'Manual native name');
  assert.equal(fixture.requests.length, requests, 'reading titles after restart stays dormant');
  await server.first.renameChat({ chatId: chat.id, title: 'New thread' });
  const literal = await server.second.openChat({ chatId: chat.id });
  assert.equal(literal.chat.name, 'New thread'); assert.equal(literal.chat.title, 'New thread');
  const literalRow = await env.runtimes.at(-1)!.controller.queryThreadById({ threadId: chat.id });
  assert.equal(literalRow!.metadata!.kodexUnnamedTitle, false);
  await server.close(); await service.dispose();
  service = env.makeService(); server = await serve(service);
  const literalRestored = await server.second.openChat({ chatId: chat.id });
  assert.equal(literalRestored.chat.name, 'New thread'); assert.equal(literalRestored.chat.title, 'New thread');
});

test('rename validates native existence and title, and fences an overlapping canonical catalog read', { timeout: 60_000 }, async t => {
  const env = await setup('rename-overlap'); const service = env.makeService(); const server = await serve(service);
  t.after(async () => { await server.close(); await service.dispose(); });
  const chat = await server.first.createChat({});
  const controller = env.runtimes[0]!.controller; const original = controller.queryThreads.bind(controller);
  let reached!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { reached = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; }); let first = true;
  controller.queryThreads = async input => { const rows = await original(input); if (first) { first = false; reached(); await gate; } return rows; };
  t.after(() => { release(); controller.queryThreads = original; });
  const pending = server.second.listChats(); await held;
  await server.first.renameChat({ chatId: chat.id, title: 'New chat' });
  release(); const current = await pending;
  assert.equal(current.chats[0]!.title, 'New chat', 'a saved manual name is not replaced by placeholder/preview logic');
  assert.equal(current.revision, (await server.first.listChats()).revision);
  await assert.rejects(server.first.renameChat({ chatId: chat.id, title: '  ' }), { code: 'BAD_REQUEST' });
  await assert.rejects(server.first.renameChat({ chatId: 'missing-native-chat', title: 'Missing' }), { code: 'NOT_FOUND' });
  assert.equal((await server.second.listChats()).chats.length, 1, 'rename never fabricates native rows');
  assert.equal((await server.second.openChat({ chatId: chat.id })).chat.title, 'New chat');
});


test('read-only title preview selects the first human signal, bounds Unicode text and never scans past the oldest native page', { timeout: 60_000 }, async t => {
  const env = await setup('bounded-preview'); const service = env.makeService(); const server = await serve(service);
  t.after(async () => { await server.close(); await service.dispose(); });
  const chat = await server.first.createChat({}); const runtime = env.runtimes[0]!;
  const nativeRow = await runtime.controller.queryThreadById({ threadId: chat.id });
  const session = (await runtime.controller.getSessionByResource(nativeRow!.resourceId))!;
  const target = { resourceId: nativeRow!.resourceId, threadId: chat.id };
  const requestStart = fixture.requests.length;
  await session.sendSignalToThread({ type: 'notification', contents: 'SYSTEM_NOT_A_CHAT_PREVIEW' }, target).accepted;
  assert.equal((await server.second.openChat({ chatId: chat.id })).chat.title, 'New thread');
  const input = 'First  human\ninput ' + '😀'.repeat(CHAT_PREVIEW_LIMIT + 10);
  await session.sendSignalToThread({ type: 'user-message', contents: input }, target).accepted;
  await session.sendSignalToThread({ type: 'user', contents: 'A later input is not the first preview' }, target).accepted;
  const shown = await server.second.openChat({ chatId: chat.id });
  const original = runtime.controller.queryThreadMessages.bind(runtime.controller);
  const reads = t.mock.method(runtime.controller, 'queryThreadMessages', original);
  assert.equal(await readChatTitle(runtime, nativeRow!), shown.chat.title);
  assert.equal(reads.mock.callCount(), 1);
  assert.equal(shown.chat.name, null);
  assert.equal(shown.chat.title, Array.from(input.replace(/\s+/g, ' ').trim()).slice(0, CHAT_PREVIEW_LIMIT).join(''));
  assert.equal(Array.from(shown.chat.title).length, CHAT_PREVIEW_LIMIT);
  assert.ok(reads.mock.calls.every(call => call.arguments[0].perPage === CHAT_PREVIEW_PAGE_SIZE && call.arguments[0].page === 0 && call.arguments[0].orderBy?.direction === 'ASC'));
  reads.mock.restore();
  const outside = await server.first.createChat({});
  const outsideRow = await runtime.controller.queryThreadById({ threadId: outside.id });
  const outsideSession = (await runtime.controller.getSessionByResource(outsideRow!.resourceId))!;
  const outsideTarget = { resourceId: outsideRow!.resourceId, threadId: outside.id };
  for (let index = 0; index < CHAT_PREVIEW_PAGE_SIZE; index++) await outsideSession.sendSignalToThread({ type: 'notification', contents: `Internal notification ${index}` }, outsideTarget).accepted;
  await outsideSession.sendSignalToThread({ type: 'user', contents: 'Outside the bounded preview window' }, outsideTarget).accepted;
  assert.equal((await server.second.openChat({ chatId: outside.id })).chat.title, 'New thread');
  assert.equal(fixture.requests.length, requestStart, 'title reads/persisted signals do not start native inference');
});
