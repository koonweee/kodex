import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { createChatService } from '../src/chat-service.js';
import { serveRouter } from '../src/server.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let root: string;
let profile: SpikeProfile;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
let childGate: { reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-chat-subagents-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(async request => {
    const task = lastUserText(request);
    const serialized = JSON.stringify(request.messages);
    const mode = task.includes('FORKED') ? 'FORKED' : 'DEFAULT';
    if (task.includes('CHILD_TASK_')) {
      if (serialized.includes('CHILD_FILE_EVIDENCE')) {
        const gate = childGate;
        if (gate) { gate.reached.resolve(); await gate.release.promise; }
        return { text: `CHILD_RESULT_${mode}` };
      }
      assert.ok(request.tools?.some(tool => tool.function.name === 'view'));
      return { toolCalls: [{ name: 'view', arguments: { path: 'evidence.txt' }, id: `child-view-${mode}` }] };
    }
    if (serialized.includes(`CHILD_RESULT_${mode}`)) return { text: `PARENT_RESULT_${mode}` };
    assert.ok(request.tools?.some(tool => tool.function.name === 'subagent'));
    return { toolCalls: [{ name: 'subagent', arguments: { agentType: 'explore', task: `CHILD_TASK_${mode}: inspect evidence.txt`,
      ...(mode === 'FORKED' && { forked: true }) }, id: `parent-subagent-${mode}` }] };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, subagentModels: { default: 'fixture/chat' },
      observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat' },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    lsp: false, observability: { enabled: false },
  }));
});
after(async () => { childGate?.release.resolve(); await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });

async function setup(t: TestContext, name: string) {
  const projectPath = join(root, name); await mkdir(projectPath);
  await writeFile(join(projectPath, 'evidence.txt'), 'CHILD_FILE_EVIDENCE: actual workspace tool output');
  let runtime!: ProjectRuntime;
  const producers = new Map<string, ReturnType<typeof deferred>>();
  const sessions = new Set<NativeSession>();
  const make = () => createChatService({ profile, instanceId: name,
    projects: [{ id: name, name, path: projectPath, runtimeRoot: join(root, `${name}-runtime`) }],
    runtimeFactory: async options => {
      const mounted = await createProjectRuntime({ ...options,
        modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
      if (options.projectPath === projectPath) runtime = mounted;
      mounted.controller.onSessionCreated(session => { sessions.add(session); });
      const register = mounted.mastra.__registerInternalWorkflow.bind(mounted.mastra);
      const unregister = mounted.mastra.__unregisterInternalWorkflow.bind(mounted.mastra);
      // Test-only native completion observation, never a production dependency.
      t.mock.method(mounted.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
        const result = register(...args);
        if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], deferred());
        return result;
      });
      t.mock.method(mounted.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
        unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.resolve();
      });
      return mounted;
    } });
  async function drain() {
    childGate?.release.resolve();
    for (const session of sessions) if (session.displayState.get().isRunning) session.abort();
    let joined = -1;
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(done => done.promise)); }
  }
  let service = make();
  let server = await serveRouter(createChatRouter(service), 0);
  const client = (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  const abort = new AbortController();
  t.after(async () => {
    abort.abort(); childGate?.release.resolve();
    await server.close(); await drain(); await service.dispose(); childGate = undefined;
  });
  return { client, abort, get runtime() { return runtime; }, get service() { return service; }, async reopen() {
    await server.close(); await drain(); await service.dispose(); service = make(); server = await serveRouter(createChatRouter(service), 0);
  } };
}
async function until<T>(iterator: AsyncIterator<T>, predicate: (value: T) => boolean) {
  for (;;) { const next = await iterator.next(); assert.equal(next.done, false); if (predicate(next.value)) return next.value; }
}

for (const forked of [false, true]) {
  const mode = forked ? 'FORKED' : 'DEFAULT';
  test(`two clients inspect native ${mode.toLowerCase()} activity/result and restart without child activation`, { timeout: 40_000 }, async t => {
    const env = await setup(t, `inspect-${mode}`);
    let first = env.client(), second = env.client();
    const parent = await first.createChat({ projectId: `inspect-${mode}` });
    const other = await first.createChat({ projectId: `inspect-${mode}` });
    const parentThread = await env.runtime.controller.queryThreadById({ threadId: parent.id }); assert.ok(parentThread);
    const session = await env.runtime.controller.getSessionByResource(parentThread.resourceId); assert.ok(session);
    const completed = deferred();
    const off = session.subscribe(event => { if (event.type === 'agent_end') completed.resolve(); }); t.after(off);
    let activations = 0;
    const uncreated = env.runtime.controller.onSessionCreated(() => { activations++; }); t.after(uncreated);
    const observer = await first.watchSubagents({ chatId: parent.id }, { signal: env.abort.signal });
    const initial = await observer.next(); assert.equal(initial.done, false); assert.equal(initial.value!.invocations.length, 0);
    const gate = { reached: deferred(), release: deferred() }; childGate = gate;
    await second.send({ chatId: parent.id, text: `PARENT_TASK_${mode}: delegate file inspection.` });
    await gate.reached.promise;
    const active = await until(observer, value => value.invocations.some(item => item.status === 'running' && item.activity?.toolCalls.some(tool => tool.name === 'view')));
    const invocation = active.invocations.find(item => item.id === `parent-subagent-${mode}`); assert.ok(invocation);
    assert.equal(invocation.forked, forked);
    assert.equal(invocation.agentType, 'explore');
    const invocationObserver = await first.watchSubagent({ chatId: parent.id, kind: 'invocation', id: invocation.id }, { signal: env.abort.signal });
    const observed = await invocationObserver.next(); assert.equal(observed.done, false); assert.equal(observed.value!.invocation?.status, 'running');
    assert.equal(observed.value!.messages.length, 0, 'ordinary inspection never invents a child transcript');
    assert.equal(active.forks.length, forked ? 1 : 0);
    let forkObserver: Awaited<ReturnType<typeof first.watchSubagent>> | undefined;
    const child = active.forks[0];
    if (child) {
      forkObserver = await first.watchSubagent({ chatId: parent.id, kind: 'fork', id: child.id }, { signal: env.abort.signal });
      const history = await forkObserver.next(); assert.equal(history.done, false);
      assert.ok(JSON.stringify(history.value!.messages).includes('CHILD_FILE_EVIDENCE'));
      await assert.rejects(second.openSubagent({ chatId: other.id, kind: 'fork', id: child.id }), { code: 'NOT_FOUND' });
    }
    await assert.rejects(second.openSubagent({ chatId: other.id, kind: 'invocation', id: invocation.id }), { code: 'NOT_FOUND' });
    await assert.rejects(second.openSubagent({ chatId: parent.id, kind: 'fork', id: other.id }), { code: 'NOT_FOUND' });
    await assert.rejects(second.openSubagent({ chatId: parent.id, kind: 'fork', id: 'missing-child' }), { code: 'NOT_FOUND' });
    await assert.rejects(second.openSubagent({ chatId: parent.id, kind: 'fork', id: parent.id }), { code: 'NOT_FOUND' });
    gate.release.resolve(); await completed.promise;
    const final = await until(invocationObserver, value => value.invocation?.result === `CHILD_RESULT_${mode}`);
    assert.equal(final.invocation?.status, 'completed');
    if (forkObserver) {
      const finalChild = await until(forkObserver, value => JSON.stringify(value.messages).includes(`CHILD_RESULT_${mode}`));
      assert.ok(JSON.stringify(finalChild.messages).includes(`PARENT_TASK_${mode}`));
      assert.ok(JSON.stringify(finalChild.messages).includes('CHILD_FILE_EVIDENCE'));
      await forkObserver.return();
    }
    const canonical = await second.openSubagent({ chatId: parent.id, kind: 'invocation', id: invocation.id });
    assert.equal(canonical.invocation?.result, final.invocation?.result);
    assert.equal(activations, 0, 'inspection never provisions a child Session');
    await observer.return(); await invocationObserver.return();
    await env.reopen(); first = env.client(); second = env.client();
    const requestCount = fixture.requests.length;
    const saved = await first.listSubagents({ chatId: parent.id });
    const restartedRuntime = env.runtime;
    let restartedActivations = 0;
    const unrestarted = restartedRuntime.controller.onSessionCreated(() => { restartedActivations++; }); t.after(unrestarted);
    const savedInvocation = await second.openSubagent({ chatId: parent.id, kind: 'invocation', id: invocation.id });
    assert.equal(savedInvocation.invocation?.result, `CHILD_RESULT_${mode}`);
    assert.equal(savedInvocation.invocation?.activity, null);
    assert.equal(savedInvocation.messages.length, 0);
    assert.equal(saved.forks.length, forked ? 1 : 0);
    if (child) {
      const savedChild = await first.openSubagent({ chatId: parent.id, kind: 'fork', id: child.id });
      assert.ok(JSON.stringify(savedChild.messages).includes('CHILD_FILE_EVIDENCE'));
      assert.ok(JSON.stringify(savedChild.messages).includes(`CHILD_RESULT_${mode}`));
    }
    assert.equal(restartedActivations, 0, 'dormant parent and child reads do not activate a Session');
    assert.equal(fixture.requests.length, requestCount);
    assert.equal(await restartedRuntime.controller.getSessionByResource(parentThread.resourceId), undefined);
    const dormant = await first.watchSubagents({ chatId: other.id }, { signal: env.abort.signal });
    await dormant.next();
    const nextGate = { reached: deferred(), release: deferred() }; childGate = nextGate;
    await second.openChat({ chatId: other.id });
    const otherThread = await restartedRuntime.controller.queryThreadById({ threadId: other.id }); assert.ok(otherThread);
    const otherSession = await restartedRuntime.controller.getSessionByResource(otherThread.resourceId); assert.ok(otherSession);
    const otherCompleted = deferred();
    const offOther = otherSession.subscribe(event => { if (event.type === 'agent_end') otherCompleted.resolve(); }); t.after(offOther);
    await second.send({ chatId: other.id, text: 'PARENT_TASK_DEFAULT: delegate while a dormant peer observes.' });
    await nextGate.reached.promise;
    const newlyActive = await until(dormant, value => value.invocations.some(item => item.status === 'running'));
    assert.ok(newlyActive.invocations[0].activity, 'a dormant observer refills when another tab mounts and runs its parent');
    nextGate.release.resolve();
    await until(dormant, value => value.invocations.some(item => item.result === 'CHILD_RESULT_DEFAULT'));
    await otherCompleted.promise; await dormant.return();
  });
}

test('read-only fork pages retain loaded history and reject invalid native relationships and aborted reads', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'boundaries');
  const first = env.client(), second = env.client();
  const parent = await first.createChat({ projectId: 'boundaries' });
  const thread = await env.runtime.controller.queryThreadById({ threadId: parent.id }); assert.ok(thread);
  const store = await env.runtime.storage.getStore('memory'); assert.ok(store);
  const now = new Date();
  const childId = 'bounded-native-child';
  const metadata = { forkedSubagent: true, parentThreadId: parent.id };
  await store.saveThread({ thread: { id: childId, resourceId: thread.resourceId, title: 'Native stored fork', createdAt: now, updatedAt: now, metadata } });
  for (const [id, resourceId, extra] of [
    ['wrong-resource', 'foreign-resource', {}],
    ['wrong-path', thread.resourceId, { projectPath: '/unowned/project' }],
    ['not-forked', thread.resourceId, { forkedSubagent: false }],
    ['other-parent', thread.resourceId, { parentThreadId: 'unrelated-parent' }],
  ] as const) {
    await store.saveThread({ thread: { id, resourceId, title: id, createdAt: now, updatedAt: now, metadata: { ...metadata, ...extra } } });
    await assert.rejects(first.openSubagent({ chatId: parent.id, kind: 'fork', id }), { code: 'NOT_FOUND' });
  }
  const message = (i: number) => ({ id: `child-message-${i}`, threadId: childId, resourceId: thread.resourceId, role: 'user' as const,
    createdAt: new Date(1_700_000_000_000 + i * 1000), content: { format: 2 as const, parts: [{ type: 'text' as const, text: `Child message ${i}` }] } });
  await store.saveMessages({ messages: Array.from({ length: 100 }, (_, i) => message(i)) });
  let activations = 0;
  const offCreated = env.runtime.controller.onSessionCreated(() => { activations++; }); t.after(offCreated);
  const inventory = await first.listSubagents({ chatId: parent.id });
  assert.deepEqual(inventory.forks.map(child => child.id), [childId]);
  const recent = await first.openSubagent({ chatId: parent.id, kind: 'fork', id: childId });
  assert.equal(recent.messages.length, 40);
  assert.equal(recent.messages[0].id, 'child-message-60');
  const observer = await first.watchSubagent({ chatId: parent.id, kind: 'fork', id: childId,
    history: { earliest: recent.history.earliest!, older: true } }, { signal: env.abort.signal });
  const older = await observer.next(); assert.equal(older.done, false);
  assert.equal(older.value!.messages.length, 80);
  const session = await env.runtime.controller.getSessionByResource(thread.resourceId); assert.ok(session);
  await store.saveMessages({ messages: [message(100)] });
  session.emit({ type: 'display_state_changed', displayState: session.displayState.get() });
  const next = await observer.next(); assert.equal(next.done, false);
  assert.equal(next.value!.messages[0].id, 'child-message-20');
  assert.equal(next.value!.messages.length, 81, 'refills do not evict loaded child history');
  const peer = await second.openSubagent({ chatId: parent.id, kind: 'fork', id: childId });
  assert.equal(peer.messages.length, 40, 'observer history depth stays local to its subscription');
  await observer.return();
  await assert.rejects(first.openSubagent({ chatId: parent.id, kind: 'invalid' as 'fork', id: childId }), { code: 'BAD_REQUEST' });
  await assert.rejects(first.openSubagent({ chatId: parent.id, kind: 'fork', id: childId, history: { earliest: 'invalid' } }), { code: 'BAD_REQUEST' });
  const original = env.runtime.controller.queryThreadMessages.bind(env.runtime.controller);
  const captured = deferred(), release = deferred(); t.after(() => release.resolve());
  const read = t.mock.method(env.runtime.controller, 'queryThreadMessages', async (input: Parameters<typeof original>[0]) => {
    const result = await original(input); captured.resolve(); await release.promise; return result;
  });
  const abort = new AbortController();
  const pending = env.service.openSubagent({ chatId: parent.id, kind: 'fork', id: childId }, abort.signal);
  await captured.promise; abort.abort(); release.resolve();
  await assert.rejects(pending, { name: 'AbortError' }); read.mock.restore();
  await first.archiveChat({ chatId: parent.id });
  await assert.rejects(second.openChat({ chatId: parent.id }), { code: 'CONFLICT' });
  const archived = await second.openSubagent({ chatId: parent.id, kind: 'fork', id: childId });
  assert.equal(archived.messages.length, 40, 'read-only inspection preserves dormant archived history without reactivation');
  assert.equal(activations, 0);
});

test('native persisted subagent errors remain inspectable without inferring successful completion', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'errors');
  const first = env.client();
  const parent = await first.createChat({ projectId: 'errors' });
  const thread = await env.runtime.controller.queryThreadById({ threadId: parent.id }); assert.ok(thread);
  const store = await env.runtime.storage.getStore('memory'); assert.ok(store);
  const cases = [
    { state: 'result', result: { content: 'Native nested child failure', isError: true } },
    { state: 'result', isError: true, errorText: 'Native outer tool failure' },
    { state: 'output-error', errorText: 'Native execution failure' },
    { state: 'output-denied', errorText: 'Native execution denied' },
  ] as const;
  await store.saveMessages({ messages: cases.map((failure, index) => ({ id: `native-error-${index}`, threadId: parent.id, resourceId: thread.resourceId,
    role: 'assistant' as const, createdAt: new Date(1_700_000_000_000 + index * 1000),
    content: { format: 2 as const, parts: [{ type: 'tool-invocation' as const,
      toolInvocation: { toolCallId: `subagent-error-${index}`, toolName: 'subagent', args: { agentType: 'explore', task: 'Fail natively' }, ...failure } }] },
  })) });
  const errors = await first.listSubagents({ chatId: parent.id });
  assert.equal(errors.invocations.length, cases.length);
  for (const [index, failure] of cases.entries()) {
    const inspected = await first.openSubagent({ chatId: parent.id, kind: 'invocation', id: `subagent-error-${index}` });
    assert.equal(inspected.invocation?.status, 'error');
    assert.equal(inspected.invocation?.result, 'result' in failure ? failure.result.content : failure.errorText);
    assert.equal(inspected.invocation?.activity, null);
  }
});

test('fresh delegated child history is scoped, live across peers, and read-only after restart', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'fresh-child');
  let first = env.client(), second = env.client();
  const parent = await first.createChat({ projectId: 'fresh-child' });
  const other = await first.createChat({ projectId: 'fresh-child' });
  const parentThread = await env.runtime.controller.queryThreadById({ threadId: parent.id }); assert.ok(parentThread);
  const observer = await second.watchSubagents({ chatId: parent.id }, { signal: env.abort.signal });
  await observer.next();
  const child = await env.runtime.createSession({ resourceId: 'fresh-inspected-resource', threadId: 'fresh-inspected-thread', tags: {
    kodexChild: '1', parentThreadId: parent.id, parentResourceId: parentThread.resourceId,
    parentSessionScope: '', parentTaskId: 'fresh-inspected-task',
  } });
  const childId = child.thread.requireId();
  const discovered = await until(observer, value => value.children.some(row => row.id === childId));
  assert.equal(discovered.forks.length, 0);
  // This is a separate native resource, not a context-inheriting fork.
  const initial = await first.openSubagent({ chatId: parent.id, kind: 'child', id: childId });
  assert.equal(initial.messages.length, 0);
  const store = await env.runtime.storage.getStore('memory'); assert.ok(store);
  const childRow = await env.runtime.controller.queryThreadById({ threadId: childId }); assert.ok(childRow);
  for (const [suffix, extra] of [
    ['parent-resource', { parentResourceId: 'unrelated-parent-resource' }],
    ['path', { projectPath: '/unrelated/project' }],
    ['scope', { parentSessionScope: 'other-scope' }],
    ['task', { parentTaskId: '' }],
    ['version', { kodexChild: 'future' }],
    ['fork', { forkedSubagent: true }],
  ] as const) {
    const id = `invalid-fresh-${suffix}`;
    await store.saveThread({ thread: { ...childRow, id, resourceId: id, metadata: { ...childRow.metadata, ...extra } } });
    await assert.rejects(first.openSubagent({ chatId: parent.id, kind: 'child', id }), { code: 'NOT_FOUND' });
  }
  assert.deepEqual((await first.listSubagents({ chatId: parent.id })).children.map(row => row.id), [childId]);
  await assert.rejects(first.openSubagent({ chatId: other.id, kind: 'child', id: childId }), { code: 'NOT_FOUND' });
  await assert.rejects(first.openSubagent({ chatId: parent.id, kind: 'fork', id: childId }), { code: 'NOT_FOUND' });
  const watcher = await first.watchSubagent({ chatId: parent.id, kind: 'child', id: childId }, { signal: env.abort.signal });
  await watcher.next();
  const gate = { reached: deferred(), release: deferred() }; childGate = gate;
  const operation = child.sendMessage({ content: 'CHILD_TASK_DEFAULT: inspect evidence.txt' });
  await gate.reached.promise;
  const live = await until(watcher, value => JSON.stringify(value.messages).includes('CHILD_FILE_EVIDENCE'));
  assert.ok(JSON.stringify(live.messages).includes('CHILD_TASK_DEFAULT'));
  assert.equal(live.display?.isRunning, true);
  gate.release.resolve(); await operation;
  const complete = await until(watcher, value => JSON.stringify(value.messages).includes('CHILD_RESULT_DEFAULT'));
  assert.ok(JSON.stringify(complete.messages).includes('CHILD_FILE_EVIDENCE'));
  await watcher.return(); await observer.return();
  await env.reopen(); first = env.client(); second = env.client();
  const requestCount = fixture.requests.length;
  await first.listSubagents({ chatId: parent.id });
  assert.equal(await env.runtime.controller.getSessionByResource(parentThread.resourceId), undefined);
  assert.equal(await env.runtime.controller.getSessionByResource('fresh-inspected-resource'), undefined);
  let activations = 0;
  const off = env.runtime.controller.onSessionCreated(() => { activations++; }); t.after(off);
  const saved = await second.openSubagent({ chatId: parent.id, kind: 'child', id: childId });
  assert.ok(JSON.stringify(saved.messages).includes('CHILD_RESULT_DEFAULT'));
  assert.equal(saved.display, undefined);
  assert.equal(activations, 0);
  assert.equal(fixture.requests.length, requestCount);
});


test('root observers inspect transitive native fork and fresh history without activation', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'nested-history');
  let first = env.client(), second = env.client();
  const parent = await first.createChat({ projectId: 'nested-history' });
  const other = await first.createChat({ projectId: 'nested-history' });
  const rootThread = await env.runtime.controller.queryThreadById({ threadId: parent.id }); assert.ok(rootThread);
  const store = await env.runtime.storage.getStore('memory'); assert.ok(store);
  const now = new Date();
  const freshMetadata = (parentThreadId: string, parentResourceId: string, task: string) => ({
    kodexChild: '1', parentThreadId, parentResourceId, parentSessionScope: '', parentTaskId: task, projectPath: env.runtime.projectPath,
  });
  const rows = [
    { id: 'nested-fresh', resourceId: 'nested-fresh-resource', metadata: freshMetadata(parent.id, rootThread.resourceId, 'nested-task') },
    { id: 'nested-fork', resourceId: 'nested-fresh-resource', metadata: { forkedSubagent: true, parentThreadId: 'nested-fresh' } },
    { id: 'nested-grandchild', resourceId: 'nested-grandchild-resource', metadata: freshMetadata('nested-fork', 'nested-fresh-resource', 'grandchild-task') },
    { id: 'ordinary-fork', resourceId: rootThread.resourceId, metadata: { parentThreadId: parent.id } },
    { id: 'invalid-bridge', resourceId: 'wrong-fork-resource', metadata: { forkedSubagent: true, parentThreadId: 'nested-fresh' } },
    { id: 'invalid-descendant', resourceId: 'invalid-descendant-resource', metadata: freshMetadata('invalid-bridge', 'wrong-fork-resource', 'invalid-task') },
  ];
  for (const row of rows) await store.saveThread({ thread: { ...row, title: row.id, createdAt: now, updatedAt: now } });
  await store.saveMessages({ messages: ['nested-fork', 'nested-grandchild'].map(id => ({ id: `${id}-message`, threadId: id,
    resourceId: rows.find(row => row.id === id)!.resourceId, role: 'assistant' as const, createdAt: now,
    content: { format: 2 as const, parts: [{ type: 'text' as const, text: `SAVED_${id}` }] } })) });
  const requestCount = fixture.requests.length;
  let activations = 0;
  const off = env.runtime.controller.onSessionCreated(() => { activations++; }); t.after(off);
  const inventory = await first.listSubagents({ chatId: parent.id });
  assert.deepEqual(inventory.forks.map(row => row.id), ['nested-fork']);
  assert.deepEqual(inventory.children.map(row => row.id).sort(), ['nested-fresh', 'nested-grandchild']);
  for (const [kind, id] of [['fork', 'nested-fork'], ['child', 'nested-grandchild']] as const) {
    const saved = await second.openSubagent({ chatId: parent.id, kind, id });
    assert.ok(JSON.stringify(saved.messages).includes(`SAVED_${id}`));
    await assert.rejects(first.openSubagent({ chatId: other.id, kind, id }), { code: 'NOT_FOUND' });
  }
  for (const id of ['ordinary-fork', 'invalid-bridge', 'invalid-descendant']) {
    await assert.rejects(first.openSubagent({ chatId: parent.id, kind: id === 'invalid-descendant' ? 'child' : 'fork', id }), { code: 'NOT_FOUND' });
  }
  assert.equal(activations, 0, 'transitive inspection never constructs a native Session');
  assert.equal(fixture.requests.length, requestCount);
  off();
  const observer = await second.watchSubagents({ chatId: parent.id }, { signal: env.abort.signal }); await observer.next();
  const live = await env.runtime.createSession({ threadId: 'nested-new-child', resourceId: 'nested-new-resource',
    tags: freshMetadata('nested-grandchild', 'nested-grandchild-resource', 'nested-new-task') });
  const discovered = await until(observer, value => value.children.some(row => row.id === 'nested-new-child'));
  assert.equal(discovered.children.length, 3, 'new nested child creation invalidates the observed root inventory');
  const watcher = await first.watchSubagent({ chatId: parent.id, kind: 'child', id: 'nested-new-child' }, { signal: env.abort.signal }); await watcher.next();
  await store.saveMessages({ messages: [{ id: 'nested-live-message', threadId: 'nested-new-child', resourceId: 'nested-new-resource', role: 'assistant', createdAt: now,
    content: { format: 2, parts: [{ type: 'text', text: 'NESTED_LIVE_EVIDENCE' }] } }] });
  live.emit({ type: 'display_state_changed', displayState: live.displayState.get() });
  const updated = await until(watcher, value => JSON.stringify(value.messages).includes('NESTED_LIVE_EVIDENCE'));
  assert.ok(updated.display);
  await watcher.return(); await observer.return();
  await env.reopen(); first = env.client(); second = env.client();
  const resumed = await first.listSubagents({ chatId: parent.id });
  assert.equal(resumed.children.length, 3);
  const dormant = await second.openSubagent({ chatId: parent.id, kind: 'child', id: 'nested-new-child' });
  assert.ok(JSON.stringify(dormant.messages).includes('NESTED_LIVE_EVIDENCE'));
  assert.equal(dormant.display, undefined);
  assert.equal(await env.runtime.controller.getSessionByResource('nested-new-resource'), undefined);
  assert.equal(fixture.requests.length, requestCount);
});
