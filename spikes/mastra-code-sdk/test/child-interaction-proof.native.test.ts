import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { createTool } from '@mastra/core/tools';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}
let profile: SpikeProfile, profileRoot: string;
before(async () => {
  profileRoot = await mkdtemp(join(tmpdir(), 'kodex-child-interaction-profile-'));
  profile = activateProfile(resolveProfile(profileRoot));
});
after(async () => { await rm(profileRoot, { recursive: true, force: true }); });

async function settled(session: NativeSession) {
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function');
  await memory.settled();
}
async function canonicalText(session: NativeSession) {
  await settled(session);
  const messages = await session.thread.listActiveMessages();
  return messages.findLast(message => message.role === 'assistant' && message.content.parts.some(part => part.type === 'text'))
    ?.content.parts.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
}

async function setup(t: TestContext, kind: 'reply' | 'cancel' | 'timeout') {
  const root = await mkdtemp(join(tmpdir(), `kodex-child-interaction-${kind}-`));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const trace: unknown[] = [];
  const parked = deferred(), firstTurn = deferred(), parentContinued = deferred(), finalParent = deferred(), childDeleted = deferred();
  const sessions: NativeSession[] = [];
  const retainedSuspendedRuns = new Set<string>();
  const producers = new Map<string, ReturnType<typeof deferred>>();
  let runtime!: ProjectRuntime, parent!: NativeSession, child: NativeSession | undefined;
  let taskId = '', cancelCalls = 0, finalParentRequested = false;
  let childModelRequests = 0;
  let resumeHold: { reached: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;
  const fixture = await startModelFixture(async request => {
    const last = lastUserText(request), serialized = JSON.stringify(request.messages);
    if (last.includes('INTERACTIVE_CHILD')) {
      childModelRequests++;
      assert.ok(!serialized.includes('PARENT_PRIVATE_CONTEXT'), 'interactive child starts fresh');
      assert.ok(!request.tools?.some(tool => ['proof_interactive_child', 'delegate_child', 'message_child', 'subagent', 'create-workflow', 'run-workflow'].includes(tool.function.name)), 'child cannot delegate nested model work');
      assert.ok(!JSON.stringify(request.tools?.find(tool => tool.function.name === 'view')?.function.parameters).includes('_background'), 'initial and resumed child model tools have native background dispatch disabled');
      if (!serialized.includes('User answered: VERIFIED_NATIVE_ANSWER')) {
        assert.ok(request.tools?.some(tool => tool.function.name === 'ask_user'));
        return { toolCalls: [{ name: 'ask_user', arguments: { question: 'Which evidence should I use?' }, id: 'proof-child-question' }] };
      }
      assert.equal(kind, 'reply', 'cancelled or expired children never reach a resumed model request');
      assert.ok(!serialized.includes('LOSING_NATIVE_ANSWER'));
      if (resumeHold) { resumeHold.reached.resolve(); await resumeHold.release.promise; }
      return { text: 'INTERACTIVE_CHILD_CANONICAL_RESULT: VERIFIED_NATIVE_ANSWER' };
    }
    if (serialized.includes('INTERACTIVE_CHILD_CANONICAL_RESULT')) {
      finalParentRequested = true;
      return { text: 'PARENT_NATIVE_INTERACTION_RESULT_ACK' };
    }
    if (request.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('Task ID:'))) {
      parentContinued.resolve();
      return { text: 'PARENT_CONTINUED_WHILE_CHILD_ASKS' };
    }
    assert.ok(last.includes('PARENT_PRIVATE_CONTEXT'));
    return { toolCalls: [{ name: 'proof_interactive_child', arguments: {}, id: 'proof-parent-delegate' }] };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    backgroundTools: { enabled: true }, lsp: false, observability: { enabled: false },
  }));
  const delegate = createTool({
    id: 'proof_interactive_child', description: 'Test-only fresh native child operation with public suspension lifecycle.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    background: { enabled: true, defaultDisposition: 'deferred', maxRetries: 0, timeoutMs: kind === 'timeout' ? 5_000 : 20_000 },
    execute: async (_input, context) => {
      assert.ok(context.background); taskId = context.background.taskId;
      const terminal = deferred<string>(); void terminal.promise.catch(() => {});
      let cancelled = false;
      const stop = () => {
        cancelled = true;
        if (child) {
          const threadId = child.thread.getId();
          if (threadId) child.machinery.getAgent().abortThreadStream({ threadId, resourceId: child.identity.getResourceId(), clearPendingSignals: true });
          child.abort();
        }
        // Public abort clears a parked question without promising a new
        // agent_end. The operation owner must also settle its adopted promise.
        terminal.reject(new Error('Owned interactive child cancelled'));
      };
      const completion = (async () => {
        const target = `interactive-child:${taskId}`;
        child = await runtime.createSession({ threadId: target, resourceId: target, tags: { interactionProof: kind } });
        if (cancelled) throw new Error('Interactive child cancelled during creation');
        const original = child.machinery;
        child.setMachinery({ ...original,
          buildStreamOptions: async input => ({ ...await original.buildStreamOptions(input), disableBackgroundTasks: true }),
          buildSharedRunOptions: () => ({ ...original.buildSharedRunOptions(), disableBackgroundTasks: true }),
        });
        for (const toolName of ['proof_interactive_child', 'delegate_child', 'message_child', 'subagent', 'create-workflow', 'run-workflow']) {
          await child.permissions.setForTool({ toolName, policy: 'deny' });
        }
        await child.thread.rename({ title: 'Native interactive child proof', pin: true });
        const off = child.subscribe(event => {
          trace.push({ child: event });
          const runId = child!.getCurrentRunId();
          if (event.type === 'agent_start' && runId) retainedSuspendedRuns.delete(runId);
          if (event.type === 'tool_suspended') {
            if (runId) retainedSuspendedRuns.add(runId);
            parked.resolve();
          }
          if (event.type === 'error') terminal.reject(event.error);
          if (event.type !== 'agent_end' || event.reason === 'suspended') return;
          if (event.reason === 'complete') void canonicalText(child!).then(terminal.resolve, terminal.reject);
          else terminal.reject(new Error(`Interactive child ended: ${event.reason}`));
        });
        try {
          // This returns at the first suspended boundary. The public event
          // subscription owns the logical operation until a final native end.
          await child.sendMessage({ content: 'INTERACTIVE_CHILD: ask which evidence to use.', untilIdle: false });
          firstTurn.resolve();
          return { taskId, childThreadId: target, result: await terminal.promise };
        } finally { off(); }
      })().catch(error => { stop(); throw error; }).finally(async () => {
        if (child) await runtime.releaseSession({ resourceId: child.identity.getResourceId() });
      });
      context.background.adopt({ completion, cancel: () => { cancelCalls++; stop(); } });
      return { taskId };
    },
  });
  runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'),
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], extraTools: { proof_interactive_child: delegate } });
  runtime.controller.onSessionCreated(session => { sessions.push(session); });
  runtime.controller.onSessionDeleted(session => { if (session.getTags().interactionProof === kind) childDeleted.resolve(); });
  // Established test-only finalizer join, never used by the proof composition.
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
  t.diagnostic(`Child interaction proof: ${join(root, 'trace.json')}`);
  let releaseHeldResume: (() => void) | undefined;
  t.after(async () => {
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    releaseHeldResume?.();
    if (taskId) await runtime.mastra.backgroundTaskManager?.cancel(taskId);
    await joinProducers(); await runtime.dispose(); await fixture.close();
    await writeFile(join(root, 'trace.json'), JSON.stringify({ taskId, cancelCalls, trace, requests: fixture.requests }, null, 2));
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
  const manager = runtime.mastra.backgroundTaskManager; assert.ok(manager);
  assert.equal((await manager.getTask(taskId))?.status, 'running', 'native adopted task remains running across child suspension');
  assert.equal((await manager.getTask(taskId))?.result, undefined);
  assert.equal(child.suspensions.hasPending(), true);
  assert.equal(child.displayState.get().pendingSuspensions.size, 1);
  assert.ok(JSON.stringify(child.displayState.get().pendingSuspensions.get('proof-child-question')).includes('Which evidence should I use?'));
  return { runtime, parent, child, manager, taskId, fixture, parked, finalParent, childDeleted, joinProducers,
    get cancelCalls() { return cancelCalls; }, get childModelRequests() { return childModelRequests; },
    holdResume() {
      resumeHold = { reached: deferred(), release: deferred() };
      const held = { reached: resumeHold.reached.promise, release: () => resumeHold!.release.resolve() };
      releaseHeldResume = held.release; return held;
    } };
}

test('public child suspension claims resume one adopted operation and return canonical native output to the continuing parent', { timeout: 35_000 }, async t => {
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
  held.release(); await reply; await env.finalParent.promise; await env.childDeleted.promise; await env.joinProducers(); await settled(env.parent);
  const task = await env.manager.getTask(env.taskId); assert.equal(task?.status, 'completed');
  assert.ok(JSON.stringify(task.result).includes('INTERACTIVE_CHILD_CANONICAL_RESULT: VERIFIED_NATIVE_ANSWER'));
  assert.ok(JSON.stringify(await env.parent.thread.listActiveMessages()).includes('PARENT_NATIVE_INTERACTION_RESULT_ACK'));
  assert.equal(await env.runtime.controller.getSessionByResource(`interactive-child:${env.taskId}`), undefined);
  const history = await env.runtime.controller.queryThreadMessages({ threadId: `interactive-child:${env.taskId}`, resourceId: `interactive-child:${env.taskId}` });
  assert.ok(JSON.stringify(history.messages).includes('User answered: VERIFIED_NATIVE_ANSWER'));
  assert.ok(JSON.stringify(history.messages).includes('INTERACTIVE_CHILD_CANONICAL_RESULT'));
  assert.equal(env.cancelCalls, 0);
});

test('archive-like parent retirement then native task cancellation clears a parked child question without continuation', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'cancel');
  const parentThread = env.parent.thread.requireId(), parentResource = env.parent.identity.getResourceId();
  env.parent.machinery.getAgent().abortThreadStream({ threadId: parentThread, resourceId: parentResource, clearPendingSignals: true });
  env.parent.abort(); await env.runtime.releaseSession({ resourceId: parentResource });
  const requestsBeforeCancel = env.fixture.requests.length;
  await env.manager.cancel(env.taskId); await env.childDeleted.promise; await env.joinProducers();
  const task = await env.manager.getTask(env.taskId); assert.equal(task?.status, 'cancelled');
  assert.equal(task.result, undefined);
  assert.equal(env.cancelCalls, 1);
  assert.equal(env.child.suspensions.hasPending(), false);
  assert.equal(env.child.displayState.get().pendingSuspensions.size, 0);
  assert.deepEqual(env.child.claimToolSuspension('proof-child-question'), { accepted: false, reason: 'no_pending_suspension' });
  await env.child.respondToToolSuspension({ toolCallId: 'proof-child-question', resumeData: 'LOSING_NATIVE_ANSWER' });
  assert.equal(env.fixture.requests.length, requestsBeforeCancel, 'stale response cannot resume the cancelled child or retired parent');
  assert.equal(env.childModelRequests, 1);
  assert.equal(await env.runtime.controller.getSessionByResource(`interactive-child:${env.taskId}`), undefined);
  assert.equal(await env.runtime.controller.getSessionByResource(parentResource), undefined);
});

test('native background timeout bounds an adopted operation parked on a child question', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'timeout');
  // Retirement-style stop before timeout notification; the SDK remains the
  // timeout owner. No sleep, host timeout loop, or fabricated completion event.
  env.parent.machinery.getAgent().abortThreadStream({ threadId: env.parent.thread.requireId(), resourceId: env.parent.identity.getResourceId(), clearPendingSignals: true });
  env.parent.abort();
  const task = await env.manager.waitForNextTask([env.taskId], { timeoutMs: 10_000 });
  await env.childDeleted.promise; await env.joinProducers();
  assert.equal(task.status, 'timed_out'); assert.equal(task.result, undefined);
  assert.ok(task.error?.message.includes('Task timed out after 5000ms'));
  assert.equal(env.cancelCalls, 1, 'native timeout invokes adopted-operation cancellation');
  assert.equal(env.child.suspensions.hasPending(), false);
  assert.equal(env.child.displayState.get().pendingSuspensions.size, 0);
  assert.equal(env.childModelRequests, 1);
});
