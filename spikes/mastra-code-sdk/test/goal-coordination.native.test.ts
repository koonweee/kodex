import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime } from '../src/runtime.js';
import { startModelFixture } from './fixtures/model-server.js';

function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
let root: string, profile: SpikeProfile, fixture: Awaited<ReturnType<typeof startModelFixture>>;
let mainGate: { reached: ReturnType<typeof latch>; release: ReturnType<typeof latch> } | undefined;
let judge: { reached: ReturnType<typeof latch>; release: ReturnType<typeof latch>; decision: 'done' | 'continue'; calls: number };
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-goal-coordination-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(async request => {
    if (request.model !== 'judge') { const gate = mainGate; if (gate) { gate.reached.resolve(); await gate.release.promise; } return { text: 'Fixture work finished' }; }
    const call = ++judge.calls;
    if (call === 1) { judge.reached.resolve(); await judge.release.promise; }
    return { text: JSON.stringify({ decision: call === 1 ? judge.decision : 'done', reason: 'Fixture judge result' }) };
  });
  await writeFile(profile.settingsPath, JSON.stringify({ models: { observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: 'fixture/judge', goalMaxTurns: Number.MAX_SAFE_INTEGER },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'local-fixture', models: ['chat', 'judge'] }], preferences: { yolo: true }, lsp: false, observability: { enabled: false } }));
});
after(async () => { judge?.release.resolve(); await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });

// Experiment only: public processor/terminal and iteration DI hooks; no storage mocks,
// no sleeps, no SDK patches, and no duplicated evaluator. Pending UI state is
// represented by the unapplied command; source-of-truth readback remains native.
for (const boundary of ['processor-terminal', 'iteration'] as const) for (const decision of ['done', 'continue'] as const) for (const operation of ['pause', 'clear', 'replace'] as const) {
  test(`defer ${operation} through ${boundary} hooks after a ${decision} judge`, { timeout: 30_000 }, async t => {
    const projectPath = join(root, `${boundary}-${decision}-${operation}`); await mkdir(projectPath);
    judge = { reached: latch(), release: latch(), decision, calls: 0 };
    let pending: (() => Promise<void>) | undefined;
    let applied = 0;
    const carriedAfterApply: unknown[] = [];
    const flush = async () => { const command = pending; pending = undefined; if (command) { await command(); applied++; } };
    const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(projectPath, 'runtime'), disableMcp: true, subagents: [],
      modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
      inputProcessors: [{ id: 'goal-pending-experiment', async processInputStep(args) { if (boundary === 'processor-terminal') await flush(); if (applied) carriedAfterApply.push(args.requestContext?.get('mastra:goal')); } }] });
    let run: Promise<unknown> | undefined;
    t.after(async () => { judge.release.resolve(); await run?.catch(() => {}); await runtime.dispose(); });
    const session = await runtime.createSession({ threadId: `thread-${decision}-${operation}`, resourceId: `resource-${decision}-${operation}` });
    const threadId = session.thread.requireId(), resourceId = session.identity.getResourceId();
    await session.thread.rename({ title: 'Pinned fixture' });
    const agent = runtime.controller.getCurrentAgent(session);
    const original = await agent.setObjective('ORIGINAL_GOAL', { threadId, resourceId, maxRuns: Number.MAX_SAFE_INTEGER });
    if (boundary === 'processor-terminal') {
      const off = session.onBeforeAgentEnd(flush); t.after(off);
    } else {
      const originalMachinery = session.machinery;
      const decorate = (options: Record<string, unknown>) => {
        assert.equal(options.onIterationComplete, undefined, 'fixture has no previous callback to compose');
        return { ...options, onIterationComplete: async () => {
          if (!pending) return;
          await flush();
          return { continue: false };
        } };
      };
      session.setMachinery({ ...originalMachinery,
        buildStreamOptions: async input => decorate(await originalMachinery.buildStreamOptions(input)),
        buildSharedRunOptions: () => decorate(originalMachinery.buildSharedRunOptions()),
      });
    }
    const requestStart = fixture.requests.length;
    run = session.sendMessage({ content: 'Work on the goal' });
    await judge.reached.promise;
    let replacementId: string | undefined;
    pending = async () => {
      if (operation === 'pause') await agent.updateObjectiveOptions({ threadId, status: 'paused' });
      else if (operation === 'clear') await agent.clearObjective({ threadId });
      else replacementId = (await agent.setObjective('REPLACEMENT_GOAL', { threadId, resourceId, maxRuns: Number.MAX_SAFE_INTEGER }))?.id;
    };
    assert.equal((await agent.getObjective({ threadId }))?.id, original?.id, 'pending command has not mutated the in-flight evaluation record');
    judge.release.resolve(); await run;
    const saved = await agent.getObjective({ threadId });
    assert.equal(applied, 1); assert.equal(pending, undefined);
    if (operation === 'pause') assert.equal(saved?.status, 'paused');
    else if (operation === 'clear') assert.equal(saved, undefined);
    else { assert.equal(saved?.id, replacementId); assert.equal(saved?.objective, 'REPLACEMENT_GOAL'); }
    const mainCalls = fixture.requests.slice(requestStart).filter(request => request.model === 'chat').length;
    if (boundary === 'iteration') {
      assert.equal(mainCalls, 1, 'no further model step under the old goal');
      assert.equal(judge.calls, 1);
      if (operation === 'replace') { assert.equal(saved?.status, 'active'); assert.equal(saved?.runsUsed, 0); }
      if (operation === 'pause') { assert.equal(saved?.id, original?.id); assert.equal(saved?.runsUsed, 1); }
    }
    if (boundary === 'processor-terminal' && decision === 'continue') {
      assert.equal(mainCalls, 2, 'processor fallback permits an extra model step');
      assert.deepEqual(carriedAfterApply.map(value => { const goal = value as { objective: string; status: string }; return { objective: goal.objective, status: goal.status }; }), [{ objective: 'ORIGINAL_GOAL', status: 'active' }]);
    }
    t.diagnostic(JSON.stringify({ boundary, decision, operation, mainCalls, judgeCalls: judge.calls, applied,
      saved: saved ? { objective: saved.objective, status: saved.status, runsUsed: saved.runsUsed } : null,
      carriedAfterApply: carriedAfterApply.map(value => value && typeof value === 'object' ? { objective: 'objective' in value ? value.objective : null, status: 'status' in value ? value.status : null } : null) }));
  });
}

// Native successful/aborted terminal paths, without slowing or replacing storage.
// The terminal callback is a fallback experiment, not a persistence-drain claim.
for (const stage of ['main-abort', 'judge-abort', 'after-completion'] as const) for (const operation of ['pause', 'clear', 'replace'] as const) {
  test(`${operation} coordination at ${stage}${stage === 'judge-abort' ? ' is superseded by abandoned native judge' : ''}`, { timeout: 30_000 }, async t => {
    const projectPath = join(root, `${stage}-${operation}`); await mkdir(projectPath);
    judge = { reached: latch(), release: latch(), decision: 'done', calls: 0 };
    const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(projectPath, 'runtime'), disableMcp: true, subagents: [],
      modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
    const session = await runtime.createSession({ threadId: `thread-${stage}-${operation}`, resourceId: `resource-${stage}-${operation}` });
    const threadId = session.thread.requireId(), resourceId = session.identity.getResourceId();
    await session.thread.rename({ title: 'Terminal fixture' });
    const agent = session.machinery.getAgent();
    let pending = false, applied = 0, iterationHooks = 0, terminalHooks = 0;
    let terminal = latch();
    const nativeOutputs: Promise<unknown>[] = [];
    // Test-only observation: wait for the producer's real finally block, without
    // delaying any native work. This internal hook is NOT a production seam.
    const finishedRuns = new Set<string>();
    const observedProducers = new Set<string>();
    const completionWaiters = new Map<string, ReturnType<typeof latch>>();
    const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
    t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
      unregister(id, runId);
      if (id === 'agentic-loop') { finishedRuns.add(runId); completionWaiters.get(runId)?.resolve(); }
    });
    const producerFinished = (runId: string) => {
      if (finishedRuns.has(runId)) return Promise.resolve();
      const waiting = completionWaiters.get(runId) ?? latch(); completionWaiters.set(runId, waiting); return waiting.promise;
    };
    const nativeSend = agent.sendSignal.bind(agent);
    t.mock.method(agent, 'sendSignal', (...args: Parameters<typeof agent.sendSignal>) => {
      const sent = nativeSend(...args);
      const output = sent.accepted.then(result => result.action === 'wake' ? result.output.getFullOutput() : undefined);
      void output.catch(() => {}); nativeOutputs.push(output);
      return sent;
    });
    let replacementId: string | undefined;
    const apply = async () => {
      if (!pending) return false;
      pending = false;
      if (operation === 'pause') await agent.updateObjectiveOptions({ threadId, status: 'paused' });
      else if (operation === 'clear') await agent.clearObjective({ threadId });
      else replacementId = (await agent.setObjective('REPLACEMENT_GOAL', { threadId, resourceId, maxRuns: Number.MAX_SAFE_INTEGER }))?.id;
      applied++;
      return true;
    };
    const originalMachinery = session.machinery;
    const decorate = (options: Record<string, unknown>) => ({ ...options, onIterationComplete: async () => {
      iterationHooks++;
      if (await apply()) return { continue: false };
    } });
    session.setMachinery({ ...originalMachinery,
      buildStreamOptions: async input => decorate(await originalMachinery.buildStreamOptions(input)),
      buildSharedRunOptions: () => decorate(originalMachinery.buildSharedRunOptions()),
    });
    const off = session.onBeforeAgentEnd(async () => { terminalHooks++; await apply(); terminal.resolve(); });
    mainGate = stage === 'main-abort' ? { reached: latch(), release: latch() } : undefined;
    const mainHold = mainGate;
    let run: Promise<unknown> | undefined;
    t.after(async () => { mainHold?.release.resolve(); judge.release.resolve(); await run?.catch(() => {}); await Promise.allSettled(nativeOutputs); await Promise.all([...observedProducers].map(producerFinished)); off(); await runtime.dispose(); mainGate = undefined; });
    const attempts = stage === 'after-completion' ? 30 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      terminal = latch();
      judge = { reached: latch(), release: latch(), decision: 'done', calls: 0 };
      const original = await agent.setObjective('ORIGINAL_GOAL', { threadId, resourceId, maxRuns: Number.MAX_SAFE_INTEGER });
      run = session.sendMessage({ content: stage === 'main-abort' ? 'TERMINAL_MAIN_HOLD' : 'Complete terminal fixture' });
      void run.catch(() => {});
      let nativeRunId: string | undefined;
      if (stage === 'main-abort') {
        await mainHold!.reached.promise; nativeRunId = agent.getActiveThreadRunId({ threadId, resourceId }); if (nativeRunId) observedProducers.add(nativeRunId); pending = true; session.abort(); mainHold!.release.resolve(); judge.release.resolve();
      } else {
        await judge.reached.promise;
        nativeRunId = agent.getActiveThreadRunId({ threadId, resourceId });
        if (nativeRunId) observedProducers.add(nativeRunId);
        if (stage === 'judge-abort') { pending = true; session.abort(); }
        judge.release.resolve();
      }
      await run;
      await terminal.promise;
      if (stage === 'after-completion') { pending = true; await apply(); }
      assert.ok(nativeRunId);
      await producerFinished(nativeRunId);
      const saved = await agent.getObjective({ threadId });
      if (stage === 'judge-abort') {
        assert.equal(saved?.id, original?.id, 'abandoned judge restores the original native goal');
        assert.equal(saved?.objective, 'ORIGINAL_GOAL'); assert.equal(saved?.status, 'done'); assert.equal(saved?.runsUsed, 1);
      } else if (operation === 'pause') { assert.equal(saved?.id, original?.id); assert.equal(saved?.status, 'paused'); }
      else if (operation === 'clear') assert.equal(saved, undefined);
      else { assert.equal(saved?.id, replacementId); assert.notEqual(saved?.id, original?.id); assert.equal(saved?.status, 'active'); }
      assert.equal(pending, false);
    }
    assert.equal(applied, attempts);
    t.diagnostic(JSON.stringify({ stage, operation, attempts, applied, iterationHooks, terminalHooks }));
  });
}
