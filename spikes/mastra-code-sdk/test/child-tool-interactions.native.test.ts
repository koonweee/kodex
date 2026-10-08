import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { createChildTools } from '../src/child-tools.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}
let profile: SpikeProfile, profileRoot: string;
before(async () => {
  profileRoot = await mkdtemp(join(tmpdir(), 'kodex-production-child-interaction-profile-'));
  profile = activateProfile(resolveProfile(profileRoot));
});
after(async () => { await rm(profileRoot, { recursive: true, force: true }); });

async function settled(session: NativeSession) {
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function');
  await memory.settled();
}

async function setup(t: TestContext, kind: 'reply' | 'cancel' | 'timeout') {
  const root = await mkdtemp(join(tmpdir(), `kodex-production-child-interaction-${kind}-`));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const trace: unknown[] = [];
  const parked = deferred(), firstTurn = deferred(), parentContinued = deferred(), finalParent = deferred();
  const sessions: NativeSession[] = [];
  const retainedSuspendedRuns = new Set<string>();
  const producers = new Map<string, ReturnType<typeof deferred>>();
  let runtime!: ProjectRuntime, parent!: NativeSession, child: NativeSession | undefined;
  let taskId = '', finalParentRequested = false;
  let childModelRequests = 0;
  let parkedGuidanceResult = '';
  let resumeHold: { reached: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;
  const fixture = await startModelFixture(async request => {
    const last = lastUserText(request), serialized = JSON.stringify(request.messages);
    if (last === 'RETAINED_CHILD_AFTER_CANCEL') {
      assert.ok(!serialized.includes('LOSING_NATIVE_ANSWER'));
      return { text: 'RETAINED_CHILD_FRESH_RESULT' };
    }
    if (last.includes('INTERACTIVE_CHILD')) {
      childModelRequests++;
      assert.ok(!serialized.includes('PARENT_PRIVATE_CONTEXT'), 'interactive child starts fresh');
      assert.ok(!request.tools?.some(tool => ['delegate_child', 'message_child', 'subagent', 'create-workflow', 'run-workflow'].includes(tool.function.name)), 'child cannot delegate nested model work');
      assert.ok(!JSON.stringify(request.tools?.find(tool => tool.function.name === 'view')?.function.parameters).includes('_background'), 'initial and resumed child model tools have native background dispatch disabled');
      if (!serialized.includes('User answered: VERIFIED_NATIVE_ANSWER')) {
        assert.ok(request.tools?.some(tool => tool.function.name === 'ask_user'));
        return { toolCalls: [{ name: 'ask_user', arguments: { question: 'Which evidence should I use?' }, id: 'proof-child-question' }] };
      }
      assert.equal(kind, 'reply', 'cancelled or expired children never reach a resumed model request');
      assert.ok(!serialized.includes('LOSING_NATIVE_ANSWER'));
      assert.ok(!serialized.includes('PARKED_GUIDANCE_NOT_AN_ANSWER'), 'parked guidance does not resume or answer the question');
      if (resumeHold) { resumeHold.reached.resolve(); await resumeHold.release.promise; }
      return { text: 'INTERACTIVE_CHILD_CANONICAL_RESULT: VERIFIED_NATIVE_ANSWER' };
    }
    if (serialized.includes('INTERACTIVE_CHILD_CANONICAL_RESULT') || serialized.includes('Child task ended without completion: suspended')) {
      finalParentRequested = true;
      return { text: 'PARENT_NATIVE_INTERACTION_RESULT_ACK' };
    }
    const parkedReply = request.messages.find(message => message.role === 'tool' && JSON.stringify(message).includes('parent-parked-guidance'));
    if (parkedReply) { parkedGuidanceResult = JSON.stringify(parkedReply.content); parentContinued.resolve(); return { text: 'PARENT_CONTINUED_WHILE_CHILD_ASKS' }; }
    if (request.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('Task ID:'))) {
      const ack = request.messages.find(message => message.role === 'tool' && JSON.stringify(message.content).includes('Task ID:'));
      const match = JSON.stringify(ack!.content).match(/Task ID: ([^.\s]+)\./); assert.ok(match); taskId = match[1]!;
      if (kind === 'reply') {
        await parked.promise; await firstTurn.promise;
        return { toolCalls: [{ name: 'message_child', arguments: { taskId, message: 'PARKED_GUIDANCE_NOT_AN_ANSWER' }, id: 'parent-parked-guidance' }] };
      }
      parentContinued.resolve();
      return { text: 'PARENT_CONTINUED_WHILE_CHILD_ASKS' };
    }
    assert.ok(last.includes('PARENT_PRIVATE_CONTEXT'));
    return { toolCalls: [{ name: 'delegate_child', arguments: { task: 'INTERACTIVE_CHILD: ask which evidence to use.', _background: { timeoutMs: kind === 'timeout' ? 5_000 : 20_000 } }, id: 'proof-parent-delegate' }] };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    backgroundTools: { enabled: true }, lsp: false, observability: { enabled: false },
  }));
  runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'),
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], extraTools: createChildTools({ getRuntime: () => runtime }) });
  runtime.controller.onSessionCreated(session => {
    sessions.push(session);
    if (session.getTags().kodexChild !== '1') return;
    child = session;
    session.subscribe(event => {
      trace.push({ child: event });
      const runId = session.getCurrentRunId();
      // A retained subscription can replay agent_start for an aborted parked
      // run without an active producer. Only the reply fixture actually resumes.
      if (kind === 'reply' && event.type === 'agent_start' && runId) retainedSuspendedRuns.delete(runId);
      if (event.type === 'tool_suspended') {
        if (runId) retainedSuspendedRuns.add(runId);
        parked.resolve();
      }
      if (event.type === 'agent_end' && event.reason === 'suspended') {
        // Public suspension identity names the originating durable workflow.
        const suspension = session.suspensions.get({ toolCallId: 'proof-child-question' });
        if (suspension) retainedSuspendedRuns.add(suspension.runId);
        firstTurn.resolve();
      }
    });
  });
  // Established fixture-only producer join, never used by product composition.
  const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
  t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
    const result = register(...args);
    if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], deferred());
    return result;
  });
  const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
  t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
    unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.resolve(undefined);
  });
  async function joinProducers() {
    let joined = -1;
    while (joined !== producers.size) {
      joined = producers.size;
      await Promise.all([...producers].map(([runId, done]) => retainedSuspendedRuns.has(runId) ? undefined : done.promise));
    }
  }
  t.diagnostic(`Production child interaction: ${join(root, 'trace.json')}`);
  let releaseHeldResume: (() => void) | undefined;
  t.after(async () => {
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    releaseHeldResume?.();
    if (taskId) await runtime.mastra.backgroundTaskManager?.cancel(taskId);
    // Native cancelled workflow registrations can remain parked after abort.
    // Retire bindings after assertions; parked registrations are not live drains.
    for (const session of sessions) {
      if (session.thread.getId()) await runtime.releaseSession({ resourceId: session.identity.getResourceId() });
    }
    await joinProducers(); await runtime.dispose(); await fixture.close();
    await writeFile(join(root, 'trace.json'), JSON.stringify({ taskId, trace, requests: fixture.requests }, null, 2));
    for (const directory of ['project', 'runtime']) await rm(join(root, directory), { recursive: true, force: true });
  });
  parent = await runtime.createSession({ threadId: `interactive-parent-${kind}`, resourceId: `interactive-parent-${kind}` });
  await parent.thread.rename({ title: 'Native interaction parent', pin: true });
  parent.subscribe(event => {
    trace.push({ parent: event });
    if (finalParentRequested && event.type === 'agent_end' && event.reason === 'complete') finalParent.resolve();
  });
  const parentRun = parent.sendMessage({ content: 'PARENT_PRIVATE_CONTEXT: delegate and continue while the child asks.', untilIdle: true });
  void parentRun.catch(() => {});
  await parked.promise; await firstTurn.promise; await parentContinued.promise; await parentRun;
  assert.ok(child);
  if (kind === 'reply') assert.ok(parkedGuidanceResult.includes('waiting_for_response'), 'parent guidance reports the real parked question without waking it');
  const manager = runtime.mastra.backgroundTaskManager; assert.ok(manager);
  assert.equal((await manager.getTask(taskId))?.status, 'running', 'native adopted task remains running across child suspension');
  assert.equal((await manager.getTask(taskId))?.result, undefined);
  assert.equal(child.suspensions.hasPending(), true);
  assert.equal(child.displayState.get().pendingSuspensions.size, 1);
  assert.ok(JSON.stringify(child.displayState.get().pendingSuspensions.get('proof-child-question')).includes('Which evidence should I use?'));
  return { runtime, parent, child, manager, taskId, fixture, parked, finalParent, joinProducers,
    get childModelRequests() { return childModelRequests; },
    holdResume() {
      resumeHold = { reached: deferred(), release: deferred() };
      const held = { reached: resumeHold.reached.promise, release: () => resumeHold!.release.resolve() };
      releaseHeldResume = held.release; return held;
    } };
}

test('production delegate_child remains pending across native suspension and public claims resume once and return canonical native output to the continuing parent', { timeout: 35_000 }, async t => {
  const env = await setup(t, 'reply');
  const held = env.holdResume();
  const relinquished = env.child.claimToolSuspension('proof-child-question'); assert.equal(relinquished.accepted, true);
  if (relinquished.accepted) env.child.releaseToolResponse(relinquished.toolCallId);
  const winner = env.child.claimToolSuspension('proof-child-question'); assert.equal(winner.accepted, true);
  const concurrent = env.child.claimToolSuspension('proof-child-question');
  assert.deepEqual(concurrent, { accepted: false, reason: 'not_pending' }, 'only one same-session caller can claim the pending answer');
  assert.ok(winner.accepted);
  const reply = env.child.respondToToolSuspension({ toolCallId: winner.toolCallId, resumeData: 'VERIFIED_NATIVE_ANSWER' })
    .finally(() => env.child.releaseToolResponse(winner.toolCallId));
  await held.reached;
  assert.equal(env.childModelRequests, 2, 'native resumed model receives the winning answer exactly once');
  assert.equal((await env.manager.getTask(env.taskId))?.status, 'running', 'native task remains pending while resumed child model is held');
  assert.equal(env.child.suspensions.hasPending(), false);
  const stale = env.child.claimToolSuspension('proof-child-question');
  assert.deepEqual(stale, { accepted: false, reason: 'no_pending_suspension' });
  held.release(); await reply; await env.finalParent.promise; await env.joinProducers(); await settled(env.parent);
  const task = await env.manager.getTask(env.taskId); assert.equal(task?.status, 'completed');
  assert.ok(JSON.stringify(task.result).includes('INTERACTIVE_CHILD_CANONICAL_RESULT: VERIFIED_NATIVE_ANSWER'));
  assert.ok(JSON.stringify(await env.parent.thread.listActiveMessages()).includes('PARENT_NATIVE_INTERACTION_RESULT_ACK'));
  assert.equal(await env.runtime.controller.getSessionByResource(`kodex-child:${env.taskId}`), env.child);
  const history = await env.runtime.controller.queryThreadMessages({ threadId: `kodex-child:${env.taskId}`, resourceId: `kodex-child:${env.taskId}` });
  assert.ok(JSON.stringify(history.messages).includes('User answered: VERIFIED_NATIVE_ANSWER'));
  assert.ok(JSON.stringify(history.messages).includes('INTERACTIVE_CHILD_CANONICAL_RESULT'));
  assert.equal((await env.manager.listTasks({})).tasks.length, 1, 'resumed child dispatch creates no nested native background tasks');
});

test('parked cancellation rejects stale answers and retains its child binding for fresh native input', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'cancel');
  const parentThread = env.parent.thread.requireId(), parentResource = env.parent.identity.getResourceId();
  env.parent.machinery.getAgent().abortThreadStream({ threadId: parentThread, resourceId: parentResource, clearPendingSignals: true });
  env.parent.abort(); await env.runtime.releaseSession({ resourceId: parentResource });
  const requestsBeforeCancel = env.fixture.requests.length;
  await env.manager.cancel(env.taskId);
  const task = await env.manager.getTask(env.taskId); assert.equal(task?.status, 'cancelled');
  assert.equal(task.result, undefined);
  assert.equal(env.child.suspensions.hasPending(), false);
  assert.equal(env.child.displayState.get().pendingSuspensions.size, 0);
  assert.deepEqual(env.child.claimToolSuspension('proof-child-question'), { accepted: false, reason: 'no_pending_suspension' });
  await env.child.respondToToolSuspension({ toolCallId: 'proof-child-question', resumeData: 'LOSING_NATIVE_ANSWER' });
  assert.equal(env.fixture.requests.length, requestsBeforeCancel, 'stale response cannot resume the cancelled child or retired parent');
  assert.equal(env.childModelRequests, 1);
  assert.equal(await env.runtime.controller.getSessionByResource(`kodex-child:${env.taskId}`), env.child);
  assert.equal(await env.runtime.controller.getSessionByResource(parentResource), undefined);
  assert.equal(env.child.machinery.getAgent().getActiveThreadRunId({ threadId: env.child.thread.requireId(), resourceId: env.child.identity.getResourceId() }), undefined);
  const freshEnded = deferred();
  const off = env.child.subscribe(event => { if (event.type === 'agent_end' && event.reason === 'complete') freshEnded.resolve(); }); t.after(off);
  const fresh = await env.child.sendSignal({ type: 'user', contents: 'RETAINED_CHILD_AFTER_CANCEL' }, { requireDelivery: true }).accepted;
  assert.equal(fresh.action, 'wake');
  await freshEnded.promise; await settled(env.child);
  const history = await env.child.thread.listActiveMessages();
  assert.ok(JSON.stringify(history).includes('RETAINED_CHILD_FRESH_RESULT'));
  assert.ok(!JSON.stringify(history).includes('LOSING_NATIVE_ANSWER'));
  assert.equal(env.fixture.requests.filter(request => request.stream && lastUserText(request) === 'RETAINED_CHILD_AFTER_CANCEL').length, 1);
  assert.equal((await env.manager.getTask(env.taskId))?.status, 'cancelled', 'independent input cannot revive the original task');
  assert.equal(await env.runtime.controller.getSessionByResource(env.child.identity.getResourceId()), env.child);
  await env.runtime.releaseSession({ resourceId: env.child.identity.getResourceId() });
  await env.joinProducers();
});

test('native background timeout bounds an adopted operation parked on a child question', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'timeout');
  // Retirement-style stop before timeout notification; the SDK remains the
  // timeout owner. No sleep, host timeout loop, or fabricated completion event.
  env.parent.machinery.getAgent().abortThreadStream({ threadId: env.parent.thread.requireId(), resourceId: env.parent.identity.getResourceId(), clearPendingSignals: true });
  env.parent.abort();
  const task = await env.manager.waitForNextTask([env.taskId], { timeoutMs: 10_000 });
  assert.equal(task.status, 'timed_out'); assert.equal(task.result, undefined);
  assert.ok(task.error?.message.includes('Task timed out after 5000ms'));
  assert.equal(await env.runtime.controller.getSessionByResource(`kodex-child:${env.taskId}`), env.child, 'native timeout leaves the retained child quiescent');
  assert.equal(env.child.suspensions.hasPending(), false);
  assert.equal(env.child.displayState.get().pendingSuspensions.size, 0);
  assert.equal(env.childModelRequests, 1);
  assert.equal(env.child.machinery.getAgent().getActiveThreadRunId({ threadId: env.child.thread.requireId(), resourceId: env.child.identity.getResourceId() }), undefined);
  assert.deepEqual(env.child.claimToolSuspension('proof-child-question'), { accepted: false, reason: 'no_pending_suspension' });
  await env.child.respondToToolSuspension({ toolCallId: 'proof-child-question', resumeData: 'LOSING_TIMEOUT_ANSWER' });
  assert.equal(env.childModelRequests, 1);
  await env.runtime.releaseSession({ resourceId: env.child.identity.getResourceId() });
  await env.joinProducers();
});
