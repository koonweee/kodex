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
import { createChatService, type CatalogSnapshot, type ChatService, type ChatSnapshot } from '../src/chat-service.js';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { serveRouter } from '../src/server.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

let root: string, profile: SpikeProfile, fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-chat-projects-')));
  profile = activateProfile(resolveProfile(join(root, 'sdk-profile')));
  fixture = await startModelFixture(request => {
    const user = lastUserText(request);
    if (user.startsWith('READ_MARKER') && request.messages.at(-1)?.role !== 'tool') return { toolCalls: [{ name: 'view', arguments: { path: 'marker.txt' } }] };
    return { text: user.startsWith('READ_MARKER') ? `tool-result:${JSON.stringify(request.messages.at(-1))}` : `fixture:${user}` };
  });
  await writeFile(profile.settingsPath, JSON.stringify({ models: { observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fake-local-key', models: ['chat'] }], lsp: false, observability: { enabled: false } }));
});
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function setup(name: string) {
  const home = join(root, name); await mkdir(home);
  const old = join(home, 'old'), next = join(home, 'next');
  await Promise.all([mkdir(old), mkdir(next)]);
  await Promise.all([writeFile(join(old, 'marker.txt'), 'OLD_NATIVE_CWD'), writeFile(join(next, 'marker.txt'), 'NEW_NATIVE_CWD')]);
  const registryProfile = resolveProfile(join(home, 'product-profile'));
  const projects = [{ id: 'cli-seed', name: 'Seed', path: old, runtimeRoot: join(home, 'seed-runtime') }];
  const runtimes: ProjectRuntime[] = [];
  const makeService = () => createChatService({ profile, projects, instanceId: 'project-fixture', directoryHome: home,
    registryFactory: () => openProductRegistry(registryProfile, { standaloneCwd: home }),
    runtimeFactory: async options => { const runtime = await createProjectRuntime({ ...options, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] }); runtimes.push(runtime); return runtime; },
  });
  return { home, old, next, registryProfile, runtimes, makeService };
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
    const deadline = new Promise<never>((_, reject) => { expire = () => reject(new Error('Project watch timeout')); });
    signal.addEventListener('abort', expire, { once: true });
    try { const next = await Promise.race([watch.next(), deadline]); assert.equal(next.done, false); if (predicate(next.value!)) return next.value!; }
    finally { signal.removeEventListener('abort', expire); }
  }
}
async function nameChat(runtimes: ProjectRuntime[], id: string) {
  for (const runtime of runtimes) {
    const thread = await runtime.controller.queryThreadById({ threadId: id });
    if (thread) { await (await runtime.controller.getSessionByResource(thread.resourceId))!.thread.rename({ title: 'Project fixture' }); return; }
  }
  throw new Error('Native fixture session missing');
}

test('two clients mutate ordered projects while existing native chat cwd and binding remain stable', { timeout: 60_000 }, async t => {
  const env = await setup('mutations'); const service = env.makeService(); const server = await serve(service);
  const abort = new AbortController(); t.after(async () => { abort.abort(); await server.close(); await service.dispose(); });
  const catalog = await server.second.watchCatalog(undefined, { signal: abort.signal });
  const initial = await until<CatalogSnapshot>(catalog, () => true);
  assert.deepEqual(initial.projects, [{ id: 'cli-seed', name: 'Seed', roots: [env.old] }]);
  const oldChat = await server.first.createChat({ projectId: 'cli-seed' }); await nameChat(env.runtimes, oldChat.id);
  const oldWatch = await server.second.watchChat({ chatId: oldChat.id }, { signal: abort.signal }); await oldWatch.next();
  const created = await server.first.createProject({ createKey: 'one-browser-attempt', path: env.next });
  assert.deepEqual(await server.second.createProject({ createKey: 'one-browser-attempt', path: env.next }), created);
  await server.second.moveProjectBefore({ projectId: created.id, beforeId: 'cli-seed' });
  const ordered = await until<CatalogSnapshot>(catalog, value => value.projects[0]?.id === created.id);
  assert.equal(ordered.projects.length, 2); assert.ok(ordered.revision > initial.revision);
  await server.first.updateProject({ projectId: 'cli-seed', patch: { name: 'Renamed', roots: [env.next] } });
  const changed = await until<CatalogSnapshot>(catalog, value => value.projects.find(project => project.id === 'cli-seed')?.name === 'Renamed');
  assert.deepEqual(changed.projects.find(project => project.id === 'cli-seed')!.roots, [env.next]);
  assert.equal(changed.chats.find(chat => chat.id === oldChat.id)!.cwd, env.old);
  const newChat = await server.second.createChat({ projectId: 'cli-seed' }); await nameChat(env.runtimes, newChat.id);
  assert.equal(newChat.cwd, env.next);
  assert.equal((await server.first.openChat({ chatId: oldChat.id })).chat.cwd, env.old);
  await server.first.send({ chatId: oldChat.id, text: 'READ_MARKER_OLD' });
  await until<ChatSnapshot>(oldWatch, value => !value.display.isRunning && JSON.stringify(value.messages).includes('tool-result:') && JSON.stringify(value.messages).includes('OLD_NATIVE_CWD'));
  const nextWatch = await server.first.watchChat({ chatId: newChat.id }, { signal: abort.signal }); await nextWatch.next();
  await server.second.send({ chatId: newChat.id, text: 'READ_MARKER_NEW' });
  await until<ChatSnapshot>(nextWatch, value => !value.display.isRunning && JSON.stringify(value.messages).includes('tool-result:') && JSON.stringify(value.messages).includes('NEW_NATIVE_CWD'));
  await server.first.updateProject({ projectId: 'cli-seed', patch: { roots: [] } });
  await assert.rejects(server.second.createChat({ projectId: 'cli-seed' }), { code: 'CONFLICT' });
  assert.ok((await server.first.listModels({ chatId: oldChat.id })).some(model => model.modelName === 'chat'));
  await server.first.updateProject({ projectId: 'cli-seed', patch: { roots: [env.old, env.next] } });
  await assert.rejects(server.second.createChat({ projectId: 'cli-seed' }), { code: 'CONFLICT' });
  assert.equal((await server.second.openChat({ chatId: oldChat.id })).chat.projectId, 'cli-seed');
});

test('deletion detaches old chats live; recreation and service restart never reassign them or resurrect CLI seeds', { timeout: 60_000 }, async t => {
  const env = await setup('deletion'); let service = env.makeService(); let server = await serve(service);
  const abort = new AbortController(); t.after(async () => { abort.abort(); await server.close(); await service.dispose(); });
  const chat = await server.first.createChat({ projectId: 'cli-seed' }); await nameChat(env.runtimes, chat.id);
  const watch = await server.second.watchChat({ chatId: chat.id }, { signal: abort.signal }); await watch.next();
  await server.first.send({ chatId: chat.id, text: 'PROJECT_HISTORY_SURVIVES' });
  await until<ChatSnapshot>(watch, value => !value.display.isRunning && JSON.stringify(value.messages).includes('fixture:PROJECT_HISTORY_SURVIVES'));
  await server.first.deleteProject({ projectId: 'cli-seed' });
  const detached = await until<ChatSnapshot>(watch, value => value.chat.projectId === null);
  assert.equal(detached.chat.cwd, env.old);
  assert.deepEqual((await server.second.listChats()).projects, []);
  const recreated = await server.second.createProject({ createKey: 'new-project', path: env.old });
  assert.notEqual(recreated.id, 'cli-seed');
  const newChat = await server.first.createChat({ projectId: recreated.id });
  assert.notEqual(newChat.id, chat.id);
  assert.equal((await server.second.openChat({ chatId: chat.id })).chat.projectId, null);
  abort.abort(); await server.close(); await service.dispose();
  const beforeRequests = fixture.requests.length;
  service = env.makeService(); server = await serve(service);
  const catalog = await server.first.listChats();
  assert.deepEqual(catalog.projects.map(project => project.id), [recreated.id]);
  assert.equal(catalog.chats.find(row => row.id === chat.id)!.projectId, null);
  assert.equal(catalog.chats.find(row => row.id === newChat.id)!.projectId, recreated.id);
  const restored = await server.second.openChat({ chatId: chat.id });
  assert.equal(restored.chat.cwd, env.old);
  assert.ok(restored.messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('fixture:PROJECT_HISTORY_SURVIVES')));
  assert.equal(fixture.requests.length, beforeRequests, 'discovery/history never activates old chats');
});

test('standalone creation and default settings work without projects; directory and RPC input validation stay authoritative', { timeout: 60_000 }, async t => {
  const env = await setup('standalone'); const service = env.makeService(); const server = await serve(service);
  t.after(async () => { await server.close(); await service.dispose(); });
  await server.first.deleteProject({ projectId: 'cli-seed' });
  assert.deepEqual(await server.first.info(), { instanceId: 'project-fixture' });
  const directory = await server.first.listDirectories({});
  assert.equal(directory.homePath, env.home);
  assert.ok(directory.directories.some(row => row.path === env.next));
  await assert.rejects(server.second.createProject({ createKey: 'outside', path: root }), { code: 'BAD_REQUEST' });
  await assert.rejects(server.second.updateProject({ projectId: 'missing', patch: { name: 'x' } }), { code: 'NOT_FOUND' });
  await assert.rejects(server.first.updateProject({ projectId: 'missing', patch: { permissionMode: 'anything' } } as never), { code: 'BAD_REQUEST' });
  const models = await server.first.listModels({ projectId: null });
  assert.ok(models.some(model => model.modelName === 'chat'));
  assert.ok((await server.second.getDraftDefaults()).modelId);
  const chat = await server.first.createChat({});
  assert.equal(chat.projectId, null); assert.equal(chat.cwd, env.home);
  assert.equal((await server.second.listChats()).chats.find(row => row.id === chat.id)!.projectId, null);
  await assert.rejects(server.first.listModels({ projectId: null, chatId: chat.id } as never), { code: 'BAD_REQUEST' });
});

test('validated native children reopen across restart while all child rows stay outside ordinary inventory', { timeout: 60_000 }, async t => {
  const env = await setup('child-admission');
  let service = env.makeService();
  let server = await serve(service);
  t.after(async () => { await server.close(); await service.dispose(); });
  const parent = await server.first.createChat({ projectId: 'cli-seed' });
  const runtime = env.runtimes.find(candidate => candidate.projectPath === env.old)!;
  const parentThread = await runtime.controller.queryThreadById({ threadId: parent.id });
  assert.ok(parentThread);
  const child = await runtime.createSession({ resourceId: 'child-catalog-resource', threadId: 'child-catalog-thread', tags: {
    kodexChild: '1', parentThreadId: parent.id, parentResourceId: parentThread.resourceId,
    parentSessionScope: '', parentTaskId: 'native-task-catalog',
  } });
  const childId = child.thread.requireId();
  await child.thread.rename({ title: 'Validated child' });
  // Partial relations must not turn internal children into editable chats.
  const incomplete = await runtime.createSession({ resourceId: 'partial-child-resource', threadId: 'partial-child-thread', tags: { kodexChild: '1' } });
  const malformed = await runtime.createSession({ resourceId: 'malformed-child-resource', threadId: 'malformed-child-thread', tags: {
    kodexChild: '1', parentThreadId: parent.id, parentResourceId: 'foreign-parent-resource',
    parentSessionScope: '', parentTaskId: 'malformed-native-task',
  } });
  const rejectedIds = [incomplete.thread.requireId(), malformed.thread.requireId()];
  const internalIds = [childId, ...rejectedIds];
  const requestsBefore = fixture.requests.length;
  async function assertAdmission() {
    for (const client of [server.first, server.second]) {
      const { chats } = await client.listChats();
      assert.ok(chats.some(chat => chat.id === parent.id));
      for (const chatId of internalIds) assert.equal(chats.some(chat => chat.id === chatId), false, 'child is not an ordinary sidebar chat');
      const opened = await client.openChat({ chatId: childId });
      assert.equal(opened.chat.id, childId);
      assert.equal(opened.chat.title, 'Validated child');
      assert.equal(opened.chat.projectId, 'cli-seed');
      assert.equal(opened.chat.cwd, env.old);
      assert.equal(opened.display.isRunning, false);
      for (const chatId of rejectedIds) {
        await assert.rejects(client.openChat({ chatId }), { code: 'NOT_FOUND' });
        await assert.rejects(client.send({ chatId, text: 'must not start a malformed child run' }), { code: 'NOT_FOUND' });
      }
      assert.equal(fixture.requests.length, requestsBefore, 'editable reopen and rejected relations never start model work');
    }
  }
  await assertAdmission();
  await server.close(); await service.dispose();
  service = env.makeService(); server = await serve(service);
  await assertAdmission();
});
