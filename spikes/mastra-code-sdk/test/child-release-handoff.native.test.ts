import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { createChildTools } from '../src/child-tools.js';
import { readChildRelation } from '../src/child-relation.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release };
}
let profile: SpikeProfile, profileRoot: string;
before(async () => {
  profileRoot = await mkdtemp(join(tmpdir(), 'kodex-child-handoff-profile-'));
  profile = activateProfile(resolveProfile(profileRoot));
});
after(async () => { await rm(profileRoot, { recursive: true, force: true }); });

async function setup(t: TestContext, boundary: 'history' | 'history-error') {
  const root = await mkdtemp(join(tmpdir(), `kodex-child-handoff-${boundary}-`));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const sessions: NativeSession[] = [], producers = new Map<string, ReturnType<typeof gate>>();
  const reached = gate(), resume = gate(), childEnded = gate();
  const trace: unknown[] = [];
  let child: NativeSession | undefined, runtime!: ProjectRuntime, initialEnded = false, boundaryUsed = false;
  const fixture = await startModelFixture(request => {
    // SDK title generation uses the same local fixture, never a real provider.
    if (!request.stream) return { text: 'Handoff fixture' };
    const last = lastUserText(request), content = JSON.stringify(request.messages);
    if (last.includes('NAIVE_DIRECT') || last.includes('SAFE_DIRECT')) return { text: `DIRECT_RESULT:${last}` };
    if (last.includes('HANDOFF_CHILD')) {
      assert.ok(!content.includes('PARENT_PRIVATE_HANDOFF'));
      return { text: 'HANDOFF_CHILD_RESULT' };
    }
    if (content.includes('HANDOFF_CHILD_RESULT') || request.messages.some(message => message.role === 'tool')) return { text: 'PARENT_HANDOFF_ACK' };
    assert.equal(last, 'PARENT_PRIVATE_HANDOFF');
    return { toolCalls: [{ name: 'delegate_child', arguments: { task: 'HANDOFF_CHILD: report a verified result.' }, id: 'handoff-delegate' }] };
  });
  const initial = fixture.holdNext('HANDOFF_CHILD'), naive = fixture.holdNext('NAIVE_DIRECT');
  await writeFile(profile.settingsPath, JSON.stringify({
    lsp: false, observability: { enabled: false }, backgroundTools: { enabled: true },
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: 'fixture/chat', reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
  }));
  runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'),
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
    extraTools: createChildTools({ getRuntime: () => runtime }) });
  runtime.controller.onSessionCreated(session => {
    sessions.push(session);
    if (session.getTags().kodexChild !== '1') return;
    child = session;
    session.subscribe(event => {
      trace.push({ event });
      if (event.type === 'agent_end' && event.reason === 'complete' && !initialEnded) {
        initialEnded = true; childEnded.release();
      }
    });
    const read = session.thread.listActiveMessages.bind(session.thread);
    t.mock.method(session.thread, 'listActiveMessages', async (...args: Parameters<typeof read>) => {
      if (initialEnded && !boundaryUsed) {
        boundaryUsed = true; reached.release(); await resume.promise;
        if (boundary === 'history-error') throw new Error('HELD_NATIVE_HISTORY_FAILURE');
      }
      return read(...args);
    });
  });
  // Existing fixture-only producer join: public memory.settled is not a run drain.
  // These passthrough observers do not participate in the admission strategy.
  const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
  const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
  t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
    const result = register(...args);
    if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], gate());
    return result;
  });
  t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
    unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.release();
  });
  async function joinProducers() {
    let joined = -1;
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(done => done.promise)); }
  }
  t.diagnostic(`Child handoff trace: ${join(root, 'trace.json')}`);
  t.after(async () => {
    // Quiesce every Session before native cancellation can wake its parent.
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    resume.release(); initial.release(); naive.release();
    const tasks = await runtime.mastra.backgroundTaskManager?.listTasks({ status: ['pending', 'running', 'suspended'] });
    for (const task of tasks?.tasks ?? []) await runtime.mastra.backgroundTaskManager?.cancel(task.id);
    await joinProducers(); await runtime.dispose(); await fixture.close();
    await writeFile(join(root, 'trace.json'), JSON.stringify({ trace, requests: fixture.requests }, null, 2));
    for (const directory of ['project', 'runtime']) await rm(join(root, directory), { recursive: true, force: true });
  });
  const parent = await runtime.createSession({ resourceId: 'handoff-parent-resource', threadId: 'handoff-parent-thread' });
  const parentRun = parent.sendMessage({ content: 'PARENT_PRIVATE_HANDOFF', untilIdle: true }); void parentRun.catch(() => {});
  await initial.reached; await parentRun;
  assert.ok(child);
  const target = { resourceId: child.identity.getResourceId(), threadId: child.thread.requireId() };
  const row = await runtime.controller.queryThreadById({ threadId: target.threadId });
  const relation = readChildRelation(row?.metadata); assert.ok(relation);
  const manager = runtime.mastra.backgroundTaskManager; assert.ok(manager);
  assert.equal((await manager.getTask(relation.parentTaskId))?.status, 'running');
  return { runtime, parent, child, target, taskId: relation.parentTaskId, manager, fixture, initial, naive,
    reached, resume, childEnded, joinProducers };
}

test('retained child binding admits a later completed direct response while the adopted result selects only its original canonical message IDs', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'history');
  env.initial.release(); await env.childEnded.promise; await env.reached.promise;
  assert.equal(env.child.displayState.get().isRunning, false);
  assert.equal((await env.manager.getTask(env.taskId))?.status, 'running');
  const alias = await env.runtime.createSession(env.target); assert.equal(alias, env.child);
  const directEnded = gate();
  const off = alias.subscribe(event => { if (event.type === 'agent_end' && event.reason === 'complete') directEnded.release(); }); t.after(off);
  await alias.sendSignal({ type: 'user', contents: 'SAFE_DIRECT_BEFORE_ORIGINAL_RESULT' }, { requireDelivery: true }).accepted;
  await env.fixture.waitForRequest(request => lastUserText(request).includes('SAFE_DIRECT_BEFORE_ORIGINAL_RESULT'));
  await directEnded.promise; await env.joinProducers();
  const memory = await alias.machinery.getAgent().getMemory({ requestContext: await alias.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function'); await memory.settled();
  const saved = await env.runtime.controller.queryThreadMessages({ ...env.target, perPage: false });
  assert.ok(JSON.stringify(saved.messages).includes('DIRECT_RESULT:SAFE_DIRECT_BEFORE_ORIGINAL_RESULT'));
  env.resume.release();
  const task = await env.manager.waitForNextTask([env.taskId], { timeoutMs: 5_000 });
  assert.equal(task.status, 'completed');
  assert.ok(JSON.stringify(task.result).includes('started:HANDOFF_CHILD'));
  assert.ok(!JSON.stringify(task.result).includes('DIRECT_RESULT'), 'later canonical responses cannot replace the delegated result');
  assert.equal(await env.runtime.controller.getSessionByResource(env.target.resourceId), env.child);
  assert.equal(env.child.thread.getId(), env.target.threadId);
});

test('native queued follow-up drains after the original terminal while its held result remains scoped to original canonical messages', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'history');
  const queuedEnded = gate(); let queuedStarted = false;
  const off = env.child.subscribe(event => {
    if (event.type === 'message_start' && JSON.stringify(event.message.content).includes('SAFE_DIRECT_QUEUED_AFTER_ORIGINAL')) queuedStarted = true;
    if (queuedStarted && event.type === 'agent_end' && event.reason === 'complete') queuedEnded.release();
  }); t.after(off);
  await env.child.queueMessage({ content: 'SAFE_DIRECT_QUEUED_AFTER_ORIGINAL' });
  assert.equal(env.child.displayState.get().queuedFollowUps, 1);
  env.initial.release(); await env.childEnded.promise; await env.reached.promise;
  await env.fixture.waitForRequest(request => lastUserText(request).includes('SAFE_DIRECT_QUEUED_AFTER_ORIGINAL'));
  await queuedEnded.promise; await env.joinProducers();
  assert.equal((await env.manager.getTask(env.taskId))?.status, 'running');
  assert.equal(env.child.displayState.get().queuedFollowUps, 0);
  env.resume.release();
  const task = await env.manager.waitForNextTask([env.taskId], { timeoutMs: 5_000 });
  assert.equal(task.status, 'completed');
  assert.ok(JSON.stringify(task.result).includes('started:HANDOFF_CHILD'));
  assert.ok(!JSON.stringify(task.result).includes('DIRECT_RESULT'));
  const saved = await env.runtime.controller.queryThreadMessages({ ...env.target, perPage: false });
  assert.ok(JSON.stringify(saved.messages).includes('DIRECT_RESULT:SAFE_DIRECT_QUEUED_AFTER_ORIGINAL'));
  assert.equal(env.fixture.requests.filter(request => request.stream && lastUserText(request).includes('SAFE_DIRECT_QUEUED_AFTER_ORIGINAL')).length, 1);
  assert.equal(await env.runtime.controller.getSessionByResource(env.target.resourceId), env.child);
});

for (const lateOutcome of ['cancel', 'history-error'] as const) {
  test(`late adopted ${lateOutcome} preserves a new direct run and its retained native binding`, { timeout: 30_000 }, async t => {
    const env = await setup(t, lateOutcome === 'cancel' ? 'history' : 'history-error');
    env.initial.release(); await env.childEnded.promise; await env.reached.promise;
    const directRun = env.child.sendMessage({ content: `NAIVE_DIRECT_AFTER_TERMINAL_${lateOutcome}` });
    void directRun.catch(() => {}); await env.naive.reached;
    const directRunId = env.child.getCurrentRunId(), abortGeneration = env.child.run.getAbortGeneration();
    assert.ok(directRunId); assert.equal(env.child.displayState.get().isRunning, true);
    // Retirement-style parent stop prevents its cancellation/failure callback
    // starting unrelated preparation during fixture shutdown.
    env.parent.machinery.getAgent().abortThreadStream({ threadId: env.parent.thread.requireId(), resourceId: env.parent.identity.getResourceId(), clearPendingSignals: true });
    env.parent.abort();
    if (lateOutcome === 'cancel') await env.manager.cancel(env.taskId);
    env.resume.release();
    const task = await env.manager.waitForNextTask([env.taskId], { timeoutMs: 5_000 });
    assert.equal(task.status, lateOutcome === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(task.result, undefined);
    if (lateOutcome === 'history-error') assert.ok(task.error?.message.includes('HELD_NATIVE_HISTORY_FAILURE'));
    assert.equal(env.child.run.getAbortGeneration(), abortGeneration, 'late original-task cleanup cannot abort independent input');
    assert.equal(env.child.getCurrentRunId(), directRunId);
    assert.equal(await env.runtime.controller.getSessionByResource(env.target.resourceId), env.child);
    env.naive.release(); await directRun; await env.joinProducers();
    assert.equal(env.child.thread.getId(), env.target.threadId);
    const saved = await env.runtime.controller.queryThreadMessages({ ...env.target, perPage: false });
    assert.ok(JSON.stringify(saved.messages).includes('started:NAIVE_DIRECT'));
    assert.equal(await env.runtime.controller.getSessionByResource(env.target.resourceId), env.child);
  });
}
