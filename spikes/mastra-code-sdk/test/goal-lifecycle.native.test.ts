import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
