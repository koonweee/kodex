import assert from 'node:assert/strict';
import { createGoalReminderSignal } from '@mastra/code-sdk/goal-signal';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime } from '../src/runtime.js';
import { startModelFixture } from './fixtures/model-server.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let root: string;
let profile: SpikeProfile;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
let judgeGate: { reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; decision: 'done' | 'continue' } | undefined;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-native-goal-lifecycle-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(async request => {
    if (request.model !== 'judge') return { text: 'Native fixture task result' };
    const gate = judgeGate;
    assert.ok(gate, 'every judge request belongs to the controlled native run');
    gate.reached.resolve();
    await gate.release.promise;
    return { text: JSON.stringify({ decision: gate.decision, reason: 'Fixture judge result' }) };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { observerModelOverride: null, reflectorModelOverride: null,
      goalJudgeModel: 'fixture/judge', goalMaxTurns: Number.MAX_SAFE_INTEGER },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat', 'judge'] }],
    preferences: { yolo: true }, lsp: false, observability: { enabled: false },
  }));
});
after(async () => {
  judgeGate?.release.resolve();
  await fixture?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

// Public goal commands only; no host evaluation/iteration/terminal workaround.
// Hold the remote judge response, not native storage. Stop ends the consumer
// before the judge, so tests observe the parent's eventual native finally block
// to catch late overwrites that an immediate readback would miss. That internal
// observer is test-only and scoped to this non-durable, no-total-timeout fixture.
for (const stop of [false, true]) for (const decision of ['done', 'continue'] as const) for (const operation of ['pause', 'clear', 'replace'] as const) {
  const name = `${stop ? 'stopped' : 'running'}-${decision}-${operation}`;
  test(`native ${operation} survives ${decision} from a ${stop ? 'stopped' : 'running'} judge`, { timeout: 40_000 }, async t => {
    const projectPath = join(root, name);
    await mkdir(projectPath);
    const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, `${name}-runtime`),
      disableMcp: true, subagents: [], modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
    const gate = { reached: deferred(), release: deferred(), decision };
    judgeGate = gate;
    const terminal = deferred();
    const producer = deferred();
    let nativeRunId: string | undefined;
    let running: Promise<unknown> | undefined;
    const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
    t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
      unregister(id, runId);
      if (id === 'agentic-loop' && runId === nativeRunId) producer.resolve();
    });
    t.after(async () => {
      gate.release.resolve();
      await running?.catch(() => {});
      if (nativeRunId) await producer.promise;
      await runtime.dispose();
      if (judgeGate === gate) judgeGate = undefined;
    });
    const threadId = `goal-${name}-thread`;
    const resourceId = `goal-${name}-resource`;
    const session = await runtime.createSession({ threadId, resourceId });
    await session.thread.rename({ title: `Goal ${name} fixture` });
    const agent = runtime.controller.getCurrentAgent(session);
    const original = await agent.setObjective(`Original ${name} objective`, { threadId, resourceId, maxRuns: Number.MAX_SAFE_INTEGER });
    assert.ok(original?.id);
    assert.equal(session.displayState.get().isRunning, false, 'setting the objective alone does not start execution');
    const evaluations: Extract<AgentControllerEvent, { type: 'goal_evaluation' }>[] = [];
    let pendingEvaluations = 0;
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'agent_end') terminal.resolve();
      if (event.type !== 'goal_evaluation') return;
      if (event.payload.pending) pendingEvaluations++;
      else evaluations.push(event);
    });
    t.after(unsubscribe);
    const requestStart = fixture.requests.length;
    running = session.sendMessage({ content: `Pursue the ${name} fixture objective` });
    void running.catch(() => {});
    await gate.reached.promise;
    nativeRunId = agent.getActiveThreadRunId({ threadId, resourceId });
    assert.ok(nativeRunId);
    assert.equal(session.displayState.get().isRunning, true);
    assert.ok(pendingEvaluations > 0);
    assert.equal(evaluations.length, 0, 'the judge is still pending');
    if (stop) {
      session.abort();
      await running;
      await terminal.promise;
      assert.equal(session.displayState.get().isRunning, false, 'chat Stop remains immediate while the judge is held');
    }

    let expectedId = original.id;
    if (operation === 'pause') {
      await agent.updateObjectiveOptions({ threadId, status: 'paused' });
      assert.equal((await agent.getObjective({ threadId }))?.status, 'paused');
    } else if (operation === 'clear') {
      await agent.clearObjective({ threadId });
      assert.equal(await agent.getObjective({ threadId }), undefined);
    } else {
      const replacement = await agent.setObjective('Replacement objective', { threadId, resourceId, maxRuns: Number.MAX_SAFE_INTEGER });
      assert.ok(replacement?.id);
      assert.notEqual(replacement.id, original.id);
      expectedId = replacement.id;
      assert.equal((await agent.getObjective({ threadId }))?.id, expectedId);
    }
    assert.equal(evaluations.length, 0);
    gate.release.resolve();
    await running;
    await producer.promise;
    const saved = await agent.getObjective({ threadId });
    if (operation === 'clear') assert.equal(saved, undefined, 'late evaluation must not recreate a cleared goal');
    else {
      assert.equal(saved?.id, expectedId);
      assert.equal(saved?.objective, operation === 'replace' ? 'Replacement objective' : original.objective);
      assert.equal(saved?.status, operation === 'pause' ? 'paused' : 'active');
      assert.equal(saved?.runsUsed, 0, 'discarded evaluation does not consume the current goal counter');
      assert.equal(saved?.maxRuns, Number.MAX_SAFE_INTEGER);
    }
    assert.equal(evaluations.length, 0, 'the stale judge emits no final verdict');
    assert.equal(session.displayState.get().isRunning, false);
    const requests = fixture.requests.slice(requestStart);
    assert.equal(requests.filter(request => request.model === 'chat').length, 1, 'stale continue verdict cannot start more old-goal work');
    assert.equal(requests.filter(request => request.model === 'judge').length, 1);
    const history = await session.thread.listActiveMessages();
    assert.equal(history.some(message => JSON.stringify(message.content).includes('"goalEvaluation"')), false, 'stale goal feedback is not persisted into native history');
  });
}


for (const [replaceDuringJudge, configuredJudge] of [[false, true], [true, true], [false, false]] as const) {
  test(`native goal reminder ${!configuredJudge ? 'pauses when the mounted custom judge has no profile default' : replaceDuringJudge ? 'starts replacement after an old judge' : 'starts an idle goal'}`,  { timeout: 20_000 }, async t => {
    const name = `reminder-${replaceDuringJudge}-${configuredJudge}`;
    const originalSettings = await readFile(profile.settingsPath, 'utf8');
    if (!configuredJudge) {
      const settings = JSON.parse(originalSettings);
      settings.models.goalJudgeModel = null;
      await writeFile(profile.settingsPath, JSON.stringify(settings));
      t.after(() => writeFile(profile.settingsPath, originalSettings));
    }
    const projectPath = join(root, name);
    await mkdir(projectPath);
    const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, `${name}-runtime`),
      disableMcp: true, subagents: [], modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
    const gate = { reached: deferred(), release: deferred(), decision: 'done' as const };
    judgeGate = gate;
    const session = await runtime.createSession({ threadId: name, resourceId: name });
    await session.thread.rename({ title: name });
    const agent = runtime.controller.getCurrentAgent(session);
    const target = { threadId: name, resourceId: name, maxRuns: Number.MAX_SAFE_INTEGER, judgeModelId: 'fixture/judge' };
    let goal = await agent.setObjective('Initial native goal', target);
    assert.ok(goal);
    const completed = deferred();
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'goal_evaluation' && !event.payload.pending) completed.resolve();
    });
    const producers = new Set<Promise<void>>();
    const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
    // Track actual native producer completion for fixture teardown only.
    const finished = new Map<string, ReturnType<typeof deferred>>();
    const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
    t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
      const result = register(...args);
      if (args[0].id === 'agentic-loop' && args[1]) { const done = deferred(); finished.set(args[1], done); producers.add(done.promise); }
      return result;
    });
    t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
      unregister(id, runId);
      if (id === 'agentic-loop') finished.get(runId)?.resolve();
    });
    t.after(async () => {
      agent.abortThreadStream({ threadId: name, resourceId: name, clearPendingSignals: true });
      session.abort(); gate.release.resolve();
      let joined = -1;
      while (joined !== producers.size) { joined = producers.size; await Promise.all(producers); }
      unsubscribe(); await runtime.dispose(); judgeGate = undefined;
    });
    const remind = () => session.sendSignal(createGoalReminderSignal({
      id: goal!.id!, objective: goal!.objective, status: 'active', turnsUsed: 0,
      maxTurns: Number.MAX_SAFE_INTEGER, judgeModelId: 'fixture/judge', startedAt: new Date(goal!.startedAt).toISOString(),
    }), { requireDelivery: true }).accepted;
    const start = fixture.requests.length;
    await remind();
    if (!configuredJudge) {
      await completed.promise;
      await Promise.all(producers);
      const saved = await agent.getObjective({ threadId: name });
      assert.equal(saved?.status, 'paused', 'bare custom judge fallback does not inherit the SDK gateway');
      assert.ok(fixture.requests.slice(start).every(request => request.model !== 'judge'));
      return;
    }
    await gate.reached.promise;
    if (replaceDuringJudge) {
      const previousId = goal.id;
      goal = await agent.setObjective('Replacement native goal', target);
      assert.ok(goal); assert.notEqual(goal.id, previousId);
      await remind();
    }
    gate.release.resolve();
    await completed.promise;
    await Promise.all(producers);
    const saved = await agent.getObjective({ threadId: name });
    assert.equal(saved?.id, goal.id);
    assert.equal(saved?.status, 'done');
    assert.equal(saved?.runsUsed, 1);
    const requests = fixture.requests.slice(start);
    assert.equal(requests.filter(request => request.model === 'chat').length, replaceDuringJudge ? 2 : 1);
    const judges = requests.filter(request => request.model === 'judge');
    assert.equal(judges.length, replaceDuringJudge ? 2 : 1);
    if (replaceDuringJudge) {
      assert.ok(JSON.stringify(requests.filter(request => request.model === 'chat')[1]).includes('Replacement native goal'));
      assert.ok(JSON.stringify(judges[1]).includes('Replacement native goal'));
    }
  });
}
