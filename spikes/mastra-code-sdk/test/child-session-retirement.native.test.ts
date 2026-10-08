import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTool } from '@mastra/core/tools';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Investigation only: compare public native manager shutdown ordering without
// changing runtime disposal or SDK behavior. Public Agent.stream spies identify
// preparation calls that outlive the registered agentic-loop producers.
test('characterize native cancelled-child retirement ordering', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-child-retirement-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const trace: unknown[] = [];
  const tracePath = join(root, 'retirement-trace.json');
  const continuations = new Map<string, ReturnType<typeof gate>>();
  const fixture = await startModelFixture(request => {
    const last = lastUserText(request);
    const mode = ['manager-first', 'parent-stop-first', 'current'].find(mode => last.includes(mode))!;
    if (last.includes('CHILD_RETIRE')) return { toolCalls: [{ name: 'view', arguments: { path: 'evidence.txt' }, id: `child-view-${mode}` }] };
    if (request.messages.some(message => message.role === 'tool')) {
      continuations.get(mode)!.resolve();
      return { text: `PARENT_RUNNING_${mode}` };
    }
    return { toolCalls: [{ name: 'retire_child', arguments: {}, id: `parent-child-${mode}` }] };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    backgroundTools: { enabled: true }, lsp: false, observability: { enabled: false },
  }));
  t.diagnostic(`Retirement probe trace: ${tracePath}`);
  t.after(async () => {
    await fixture.close();
    await writeFile(tracePath, JSON.stringify(trace, null, 2));
    for (const mode of ['current', 'manager-first', 'parent-stop-first']) await rm(join(root, mode), { recursive: true, force: true });
    await rm(join(root, 'profile'), { recursive: true, force: true });
  });
  for (const mode of ['current', 'manager-first', 'parent-stop-first'] as const) await t.test(mode, { timeout: 20_000 }, async sub => {
    const parentTarget = { resourceId: `retire-parent-${mode}`, threadId: `retire-parent-${mode}` };
    const childTarget = { resourceId: `retire-child-${mode}`, threadId: `retire-child-${mode}` };
    const parentContinued = gate(); continuations.set(mode, parentContinued);
    const childAborted = gate();
    const held = fixture.holdNext(`CHILD_RETIRE_${mode}`);
    const projectPath = join(root, mode, 'project');
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, 'evidence.txt'), 'RETIRE_EVIDENCE');
    let child: NativeSession | undefined;
    let operation: Promise<unknown> | undefined;
    let taskId: string | undefined;
    let cancelCalls = 0;
    let phase = 'running';
    const timeline: unknown[] = [];
    const producers = new Map<string, ReturnType<typeof gate>>();
    const delegate = createTool({
      id: 'retire_child', description: 'Launch a native child session for bounded retirement characterization.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      background: { enabled: true, defaultDisposition: 'deferred', timeoutMs: 15_000, maxRetries: 0 },
      execute: async (_input, context) => {
        assert.ok(context.background);
        taskId = context.background.taskId;
        child = await runtime.createSession(childTarget);
        await child.thread.rename({ title: `Retirement child ${mode}`, pin: true });
        child.subscribe(event => {
          if (['agent_start', 'agent_end', 'error'].includes(event.type)) timeline.push({ phase, session: 'child', event });
          if (event.type === 'agent_end' && event.reason === 'aborted') childAborted.resolve();
        });
        operation = child.sendMessage({ content: `CHILD_RETIRE_${mode}: inspect evidence.txt.` }).then(() => child!.thread.listActiveMessages());
        context.background.adopt({ completion: operation, cancel: () => { cancelCalls++; child!.abort(); } });
        return { launched: true };
      },
    });
    const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, mode, 'runtime'),
      modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [],
      extraTools: { retire_child: delegate } });
    const parent = await runtime.createSession(parentTarget);
    await parent.thread.rename({ title: `Retirement parent ${mode}`, pin: true });
    parent.subscribe(event => {
      if (['agent_start', 'agent_end', 'error'].includes(event.type)) timeline.push({ phase, session: 'parent', event });
    });
    const agent = runtime.controller.getCurrentAgent(parent);
    const streamFrames: unknown[] = [];
    const originalStream = agent.stream;
    const streamSpy = sub.mock.method(agent, 'stream', (...args: unknown[]) => {
      const options = args[1] as { memory?: unknown; untilIdle?: unknown; runId?: string; abortSignal?: AbortSignal } | undefined;
      streamFrames.push({ phase, messages: args[0], memory: options?.memory, untilIdle: options?.untilIdle, runId: options?.runId,
        abortAlreadyRequested: options?.abortSignal?.aborted, stack: new Error('Public native stream invocation').stack });
      return Reflect.apply(originalStream, agent, args) as ReturnType<typeof originalStream>;
    });
    const memory = await agent.getMemory({ requestContext: await parent.machinery.buildRequestContext() });
    assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function');
    const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
    sub.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
      const result = register(...args);
      if (args[0].id === 'agentic-loop' && args[1]) { producers.set(args[1], gate()); timeline.push({ phase, kind: 'register', runId: args[1] }); }
      return result;
    });
    const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
    sub.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
      unregister(id, runId);
      if (id === 'agentic-loop') { producers.get(runId)?.resolve(); timeline.push({ phase, kind: 'unregister', runId }); }
    });
    const joinLoops = async () => {
      let joined = -1;
      while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(producer => producer.promise)); }
    };
    let retired = false;
    sub.after(async () => {
      held.release();
      if (!retired) {
        for (const [session, target] of [[parent, parentTarget], [child, childTarget]] as const) if (session) {
          agent.abortThreadStream({ ...target, clearPendingSignals: true }); session.abort();
        }
        await joinLoops(); await runtime.dispose();
      }
    });
    const runningParent = parent.sendMessage({ content: `PARENT_RETIRE_${mode}: delegate then continue.` });
    await held.reached; await parentContinued.promise; await runningParent;
    assert.ok(taskId);
    const manager = runtime.mastra.backgroundTaskManager;
    assert.ok(manager);
    if (mode === 'parent-stop-first') {
      phase = 'stop-parent-before-cancel';
      assert.equal(agent.abortThreadStream({ ...parentTarget, clearPendingSignals: true }), true, 'stop the native idle parent wrapper before publishing cancellation');
      // abortThreadStream synchronously closes the untilIdle wrapper. It has
      // no promise/acknowledgement to await before publishing task cancellation.
    }
    phase = 'cancel'; await manager.cancel(taskId);
    await childAborted.promise; await operation; await joinLoops();
    assert.equal(cancelCalls, 1);
    assert.equal((await manager.getTask(taskId))?.status, 'cancelled');
    phase = 'before-retirement';
    for (const [session, target] of [[parent, parentTarget], [child!, childTarget]] as const) {
      agent.abortThreadStream({ ...target, clearPendingSignals: true }); session.abort();
    }
    await joinLoops(); await memory.settled();
    if (mode === 'manager-first') { phase = 'manager-shutdown'; await manager.shutdown(); }
    const streamsBeforeDispose = streamSpy.mock.callCount();
    phase = 'runtime-dispose'; await runtime.dispose(); retired = true;
    phase = 'closed';
    // Observe public preparation promise settlement after the boundary; never
    // use this probe-only observer to extend the application's shutdown contract.
    const streamOutcomes = await Promise.allSettled(streamSpy.mock.calls.map(call => call.result));
    const streams = streamSpy.mock.calls.map((call, index) => ({
      index, messages: call.arguments[0], frame: streamFrames[index],
      outcome: streamOutcomes[index]?.status, error: streamOutcomes[index]?.status === 'rejected' ? String(streamOutcomes[index].reason) : undefined,
    }));
    const failedStreams = streamOutcomes.flatMap((outcome, index) => outcome.status === 'rejected' ? [{ index, error: String(outcome.reason) }] : []);
    trace.push({ mode, taskId, cancelCalls, streamsBeforeDispose, streamsAfterDispose: streamSpy.mock.callCount(), streams, failedStreams, timeline });
    sub.diagnostic(JSON.stringify({ mode, streamsBeforeDispose, streamsAfterDispose: streamSpy.mock.callCount(), failedStreams }));
    if (mode === 'parent-stop-first') {
      assert.deepEqual(failedStreams, [], 'stopping the parent before cancellation prevents the late pre-loop stream');
      assert.equal(streams.length, 4, 'only the native outer/first-turn parent and child streams ran');
      assert.ok(!streamSpy.mock.calls.some(call => Array.isArray(call.arguments[0]) && call.arguments[0].length === 0), 'retirement never launches an empty parent continuation');
    } else {
      assert.equal(failedStreams.length, 1, 'cancel-first retirement reproduces one unresolved native parent preparation');
      const failed = streams[failedStreams[0]!.index]!;
      assert.deepEqual(failed.messages, [], 'the straggler is a native background-cancellation continuation');
      assert.ok(failed.error?.includes('CLIENT_CLOSED'));
      assert.ok(failed.error?.includes(parentTarget.threadId), 'the late read belongs to the parent, not the cancelled child');
      assert.equal(streams.length, 5, 'cancellation adds one native parent continuation before retirement');
    }
  });
});

