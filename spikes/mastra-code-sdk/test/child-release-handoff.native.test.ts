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

async function setup(t: TestContext, boundary: 'history' | 'cancel-release') {
  const root = await mkdtemp(join(tmpdir(), `kodex-child-handoff-${boundary}-`));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const sessions: NativeSession[] = [], producers = new Map<string, ReturnType<typeof gate>>();
  const reached = gate(), resume = gate(), childEnded = gate(), childDeleted = gate();
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
    if (boundary === 'history') {
      const read = session.thread.listActiveMessages.bind(session.thread);
      t.mock.method(session.thread, 'listActiveMessages', async (...args: Parameters<typeof read>) => {
        const messages = await read(...args);
        if (initialEnded && !boundaryUsed) {
          boundaryUsed = true; reached.release(); await resume.promise;
        }
        return messages;
      });
    } else {
      const clear = session.thread.clearAndReleaseLock.bind(session.thread);
      t.mock.method(session.thread, 'clearAndReleaseLock', async () => {
        await clear();
        if (!boundaryUsed) { boundaryUsed = true; reached.release(); await resume.promise; }
      });
    }
  });
  runtime.controller.onSessionDeleted(session => {
    trace.push({ deleted: session.identity.getResourceId() });
    if (session === child) childDeleted.release();
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
  return { runtime, child, target, taskId: relation.parentTaskId, manager, fixture, initial, naive,
    reached, resume, childEnded, childDeleted, joinProducers };
}

test('native idle before adopted history/result handoff can admit a direct run that the old finalizer aborts; successful task wait closes that window', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'history');
  env.initial.release(); await env.childEnded.promise; await env.reached.promise;
  assert.equal(env.child.displayState.get().isRunning, false);
  assert.equal((await env.manager.getTask(env.taskId))?.status, 'running', 'native idle does not mean adopted completion has settled');
  const alias = await env.runtime.createSession(env.target); assert.equal(alias, env.child);
  let completed = 0;
  const off = alias.subscribe(event => {
    if (event.type !== 'agent_end') return;
    if (event.reason === 'complete') completed++;
  }); t.after(off);
  const naiveRun = alias.sendMessage({ content: 'NAIVE_DIRECT' }); void naiveRun.catch(() => {});
  await env.naive.reached;
  assert.equal(alias.displayState.get().isRunning, true, 'the naive input really starts model work on the old binding');
  const abortWatch = new AbortController(); t.after(() => abortWatch.abort());
  const abortGeneration = alias.run.getAbortGeneration();
  const newRunAborted = alias.run.waitForAbortRequest(abortWatch.signal, { after: abortGeneration });
  env.resume.release();
  const task = await env.manager.waitForNextTask([env.taskId], { timeoutMs: 5_000 });
  await newRunAborted; env.naive.release(); await Promise.allSettled([naiveRun]); await env.joinProducers();
  assert.equal(task.status, 'completed'); assert.ok(JSON.stringify(task.result).includes('started:HANDOFF_CHILD'), 'native adopted result retains the actual held fixture response, which replaces its configured text');
  assert.ok(alias.run.getAbortGeneration() > abortGeneration, 'native finalizer deletion requests abort after the new direct run started');
  assert.equal(completed, 0, 'detached native subscription emits no completion for the new direct run');
  assert.equal(await env.runtime.controller.getSessionByResource(env.target.resourceId), undefined);
  assert.equal(alias.thread.getId(), null);

  const reopened = await env.runtime.createSession(env.target);
  assert.notEqual(reopened, alias);
  await reopened.sendMessage({ content: 'SAFE_DIRECT_AFTER_COMPLETED_WAIT' }); await env.joinProducers();
  assert.equal(reopened.thread.getId(), env.target.threadId);
  assert.ok(JSON.stringify(await reopened.thread.listActiveMessages()).includes('DIRECT_RESULT:SAFE_DIRECT_AFTER_COMPLETED_WAIT'));
  assert.equal((await env.manager.getTask(env.taskId))?.status, 'completed');
});

test('cancelled task wait is earlier than native binding release; an admitted runtime release and native createSession deletion wait join the original binding', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'cancel-release');
  let deleted = false; void env.childDeleted.promise.then(() => { deleted = true; });
  await env.manager.cancel(env.taskId); await env.reached.promise;
  const terminal = await env.manager.waitForNextTask([env.taskId], { timeoutMs: 5_000 });
  assert.equal(terminal.status, 'cancelled');
  assert.equal(deleted, false, 'terminal cancellation is visible while native deletion still holds the original binding');
  assert.equal(env.child.thread.getId(), null, 'the public native clear has already run before this held release returns');
  assert.equal(await env.runtime.controller.getSessionByResource(env.target.resourceId), env.child);

  let releaseJoined = false, recreated = false;
  const joining = env.runtime.releaseSession({ resourceId: env.target.resourceId }).then(() => { releaseJoined = true; });
  const creating = env.runtime.createSession(env.target).then(session => { recreated = true; return session; });
  await env.manager.getTask(env.taskId);
  assert.equal(releaseJoined, false, 'runtime duplicate release joins the already admitted original release');
  assert.equal(recreated, false, 'native createSession waits for the existing deletion instead of returning the retiring alias');
  env.resume.release(); await joining;
  const reopened = await creating; await env.childDeleted.promise;
  assert.notEqual(reopened, env.child); assert.equal(reopened.thread.getId(), env.target.threadId);
  assert.equal(await env.runtime.controller.getSessionByResource(env.target.resourceId), reopened);
  env.initial.release();
  await reopened.sendMessage({ content: 'SAFE_DIRECT_AFTER_CANCELLED_RELEASE' }); await env.joinProducers();
  assert.ok(JSON.stringify(await reopened.thread.listActiveMessages()).includes('DIRECT_RESULT:SAFE_DIRECT_AFTER_CANCELLED_RELEASE'));
  assert.equal(await env.runtime.controller.getSessionByResource(env.target.resourceId), reopened, 'the old finalizer does not release the replacement once its admitted release is joined');
});

test('cancellation before release admission discards active-only user input, but terminal status plus early release/reopen still lets the old finalizer abort the replacement', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'history');
  env.initial.release(); await env.childEnded.promise; await env.reached.promise;
  const release = env.runtime.releaseSession.bind(env.runtime);
  let releases = 0;
  t.mock.method(env.runtime, 'releaseSession', (...args: Parameters<typeof release>) => {
    if (args[0].resourceId === env.target.resourceId) releases++;
    return release(...args);
  });
  await env.manager.cancel(env.taskId);
  const terminal = await env.manager.waitForNextTask([env.taskId], { timeoutMs: 5_000 });
  assert.equal(terminal.status, 'cancelled'); assert.equal(terminal.result, undefined);
  assert.equal(releases, 0, 'the adopted completion is still awaiting its history return, before release admission');
  assert.equal(env.child.thread.getId(), env.target.threadId);
  assert.equal(env.child.displayState.get().isRunning, false);

  const discardedInputRequests = () => env.fixture.requests.filter(request => request.stream && lastUserText(request).includes('ACTIVE_ONLY_CANCELLED_HANDOFF')).length;
  assert.equal(discardedInputRequests(), 0);
  let starts = 0;
  const off = env.child.subscribe(event => { if (event.type === 'agent_start') starts++; }); t.after(off);
  const signal = env.child.sendSignal({ type: 'user', contents: 'ACTIVE_ONLY_CANCELLED_HANDOFF',
    metadata: { clientId: 'handoff-discarded-client' } },
  { ifActive: { behavior: 'deliver' }, ifIdle: { behavior: 'discard' }, requireDelivery: true });
  const acceptance = await signal.accepted;
  assert.equal(acceptance.action, 'discard', 'public native disposition avoids waking the idle owned binding');
  assert.equal(acceptance.runId, undefined); assert.equal(starts, 0);
  assert.equal(env.child.machinery.getAgent().getActiveThreadRunId(env.target), undefined);
  assert.equal(discardedInputRequests(), 0, 'parent cancellation wakes do not substitute for model work on the discarded child input');
  assert.equal((await env.runtime.controller.queryThreadMessages({ ...env.target, perPage: false })).messages.some(message => message.id === signal.id), false, 'known discard is not a persisted input acknowledgment');
  assert.equal(await env.runtime.createSession(env.target), env.child, 'terminal cancellation alone still returns the unreleased original alias');
  assert.equal(releases, 0);

  // A caller may try to force cleanup after the terminal wait. It has not joined
  // a future finalizer admission, so reopening now still needs identity protection.
  await env.runtime.releaseSession({ resourceId: env.target.resourceId });
  const replacement = await env.runtime.createSession(env.target);
  assert.notEqual(replacement, env.child);
  const deleted = gate();
  const offDeleted = env.runtime.controller.onSessionDeleted(session => { if (session === replacement) deleted.release(); });
  t.after(offDeleted);
  const newRun = replacement.sendMessage({ content: 'NAIVE_DIRECT_AFTER_CANCELLED_EARLY_RELEASE' }); void newRun.catch(() => {});
  await env.naive.reached;
  assert.equal(replacement.displayState.get().isRunning, true);
  const abortWatch = new AbortController(); t.after(() => abortWatch.abort());
  const abortGeneration = replacement.run.getAbortGeneration();
  const aborted = replacement.run.waitForAbortRequest(abortWatch.signal, { after: abortGeneration });
  env.resume.release(); await aborted; await deleted.promise;
  assert.equal(releases, 2, 'the delayed adopted finalizer releases the resource again after the caller already reopened it');
  assert.ok(replacement.run.getAbortGeneration() > abortGeneration);
  assert.equal(replacement.thread.getId(), null);
  assert.equal(await env.runtime.controller.getSessionByResource(env.target.resourceId), undefined);
  env.naive.release(); await Promise.allSettled([newRun]); await env.joinProducers();
  assert.equal((await env.manager.getTask(env.taskId))?.status, 'cancelled');
  assert.equal((await env.runtime.controller.queryThreadMessages({ ...env.target, perPage: false })).messages.some(message => message.id === signal.id), false, 'the discarded signal stays absent after all fixture producers settle');
});
