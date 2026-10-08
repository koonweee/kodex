import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { createChatService, type ChatSnapshot } from '../src/chat-service.js';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { createChildTools } from '../src/child-tools.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { openProductRegistry } from '../src/product-registry.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { serveRouter } from '../src/server.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

let profileRoot: string, profile: SpikeProfile;
before(async () => {
  profileRoot = await realpath(await mkdtemp(join(tmpdir(), 'kodex-direct-descendants-')));
  profile = activateProfile(resolveProfile(join(profileRoot, 'sdk-profile')));
});
after(async () => { await rm(profileRoot, { recursive: true, force: true }); });
async function setup(t: TestContext) {
  const root = await mkdtemp(join(profileRoot, 'case-'));
  const fixture = await startModelFixture(request => {
    const text = lastUserText(request);
    if (text.includes('FORK_QUESTION')) {
      if (JSON.stringify(request.messages).includes('User answered:')) return { text: 'DIRECT_FORK_QUESTION_RESUMED' };
      return { toolCalls: [{ name: 'ask_user', id: 'direct-fork-question', arguments: { question: 'Which scoped fork evidence?' } }] };
    }
    if (text.includes('CHILD_DIRECT_INPUT')) {
      assert.ok(!request.tools?.some(tool => ['delegate_child', 'message_child', 'subagent'].includes(tool.function.name)), 'child policy is enforced before provider input');
      assert.ok(!JSON.stringify(request.tools?.find(tool => tool.function.name === 'view')?.function.parameters).includes('_background'));
      assert.ok(JSON.stringify(request.messages).includes('SAVED_CHILD_REPLY'), 'native child history reaches the direct provider request');
    }
    if (text.includes('FORK_DIRECT_INPUT')) assert.ok(JSON.stringify(request.messages).includes('SAVED_FORK_REPLY'));
    return { text: `DIRECT_DESCENDANT_RESULT:${text}` };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'local-no-real-key', models: ['chat', 'second'] }],
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: null },
    backgroundTools: { enabled: true }, lsp: false, observability: { enabled: false },
  }));
  const registryProfile = resolveProfile(join(root, 'product'));
  const runtimes: ProjectRuntime[] = [], holds: Array<{ release(): void }> = [], aborts: AbortController[] = [];
  let mounts = 0;
  const make = () => createChatService({ profile, instanceId: 'direct-descendants', directoryHome: root,
    registryFactory: () => openProductRegistry(registryProfile, { standaloneCwd: root }),
    runtimeFactory: async options => {
      let runtime!: ProjectRuntime;
      runtime = await createProjectRuntime({ ...options, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
        subagents: [], extraTools: createChildTools({ getRuntime: () => runtime }) });
      runtime.controller.onSessionCreated(() => { mounts++; }); runtimes.push(runtime); return runtime;
    },
  });
  let service = make(), server = await serveRouter(createChatRouter(service), 0);
  const client = (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  await service.listModels({ projectId: null });
  const runtime = runtimes.at(-1)!, store = await runtime.storage.getStore('memory'); assert.ok(store);
  const now = new Date();
  const save = (id: string, resourceId: string, metadata: Record<string, unknown>) => store.saveThread({ thread: { id, resourceId, title: id, createdAt: now, updatedAt: now, metadata } });
  await save('parent', 'parent-resource', { projectPath: root });
  await save('peer', 'peer-resource', { projectPath: root });
  await save('child', 'child-resource', { projectPath: root, kodexChild: '1', parentThreadId: 'parent', parentResourceId: 'parent-resource', parentSessionScope: '', parentTaskId: 'saved-child-task' });
  await save('fork', 'parent-resource', { forkedSubagent: true, parentThreadId: 'parent' });
  await store.saveMessages({ messages: ['child', 'fork'].flatMap(id => [
    { id: `${id}-saved-user`, threadId: id, resourceId: id === 'fork' ? 'parent-resource' : 'child-resource', role: 'user' as const, createdAt: new Date(now.getTime() - 2000),
      content: { format: 2 as const, parts: [{ type: 'text' as const, text: `SAVED_${id.toUpperCase()}_INPUT` }] } },
    { id: `${id}-saved-reply`, threadId: id, resourceId: id === 'fork' ? 'parent-resource' : 'child-resource', role: 'assistant' as const, createdAt: new Date(now.getTime() - 1000),
      content: { format: 2 as const, parts: [{ type: 'text' as const, text: `SAVED_${id.toUpperCase()}_REPLY` }] } },
  ]) });
  t.after(async () => {
    for (const hold of holds) hold.release(); for (const abort of aborts) abort.abort();
    await server.close(); await service.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true });
  });
  return { client, fixture, get runtime() { return runtimes.at(-1)!; }, get mounts() { return mounts; },
    hold(marker: string) { const hold = fixture.holdNext(marker); holds.push(hold); return hold; },
    releaseOnCleanup(release: () => void) { holds.push({ release }); },
    async watch(chatId: string, peer = client()) { const abort = new AbortController(); aborts.push(abort); const iterator = await peer.watchChat({ chatId }, { signal: abort.signal }); return { iterator, abort }; },
    async restart() { for (const abort of aborts) abort.abort(); await server.close(); await service.dispose(); service = make(); server = await serveRouter(createChatRouter(service), 0); },
  };
}
async function until<T>(iterator: AsyncIterator<T>, matches: (snapshot: T) => boolean) {
  for (;;) { const next = await iterator.next(); assert.equal(next.done, false); if (matches(next.value)) return next.value; }
}
const contains = (snapshot: ChatSnapshot, text: string) => JSON.stringify(snapshot.messages).includes(text);
async function settled(session: ReturnType<ProjectRuntime['sessionsForThread']>[number]['session']) {
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function'); await memory.settled();
}

test('two HTTP peers open native child and same-resource fork, share sparse settings/title/pin and preserve dormant history across recreation', { timeout: 40_000 }, async t => {
  const env = await setup(t), a = env.client(), b = env.client();
  const parent = await a.openChat({ chatId: 'parent' });
  const openedChild = await a.openChat({ chatId: 'child' });
  const openedFork = await b.openChat({ chatId: 'fork' });
  assert.equal(openedChild.chat.id, 'child'); assert.equal(openedFork.chat.id, 'fork');
  assert.equal(openedChild.epoch, (await b.openChat({ chatId: 'child' })).epoch);
  assert.ok(contains(openedChild, 'SAVED_CHILD_REPLY')); assert.ok(contains(openedFork, 'SAVED_FORK_REPLY'));
  assert.ok(!contains(parent, 'SAVED_FORK_REPLY'));
  const parentBinding = env.runtime.sessionsForThread({ resourceId: 'parent-resource', threadId: 'parent' })[0];
  const forkBinding = env.runtime.sessionsForThread({ resourceId: 'parent-resource', threadId: 'fork' })[0];
  assert.ok(parentBinding && forkBinding); assert.notEqual(parentBinding.session, forkBinding.session);
  assert.equal(parentBinding.session.thread.getId(), 'parent', 'fork opening must not retarget the parent Session');
  assert.notEqual(forkBinding.scope, parentBinding.scope, 'same-resource descendants need a distinct native scope');
  const childWatch = await env.watch('child', b); await childWatch.iterator.next();
  const forkWatch = await env.watch('fork', a); await forkWatch.iterator.next();
  await a.updateChatSettings({ chatId: 'child', patch: { modelId: 'fixture/second' } });
  await until(childWatch.iterator, snapshot => snapshot.settings.modelId === 'fixture/second');
  assert.equal((await b.getChatSettings({ chatId: 'child' })).modelId, 'fixture/second');
  assert.equal((await a.getChatSettings({ chatId: 'parent' })).modelId, 'fixture/chat');
  await b.renameChat({ chatId: 'child', title: 'Direct child shared title' });
  await until(childWatch.iterator, snapshot => snapshot.chat.title === 'Direct child shared title');
  await a.renameChat({ chatId: 'fork', title: 'Direct fork shared title' });
  await until(forkWatch.iterator, snapshot => snapshot.chat.title === 'Direct fork shared title');
  await a.setChatPinned({ chatId: 'child', pinned: true }); await b.setChatPinned({ chatId: 'fork', pinned: true });
  const catalog = await a.listChats();
  assert.deepEqual(new Set(catalog.pinnedDescendants.map(row => row.id)), new Set(['child', 'fork']));
  assert.deepEqual(new Set(catalog.chats.map(row => row.id)), new Set(['parent', 'peer']), 'editable descendants stay outside ordinary chat inventory');
  await a.send({ chatId: 'child', text: 'CHILD_DIRECT_INPUT' });
  const childDone = await until(childWatch.iterator, snapshot => !snapshot.display.isRunning && contains(snapshot, 'DIRECT_DESCENDANT_RESULT:CHILD_DIRECT_INPUT'));
  await b.send({ chatId: 'fork', text: 'FORK_DIRECT_INPUT' });
  await until(forkWatch.iterator, snapshot => !snapshot.display.isRunning && contains(snapshot, 'DIRECT_DESCENDANT_RESULT:FORK_DIRECT_INPUT'));
  await a.send({ chatId: 'fork', text: 'FORK_QUESTION' });
  const parked = await until(forkWatch.iterator, snapshot => snapshot.prompts.some(prompt => prompt.kind === 'question'));
  const prompt = parked.prompts.find(prompt => prompt.kind === 'question'); assert.ok(prompt && prompt.kind === 'question');
  assert.equal(prompt.target.sessionId, forkBinding.session.identity.getId());
  assert.equal(prompt.target.resourceId, parentBinding.session.identity.getResourceId());
  assert.equal(prompt.target.threadId, forkBinding.session.thread.requireId(), 'the prompt targets the scoped fork rather than its same-resource parent');
  assert.notEqual(prompt.target.threadId, parentBinding.session.thread.requireId());
  assert.equal(prompt.target.runId, forkBinding.session.suspensions.get({ toolCallId: prompt.target.toolCallId })?.runId);
  const replies = await Promise.allSettled([
    a.respondPrompt({ chatId: 'fork', kind: 'question', target: prompt.target, answer: 'FIRST_FORK_ANSWER' }),
    b.respondPrompt({ chatId: 'fork', kind: 'question', target: prompt.target, answer: 'SECOND_FORK_ANSWER' }),
  ]);
  assert.equal(replies.filter(reply => reply.status === 'fulfilled').length, 1, 'native claim accepts one peer response');
  const loser = replies.find(reply => reply.status === 'rejected'); assert.ok(loser && loser.status === 'rejected'); assert.equal(loser.reason.code, 'CONFLICT');
  const forkDone = await until(forkWatch.iterator, snapshot => !snapshot.display.isRunning && contains(snapshot, 'DIRECT_FORK_QUESTION_RESUMED'));
  assert.equal(forkDone.prompts.length, 0);
  await assert.rejects(a.respondPrompt({ chatId: 'fork', kind: 'question', target: prompt.target, answer: 'STALE_FORK_ANSWER' }), { code: 'CONFLICT' });
  assert.equal(parentBinding.session.thread.getId(), 'parent');
  await settled(env.runtime.sessionsForThread({ resourceId: 'child-resource', threadId: 'child' })[0]!.session); await settled(forkBinding.session);
  const requests = env.fixture.requests.length;
  await env.restart();
  const beforeMounts = env.mounts;
  const routes = await Promise.all(['child', 'fork'].map(chatId => env.client().readChatRoute({ chatId })));
  assert.deepEqual(routes.map(route => route.chat.title), ['Direct child shared title', 'Direct fork shared title']);
  assert.equal(env.mounts, beforeMounts, 'dormant metadata reads do not mount descendants');
  assert.equal(env.fixture.requests.length, requests);
  for (const [id, saved] of [['child', childDone], ['fork', forkDone]] as const) {
    const restored = await env.client().openChat({ chatId: id });
    const byId = new Map(restored.messages.map(message => [message.id, message]));
    for (const message of saved.messages) assert.deepEqual(byId.get(message.id), message, 'opening preserves canonical saved history');
    assert.equal(restored.chat.title, saved.chat.title);
  }
  assert.equal((await env.client().getChatSettings({ chatId: 'child' })).modelId, 'fixture/second');
  assert.equal(env.fixture.requests.length, requests, 'reopening existing native history does not itself run the model');
  assert.deepEqual((await env.client().listChats()).pinnedChatIds, catalog.pinnedChatIds);
});

test('parent archive closes descendant observers and admissions, preserves native history and leaves unrelated work running', { timeout: 40_000 }, async t => {
  const env = await setup(t), a = env.client(), b = env.client();
  const childWatch = await env.watch('child', a); await childWatch.iterator.next();
  const forkWatch = await env.watch('fork', b); await forkWatch.iterator.next();
  const peerWatch = await env.watch('peer', b); await peerWatch.iterator.next();
  const heldChild = env.hold('CHILD_ARCHIVE_HELD'), heldFork = env.hold('FORK_ARCHIVE_HELD'), heldPeer = env.hold('PEER_ARCHIVE_HELD');
  await a.send({ chatId: 'child', text: 'CHILD_ARCHIVE_HELD' }); await heldChild.reached;
  await b.send({ chatId: 'fork', text: 'FORK_ARCHIVE_HELD' }); await heldFork.reached;
  await b.send({ chatId: 'peer', text: 'PEER_ARCHIVE_HELD' }); await heldPeer.reached;
  await until(childWatch.iterator, snapshot => snapshot.display.isRunning);
  await until(forkWatch.iterator, snapshot => snapshot.display.isRunning);
  await until(peerWatch.iterator, snapshot => snapshot.display.isRunning);
  await a.archiveChat({ chatId: 'parent' });
  await closed(childWatch.iterator); await closed(forkWatch.iterator);
  for (const chatId of ['child', 'fork']) {
    await assert.rejects(b.openChat({ chatId }), { code: 'CONFLICT' });
    await assert.rejects(a.send({ chatId, text: 'ARCHIVED_INPUT_REJECTED' }), { code: 'CONFLICT' });
    await assert.rejects(b.watchChat({ chatId }).then(iterator => iterator.next()), { code: 'CONFLICT' });
  }
  assert.deepEqual(env.runtime.sessionsForThread({ resourceId: 'child-resource', threadId: 'child' }), []);
  assert.deepEqual(env.runtime.sessionsForThread({ resourceId: 'parent-resource', threadId: 'fork' }), []);
  const peer = env.runtime.sessionsForThread({ resourceId: 'peer-resource', threadId: 'peer' })[0]; assert.ok(peer);
  assert.equal(peer.session.displayState.get().isRunning, true, 'parent archive does not interrupt an unrelated native run');
  heldChild.release(); heldFork.release(); heldPeer.release();
  await until(peerWatch.iterator, snapshot => !snapshot.display.isRunning && contains(snapshot, 'started:PEER_ARCHIVE_HELD'));
  for (const [threadId, resourceId] of [['child', 'child-resource'], ['fork', 'parent-resource']] as const) {
    const history = await env.runtime.controller.queryThreadMessages({ threadId, resourceId, perPage: false });
    assert.ok(history.messages.some(message => message.id === `${threadId}-saved-reply`), 'archive retains preexisting saved native descendant history');
  }
  assert.ok(!env.fixture.requests.some(request => lastUserText(request).includes('ARCHIVED_INPUT_REJECTED')));
});

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function closed(iterator: AsyncIterator<ChatSnapshot>) {
  // Buffered pre-retirement rows may precede the clean native observer close.
  for (;;) { const next = await iterator.next(); if (next.done) return; }
}

test('parent retirement drains a child input acknowledgment, rejects new descendant commands and aborts the held model without awaiting its response', { timeout: 40_000 }, async t => {
  const env = await setup(t), a = env.client(), b = env.client();
  const watch = await env.watch('child', b); await watch.iterator.next();
  const child = env.runtime.sessionsForThread({ resourceId: 'child-resource', threadId: 'child' })[0]!.session;
  const entered = gate(), release = gate(); env.releaseOnCleanup(release.release);
  const signal = child.sendSignal.bind(child);
  t.mock.method(child, 'sendSignal', (...args: Parameters<typeof signal>) => {
    const sent = signal(...args);
    if (!JSON.stringify(args[0]).includes('CHILD_ACCEPTANCE_HELD')) return sent;
    return { ...sent, accepted: sent.accepted.then(async decision => { entered.release(); await release.promise; return decision; }) };
  });
  const held = env.hold('CHILD_ACCEPTANCE_HELD');
  const input = a.send({ chatId: 'child', text: 'CHILD_ACCEPTANCE_HELD' }); void input.catch(() => {});
  await entered.promise; await held.reached;
  let archived = false;
  const archive = b.archiveChat({ chatId: 'parent' }).then(result => { archived = true; return result; }); void archive.catch(() => {});
  // Read-only public requests witness the async archive admission closing.
  // This is bounded fixture observation, not a production retry/wait loop.
  let fenced = false;
  for (let attempt = 0; attempt < 20 && !fenced; attempt++) {
    try { await a.readChatRoute({ chatId: 'parent' }); }
    catch (error) { assert.equal((error as { code: string }).code, 'CONFLICT'); fenced = true; }
  }
  assert.equal(fenced, true);
  assert.equal(archived, false, 'parent retirement waits for the already-admitted child input acknowledgment');
  assert.equal(child.displayState.get().isRunning, true);
  await assert.rejects(a.send({ chatId: 'child', text: 'AFTER_PARENT_ARCHIVE_ADMISSION' }), { code: 'CONFLICT' });
  await assert.rejects(a.renameChat({ chatId: 'fork', title: 'Rejected during root retirement' }), { code: 'CONFLICT' });
  release.release();
  assert.deepEqual(await input, { accepted: true }); assert.deepEqual(await archive, { accepted: true });
  assert.equal(child.displayState.get().isRunning, false, 'retirement finished while the provider response gate remains held');
  await closed(watch.iterator);
  assert.deepEqual(env.runtime.sessionsForThread({ resourceId: 'child-resource', threadId: 'child' }), []);
  assert.ok(!env.fixture.requests.some(request => lastUserText(request).includes('AFTER_PARENT_ARCHIVE_ADMISSION')));
  held.release();
});

test('direct fork archive closes only its scoped Session and observers while its same-resource parent and unrelated peer continue', { timeout: 40_000 }, async t => {
  const env = await setup(t), a = env.client(), b = env.client();
  const parentWatch = await env.watch('parent', a); await parentWatch.iterator.next();
  const forkWatch = await env.watch('fork', b); await forkWatch.iterator.next();
  const peerWatch = await env.watch('peer', b); await peerWatch.iterator.next();
  const parent = env.runtime.sessionsForThread({ resourceId: 'parent-resource', threadId: 'parent' })[0]!.session;
  const fork = env.runtime.sessionsForThread({ resourceId: 'parent-resource', threadId: 'fork' })[0]!.session;
  const peer = env.runtime.sessionsForThread({ resourceId: 'peer-resource', threadId: 'peer' })[0]!.session;
  const parentHold = env.hold('PARENT_FORK_ARCHIVE_HELD'), forkHold = env.hold('FORK_OWN_ARCHIVE_HELD'), peerHold = env.hold('PEER_FORK_ARCHIVE_HELD');
  await a.send({ chatId: 'parent', text: 'PARENT_FORK_ARCHIVE_HELD' }); await parentHold.reached;
  await b.send({ chatId: 'fork', text: 'FORK_OWN_ARCHIVE_HELD' }); await forkHold.reached;
  await b.send({ chatId: 'peer', text: 'PEER_FORK_ARCHIVE_HELD' }); await peerHold.reached;
  const parentRun = parent.getCurrentRunId(), peerRun = peer.getCurrentRunId(); assert.ok(parentRun && peerRun);
  await a.archiveChat({ chatId: 'fork' }); await closed(forkWatch.iterator);
  assert.equal(fork.thread.getId(), null);
  assert.equal(parent.displayState.get().isRunning, true); assert.equal(parent.getCurrentRunId(), parentRun);
  assert.equal(peer.displayState.get().isRunning, true); assert.equal(peer.getCurrentRunId(), peerRun);
  assert.equal((await b.openChat({ chatId: 'parent' })).chat.id, 'parent');
  await assert.rejects(a.openChat({ chatId: 'fork' }), { code: 'CONFLICT' });
  assert.ok((await b.listChats()).chats.some(row => row.id === 'parent'));
  forkHold.release(); parentHold.release(); peerHold.release();
  await until(parentWatch.iterator, snapshot => !snapshot.display.isRunning && contains(snapshot, 'started:PARENT_FORK_ARCHIVE_HELD'));
  await until(peerWatch.iterator, snapshot => !snapshot.display.isRunning && contains(snapshot, 'started:PEER_FORK_ARCHIVE_HELD'));
  const saved = await env.runtime.controller.queryThreadMessages({ threadId: 'fork', resourceId: 'parent-resource', perPage: false });
  assert.ok(saved.messages.some(message => message.id === 'fork-saved-reply'));
});
