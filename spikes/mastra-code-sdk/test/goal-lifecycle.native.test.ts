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
let judgeGate: { reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-native-goal-lifecycle-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(async request => {
    if (request.model !== 'judge') return { text: 'Native fixture task result' };
    const gate = judgeGate;
    assert.ok(gate, 'every judge request belongs to the controlled native run');
    gate.reached.resolve();
    await gate.release.promise;
    return { text: JSON.stringify({ decision: 'done', reason: 'The fixture objective is complete.' }) };
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

// Characterization of the pinned public SDK, not a coordination guarantee.
// Only the remote judge's response is delayed. Native storage, execution,
// objective APIs and event delivery run normally, with every mutation awaited.
for (const operation of ['pause', 'clear', 'replace'] as const) {
  test(`native ${operation} during a pending judge is persisted, then superseded by that judge's result`, { timeout: 40_000 }, async t => {
    const projectPath = join(root, operation);
    await mkdir(projectPath);
    const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, `${operation}-runtime`),
      disableMcp: true, subagents: [], modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
    const gate = { reached: deferred(), release: deferred() };
    judgeGate = gate;
    let running: Promise<unknown> | undefined;
    t.after(async () => {
      gate.release.resolve();
      await running?.catch(() => {});
      await runtime.dispose();
      if (judgeGate === gate) judgeGate = undefined;
    });
    const threadId = `goal-${operation}-thread`;
    const resourceId = `goal-${operation}-resource`;
    const session = await runtime.createSession({ threadId, resourceId });
    await session.thread.rename({ title: `Goal ${operation} fixture` });
    const agent = runtime.controller.getCurrentAgent(session);
    const original = await agent.setObjective(`Original ${operation} objective`, { threadId, resourceId, maxRuns: Number.MAX_SAFE_INTEGER });
    assert.ok(original?.id);
    assert.equal(session.displayState.get().isRunning, false, 'setting the objective alone does not start execution');
    const evaluations: Extract<AgentControllerEvent, { type: 'goal_evaluation' }>[] = [];
    let pendingEvaluations = 0;
    const unsubscribe = session.subscribe(event => {
      if (event.type !== 'goal_evaluation') return;
      if (event.payload.pending) pendingEvaluations++;
      else evaluations.push(event);
    });
    t.after(unsubscribe);
    running = session.sendMessage({ content: `Pursue the ${operation} fixture objective` });
    await gate.reached.promise;
    assert.equal(session.displayState.get().isRunning, true);
    assert.ok(fixture.requests.some(request => request.model === 'judge'), 'a real native judge call reached the provider');
    assert.ok(pendingEvaluations > 0, 'the native pre-evaluation event precedes the held provider response');
    assert.equal(evaluations.length, 0, 'the judge is still pending');

    if (operation === 'pause') {
      const paused = await agent.updateObjectiveOptions({ threadId, status: 'paused' });
      assert.equal(paused?.id, original.id);
      assert.equal((await agent.getObjective({ threadId }))?.status, 'paused');
    } else if (operation === 'clear') {
      await agent.clearObjective({ threadId });
      assert.equal(await agent.getObjective({ threadId }), undefined, 'clear really deleted the native objective');
    } else {
      const replacement = await agent.setObjective('Replacement objective', { threadId, resourceId, maxRuns: Number.MAX_SAFE_INTEGER });
      assert.ok(replacement?.id);
      assert.notEqual(replacement.id, original.id);
      const saved = await agent.getObjective({ threadId });
      assert.equal(saved?.id, replacement.id);
      assert.equal(saved?.objective, 'Replacement objective');
      assert.equal(saved?.runsUsed, 0);
      assert.equal(saved?.status, 'active');
    }
    assert.equal(session.displayState.get().isRunning, true, 'the mutation does not interrupt the native run');
    assert.equal(evaluations.length, 0);
    gate.release.resolve();
    await running;
    const settled = await agent.getObjective({ threadId });
    assert.equal(evaluations.length, 1);
    assert.equal(evaluations[0]!.payload.status, 'done');
    assert.equal(settled?.id, original.id, 'the completed judge writes the original goal record');
    assert.equal(settled?.objective, original.objective);
    assert.equal(settled?.status, 'done');
    assert.equal(settled?.runsUsed, 1);
    assert.equal(settled?.maxRuns, Number.MAX_SAFE_INTEGER);
    assert.equal(session.displayState.get().isRunning, false);
  });
}
