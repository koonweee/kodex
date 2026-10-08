import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTool } from '@mastra/core/tools';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture, type FixtureRequest } from './fixtures/model-server.js';

function gate() {
  let release!: () => void;
  const reached = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
}
async function settle(session: NativeSession) {
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function', 'pinned memory exposes a persistence join');
  await memory.settled();
}

// Characterization only: host tools compose public sessions/background adoption/signals.
// This does not replace CodeSDK's synchronous native `subagent` implementation.
test('native background tool adopts a fresh child session, receives live parent guidance, and reports its persisted result', { timeout: 45_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-child-session-proof-'));
  const tracePath = join(root, 'trace.json');
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const childTarget = { resourceId: 'delegated-child-resource', threadId: 'delegated-child-thread' };
  const cancelChildTarget = { resourceId: 'cancel-child-resource', threadId: 'cancel-child-thread' };
  const cancelParentTarget = { resourceId: 'cancel-parent-resource', threadId: 'cancel-parent-thread' };
  const parentTarget = { resourceId: 'delegating-parent-resource', threadId: 'delegating-parent-thread' };
  const childGuided = gate();
  const finishChild = gate();
  const parentContinued = gate();
  const nativeFinalReceived = gate();
  const parentFinalEnded = gate();
  let parentFinalRequested = false;
  let liveSessions: Array<{ session: NativeSession; target: typeof childTarget }> = [];
  let nativeRuns = new Set<string>();
  let finishedProducers = new Set<string>();
  let producerWaiters = new Map<string, ReturnType<typeof gate>>();
  const joinProducers = async () => {
    let joined = -1;
    while (joined !== nativeRuns.size) {
      joined = nativeRuns.size;
      await Promise.all([...nativeRuns].map(runId => {
        if (finishedProducers.has(runId)) return;
        const waiter = producerWaiters.get(runId) ?? gate();
        producerWaiters.set(runId, waiter);
        return waiter.reached;
      }));
    }
  };
  const observeProducers = (instance: ProjectRuntime) => {
    liveSessions = []; nativeRuns = new Set(); finishedProducers = new Set(); producerWaiters = new Map();
    // Test-only observer: native sendMessage/agent_end precede detached snapshot cleanup.
    const register = instance.mastra.__registerInternalWorkflow.bind(instance.mastra);
    t.mock.method(instance.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
      const result = register(...args);
      if (args[0].id === 'agentic-loop' && args[1]) nativeRuns.add(args[1]);
      return result;
    });
    const unregister = instance.mastra.__unregisterInternalWorkflow.bind(instance.mastra);
    t.mock.method(instance.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
      unregister(id, runId);
      if (id === 'agentic-loop') { finishedProducers.add(runId); producerWaiters.get(runId)?.release(); }
    });
  };
  const events: Array<{ session: string; event: AgentControllerEvent }> = [];
  let childFinished = false;
  let child: NativeSession | undefined;
  let parent: NativeSession | undefined;
  let runtime: ProjectRuntime | undefined;
  let backgroundTaskId: string | undefined;
  let delivery: unknown;
  let parentContinuations = 0;
  let cancelChild: NativeSession | undefined;
  let cancelParent: NativeSession | undefined;
  let cancelOperation: Promise<unknown> | undefined;
  let cancelTaskId: string | undefined;
  let cancelBridgeCalls = 0;
  const cancelParentContinued = gate();
  const cancelChildEnded = gate();
  const fixture = await startModelFixture(async request => {
    const last = lastUserText(request);
    const serialized = JSON.stringify(request.messages);
    const isChild = request.messages.some(message => message.role === 'user' &&
      (JSON.stringify(message.content).includes('CHILD_ONLY_TASK') || JSON.stringify(message.content).includes('CHILD_FOLLOWUP')));
    const isCancelChild = request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('CANCEL_CHILD_TASK'));
    const isCancelParent = request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('CANCEL_PARENT_TASK'));
    const currentSession = isCancelChild ? cancelChild : isCancelParent ? cancelParent : isChild ? child : parent;
    const currentTarget = isCancelChild ? cancelChildTarget : isCancelParent ? cancelParentTarget : isChild ? childTarget : parentTarget;
    if (runtime && currentSession) {
      const runId = runtime.controller.getCurrentAgent(currentSession).getActiveThreadRunId(currentTarget);
      assert.ok(runId, 'fixture model request belongs to a real native producer');
      assert.ok(nativeRuns.has(runId), 'test-only teardown observer tracks the actual registered producer');
    }
    if (isCancelChild) return { toolCalls: [{ name: 'view', arguments: { path: 'evidence.txt' }, id: 'cancel-child-view' }] };
    if (isCancelParent) {
      if (request.messages.some(message => message.role === 'tool')) {
        cancelParentContinued.release();
        return { text: 'PARENT_CANCEL_CHILD_RUNNING' };
      }
      return { toolCalls: [{ name: 'cancel_child', arguments: {}, id: 'parent-cancel-child' }] };
    }
    if (last.includes('CHILD_FOLLOWUP')) {
      assert.ok(serialized.includes('CHILD_FILE_EVIDENCE'), 'follow-up receives persisted child tool history');
      assert.ok(serialized.includes('CHILD_FINAL_GUIDED'), 'follow-up receives prior child assistant result');
      assert.ok(serialized.includes('CHILD_GUIDANCE'), 'follow-up retains the non-transient guidance signal');
      assert.ok(!serialized.includes('PARENT_ONLY_SECRET'), 'fresh child never receives the parent conversation');
      return { text: 'CHILD_FOLLOWUP_RESULT' };
    }
    if (request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('CHILD_ONLY_TASK'))) {
      assert.ok(!serialized.includes('PARENT_ONLY_SECRET'), 'fresh child has isolated context');
      if (!serialized.includes('CHILD_FILE_EVIDENCE')) {
        assert.ok(request.tools?.some(tool => tool.function.name === 'view'), 'child has the real workspace view tool');
        return { toolCalls: [{ name: 'view', arguments: { path: 'evidence.txt' }, id: 'child-view' }] };
      }
      assert.ok(serialized.includes('CHILD_GUIDANCE: prefer the verified file evidence'), 'guidance reaches the model before child completion');
      assert.equal(childFinished, false);
      childGuided.release();
      await finishChild.reached;
      return { text: 'CHILD_FINAL_GUIDED' };
    }
    if (serialized.includes('CHILD_FINAL_GUIDED')) {
      assert.equal(childFinished, true, 'parent receives the terminal child result after the adopted operation settles');
      parentFinalRequested = true;
      nativeFinalReceived.release();
      return { text: 'PARENT_FINAL_ACK' };
    }
    if (serialized.includes('guidanceDelivered')) {
      assert.equal(childFinished, false, 'parent model continues while child is still executing');
      parentContinuations++;
      parentContinued.release();
      return { text: 'PARENT_CONTINUED_WHILE_CHILD_RUNNING' };
    }
    if (request.messages.some(message => message.role === 'tool')) {
      const calls = request.messages.flatMap(message => message.tool_calls ?? []) as Array<{ function: { name: string; arguments: string } }>;
      const launch = calls.find(call => call.function.name === 'delegate_child');
      assert.ok(launch, 'parent retains its original delegation identity');
      const identity = JSON.parse(launch.function.arguments) as { childThreadId: string };
      assert.equal(identity.childThreadId, childTarget.threadId);
      assert.ok(request.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('background')), 'parent receives a native background acknowledgement before messaging its chosen child');
      return { toolCalls: [{ name: 'message_child', arguments: {
        childThreadId: identity.childThreadId, guidance: 'CHILD_GUIDANCE: prefer the verified file evidence',
      }, id: 'parent-message-child' }] };
    }
    assert.ok(last.includes('PARENT_ONLY_SECRET'));
    return { toolCalls: [{ name: 'delegate_child', arguments: { childThreadId: childTarget.threadId }, id: 'parent-delegate-child' }] };
  });
  const heldInitialChild = fixture.holdNext('CHILD_ONLY_TASK');
  const heldCancelChild = fixture.holdNext('CANCEL_CHILD_TASK');
  t.diagnostic(`Native child-session proof trace: ${tracePath}`);
  t.after(async () => {
    heldInitialChild.release(); heldCancelChild.release(); finishChild.release();
    // Fixture retirement only: Session.abort preserves queued native signals.
    for (const { session, target } of liveSessions) {
      runtime!.controller.getCurrentAgent(session).abortThreadStream({ ...target, clearPendingSignals: true });
      session.abort();
    }
    await joinProducers();
    await runtime?.dispose();
    await fixture.close();
    await writeFile(tracePath, JSON.stringify({ versions: { core: '1.75.0', codeSdk: '1.11.0' },
      backgroundTaskId, delivery, childFinished, parentContinuations, cancelTaskId, cancelBridgeCalls, requests: fixture.requests, events }, null, 2));
    for (const directory of ['profile', 'project', 'runtime']) await rm(join(root, directory), { recursive: true, force: true });
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    backgroundTools: { enabled: true }, lsp: false, observability: { enabled: false },
  }));
  const projectPath = join(root, 'project');
  await mkdir(projectPath);
  await writeFile(join(projectPath, 'evidence.txt'), 'CHILD_FILE_EVIDENCE: actual child workspace read.');
  const delegate = createTool({
    id: 'delegate_child', description: 'Delegate file inspection to a separate child session in the background.',
    inputSchema: { type: 'object', properties: { childThreadId: { type: 'string' } }, required: ['childThreadId'], additionalProperties: false },
    background: { enabled: true, defaultDisposition: 'deferred', timeoutMs: 30_000, maxRetries: 0 },
    execute: async (input, context) => {
      const args = input as { childThreadId: string };
      assert.equal(args.childThreadId, childTarget.threadId);
      assert.ok(context.background, 'native dispatch provides the public adoption bridge');
      backgroundTaskId = context.background.taskId;
      child = await runtime!.createSession({ ...childTarget, threadId: args.childThreadId });
      liveSessions.push({ session: child, target: childTarget });
      await child.thread.rename({ title: 'Delegated child fixture', pin: true });
      child.subscribe(event => { events.push({ session: 'child', event }); });
      const operation = child.sendMessage({ content: 'CHILD_ONLY_TASK: inspect evidence.txt and report.' }).then(async () => {
        await settle(child!);
        const messages = await child!.thread.listActiveMessages();
        const result = messages.filter(message => message.role === 'assistant')
          .flatMap(message => message.content.parts).filter(part => part.type === 'text').map(part => part.text).join('\n');
        assert.ok(result.includes('CHILD_FINAL_GUIDED'), 'completion uses canonical child assistant output');
        childFinished = true;
        return { childThreadId: childTarget.threadId, result };
      });
      context.background.adopt({ completion: operation, cancel: () => child!.abort() });
      return { childThreadId: childTarget.threadId, launched: true };
    },
  });
  const messageChild = createTool({
    id: 'message_child', description: 'Send guidance to a running child identified by its native thread ID.',
    inputSchema: { type: 'object', properties: { childThreadId: { type: 'string' }, guidance: { type: 'string' } },
      required: ['childThreadId', 'guidance'], additionalProperties: false },
    execute: async input => {
      const args = input as { childThreadId: string; guidance: string };
      assert.equal(args.childThreadId, childTarget.threadId);
      await heldInitialChild.reached;
      assert.ok(child);
      assert.equal(childFinished, false);
      delivery = await child.sendSignal({ id: 'parent-guidance', type: 'reactive', contents: args.guidance },
        { ifActive: { behavior: 'deliver' }, ifIdle: { behavior: 'discard' }, requireDelivery: true }).accepted;
      assert.equal((delivery as { action?: string }).action, 'deliver', 'native runtime routes guidance into the active child');
      heldInitialChild.release();
      await childGuided.reached;
      return { childThreadId: args.childThreadId, guidanceDelivered: true };
    },
  });
  const cancelDelegate = createTool({
    id: 'cancel_child', description: 'Launch a bounded child operation for native cancellation characterization.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    background: { enabled: true, defaultDisposition: 'deferred', timeoutMs: 30_000, maxRetries: 0 },
    execute: async (_input, context) => {
      assert.ok(context.background);
      cancelTaskId = context.background.taskId;
      cancelChild = await runtime!.createSession(cancelChildTarget);
      liveSessions.push({ session: cancelChild, target: cancelChildTarget });
      await cancelChild.thread.rename({ title: 'Cancellation child fixture', pin: true });
      cancelChild.subscribe(event => {
        events.push({ session: 'cancel-child', event });
        if (event.type === 'agent_end' && event.reason === 'aborted') cancelChildEnded.release();
      });
      cancelOperation = cancelChild.sendMessage({ content: 'CANCEL_CHILD_TASK: inspect evidence.txt.' })
        .then(() => cancelChild!.thread.listActiveMessages());
      context.background.adopt({ completion: cancelOperation, cancel: () => { cancelBridgeCalls++; cancelChild!.abort(); } });
      return { childThreadId: cancelChildTarget.threadId, launched: true };
    },
  });
  const options = { profile, projectPath, runtimeRoot: join(root, 'runtime'),
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
    subagents: [], extraTools: { delegate_child: delegate, message_child: messageChild, cancel_child: cancelDelegate } };
  runtime = await createProjectRuntime(options);
  observeProducers(runtime);
  parent = await runtime.createSession(parentTarget);
  liveSessions.push({ session: parent, target: parentTarget });
  await parent.thread.rename({ title: 'Delegating parent fixture', pin: true });
  parent.subscribe(event => {
    events.push({ session: 'parent', event });
    if (parentFinalRequested && event.type === 'agent_end' && event.reason === 'complete') parentFinalEnded.release();
  });
  // Native untilIdle keeps the originating parent available for native background results.
  const parentRun = parent.sendMessage({ content: 'PARENT_ONLY_SECRET: delegate, guide the child, then synthesize its result.', untilIdle: true });
  await parentContinued.reached;
  await parentRun; // Session.sendMessage resolves at the originating turn while native untilIdle continues.
  assert.ok(backgroundTaskId);
  assert.equal(childFinished, false);
  const manager = runtime.mastra.backgroundTaskManager;
  assert.ok(manager);
  const runningTask = await manager.getTask(backgroundTaskId);
  assert.equal(runningTask?.status, 'running', 'adoption keeps the native task running after its launch acknowledgement');
  assert.equal(runningTask?.threadId, parentTarget.threadId);
  finishChild.release();
  await nativeFinalReceived.reached;
  await parentFinalEnded.reached;
  await joinProducers();
  await settle(parent);
  await settle(child!);
  const completedTask = await manager.getTask(backgroundTaskId);
  assert.equal(completedTask?.status, 'completed');
  assert.ok(JSON.stringify(completedTask.result).includes('CHILD_FINAL_GUIDED'), 'native task stores adopted terminal output');
  const read = (target: typeof childTarget) => runtime!.controller.queryThreadMessages({ ...target, perPage: false,
    orderBy: { field: 'createdAt' as const, direction: 'ASC' as const } });
  const parentBefore = (await read(parentTarget)).messages;
  const childBefore = (await read(childTarget)).messages;
  assert.ok(JSON.stringify(parentBefore).includes('PARENT_CONTINUED_WHILE_CHILD_RUNNING'));
  assert.ok(JSON.stringify(parentBefore).includes('PARENT_FINAL_ACK'), 'native result injection resumes parent synthesis without host completion notification');
  assert.ok(!JSON.stringify(parentBefore).includes('CHILD_FILE_EVIDENCE'), 'child workspace transcript stays out of the parent context');
  assert.ok(JSON.stringify(childBefore).includes('CHILD_FILE_EVIDENCE'));
  assert.ok(JSON.stringify(childBefore).includes('CHILD_GUIDANCE'));
  assert.ok(!JSON.stringify(childBefore).includes('PARENT_ONLY_SECRET'));
  assert.ok((await runtime.controller.queryThreads({})).some(thread => thread.id === childTarget.threadId), 'fresh child is a normal native persisted thread');
  await runtime.dispose();
  parent = undefined; child = undefined; // Never reuse sessions from the retired runtime.
  runtime = await createProjectRuntime(options);
  observeProducers(runtime);
  const beforeRead = fixture.requests.length;
  assert.deepEqual((await read(parentTarget)).messages, parentBefore, 'parent history survives restart');
  assert.deepEqual((await read(childTarget)).messages, childBefore, 'fresh child history survives restart');
  assert.equal(fixture.requests.length, beforeRead, 'history inspection never invokes the model');
  const resumedChild = await runtime.createSession(childTarget);
  child = resumedChild;
  liveSessions.push({ session: resumedChild, target: childTarget });
  await resumedChild.sendMessage({ content: 'CHILD_FOLLOWUP: continue your prior file inspection.' });
  await joinProducers();
  await settle(resumedChild);
  const childAfter = (await read(childTarget)).messages;
  assert.ok(JSON.stringify(childAfter).includes('CHILD_FOLLOWUP_RESULT'), 'follow-up persists in the same child conversation');
  assert.deepEqual((await read(parentTarget)).messages, parentBefore, 'child follow-up cannot alter parent history');
  const firstChildRequest = fixture.requests.find(request => lastUserText(request).includes('CHILD_ONLY_TASK'));
  assert.ok(firstChildRequest);
  assert.ok(!JSON.stringify(firstChildRequest.messages).includes('PARENT_ONLY_SECRET'));
  const guidedRequest: FixtureRequest | undefined = fixture.requests.find(request =>
    JSON.stringify(request.messages).includes('CHILD_ONLY_TASK') && JSON.stringify(request.messages).includes('CHILD_FILE_EVIDENCE'));
  assert.ok(guidedRequest && JSON.stringify(guidedRequest.messages).includes('CHILD_GUIDANCE'));

  // Cancellation proves operation routing/result fencing. Native pre-loop preparation
  // can outlive cancellation despite loop-producer joins; safe retirement is unproven.
  await t.test('native cancellation reaches the adopted child and fences its eventual terminal output', { timeout: 15_000 }, async () => {
    cancelParent = await runtime!.createSession(cancelParentTarget);
    liveSessions.push({ session: cancelParent, target: cancelParentTarget });
    await cancelParent.thread.rename({ title: 'Cancellation parent fixture', pin: true });
    cancelParent.subscribe(event => { events.push({ session: 'cancel-parent', event }); });
    const runningParent = cancelParent.sendMessage({ content: 'CANCEL_PARENT_TASK: launch the child and continue.' });
    await heldCancelChild.reached;
    await cancelParentContinued.reached;
    await runningParent;
    assert.ok(cancelTaskId);
    const nativeManager = runtime!.mastra.backgroundTaskManager;
    assert.ok(nativeManager);
    assert.equal((await nativeManager.getTask(cancelTaskId))?.status, 'running');
    await nativeManager.cancel(cancelTaskId);
    await cancelChildEnded.reached;
    await cancelOperation;
    await joinProducers();
    assert.equal(cancelBridgeCalls, 1, 'native cancellation invokes the adopted operation cancellation hook exactly once');
    const cancelled = await nativeManager.getTask(cancelTaskId);
    assert.equal(cancelled?.status, 'cancelled', 'late child promise settlement cannot change cancellation to success');
    assert.equal(cancelled.result, undefined, 'cancelled native task does not publish child terminal output as a result');
    assert.equal(cancelChild!.displayState.get().isRunning, false, 'adopted cancellation stops the actual child run');
    await settle(cancelParent);
    const parentHistory = JSON.stringify((await read(cancelParentTarget)).messages);
    assert.ok(parentHistory.includes('PARENT_CANCEL_CHILD_RUNNING'));
    assert.ok(!parentHistory.includes('started:CANCEL_CHILD_TASK'), 'cancelled child output is not injected into parent history');
    assert.ok(!fixture.requests.some(request => request.messages.some(message => message.role === 'tool' &&
      JSON.stringify(message.content).includes('started:CANCEL_CHILD_TASK'))), 'no parent model request receives cancelled child output');
  });
});
