import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createChildTools } from '../src/child-tools.js';
import { readChildRelation } from '../src/child-relation.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

let profile: SpikeProfile;
let profileRoot: string;
before(async () => {
  profileRoot = await mkdtemp(join(tmpdir(), 'kodex-child-tools-profile-'));
  profile = activateProfile(resolveProfile(profileRoot));
});
after(async () => { await rm(profileRoot, { recursive: true, force: true }); });

function gate() {
  let release!: () => void;
  return { reached: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function settle(session: NativeSession) {
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function');
  await memory.settled();
}


function observeProducers(t: import('node:test').TestContext, runtime: ProjectRuntime, suspendedRuns = new Set<string>()) {
  const nativeRuns = new Set<string>(), finishedRuns = new Set<string>();
  const producerWaiters = new Map<string, ReturnType<typeof gate>>();
  // Fixture only: join loop finally after native terminal events, never a
  // product dependency on internal workflow registration.
  const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
  t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
    const result = register(...args); if (args[0].id === 'agentic-loop' && args[1]) nativeRuns.add(args[1]); return result;
  });
  const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
  t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
    unregister(id, runId); if (id === 'agentic-loop') { finishedRuns.add(runId); producerWaiters.get(runId)?.release(); }
  });
  return async () => {
    let joined = -1;
    while (joined !== nativeRuns.size) {
      joined = nativeRuns.size;
      await Promise.all([...nativeRuns].map(id => {
        if (finishedRuns.has(id) || suspendedRuns.has(id)) return;
        const waiter = producerWaiters.get(id) ?? gate(); producerWaiters.set(id, waiter); return waiter.reached;
      }));
    }
  };
}

// Actual pinned SDK: the fixture supplies model decisions; native sessions,
// task acknowledgements, tool dispatch, signal acceptance and storage stay real.
test('host child tools use native task handles, enforce parent origin, deliver live guidance and return canonical child output', { timeout: 45_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-child-tools-'));
  let runtime: ProjectRuntime | undefined;
  let parent: NativeSession | undefined;
  let child: NativeSession | undefined;
  let hostile: NativeSession | undefined;
  let taskId = '';
  let childFinished = false;
  let parentFinalRequested = false;
  let sawStarting = false;
  const allowChildCreation = gate();
  const childReady = gate(), childGuided = gate(), finishChild = gate(), parentContinued = gate(), finalEnded = gate();
  const sessions: NativeSession[] = [];
  const trace: unknown[] = [];
  let joinProducers = async () => {};
  const fixture = await startModelFixture(async request => {
    const serialized = JSON.stringify(request.messages);
    const last = lastUserText(request);
    if (request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('CHILD_ONLY_TASK'))) {
      assert.ok(!serialized.includes('PARENT_PRIVATE_CONTEXT'), 'fresh child receives no parent transcript');
      assert.ok(!request.tools?.some(tool => ['delegate_child', 'message_child', 'subagent', 'run-workflow', 'create-workflow'].includes(tool.function.name)), 'child cannot create nested delegated operations');
      const view = request.tools?.find(tool => tool.function.name === 'view');
      assert.ok(view, 'child uses the actual public workspace view tool');
      assert.ok(!JSON.stringify(view.function.parameters).includes('_background'), 'child workspace tools cannot dispatch nested background tasks');
      if (!serialized.includes('CHILD_FILE_EVIDENCE')) {
        childReady.release();
        return { toolCalls: [{ name: 'view', arguments: { path: 'evidence.txt', _background: { enabled: true } }, id: 'child-view' }] };
      }
      assert.ok(serialized.includes('CHILD_GUIDANCE'), 'guidance is in the child model request before completion');
      assert.equal(childFinished, false);
      childGuided.release();
      await finishChild.reached;
      if (!serialized.includes('blocked-delegate')) return { toolCalls: [
        { name: 'delegate_child', arguments: { task: 'NESTED_CHILD_MUST_NOT_START' }, id: 'blocked-delegate' },
        { name: 'subagent', arguments: { agentType: 'explore', task: 'NESTED_SUBAGENT_MUST_NOT_START' }, id: 'blocked-subagent' },
      ] };
      assert.ok(request.messages.some(message => message.role === 'tool' && /not found|denied/i.test(JSON.stringify(message.content))), 'native execution rejects attempted hidden delegation tools');
      return { text: 'CHILD_CANONICAL_RESULT' };
    }
    if (last.includes('HOSTILE_PARENT')) {
      if (!request.messages.some(message => message.role === 'tool')) return { toolCalls: [{ name: 'message_child', arguments: { taskId, message: 'HOSTILE_GUIDANCE' }, id: 'hostile-message' }] };
      assert.ok(serialized.includes('Child task does not belong to this parent'), 'native tool invocation reports the rejected parent origin');
      return { text: 'HOSTILE_REJECTED_ACK' };
    }
    if (serialized.includes('CHILD_CANONICAL_RESULT')) {
      childFinished = true;
      parentFinalRequested = true;
      return { text: 'PARENT_FINAL_ACK' };
    }
    if (serialized.includes('guidanceDelivered')) {
      assert.equal(childFinished, false);
      parentContinued.release();
      return { text: 'PARENT_CONTINUED_WHILE_CHILD_RUNNING' };
    }
    if (request.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('starting'))) {
      sawStarting = true;
      assert.equal(child, undefined, 'native acknowledgment can precede launch registration');
      allowChildCreation.release();
      await childReady.reached;
      return { toolCalls: [{ name: 'message_child', arguments: { taskId, message: 'CHILD_GUIDANCE: prefer verified evidence.' }, id: 'parent-message-ready' }] };
    }
    const acknowledgement = request.messages.find(message => message.role === 'tool' && JSON.stringify(message.content).includes('Task ID:'));
    if (acknowledgement) {
      const match = JSON.stringify(acknowledgement.content).match(/Task ID: ([^.\s]+)\./);
      assert.ok(match, 'native acknowledgement exposes a usable native task ID');
      taskId = match[1]!;
      assert.ok(!serialized.includes('kodex-child:'), 'parent never depends on a hidden child thread handle');
      // The fixture gates the actual child model; host messaging still performs
      // native requireDelivery acceptance instead of assuming readiness.
      return { toolCalls: [{ name: 'message_child', arguments: { taskId, message: 'CHILD_GUIDANCE: prefer verified evidence.' }, id: 'parent-message-starting' }] };
    }
    assert.ok(last.includes('PARENT_PRIVATE_CONTEXT'));
    return { toolCalls: [{ name: 'delegate_child', arguments: { task: 'CHILD_ONLY_TASK: inspect evidence.txt.' }, id: 'parent-delegate' }] };
  });
  const heldChild = fixture.holdNext('CHILD_ONLY_TASK');
  t.diagnostic(`Child tools trace: ${join(root, 'trace.json')}`);
  t.after(async () => {
    allowChildCreation.release(); heldChild.release(); finishChild.release(); childReady.release();
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    await joinProducers();
    await runtime?.dispose(); await fixture.close();
    await writeFile(join(root, 'trace.json'), JSON.stringify({ taskId, trace, requests: fixture.requests }, null, 2));
    for (const directory of ['profile', 'project', 'runtime']) await rm(join(root, directory), { recursive: true, force: true });
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    backgroundTools: { enabled: true }, lsp: false, observability: { enabled: false },
  }));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  await writeFile(join(projectPath, 'evidence.txt'), 'CHILD_FILE_EVIDENCE: real native workspace output.');
  const tools = createChildTools({ getRuntime: () => {
    assert.ok(runtime); return runtime;
  } });
  runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'),
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], extraTools: tools });
  const nativeCreateSession = runtime.createSession.bind(runtime);
  t.mock.method(runtime, 'createSession', async (input: Parameters<typeof nativeCreateSession>[0], initialize: Parameters<typeof nativeCreateSession>[1]) => {
    if (input.tags?.kodexChild === '1') await allowChildCreation.reached;
    return nativeCreateSession(input, initialize);
  });
  joinProducers = observeProducers(t, runtime);
  const off = runtime.controller.onSessionCreated(session => {
    sessions.push(session);
    if (session.getTags().kodexChild === '1') {
      child = session;
      session.subscribe(event => { trace.push({ child: event }); });
    }
  });
  t.after(off);
  const target = { threadId: 'parent-thread', resourceId: 'parent-resource' };
  parent = await runtime.createSession(target);
  await parent.thread.rename({ title: 'Parent fixture', pin: true });
  parent.subscribe(event => {
    trace.push({ parent: event });
    if (parentFinalRequested && event.type === 'agent_end' && event.reason === 'complete') finalEnded.release();
  });
  const parentRun = parent.sendMessage({ content: 'PARENT_PRIVATE_CONTEXT: delegate and guide the child, then report its result.', untilIdle: true });
  await heldChild.reached;
  assert.ok(child);
  assert.equal(sawStarting, true);
  await parentContinued.reached;
  heldChild.release();
  await childGuided.reached;
  await parentRun; // First parent turn ends while native adopted child is held.
  const manager = runtime.mastra.backgroundTaskManager; assert.ok(manager);
  const task = await manager.getTask(taskId); assert.ok(task);
  assert.equal(task.status, 'running');
  assert.equal(task.threadId, target.threadId); assert.equal(task.resourceId, target.resourceId);
  const row = await runtime.controller.queryThreadById({ threadId: child.thread.requireId() }); assert.ok(row);
  const relation = readChildRelation(row.metadata); assert.ok(relation);
  assert.deepEqual(relation, { parentThreadId: target.threadId, parentResourceId: target.resourceId, parentSessionScope: '', parentTaskId: taskId });
  assert.notEqual(row.id, target.threadId); assert.notEqual(row.resourceId, target.resourceId);
  assert.equal(row.metadata?.forkedSubagent, undefined);
  assert.ok((await runtime.controller.queryThreads({ metadata: { parentTaskId: taskId } })).some(entry => entry.id === row.id));
  hostile = await runtime.createSession({ threadId: 'hostile-thread', resourceId: target.resourceId, scope: 'hostile-scope' });
  await hostile.thread.rename({ title: 'Hostile fixture', pin: true });
  await hostile.sendMessage({ content: 'HOSTILE_PARENT: attempt to message the other parent child.' });
  await settle(hostile);
  assert.ok(JSON.stringify(await hostile.thread.listActiveMessages()).includes('HOSTILE_REJECTED_ACK'));
  assert.ok(!JSON.stringify(await child.thread.listActiveMessages()).includes('HOSTILE_GUIDANCE'));
  finishChild.release();
  await finalEnded.reached;
  await joinProducers(); await settle(parent);
  const completed = await manager.getTask(taskId); assert.equal(completed?.status, 'completed');
  assert.ok(JSON.stringify(completed?.result).includes('CHILD_CANONICAL_RESULT'));
  assert.ok(JSON.stringify(await parent.thread.listActiveMessages()).includes('PARENT_FINAL_ACK'));
  assert.equal(await runtime.controller.getSessionByResource(row.resourceId), child, 'completed child binding remains available for later native input');
  const savedChild = await runtime.controller.queryThreadMessages({ threadId: row.id, resourceId: row.resourceId, perPage: 40, orderBy: { field: 'createdAt', direction: 'ASC' } });
  assert.ok(JSON.stringify(savedChild.messages).includes('CHILD_CANONICAL_RESULT'), 'released child history remains readable without reactivation');
  const tasks = await manager.listTasks({});
  assert.equal(tasks.tasks.length, 1, 'eligible child view override and hidden delegation attempts create no nested native tasks');
  assert.equal(sessions.length, 3, 'only the invoking parent, its fresh child, and unrelated parent materialized');
  assert.ok(!fixture.requests.some(request => lastUserText(request).includes('NESTED_CHILD_MUST_NOT_START') || lastUserText(request).includes('NESTED_SUBAGENT_MUST_NOT_START')));
});

for (const maxRetries of [0, 1]) test(maxRetries === 0
  ? 'a native child model error fails its task and retains its quiescent binding'
  : 'a native model retry override cannot reopen the saved fresh child thread', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-child-error-'));
  let runtime: ProjectRuntime | undefined, child: NativeSession | undefined;
  let parentFinalRequested = false;
  let childRequests = 0;
  let nativeChildError: string | undefined;
  let joinProducers = async () => {};
  const finalEnded = gate(), errored = gate();
  const sessions: NativeSession[] = [];
  const trace: unknown[] = [];
  const fixture = await startModelFixture(request => {
    const serialized = JSON.stringify(request.messages);
    if (request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('FAILED_CHILD_TASK'))) {
      if (serialized.includes('FAILED_CHILD_FILE_EVIDENCE')) return { text: 'REOPENED_CHILD_RESULT' };
      return { toolCalls: [{ name: 'view', arguments: { path: 'evidence.txt' }, id: 'failed-child-view' }] };
    }
    if (lastUserText(request).includes('background-task-failed')
      || serialized.includes('A delegated child task cannot reopen an existing child thread')
      || serialized.includes('REOPENED_CHILD_RESULT')) {
      parentFinalRequested = true;
      return { text: 'PARENT_NATIVE_FAILURE_ACK' };
    }
    if (request.messages.some(message => message.role === 'tool')) return { text: 'PARENT_WAITING_FOR_CHILD' };
    return { toolCalls: [{ name: 'delegate_child', arguments: { task: 'FAILED_CHILD_TASK: inspect evidence.txt and report the evidence.', _background: { maxRetries } }, id: 'failed-delegate' }] };
  });
  // The real SDK sees a nonretryable HTTP model error after its real view
  // output persisted. Other requests use the ordinary streaming fixture.
  const modelBoundary = http.createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content?: unknown }> };
      if (body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('FAILED_CHILD_TASK'))) {
        childRequests++;
        if (childRequests >= 2) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'Fixture native child model failure', type: 'invalid_request_error', code: 'child_model_failure' } }));
          return;
        }
      }
      const result = await fetch(`${fixture.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
      response.writeHead(result.status, { 'content-type': result.headers.get('content-type') ?? 'application/json' });
      assert.ok(result.body);
      const reader = result.body.getReader();
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        response.write(next.value);
      }
      response.end();
    } catch (error) { response.destroy(error instanceof Error ? error : new Error(String(error))); }
  });
  modelBoundary.listen(0, '127.0.0.1'); await once(modelBoundary, 'listening');
  const address = modelBoundary.address(); assert.ok(address && typeof address !== 'string');
  t.diagnostic(`Child native error trace: ${join(root, 'trace.json')}`);
  t.after(async () => {
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    await joinProducers(); await runtime?.dispose();
    modelBoundary.closeAllConnections(); await new Promise<void>((resolve, reject) => modelBoundary.close(error => error ? reject(error) : resolve()));
    await fixture.close();
    await writeFile(join(root, 'trace.json'), JSON.stringify({ childRequests, requests: fixture.requests, trace }, null, 2));
    for (const directory of ['profile', 'project', 'runtime']) await rm(join(root, directory), { recursive: true, force: true });
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    backgroundTools: { enabled: true }, lsp: false, observability: { enabled: false },
  }));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  await writeFile(join(projectPath, 'evidence.txt'), 'FAILED_CHILD_FILE_EVIDENCE: retained native view output.');
  const tools = createChildTools({ getRuntime: () => { assert.ok(runtime); return runtime; } });
  runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'),
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], extraTools: tools });
  joinProducers = observeProducers(t, runtime);
  const off = runtime.controller.onSessionCreated(session => {
    sessions.push(session);
    if (session.getTags().kodexChild === '1') {
      child = session;
      session.subscribe(event => {
        trace.push({ child: event });
        if (event.type === 'error') { nativeChildError = event.error.message; errored.release(); }
      });
    }
  });
  t.after(off);
  const parent = await runtime.createSession({ threadId: 'failure-parent', resourceId: 'failure-parent' });
  await parent.thread.rename({ title: 'Failure parent', pin: true });
  parent.subscribe(event => {
    trace.push({ parent: event });
    if (parentFinalRequested && event.type === 'agent_end' && event.reason === 'complete') finalEnded.release();
  });
  const run = parent.sendMessage({ content: 'Delegate the file inspection task.', untilIdle: true });
  await errored.reached;
  await finalEnded.reached; await run;
  await joinProducers(); assert.ok(child); await settle(parent);
  const manager = runtime.mastra.backgroundTaskManager; assert.ok(manager);
  const tasks = await manager.listTasks({}); assert.equal(tasks.tasks.length, 1);
  const task = tasks.tasks[0]!;
  assert.equal(task.maxRetries, maxRetries, 'native model retry override is admitted');
  assert.equal(task.retryCount, maxRetries, 'native retry actually reaches the owned tool executor');
  assert.ok(childRequests >= 2, 'the real child model receives the failing request after native view output');
  assert.equal(fixture.requests.filter(request => request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('FAILED_CHILD_TASK'))).length, 1, 'native task retries cannot resume or run the saved child context');
  assert.equal(sessions.filter(session => session.getTags().kodexChild === '1').length, 1, 'retry is rejected before native child session creation');
  assert.equal(task.status, 'failed');
  assert.ok(nativeChildError, 'nonretryable native model failure emits a public Session error');
  assert.ok(task.error?.message.includes(maxRetries ? 'A delegated child task cannot reopen an existing child thread' : nativeChildError));
  assert.equal(task.result, undefined, 'a native model error never becomes a successful child result');
  assert.equal(child.suspensions.hasPending(), false, 'failed task leaves no parked child question');
  assert.equal(child.displayState.get().pendingSuspensions.size, 0, 'read-only child has no unreachable live question');
  assert.equal(await runtime.controller.getSessionByResource(child.identity.getResourceId()), child, 'failed child binding is retained without reviving its native task');
  const saved = await runtime.controller.queryThreads({ metadata: { parentTaskId: task.id } });
  assert.equal(saved.length, 1, 'failed child relation and native history remain persisted');
  const history = await runtime.controller.queryThreadMessages({ threadId: saved[0]!.id, resourceId: saved[0]!.resourceId, perPage: 40, orderBy: { field: 'createdAt', direction: 'ASC' } });
  assert.ok(JSON.stringify(history.messages).includes('FAILED_CHILD_FILE_EVIDENCE'), 'first child native view history survives failure and retry');
  assert.ok(!JSON.stringify(history.messages).includes('REOPENED_CHILD_RESULT'));
  assert.ok(JSON.stringify(await parent.thread.listActiveMessages()).includes('PARENT_NATIVE_FAILURE_ACK'));
});

test('native cancellation during child setup aborts a late-created child before any model work', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-child-setup-cancel-'));
  let runtime: ProjectRuntime | undefined, child: NativeSession | undefined;
  let joinProducers = async () => {};
  let taskId = '';
  const creationHeld = gate(), releaseCreation = gate(), lateChildAborted = gate(), childReleased = gate(), parentContinued = gate();
  const abortWatch = new AbortController();
  const sessions: NativeSession[] = [];
  const fixture = await startModelFixture(request => {
    assert.ok(!request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('CANCEL_DURING_SETUP_CHILD')), 'cancelled setup never starts a child model request');
    const acknowledgement = request.messages.find(message => message.role === 'tool' && JSON.stringify(message.content).includes('Task ID:'));
    if (acknowledgement) {
      const match = JSON.stringify(acknowledgement.content).match(/Task ID: ([^.\s]+)\./); assert.ok(match);
      taskId = match[1]!; parentContinued.release();
      return { text: 'PARENT_CONTINUED_DURING_SETUP' };
    }
    return { toolCalls: [{ name: 'delegate_child', arguments: { task: 'CANCEL_DURING_SETUP_CHILD: inspect the project.' }, id: 'setup-cancel-delegate' }] };
  });
  t.diagnostic(`Child setup cancellation trace: ${join(root, 'trace.json')}`);
  t.after(async () => {
    releaseCreation.release(); abortWatch.abort();
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    await joinProducers(); await runtime?.dispose();
    await fixture.close();
    await writeFile(join(root, 'trace.json'), JSON.stringify({ taskId, requests: fixture.requests }, null, 2));
    for (const directory of ['project', 'runtime']) await rm(join(root, directory), { recursive: true, force: true });
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    backgroundTools: { enabled: true }, lsp: false, observability: { enabled: false },
  }));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const tools = createChildTools({ getRuntime: () => { assert.ok(runtime); return runtime; } });
  runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'),
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], extraTools: tools });
  joinProducers = observeProducers(t, runtime);
  const nativeCreateSession = runtime.createSession.bind(runtime);
  t.mock.method(runtime, 'createSession', async (input: Parameters<typeof nativeCreateSession>[0], initialize: Parameters<typeof nativeCreateSession>[1]) => {
    if (input.tags?.kodexChild === '1') { creationHeld.release(); await releaseCreation.reached; }
    return nativeCreateSession(input, initialize);
  });
  const off = runtime.controller.onSessionCreated(session => {
    sessions.push(session);
    if (session.getTags().kodexChild === '1') {
      child = session;
      void session.run.waitForAbortRequest(abortWatch.signal).then(() => lateChildAborted.release());
    }
  });
  t.after(off);
  const offDeleted = runtime.controller.onSessionDeleted(session => {
    if (session.getTags().kodexChild === '1') childReleased.release();
  });
  t.after(offDeleted);
  const parent = await runtime.createSession({ threadId: 'setup-cancel-parent', resourceId: 'setup-cancel-parent' });
  await parent.thread.rename({ title: 'Setup cancel parent', pin: true });
  const run = parent.sendMessage({ content: 'Delegate while setup is slow.', untilIdle: true });
  await creationHeld.reached; await parentContinued.reached; await run;
  const manager = runtime.mastra.backgroundTaskManager; assert.ok(manager);
  // Retirement semantics: quiesce the parent wrapper before terminal task
  // notification, so this test does not start an unrelated parent continuation.
  parent.machinery.getAgent().abortThreadStream({ threadId: parent.thread.requireId(), resourceId: parent.identity.getResourceId(), clearPendingSignals: true });
  parent.abort();
  await manager.cancel(taskId);
  assert.equal((await manager.getTask(taskId))?.status, 'cancelled');
  assert.equal(Boolean(child), false, 'cancellation reaches adoption while launch still awaits setup');
  releaseCreation.release(); await lateChildAborted.reached; assert.ok(child);
  assert.equal(child.run.isAbortRequested(), true, 'late native session is aborted before sendMessage');
  assert.equal(child.getCurrentRunId(), null);
  assert.equal(child.suspensions.hasPending(), false);
  await childReleased.reached; await joinProducers();
  assert.equal(await runtime.controller.getSessionByResource(child.identity.getResourceId()), undefined);
  const task = await manager.getTask(taskId); assert.equal(task?.status, 'cancelled');
  assert.equal(task.result, undefined);
  const saved = await runtime.controller.queryThreads({ metadata: { parentTaskId: taskId } }); assert.equal(saved.length, 1);
  const history = await runtime.controller.queryThreadMessages({ threadId: saved[0]!.id, resourceId: saved[0]!.resourceId, perPage: 40, orderBy: { field: 'createdAt', direction: 'ASC' } });
  assert.equal(history.messages.length, 0);
  assert.equal(fixture.requests.length, 2, 'only initial parent and native acknowledgement continuation reached the model');
});
