import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { before, after, test, type TestContext } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RequestContext } from '@mastra/core/request-context';
import { noopObserve } from '@mastra/core/tools';
import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { createControlTools } from '../src/control-tools.js';
import { createChildTools } from '../src/child-tools.js';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { createChatService, type ChatService } from '../src/chat-service.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { serveRouter } from '../src/server.js';
import { lastUserText, startModelFixture, type FixtureRequest, type FixtureReply } from './fixtures/model-server.js';

let profile: SpikeProfile, profileRoot: string;
before(async () => {
  profileRoot = await mkdtemp(join(tmpdir(), 'kodex-control-profile-'));
  profile = activateProfile(resolveProfile(profileRoot));
});
after(async () => { await rm(profileRoot, { recursive: true, force: true }); });

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function setup(t: TestContext, reply: (request: FixtureRequest) => FixtureReply | Promise<FixtureReply>) {
  const root = await mkdtemp(join(profileRoot, 'case-'));
  const projectId = basename(root);
  const cwd = join(root, 'project'); await mkdir(cwd);
  const fixture = await startModelFixture(reply);
  await writeFile(profile.settingsPath, JSON.stringify({
    lsp: false, observability: { enabled: false }, backgroundTools: { enabled: true },
    models: { observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
  }));
  const sessions = new Set<NativeSession>(), cleanup: Array<() => void> = [];
  const producers = new Map<string, ReturnType<typeof gate>>();
  let runtime!: ProjectRuntime, service!: ChatService;
  async function settled() {
    let joined = -1;
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(done => done.promise)); }
  }
  async function open() {
    service = createChatService({ profile, instanceId: 'control-tools-proof', directoryHome: cwd,
      projects: [{ id: projectId, name: 'Project', path: cwd, runtimeRoot: join(root, 'runtime') }],
      runtimeFactory: async input => {
        let mounted!: ProjectRuntime;
        mounted = await createProjectRuntime({ ...input, subagents: [],
          modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
          extraTools: { ...createChildTools({ getRuntime: () => mounted }),
            ...createControlTools({ getRuntime: () => mounted, getService: () => service }) },
        });
        if (input.runtimeRoot.endsWith('/' + basename(root) + '/runtime')) runtime = mounted;
        mounted.controller.onSessionCreated(session => { sessions.add(session); });
        const register = mounted.mastra.__registerInternalWorkflow.bind(mounted.mastra);
        const unregister = mounted.mastra.__unregisterInternalWorkflow.bind(mounted.mastra);
        // Fixture-only producer observation joins persistence before disposal.
        t.mock.method(mounted.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
          const result = register(...args);
          if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], gate());
          return result;
        });
        t.mock.method(mounted.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
          unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.release();
        });
        return mounted;
      },
    });
  }
  await open();
  let server = await serveRouter(createChatRouter(service), 0);
  const client = (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  t.after(async () => {
    for (const run of cleanup) run();
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    await settled(); await server.close(); await service.dispose(); await fixture.close();
    
  });
  return { fixture, client, settled, sessions, projectId, cleanup,
    get runtime() { return runtime; }, get service() { return service; },
    async session(id: string) {
      const thread = await runtime.controller.queryThreadById({ threadId: id }); assert.ok(thread);
      const session = await runtime.controller.getSessionByResource(thread.resourceId); assert.ok(session);
      return session;
    },
    async send(id: string, text: string) {
      const session = await this.session(id), ended = gate();
      const off = session.subscribe(event => { if (event.type === 'agent_end') ended.release(); });
      try { await client().send({ chatId: id, text }); await ended.promise; await settled(); } finally { off(); }
    },
    async restart() {
      await settled(); await server.close(); await service.dispose(); await open();
      server = await serveRouter(createChatRouter(service), 0);
    },
  };
}
function invocation(messages: Awaited<ReturnType<ChatService['openChat']>>['messages'], id: string) {
  for (const message of messages) for (const part of message.content.parts) {
    if (part.type === 'tool-invocation' && part.toolInvocation.toolCallId === id) return part.toolInvocation;
  }
  throw new Error(`Missing native tool invocation ${id}`);
}

function result(request: FixtureRequest, index: number): Record<string, unknown> {
  const content = request.messages.filter(message => message.role === 'tool')[index]?.content;
  assert.equal(typeof content, 'string');
  return JSON.parse(content as string) as Record<string, unknown>;
}
async function until<T>(iterator: AsyncIterator<T>, predicate: (value: T) => boolean) {
  for (;;) { const next = await iterator.next(); assert.equal(next.done, false); if (predicate(next.value)) return next.value; }
}

test('native Control tools dispatch through the host and two clients observe shared chat mutations', { timeout: 40_000 }, async t => {
  let createdId = '', projectId = '';
  let hold: ReturnType<Awaited<ReturnType<typeof startModelFixture>>['holdNext']>;
  const env = await setup(t, async request => {
    if (lastUserText(request) === 'CONTROL_QUEUED_INPUT') return { text: 'CONTROL_TARGET_RESULT' };
    const received = request.messages.filter(message => message.role === 'tool').length;
    if (received === 6) { const created = result(request, 5); assert.equal(typeof created.id, 'string'); createdId = created.id as string; }
    if (received === 12) await hold.reached;
    const calls = [
      { name: 'get_status', arguments: {} },
      { name: 'list_projects', arguments: {} },
      { name: 'get_project', arguments: { projectId } },
      { name: 'list_threads', arguments: { projectId } },
      { name: 'list_sidebar_threads', arguments: {} },
      { name: 'create_thread', arguments: { projectId } },
      { name: 'rename_thread', arguments: { threadId: createdId, name: 'Controlled chat' } },
      { name: 'pin_thread', arguments: { threadId: createdId, pinned: true } },
      { name: 'list_pinned_threads', arguments: {} },
      { name: 'get_thread', arguments: { threadId: createdId } },
      { name: 'get_thread_timeline', arguments: { threadId: createdId } },
      { name: 'send_thread_input', arguments: { threadId: createdId, text: 'CONTROL_QUEUED_INPUT' } },
      { name: 'interrupt_thread', arguments: { threadId: createdId } },
      { name: 'archive_thread', arguments: { threadId: createdId } },
    ];
    return received < calls.length
      ? { toolCalls: [{ ...calls[received]!, id: 'control-' + received }] }
      : { text: 'CONTROL_FINISHED' };
  });
  projectId = env.projectId; hold = env.fixture.holdNext('CONTROL_QUEUED_INPUT'); env.cleanup.push(hold.release);
  const first = env.client(), second = env.client();
  const parent = await first.createChat({ projectId });
  const watching = new AbortController(); env.cleanup.push(() => watching.abort());
  const left = await first.watchCatalog(undefined, { signal: watching.signal });
  const right = await second.watchCatalog(undefined, { signal: watching.signal });
  await Promise.all([left.next(), right.next()]);
  const converged = Promise.all([left, right].map(watch => until(watch, catalog => Boolean(createdId) && catalog.archivedChatIds.includes(createdId))));
  await env.send(parent.id, 'CONTROL_DISCOVERY_AND_MUTATIONS');
  const catalogs = await converged; watching.abort();
  assert.ok(catalogs.every(catalog => !catalog.chats.some(chat => chat.id === createdId)));
  const snapshot = await second.openChat({ chatId: parent.id });
  const outputs = Array.from({ length: 14 }, (_, index) => invocation(snapshot.messages, 'control-' + index).result);
  assert.deepEqual(outputs[0], { instanceId: 'control-tools-proof' });
  assert.ok((outputs[1] as { projects: Array<{ id: string }> }).projects.some(project => project.id === projectId));
  assert.equal((outputs[2] as { id: string }).id, projectId);
  assert.ok((outputs[3] as { chats: Array<{ id: string }> }).chats.some(chat => chat.id === parent.id));
  assert.ok((outputs[4] as { chats: Array<{ id: string }> }).chats.some(chat => chat.id === parent.id));
  assert.equal((outputs[5] as { id: string }).id, createdId);
  assert.deepEqual(outputs[6], { accepted: true }); assert.deepEqual(outputs[7], { accepted: true });
  assert.equal((outputs[8] as { chats: Array<{ id: string }> }).chats[0]?.id, createdId);
  assert.equal((outputs[9] as { name: string }).name, 'Controlled chat');
  assert.deepEqual((outputs[10] as { messages: unknown[] }).messages, []);
  assert.equal((outputs[11] as { outcome: string }).outcome, 'applied');
  assert.deepEqual(outputs[12], { accepted: true }); assert.deepEqual(outputs[13], { accepted: true });
  const row = await env.runtime.controller.queryThreadById({ threadId: createdId }); assert.ok(row);
  assert.equal(await env.runtime.controller.getSessionByResource(row.resourceId), undefined);
  assert.equal((await second.listChats()).archivedChatIds.includes(createdId), true);
});

test('Control metadata and history reads leave a persisted ordinary chat dormant after restart', { timeout: 30_000 }, async t => {
  const env = await setup(t, () => ({ text: 'CONTROL_SAVED_HISTORY' }));
  const chat = await env.client().createChat({ projectId: env.projectId });
  await env.send(chat.id, 'CONTROL_ORIGINAL_INPUT');
  const thread = await env.runtime.controller.queryThreadById({ threadId: chat.id }); assert.ok(thread);
  await env.restart();
  await env.client().listChats();
  assert.equal(await env.runtime.controller.getSessionByResource(thread.resourceId), undefined);
  const before = env.fixture.requests.length;
  assert.equal((await env.service.readControlChat({ chatId: chat.id })).id, chat.id);
  const history = await env.service.readControlHistory({ chatId: chat.id });
  assert.match(JSON.stringify(history.messages), /CONTROL_ORIGINAL_INPUT/);
  assert.match(JSON.stringify(history.messages), /CONTROL_SAVED_HISTORY/);
  assert.equal(history.chat.id, chat.id);
  assert.equal(await env.runtime.controller.getSessionByResource(thread.resourceId), undefined);
  assert.equal(env.fixture.requests.length, before);
});

test('Control queues one native follow-up while an active target runs without steering it', { timeout: 30_000 }, async t => {
  let targetId = '';
  const env = await setup(t, request => {
    if (lastUserText(request) === 'CONTROL_QUEUE_COMMAND') return request.messages.some(message => message.role === 'tool')
      ? { text: 'CONTROL_QUEUE_ACK' }
      : { toolCalls: [{ name: 'send_thread_input', arguments: { threadId: targetId, text: 'CONTROL_FOLLOW_UP' }, id: 'control-queue' }] };
    return { text: 'CONTROL_TARGET_COMPLETED' };
  });
  const first = env.client(), second = env.client();
  const parent = await first.createChat({ projectId: env.projectId });
  const target = await first.createChat({ projectId: env.projectId }); targetId = target.id;
  const hold = env.fixture.holdNext('CONTROL_ACTIVE_TARGET'); env.cleanup.push(hold.release);
  await first.send({ chatId: target.id, text: 'CONTROL_ACTIVE_TARGET' }); await hold.reached;
  const targetSession = await env.session(target.id);
  const nativeSignal = targetSession.sendSignal.bind(targetSession); let steeringSignals = 0;
  t.mock.method(targetSession, 'sendSignal', (...args: Parameters<typeof nativeSignal>) => { steeringSignals++; return nativeSignal(...args); });
  // The parent's turn may finish while the held target producer remains live.
  const parentEnded = gate();
  const offParent = (await env.session(parent.id)).subscribe(event => { if (event.type === 'agent_end') parentEnded.release(); });
  t.after(offParent);
  await first.send({ chatId: parent.id, text: 'CONTROL_QUEUE_COMMAND' }); await parentEnded.promise;
  const queued = await second.openChat({ chatId: target.id });
  assert.equal(queued.display.isRunning, true);
  assert.equal(queued.queue.rows.length, 1);
  assert.equal(queued.queue.rows[0]?.input.text, 'CONTROL_FOLLOW_UP');
  assert.equal(steeringSignals, 0, 'Control admission must not call the target send/steer path');
  assert.equal(env.fixture.requests.some(request => lastUserText(request) === 'CONTROL_FOLLOW_UP'), false);
  const complete = gate();
  const off = targetSession.subscribe(event => {
    if (event.type === 'agent_end' && event.reason === 'complete'
      && env.fixture.requests.some(request => lastUserText(request) === 'CONTROL_FOLLOW_UP')) complete.release();
  });
  t.after(off); hold.release(); await complete.promise; await env.settled();
  const finished = await second.openChat({ chatId: target.id });
  assert.equal(finished.queue.rows.length, 0);
  assert.equal(env.fixture.requests.filter(request => lastUserText(request) === 'CONTROL_FOLLOW_UP').length, 1);
  assert.equal(finished.messages.filter(message => (message.role === 'signal' || message.role === 'user')
    && JSON.stringify(message.content).includes('CONTROL_FOLLOW_UP')).length, 1);
});

test('Control rejects forged, aborted, switched and child origins before host mutations', { timeout: 30_000 }, async t => {
  const env = await setup(t, () => ({ text: 'NO_UNTRUSTED_MODEL_WORK' }));
  const parent = await env.client().createChat({ projectId: env.projectId });
  const session = await env.session(parent.id);
  const context = await session.machinery.buildRequestContext();
  const origin = context.get('controller') as AgentControllerRequestContext<MastraCodeState>;
  const tool = createControlTools({ getRuntime: () => env.runtime, getService: () => env.service }).create_thread;
  assert.ok(tool.execute);
  const before = (await env.service.listChats()).chats.length;
  const variants = [
    undefined, { ...origin, controllerId: 'wrong-controller' }, { ...origin, resourceId: 'wrong-resource' },
    { ...origin, threadId: 'wrong-thread' }, { ...origin, session: { ...origin.session, id: 'wrong-session' } },
    { ...origin, scope: 'unexpected-scope' }, { ...origin, isThreadActive: () => false },
  ];
  for (const value of variants) {
    const requestContext = new RequestContext();
    if (value !== undefined) requestContext.set('controller', value);
    await assert.rejects(tool.execute({ projectId: env.projectId }, { requestContext, observe: noopObserve }), /original live ordinary chat/);
  }
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(tool.execute({ projectId: env.projectId }, { requestContext: context, abortSignal: aborted.signal, observe: noopObserve }), /original live ordinary chat/);
  const child = await env.runtime.createSession({ threadId: 'marked-child', resourceId: 'marked-child', tags: { kodexChild: 'future-invalid' } });
  await assert.rejects(tool.execute({ projectId: env.projectId }, { requestContext: await child.machinery.buildRequestContext(), observe: noopObserve }), /original live ordinary chat/);
  const fork = await env.runtime.createSession({ threadId: 'marked-fork', resourceId: 'marked-fork', tags: { fixture: 'fork' } });
  await fork.thread.setSetting({ key: 'forkedSubagent', value: true });
  await assert.rejects(tool.execute({ projectId: env.projectId }, { requestContext: await fork.machinery.buildRequestContext(), observe: noopObserve }), /original live ordinary chat/);
  const tools = createControlTools({ getRuntime: () => env.runtime, getService: () => env.service });
  const valid = { requestContext: context, observe: noopObserve };
  assert.ok(tools.get_thread.execute && tools.rename_thread.execute && tools.send_thread_input.execute && tools.pin_thread.execute);
  await assert.rejects(tools.get_thread.execute({ threadId: 'unknown-target' }, valid), { code: 'NOT_FOUND' });
  await assert.rejects(tools.get_thread.execute({ threadId: 'marked-child' }, valid), { code: 'NOT_FOUND' });
  await assert.rejects(tools.send_thread_input.execute({ threadId: 'unknown-target', text: 'MUST_NOT_DELIVER' }, valid), { code: 'NOT_FOUND' });
  await assert.rejects(tools.pin_thread.execute({ threadId: parent.id, pinned: false, beforeThreadId: null }, valid), { code: 'BAD_REQUEST' });
  const retired = await env.client().createChat({ projectId: env.projectId });
  await env.service.archiveChat({ chatId: retired.id });
  await assert.rejects(tools.get_thread.execute({ threadId: retired.id }, valid), { code: 'CONFLICT' });
  await assert.rejects(tools.rename_thread.execute({ threadId: retired.id, name: 'MUST_NOT_RENAME' }, valid), { code: 'CONFLICT' });
  await assert.rejects(tools.send_thread_input.execute({ threadId: retired.id, text: 'MUST_NOT_DELIVER' }, valid), { code: 'CONFLICT' });
  await env.runtime.releaseSession({ resourceId: session.identity.getResourceId() });
  await assert.rejects(tool.execute({ projectId: env.projectId }, { requestContext: context, observe: noopObserve }), /original live ordinary chat/);
  assert.equal((await env.service.listChats()).chats.length, before);
  assert.equal(env.fixture.requests.length, 0);
});

test('a real fresh child cannot invoke native Control creation or escape through its context', { timeout: 40_000 }, async t => {
  const reached = gate(), release = gate(), parentFinal = gate();
  const env = await setup(t, async request => {
    const serialized = JSON.stringify(request.messages);
    if (lastUserText(request).includes('CHILD_CONTROL_ESCAPE')) {
      assert.equal(request.tools?.some(tool => tool.function.name === 'create_thread'), false, 'native permissions hide Control creation from the child');
      if (!request.messages.some(message => message.role === 'tool')) {
        reached.release(); await release.promise;
        return { toolCalls: [{ name: 'create_thread', arguments: { projectId: null }, id: 'child-control-escape' }] };
      }
      assert.match(serialized, /not found|denied/i);
      return { text: 'CHILD_CONTROL_ESCAPE_REJECTED' };
    }
    if (serialized.includes('CHILD_CONTROL_ESCAPE_REJECTED')) { parentFinal.release(); return { text: 'CONTROL_PARENT_FINAL' }; }
    return request.messages.some(message => message.role === 'tool') ? { text: 'CONTROL_PARENT_WAITING' }
      : { toolCalls: [{ name: 'delegate_child', arguments: { task: 'CHILD_CONTROL_ESCAPE: attempt creation once.' }, id: 'control-delegate' }] };
  });
  env.cleanup.push(release.release);
  const parent = await env.client().createChat({ projectId: env.projectId });
  const before = (await env.service.listChats()).chats.length;
  const ended = gate(); let continuation = false;
  const off = (await env.session(parent.id)).subscribe(event => {
    if (event.type === 'agent_end' && event.reason === 'complete' && continuation) ended.release();
  }); t.after(off);
  await env.client().send({ chatId: parent.id, text: 'CONTROL_PARENT_DELEGATE' });
  await reached.promise;
  const child = [...env.sessions].find(session => session.getTags().kodexChild === '1'); assert.ok(child);
  const status = createControlTools({ getRuntime: () => env.runtime, getService: () => env.service }).get_status;
  assert.ok(status.execute);
  await assert.rejects(status.execute({}, { requestContext: await child.machinery.buildRequestContext(), observe: noopObserve }), /original live ordinary chat/);
  continuation = true; release.release(); await parentFinal.promise; await ended.promise; await env.settled();
  assert.equal((await env.service.listChats()).chats.length, before);
  const snapshot = await env.client().openChat({ chatId: parent.id });
  assert.match(JSON.stringify(snapshot.messages), /CHILD_CONTROL_ESCAPE_REJECTED/);
});

test('native Control can archive its own invoking chat without waiting for its tool to finish', { timeout: 10_000 }, async t => {
  let parentId = '';
  const env = await setup(t, () => ({ toolCalls: [{ name: 'archive_thread', arguments: { threadId: parentId }, id: 'self-archive' }] }));
  const first = env.client(), second = env.client();
  const parent = await first.createChat({ projectId: env.projectId }); parentId = parent.id;
  const thread = await env.runtime.controller.queryThreadById({ threadId: parent.id }); assert.ok(thread);
  const watching = new AbortController(); env.cleanup.push(() => watching.abort());
  const peer = await second.watchCatalog(undefined, { signal: watching.signal }); await peer.next();
  const archived = until(peer, catalog => catalog.archivedChatIds.includes(parent.id));
  await first.send({ chatId: parent.id, text: 'CONTROL_SELF_ARCHIVE' });
  const canonical = await archived; watching.abort();
  assert.equal(canonical.chats.some(chat => chat.id === parent.id), false);
  assert.equal(await env.runtime.controller.getSessionByResource(thread.resourceId), undefined);
  assert.ok(await env.runtime.controller.queryThreadById({ threadId: parent.id }), 'archive retains the native history row');
  await assert.rejects(second.openChat({ chatId: parent.id }), { code: 'CONFLICT' });
  await env.settled();
});
