import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { abortNativeChat, retireChatDescendants } from '../src/chat-archive.js';
import { createChildTools } from '../src/child-tools.js';
import { readChildRelation } from '../src/child-relation.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture, type FixtureRequest } from './fixtures/model-server.js';

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve };
}
let profile: SpikeProfile, profileRoot: string;
before(async () => {
  profileRoot = await mkdtemp(join(tmpdir(), 'kodex-direct-child-profile-'));
  profile = activateProfile(resolveProfile(profileRoot));
});
after(async () => { await rm(profileRoot, { recursive: true, force: true }); });
const serialized = (request: FixtureRequest) => JSON.stringify(request.messages);
async function memorySettled(session: NativeSession) {
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function'); await memory.settled();
}

/** Actual SDK composition only. Internal producer observation is fixture cleanup,
 * not a proposed host shutdown/join mechanism or a public memory drain claim. */
async function setup(t: TestContext, kind: 'reopen' | 'steer' | 'fork') {
  const root = await mkdtemp(join(tmpdir(), `kodex-direct-child-${kind}-`));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  await writeFile(join(projectPath, 'evidence.txt'), 'DIRECT_CHILD_EVIDENCE: persisted native workspace result');
  const sessions = new Set<NativeSession>(), producers = new Map<string, ReturnType<typeof gate>>();
  const holds: Array<ReturnType<Awaited<ReturnType<typeof startModelFixture>>['holdNext']>> = [];
  const trace: unknown[] = [], completion = gate<string>(), parentFinal = gate();
  let runtime!: ProjectRuntime, child: NativeSession | undefined, parentFinalRequested = false;
  const fixture = await startModelFixture(request => {
    const last = lastUserText(request), content = serialized(request);
    if (['REOPEN_DIRECT', 'RESTART_DIRECT', 'DIRECT_STOP', 'DIRECT_ARCHIVE', 'PEER_HOLD', 'FORK_DIRECT', 'FORK_STOP', 'FORK_ARCHIVE', 'HARD_STEER'].some(marker => last.includes(marker))) {
      if (last.includes('REOPEN_DIRECT') || last.includes('RESTART_DIRECT')) {
        assert.ok(content.includes('CHILD_DIRECT_TASK') && content.includes('CHILD_DIRECT_RESULT'), 'native direct reopening supplies the actual retained child conversation');
        assert.ok(request.tools?.some(tool => tool.function.name === 'delegate_child'), 'a recreated Session does not retain the prior per-tool deny');
        assert.ok(JSON.stringify(request.tools?.find(tool => tool.function.name === 'view')?.function.parameters).includes('_background'), 'the ephemeral no-background machinery is absent after native recreation');
      }
      if (last.includes('FORK_DIRECT')) assert.ok(content.includes('FORK_CHILD_TASK') && content.includes('FORK_CHILD_RESULT'), 'scoped direct fork input uses retained native fork context');
      return { text: `DIRECT_RESULT:${last}` };
    }
    if (last.includes('FORK_CHILD_TASK')) return { text: 'FORK_CHILD_RESULT' };
    if (last === 'FORK_PARENT_TASK' && !content.includes('FORK_CHILD_RESULT')) return {
      toolCalls: [{ name: 'subagent', arguments: { agentType: 'explore', task: 'FORK_CHILD_TASK', forked: true }, id: 'fork-child-call' }],
    };
    if (last === 'FORK_PARENT_TASK') return { text: 'FORK_PARENT_RESULT' };
    if (content.includes('CHILD_DIRECT_TASK') && !content.includes('PARENT_PRIVATE_TASK')) {
      assert.ok(!request.tools?.some(tool => ['delegate_child', 'message_child', 'subagent'].includes(tool.function.name)));
      assert.ok(!JSON.stringify(request.tools?.find(tool => tool.function.name === 'view')?.function.parameters).includes('_background'));
      if (!content.includes('DIRECT_CHILD_EVIDENCE')) return { toolCalls: [{ name: 'view', arguments: { path: 'evidence.txt' }, id: 'child-direct-view' }] };
      if (kind === 'reopen') assert.ok(content.includes('DIRECT_USER_GUIDANCE'), 'active direct user input reaches the next native child model step');
      return { text: 'CHILD_DIRECT_RESULT' };
    }
    if (content.includes('CHILD_DIRECT_RESULT') || last.includes('background-task-failed')) {
      parentFinalRequested = true; return { text: 'PARENT_FINAL_RESULT' };
    }
    if (request.messages.some(message => message.role === 'tool')) return { text: 'PARENT_CONTINUED' };
    assert.equal(last, 'PARENT_PRIVATE_TASK');
    return { toolCalls: [{ name: 'delegate_child', arguments: { task: 'CHILD_DIRECT_TASK: view evidence.txt and report' }, id: 'direct-delegate' }] };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    lsp: false, observability: { enabled: false }, backgroundTools: { enabled: true },
    models: { modeDefaults: { build: 'fixture/chat' }, subagentModels: { default: 'fixture/chat' }, observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
  }));
  function instrument(mounted: ProjectRuntime) {
    mounted.controller.onSessionCreated(session => {
      sessions.add(session);
      if (session.getTags().kodexChild === '1') child = session;
      session.subscribe(event => {
        trace.push({ session: session.identity.getId(), threadId: session.thread.getId(), event });
        if (session.identity.getResourceId() === 'direct-parent-resource' && parentFinalRequested && event.type === 'agent_end' && event.reason === 'complete') parentFinal.resolve();
      });
    });
    mounted.backgroundCompletionEvents?.subscribe(event => { trace.push({ task: event }); completion.resolve(event.status); });
    const register = mounted.mastra.__registerInternalWorkflow.bind(mounted.mastra);
    const unregister = mounted.mastra.__unregisterInternalWorkflow.bind(mounted.mastra);
    t.mock.method(mounted.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
      const result = register(...args); if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], gate()); return result;
    });
    t.mock.method(mounted.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
      unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.resolve(undefined);
    });
  }
  async function mount() {
    runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'),
      modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
      extraTools: createChildTools({ getRuntime: () => runtime }) });
    instrument(runtime);
  }
  async function joinProducers() {
    let joined = -1;
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(done => done.promise)); }
  }
  t.diagnostic(`Direct child characterization: ${join(root, 'trace.json')}`);
  t.after(async () => {
    // Stop every observed Session before native task callbacks can wake its parent.
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    for (const hold of holds) hold.release();
    if (runtime) {
      const tasks = await runtime.mastra.backgroundTaskManager?.listTasks({ status: ['pending', 'running', 'suspended'] });
      for (const task of tasks?.tasks ?? []) await runtime.mastra.backgroundTaskManager?.cancel(task.id);
      await joinProducers(); await runtime.dispose();
    }
    await fixture.close(); await writeFile(join(root, 'trace.json'), JSON.stringify({ trace, requests: fixture.requests }, null, 2));
    for (const directory of ['project', 'runtime']) await rm(join(root, directory), { recursive: true, force: true });
  });
  await mount();
  return { get runtime() { return runtime; }, get child() { return child; }, fixture, projectPath, completion, parentFinal, joinProducers,
    hold(marker: string) { const hold = fixture.holdNext(marker); holds.push(hold); return hold; },
    async restart() { await joinProducers(); await runtime.dispose(); await mount(); },
  };
}
async function delegate(env: Awaited<ReturnType<typeof setup>>) {
  const parent = await env.runtime.createSession({ threadId: 'direct-parent-thread', resourceId: 'direct-parent-resource' });
  const hold = env.hold('CHILD_DIRECT_TASK');
  const operation = parent.sendMessage({ content: 'PARENT_PRIVATE_TASK', untilIdle: true }); void operation.catch(() => {});
  await hold.reached; await operation;
  const child = env.child; assert.ok(child);
  const row = await env.runtime.controller.queryThreadById({ threadId: child.thread.requireId() }); assert.ok(row);
  const relation = readChildRelation(row.metadata); assert.ok(relation);
  const manager = env.runtime.mastra.backgroundTaskManager; assert.ok(manager);
  assert.equal((await manager.getTask(relation.parentTaskId))?.status, 'running');
  return { parent, child, row, relation, manager, hold };
}

test('public direct child binding aliases the live adopted Session and native user delivery preserves its owner, then stored history reopens after completion and restart', { timeout: 40_000 }, async t => {
  const env = await setup(t, 'reopen');
  const { parent, child, row, relation, manager, hold } = await delegate(env);
  const target = { resourceId: row.resourceId, threadId: row.id };
  const alias = await env.runtime.createSession(target);
  assert.equal(alias, child, 'same native resource/thread returns the exact existing owned Session');
  assert.equal(child.displayState.get().isRunning, true);
  assert.equal(child.resolveToolApproval('delegate_child'), 'deny');
  assert.equal(parent.resolveToolApproval('delegate_child'), 'allow', 'child permissions do not alter its parent');
  const runId = child.getCurrentRunId(); assert.ok(runId);
  let aborted = 0;
  const off = child.subscribe(event => { if (event.type === 'agent_end' && event.reason === 'aborted') aborted++; }); t.after(off);
  await alias.sendMessage({ content: 'DIRECT_USER_GUIDANCE: retain verified evidence' });
  assert.equal(child.getCurrentRunId(), runId, 'direct Send delivers to the same active child operation');
  assert.equal((await manager.getTask(relation.parentTaskId))?.status, 'running');
  hold.release();
  assert.equal(await env.completion.promise, 'completed'); await env.parentFinal.promise; await env.joinProducers(); await memorySettled(parent);
  assert.equal(aborted, 0, 'direct user delivery does not abort the adopted run');
  assert.ok(JSON.stringify((await manager.getTask(relation.parentTaskId))?.result).includes('CHILD_DIRECT_RESULT'));
  assert.ok(JSON.stringify(await parent.thread.listActiveMessages()).includes('PARENT_FINAL_RESULT'));
  assert.equal(await env.runtime.controller.getSessionByResource(row.resourceId), undefined);
  assert.equal(alias.thread.getId(), null, 'all aliases observe native finalizer release');
  const saved = await env.runtime.controller.queryThreadMessages({ ...target, perPage: false });
  assert.ok(JSON.stringify(saved.messages).includes('DIRECT_USER_GUIDANCE'));
  const reopened = await env.runtime.createSession(target);
  assert.notEqual(reopened, child);
  assert.deepEqual(reopened.permissions.getRules(), { tools: {}, categories: {} }, 'the previous child deny rules are not loaded from persisted thread metadata');
  assert.equal(reopened.resolveToolApproval('delegate_child'), 'allow');
  assert.equal((await reopened.machinery.buildStreamOptions({})).disableBackgroundTasks, undefined, 'native recreation drops the per-Session machinery wrapper');
  assert.ok(readChildRelation((await env.runtime.controller.queryThreadById({ threadId: row.id }))?.metadata), 'persisted child relationship survives without relying on Session tags');
  await reopened.sendMessage({ content: 'REOPEN_DIRECT' }); await env.joinProducers(); await memorySettled(reopened);
  assert.equal((await manager.getTask(relation.parentTaskId))?.status, 'completed', 'new user work does not reopen or replace the original native background task');
  const stopped = env.hold('DIRECT_STOP');
  const directRun = reopened.sendMessage({ content: 'DIRECT_STOP' }); void directRun.catch(() => {}); await stopped.reached;
  let lateComplete = 0;
  const offStop = reopened.subscribe(event => { if (event.type === 'agent_end' && event.reason === 'complete') lateComplete++; }); t.after(offStop);
  await abortNativeChat(reopened); stopped.release(); await Promise.allSettled([directRun]); await env.joinProducers();
  assert.equal(reopened.displayState.get().isRunning, false); assert.equal(lateComplete, 0);
  await reopened.permissions.setForTool({ toolName: 'delegate_child', policy: 'deny' });
  const historyBefore = (await env.runtime.controller.queryThreadMessages({ ...target, perPage: false })).messages;
  const requestsBefore = env.fixture.requests.length;
  await env.restart();
  assert.equal(await env.runtime.controller.getSessionByResource(row.resourceId), undefined);
  const historyAfter = (await env.runtime.controller.queryThreadMessages({ ...target, perPage: false })).messages;
  const retainedById = new Map(historyAfter.map(message => [message.id, message]));
  for (const message of historyBefore) assert.deepEqual(retainedById.get(message.id), message, 'restart retains every captured native row unchanged');
  const priorIds = new Set(historyBefore.map(message => message.id));
  for (const message of historyAfter.filter(message => !priorIds.has(message.id))) {
    assert.equal(message.role, 'signal'); assert.equal(message.type, 'user');
    assert.equal(message.content.parts.filter(part => part.type === 'text').map(part => part.text).join(''), 'DIRECT_STOP', 'disposal may finish saving the already accepted Stop input, but no late model completion');
  }
  assert.ok(JSON.stringify(historyAfter).includes('DIRECT_STOP'), 'the native stopped input is retained after disposal; abort acknowledgement is not a persistence barrier');
  assert.equal(env.fixture.requests.length, requestsBefore, 'history reads after in-process runtime recreation activate no model work');
  const restarted = await env.runtime.createSession(target);
  assert.equal(restarted.resolveToolApproval('delegate_child'), 'allow', 'native binding after runtime recreation also needs explicit child policy reconfiguration');
  await restarted.sendMessage({ content: 'RESTART_DIRECT' }); await env.joinProducers(); await memorySettled(restarted);

  const retiring = env.hold('DIRECT_ARCHIVE'), unrelated = env.hold('PEER_HOLD');
  const run = restarted.sendMessage({ content: 'DIRECT_ARCHIVE' }); void run.catch(() => {}); await retiring.reached;
  const peer = await env.runtime.createSession({ resourceId: 'peer-resource', threadId: 'peer-thread' });
  const peerRun = peer.sendMessage({ content: 'PEER_HOLD' }); await unrelated.reached;
  const parentRow = await env.runtime.controller.queryThreadById({ threadId: 'direct-parent-thread' }); assert.ok(parentRow);
  const parentBinding = await env.runtime.createSession({ resourceId: parentRow.resourceId, threadId: parentRow.id });
  await abortNativeChat(parentBinding); await env.runtime.releaseSession({ resourceId: parentRow.resourceId });
  assert.deepEqual(await retireChatDescendants(env.runtime, parentRow, env.projectPath), [row.id]);
  assert.equal(await env.runtime.controller.getSessionByResource(row.resourceId), undefined, 'existing descendant retirement finds a reopened unscoped fresh child');
  assert.equal(peer.displayState.get().isRunning, true, 'retiring the descendant does not stop an unrelated Session');
  retiring.release(); unrelated.release(); await Promise.allSettled([run, peerRun]); await env.joinProducers();
  assert.ok(JSON.stringify((await env.runtime.controller.queryThreadMessages({ ...target, perPage: false })).messages).includes('DIRECT_RESULT:RESTART_DIRECT'), 'retirement keeps previously completed native child history');
});

test('native hard steering an adopted child aborts its original logical operation rather than extending the native task', { timeout: 35_000 }, async t => {
  const env = await setup(t, 'steer');
  const { child, row, relation, manager, hold } = await delegate(env);
  const alias = await env.runtime.createSession({ resourceId: row.resourceId, threadId: row.id }); assert.equal(alias, child);
  const steering = alias.steer({ content: 'HARD_STEER' }); void steering.catch(() => {});
  hold.release();
  assert.equal(await env.completion.promise, 'failed');
  const outcome = await Promise.allSettled([steering]); await env.parentFinal.promise; await env.joinProducers();
  const task = await manager.getTask(relation.parentTaskId);
  assert.equal(task?.status, 'failed'); assert.equal(task.result, undefined);
  assert.equal(await env.runtime.controller.getSessionByResource(row.resourceId), undefined);
  t.diagnostic(`Hard-steer outcome: ${outcome[0]?.status}; child requests ${env.fixture.requests.filter(request => lastUserText(request).includes('HARD_STEER')).length}`);
});

test('a stored native fork needs a distinct scope to avoid parent aliasing; public Stop isolates it, while current unscoped descendant retirement does not join its binding', { timeout: 40_000 }, async t => {
  const env = await setup(t, 'fork');
  const parentTarget = { resourceId: 'fork-parent-resource', threadId: 'fork-parent-thread' };
  const parent = await env.runtime.createSession(parentTarget);
  await parent.sendMessage({ content: 'FORK_PARENT_TASK' }); await env.joinProducers(); await memorySettled(parent);
  const forks = await env.runtime.controller.queryThreads({ includeForkedSubagents: true, metadata: { parentThreadId: parentTarget.threadId } });
  assert.equal(forks.length, 1); const fork = forks[0]!;
  assert.equal(fork.resourceId, parentTarget.resourceId); assert.equal(fork.metadata?.forkedSubagent, true);
  assert.equal(await env.runtime.controller.getSessionByResource(fork.resourceId), parent, 'an unscoped resource lookup names the parent rather than this fork');
  const scope = `direct-fork:${fork.id}`;
  const scoped = await env.runtime.createSession({ resourceId: fork.resourceId, threadId: fork.id, scope });
  assert.notEqual(scoped, parent); assert.equal(scoped.thread.getId(), fork.id); assert.equal(parent.thread.getId(), parentTarget.threadId);
  await scoped.sendMessage({ content: 'FORK_DIRECT' }); await env.joinProducers(); await memorySettled(scoped);
  const parentHeld = env.hold('PEER_HOLD'), forkHeld = env.hold('FORK_STOP');
  const parentRun = parent.sendMessage({ content: 'PEER_HOLD' }); await parentHeld.reached;
  const forkRun = scoped.sendMessage({ content: 'FORK_STOP' }); void forkRun.catch(() => {}); await forkHeld.reached;
  await abortNativeChat(scoped);
  assert.equal(scoped.displayState.get().isRunning, false); assert.equal(parent.displayState.get().isRunning, true);
  assert.equal(parent.thread.getId(), parentTarget.threadId);
  forkHeld.release(); parentHeld.release(); await Promise.allSettled([parentRun, forkRun]); await env.joinProducers();

  const archiveHold = env.hold('FORK_ARCHIVE');
  const laterRun = scoped.sendMessage({ content: 'FORK_ARCHIVE' }); void laterRun.catch(() => {}); await archiveHold.reached;
  const parentRow = await env.runtime.controller.queryThreadById({ threadId: parentTarget.threadId }); assert.ok(parentRow);
  await abortNativeChat(parent); await env.runtime.releaseSession({ resourceId: parentTarget.resourceId });
  assert.deepEqual(await retireChatDescendants(env.runtime, parentRow, env.projectPath), [fork.id]);
  assert.equal(scoped.displayState.get().isRunning, true, 'current retirement resolves only unscoped descendants and does not own a newly scoped direct fork run');
  assert.equal(await env.runtime.controller.getSessionByResource(fork.resourceId, scope), scoped);
  await abortNativeChat(scoped); await env.runtime.releaseSession({ resourceId: fork.resourceId, scope });
  archiveHold.release(); await Promise.allSettled([laterRun]); await env.joinProducers();
  assert.equal(await env.runtime.controller.getSessionByResource(fork.resourceId, scope), undefined);
  assert.ok(JSON.stringify((await env.runtime.controller.queryThreadMessages({ threadId: fork.id, resourceId: fork.resourceId, perPage: false })).messages).includes('DIRECT_RESULT:FORK_DIRECT'));
});
