import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { createTool } from '@mastra/core/tools';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let root: string;
let profile: SpikeProfile;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-runtime-child-retirement-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function observeProducers(t: TestContext, runtime: ProjectRuntime) {
  const producers = new Map<string, ReturnType<typeof gate>>();
  const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
  const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
  // Fixture-only join: production uses no private preparation or producer drain.
  t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
    const result = register(...args);
    if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], gate());
    return result;
  });
  t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
    unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.resolve();
  });
  return async () => {
    let joined = -1;
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(done => done.promise)); }
  };
}
async function memoryOf(session: NativeSession) {
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function');
  return memory;
}

for (const action of ['cancel', 'complete'] as const) {
  test(`runtime quiesces both parents before ${action === 'cancel' ? 'native cancellation and first memory settlement' : 'adopted completion at the native shutdown boundary'}`, { timeout: 40_000 }, async t => {
    const projectPath = join(root, action); await mkdir(projectPath);
    await writeFile(join(projectPath, 'evidence.txt'), 'RETIRE_CHILD_EVIDENCE');
    const parentContinued = new Map(['A', 'B'].map(slot => [slot, gate()]));
    const children = new Map<string, NativeSession>();
    const operations = new Map<string, Promise<unknown>>();
    const tasks = new Map<string, string>();
    const cancellationBindings: Array<{ slot: string; threadId: string | null; stopped: string[] }> = [];
    const releaseCompletion = gate(), completionReady = gate(), releaseOtherCompletion = gate();
    let stoppedThreads = new Set<string>();
    const fixture = await startModelFixture(request => {
      const task = lastUserText(request);
      const slot = task.includes('_B') ? 'B' : 'A';
      if (task.includes('CHILD_RETIRE_')) return JSON.stringify(request.messages).includes('RETIRE_CHILD_EVIDENCE')
        ? { text: `CHILD_RESULT_${slot}` }
        : { toolCalls: [{ name: 'view', arguments: { path: 'evidence.txt' }, id: `child-view-${slot}` }] };
      if (request.messages.some(message => message.role === 'tool')) {
        parentContinued.get(slot)!.resolve(); return { text: `PARENT_CONTINUED_${slot}` };
      }
      return { toolCalls: [{ name: 'retire_child', arguments: { slot }, id: `parent-child-${slot}` }] };
    });
    const held = new Map(['A', 'B'].map(slot => [slot, fixture.holdNext(`CHILD_RETIRE_${slot}`)]));
    await writeFile(profile.settingsPath, JSON.stringify({
      models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: null, reflectorModelOverride: null },
      customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
      backgroundTools: { enabled: true }, lsp: false, observability: { enabled: false },
    }));
    let runtime!: ProjectRuntime;
    const delegate = createTool({ id: 'retire_child', description: 'Launch a native adopted child for bounded runtime retirement testing.',
      inputSchema: { type: 'object', properties: { slot: { type: 'string' } }, required: ['slot'], additionalProperties: false },
      background: { enabled: true, defaultDisposition: 'deferred', timeoutMs: 20_000, maxRetries: 0 },
      execute: async (input, context) => {
        const slot = (input as { slot: string }).slot;
        assert.ok(context.background); tasks.set(slot, context.background.taskId);
        const child = await runtime.createSession({ resourceId: `child-${slot}`, threadId: `child-${slot}` });
        children.set(slot, child); await child.thread.rename({ title: `Child ${slot}`, pin: true });
        const operation = child.sendMessage({ content: `CHILD_RETIRE_${slot}: inspect evidence.txt.` }).then(async () => {
          if (action === 'complete' && slot === 'A') await releaseOtherCompletion.promise;
          if (action === 'complete' && slot === 'B') { completionReady.resolve(); await releaseCompletion.promise; }
          return child.thread.listActiveMessages();
        });
        operations.set(slot, operation);
        context.background.adopt({ completion: operation, cancel: () => {
          cancellationBindings.push({ slot, threadId: child.thread.getId(), stopped: [...stoppedThreads] }); child.abort(); if (slot === 'A') releaseOtherCompletion.resolve();
        } });
        return { launched: true };
      } });
    runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, `${action}-runtime`),
      subagents: [], modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], extraTools: { retire_child: delegate } });
    const joinProducers = observeProducers(t, runtime);
    const parents = await Promise.all(['A', 'B'].map(async slot => {
      const parent = await runtime.createSession({ resourceId: `parent-${slot}`, threadId: `parent-${slot}` });
      await parent.thread.rename({ title: `Parent ${slot}`, pin: true });
      return parent;
    }));

    const settleReached = gate(), releaseSettle = gate();
    const shutdownReached = gate(), releaseShutdown = gate();
    let disposal: Promise<void> | undefined;
    let retiring = false;
    const nativeAgent = parents[0]!.machinery.getAgent();
    const originalStream = nativeAgent.stream;
    const streamPreparations: Array<{ input: unknown; target: unknown; retiring: boolean; promise: Promise<unknown> }> = [];
    t.mock.method(nativeAgent, 'stream', (...args: unknown[]) => {
      const options = args[1] as { memory?: unknown } | undefined;
      const result = Reflect.apply(originalStream, nativeAgent, args) as ReturnType<typeof originalStream>;
      streamPreparations.push({ input: args[0], target: options?.memory, retiring, promise: result });
      return result;
    });
    t.after(async () => {
      releaseSettle.resolve(); releaseShutdown.resolve(); releaseCompletion.resolve(); releaseOtherCompletion.resolve(); for (const hold of held.values()) hold.release();
      for (const session of [...parents, ...children.values()]) {
        const threadId = session.thread.getId();
        if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
        session.abort();
      }
      await joinProducers(); await disposal?.catch(() => {}); await runtime.dispose();
      await Promise.allSettled(streamPreparations.map(preparation => preparation.promise)); await fixture.close();
    });
    const running = parents.map((parent, index) => parent.sendMessage({ content: `PARENT_RETIRE_${index === 0 ? 'A' : 'B'}: launch child and continue.` }));
    await Promise.all([...held.values()].map(hold => hold.reached));
    await Promise.all([...parentContinued.values()].map(done => done.promise)); await Promise.all(running);
    const manager = runtime.mastra.backgroundTaskManager; assert.ok(manager);
    assert.equal((await manager.getTask(tasks.get('B')!))?.status, 'running');
    // Native quiescence changes the effective request context. Gate the actual
    // public memory selected by retirement, rather than an earlier model's memory.
    const getMemory = nativeAgent.getMemory.bind(nativeAgent);
    const gatedMemories = new Set<object>();
    let first = true;
    t.mock.method(nativeAgent, 'getMemory', async (...args: Parameters<typeof getMemory>) => {
      const memory = await getMemory(...args);
      if (retiring && memory && 'settled' in memory && typeof memory.settled === 'function' && !gatedMemories.has(memory)) {
        gatedMemories.add(memory);
        const settled = memory.settled.bind(memory);
        t.mock.method(memory, 'settled', async () => {
          if (first) { first = false; settleReached.resolve(); await releaseSettle.promise; }
          return settled();
        });
      }
      return memory;
    });
    const abort = nativeAgent.abortThreadStream.bind(nativeAgent);
    t.mock.method(nativeAgent, 'abortThreadStream', (...args: Parameters<typeof abort>) => {
      stoppedThreads.add(args[0].threadId); return abort(...args);
    });
    if (action === 'complete') {
      const shutdown = manager.shutdown.bind(manager);
      t.mock.method(manager, 'shutdown', async (...args: Parameters<typeof shutdown>) => {
        shutdownReached.resolve(); await releaseShutdown.promise; return shutdown(...args);
      });
    }
    retiring = true; disposal = runtime.dispose();
    if (action === 'complete') {
      await shutdownReached.promise;
      // Finish the real adopted operation after retirement has stopped wrappers,
      // before native manager cancellation takes ownership of remaining tasks.
      const completed = manager.waitForNextTask([tasks.get('B')!], { timeoutMs: 10_000 });
      held.get('B')!.release(); await completionReady.promise; releaseCompletion.resolve();
      await operations.get('B');
      assert.equal((await completed).status, 'completed'); await runtime.mastra.pubsub.flush();
      releaseShutdown.resolve();
    }
    await settleReached.promise;
    await operations.get('B'); await runtime.mastra.pubsub.flush();
    const lateContinuations = streamPreparations.filter(preparation => preparation.retiring && Array.isArray(preparation.input) && preparation.input.length === 0);
    assert.deepEqual(lateContinuations.map(preparation => preparation.target), [], 'no parent starts native preparation from child cancellation/completion during retirement');

    for (const id of ['parent-A', 'parent-B', 'child-A', 'child-B']) assert.ok(stoppedThreads.has(id), `all-session quiescence includes ${id} before settlement`);
    assert.deepEqual(cancellationBindings.map(binding => binding.slot).sort(), action === 'cancel' ? ['A', 'B'] : ['A'], 'native shutdown cancels each remaining adopted child exactly once');
    for (const binding of cancellationBindings) {
      assert.equal(binding.threadId, `child-${binding.slot}`, 'native cancellation retains child binding until deletion');
      for (const id of ['parent-A', 'parent-B', 'child-A', 'child-B']) assert.ok(binding.stopped.includes(id), `all-session quiescence precedes cancellation: ${id}`);
    }
    releaseSettle.resolve(); await joinProducers(); await disposal;
    const outcomes = await Promise.allSettled(streamPreparations.map(preparation => preparation.promise));
    assert.equal(outcomes.some(outcome => outcome.status === 'rejected'), false, 'this controlled retirement starts no late native preparation against closed storage');
    for (const id of ['parent-A', 'parent-B', 'child-A', 'child-B']) assert.equal(await runtime.controller.getSessionByResource(id), undefined);
  });
}

for (const rejectNativeCreation of [false, true]) {
  test(`retirement joins ${rejectNativeCreation ? 'rejected' : 'successful'} in-flight native creation and cleans existing sessions`, { timeout: 30_000 }, async t => {
    const name = `creation-${rejectNativeCreation}`;
    const projectPath = join(root, name); await mkdir(projectPath);
    await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false } }));
    const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, `${name}-runtime`), subagents: [] });
    const existing = await runtime.createSession({ resourceId: 'existing-resource', threadId: 'existing-thread' });
    const memory = await memoryOf(existing);
    const reached = gate(), release = gate();
    let nativeCreating = false;
    const failure = new Error('Fixture native session creation failure');
    const store = await runtime.storage.getStore('memory'); assert.ok(store);
    const saveThread = store.saveThread.bind(store);
    t.mock.method(store, 'saveThread', async (input: Parameters<typeof saveThread>[0]) => {
      if (input.thread.id === 'pending-thread') {
        nativeCreating = true; reached.resolve(); await release.promise; nativeCreating = false;
        if (rejectNativeCreation) throw failure;
      }
      return saveThread(input);
    });
    const settledWhileCreating: boolean[] = [];
    const settle = memory.settled.bind(memory);
    t.mock.method(memory, 'settled', async () => { settledWhileCreating.push(nativeCreating); return settle(); });
    const deleted = t.mock.method(runtime.controller, 'deleteSession');
    const aborted = t.mock.method(existing.machinery.getAgent(), 'abortThreadStream');
    const creation = runtime.createSession({ resourceId: 'pending-resource', scope: 'pending-scope', threadId: 'pending-thread' });
    void creation.catch(() => {});
    let disposal: Promise<void> | undefined;
    t.after(async () => { release.resolve(); await creation.catch(() => {}); await disposal?.catch(() => {}); await runtime.dispose(); });
    await reached.promise; disposal = runtime.dispose();
    assert.ok(aborted.mock.calls.some(call => call.arguments[0].threadId === 'existing-thread'), 'existing sessions are quiesced synchronously before joining pending creation');
    await assert.rejects(runtime.createSession({ resourceId: 'new-resource' }), /disposed/);
    release.resolve();
    await assert.rejects(creation, rejectNativeCreation ? error => error === failure : /disposed/);
    await disposal;
    if (!rejectNativeCreation) assert.ok(aborted.mock.calls.some(call => call.arguments[0].threadId === 'pending-thread'), 'late-created sessions are also natively quiesced');
    assert.ok(settledWhileCreating.length > 0, 'existing native memory reaches its settlement boundary');
    assert.ok(settledWhileCreating.every(value => value === false), 'pending native creation is joined before memory settlement/deletion');
    assert.equal(await runtime.controller.getSessionByResource('existing-resource'), undefined);
    assert.equal(await runtime.controller.getSessionByResource('pending-resource', 'pending-scope'), undefined, 'late-created sessions cannot remain registered after retirement');
    const keys = deleted.mock.calls.map(call => JSON.stringify([call.arguments[0].resourceId, call.arguments[0].scope ?? null])).sort();
    assert.deepEqual(keys, [JSON.stringify(['existing-resource', null]), ...(!rejectNativeCreation ? [JSON.stringify(['pending-resource', 'pending-scope'])] : [])].sort());
  });
}

for (const rejectNativeRelease of [false, true]) {
  test(`retirement joins an admitted ${rejectNativeRelease ? 'failing' : 'successful'} native release and owns later releases`, { timeout: 30_000 }, async t => {
    const name = `release-${rejectNativeRelease}`;
    const projectPath = join(root, name); await mkdir(projectPath);
    await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false } }));
    const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, `${name}-runtime`), subagents: [] });
    const child = await runtime.createSession({ resourceId: 'releasing-child', threadId: 'releasing-child-thread' });
    const remaining = await runtime.createSession({ resourceId: 'remaining-parent', threadId: 'remaining-parent-thread' });
    const reached = gate(), release = gate();
    const failure = new Error('Fixture native lock-release failure');
    let releasing = false;
    const clear = child.thread.clearAndReleaseLock.bind(child.thread);
    t.mock.method(child.thread, 'clearAndReleaseLock', async () => {
      releasing = true; reached.resolve(); await release.promise;
      try { await clear(); if (rejectNativeRelease) throw failure; }
      finally { releasing = false; }
    });
    const memory = await memoryOf(remaining), settled = memory.settled.bind(memory);
    const settledDuringRelease: boolean[] = [];
    t.mock.method(memory, 'settled', async () => { settledDuringRelease.push(releasing); return settled(); });
    const closedDuringRelease: boolean[] = [];
    const close = runtime.storageMaintenance.closeStorage; assert.ok(close);
    t.mock.method(runtime.storageMaintenance as { closeStorage: typeof close }, 'closeStorage', async () => { closedDuringRelease.push(releasing); await close(); });
    const deleted = t.mock.method(runtime.controller, 'deleteSession');
    const admitted = runtime.releaseSession({ resourceId: 'releasing-child' }); void admitted.catch(() => {});
    let disposal: Promise<void> | undefined;
    t.after(async () => { release.resolve(); await admitted.catch(() => {}); await disposal?.catch(() => {}); await runtime.dispose(); });
    await reached.promise;
    assert.equal(await runtime.controller.deleteSession({ resourceId: 'releasing-child' }), false, 'native duplicate deletion does not join the first native lock release');
    const callsBeforeDispose = deleted.mock.callCount();
    disposal = runtime.dispose();
    await runtime.releaseSession({ resourceId: 'releasing-child' });
    const callsAfterLateRelease = deleted.mock.callCount();
    // A single test-only event-loop checkpoint lets cached native retirement
    // reads run; this is neither a product preparation drain nor a polling loop.
    await new Promise<void>(resolve => setImmediate(resolve));
    const closedBeforeRelease = closedDuringRelease.length;
    release.resolve();
    if (rejectNativeRelease) await assert.rejects(admitted, error => error === failure);
    else await admitted;
    await disposal;
    assert.equal(callsAfterLateRelease, callsBeforeDispose, 'retirement owns bindings and starts no new native release');
    assert.equal(closedBeforeRelease, 0, 'storage remains open while an admitted native release is held');
    assert.ok(settledDuringRelease.length > 0, 'remaining native session reaches memory settlement');
    assert.ok(settledDuringRelease.every(value => value === false), 'native retirement settlement follows admitted release completion');
    assert.deepEqual(closedDuringRelease, [false], 'storage closes exactly once after native release settles');
    for (const resourceId of ['releasing-child', 'remaining-parent']) assert.equal(await runtime.controller.getSessionByResource(resourceId), undefined);
  });
}
