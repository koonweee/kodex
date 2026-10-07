import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { ORPCError } from '@orpc/server';
import { createChatGoals, type GoalPatch } from '../src/chat-goals.js';
import { CHAT_FAST_SETTING } from '../src/chat-fast.js';
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
  root = await mkdtemp(join(tmpdir(), 'kodex-chat-goals-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(async request => {
    if (request.model !== 'judge' && !JSON.stringify(request.messages).includes('You are the goal judge')) return { text: 'Native fixture task result' };
    const gate = judgeGate;
    if (gate) { gate.reached.resolve(); await gate.release.promise; }
    return { text: JSON.stringify({ decision: 'done', reason: 'Fixture objective achieved' }) };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { observerModelOverride: null, reflectorModelOverride: null,
      goalJudgeModel: 'fixture/judge', goalMaxTurns: Number.MAX_SAFE_INTEGER },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat', 'alternate', 'judge'] }],
    preferences: { yolo: true }, lsp: false, observability: { enabled: false },
  }));
});
after(async () => {
  judgeGate?.release.resolve();
  await fixture?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function setup(t: TestContext, name: string) {
  const projectPath = join(root, name);
  await mkdir(projectPath);
  const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, `${name}-runtime`),
    disableMcp: true, subagents: [], modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
  const session = await runtime.createSession({ threadId: name, resourceId: name });
  await session.thread.rename({ title: name });
  const agent = session.machinery.getAgent();
  const goals = createChatGoals();
  // Join real native producers for teardown; no production private hooks or fences.
  const producers = new Map<string, ReturnType<typeof deferred>>();
  const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
  const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
  t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
    const result = register(...args);
    if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], deferred());
    return result;
  });
  t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
    unregister(id, runId);
    if (id === 'agentic-loop') producers.get(runId)?.resolve();
  });
  let terminal = deferred();
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'agent_start') terminal = deferred();
    if (event.type === 'agent_end') terminal.resolve();
  });
  async function settled() {
    if (session.displayState.get().isRunning) await terminal.promise;
    let joined = -1;
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(producer => producer.promise)); }
  }
  t.after(async () => {
    agent.abortThreadStream({ threadId: name, resourceId: name, clearPendingSignals: true });
    session.abort(); judgeGate?.release.resolve();
    await settled(); unsubscribe(); await runtime.dispose(); judgeGate = undefined;
  });
  return { runtime, session, agent, goals, settled };
}
const errorCode = (code: string) => (error: unknown) => error instanceof ORPCError && error.code === code;
function holdJudge(t: TestContext) {
  const gate = { reached: deferred(), release: deferred() };
  judgeGate = gate;
  t.after(() => gate.release.resolve());
  return gate;
}

test('create admits execution promptly and projects native usage, configured judge and completion', { timeout: 30_000 }, async t => {
  const { session, agent, goals, settled } = await setup(t, 'create');
  assert.equal(await goals.read(session), null);
  const gate = holdJudge(t);
  const requestStart = fixture.requests.length;
  await goals.update(session, { objective: 'Complete the native fixture goal' });
  await gate.reached.promise;
  const active = await goals.read(session);
  assert.ok(active);
  assert.equal(active.status, 'active');
  assert.equal(active.objective, 'Complete the native fixture goal');
  assert.equal(active.evaluationsUsed, 0);
  assert.equal(active.pausedReason, null);
  assert.ok(active.timeUsedSeconds > 0, 'live native pursuit duration is projected before completion');
  const record = await agent.getObjective({ threadId: 'create' });
  assert.equal(record?.judgeModelId, 'fixture/chat', 'the session model fallback is persisted');
  assert.equal(record?.maxRuns, Number.MAX_SAFE_INTEGER);
  assert.equal(session.displayState.get().isRunning, true, 'the command returned before the held judge completed');
  gate.release.resolve(); await settled();
  const done = await goals.read(session);
  assert.equal(done?.id, active.id);
  assert.equal(done?.status, 'done');
  assert.equal(done?.evaluationsUsed, 1);
  assert.ok(done!.timeUsedSeconds >= active.timeUsedSeconds);
  assert.deepEqual(fixture.requests.slice(requestStart).map(request => request.model), ['chat', 'judge'], 'native profile judge takes precedence over the persisted fallback');
});

test('paused create and replacement remain idle; replacement resets native ID, counters and duration', { timeout: 30_000 }, async t => {
  const { session, agent, goals, settled } = await setup(t, 'paused-edit');
  await goals.update(session, { objective: 'Original native objective' }); await settled();
  const original = await goals.read(session);
  assert.equal(original?.evaluationsUsed, 1);
  assert.ok(original!.timeUsedSeconds > 0);
  await goals.update(session, { status: 'paused' });
  await agent.updateObjectiveOptions({ threadId: 'paused-edit', pausedReason: 'Native pause reason' });
  assert.equal((await goals.read(session))?.pausedReason, 'Native pause reason');
  const requestStart = fixture.requests.length;
  await goals.update(session, { objective: 'Replacement paused objective' });
  const replacement = await goals.read(session);
  assert.ok(replacement);
  assert.notEqual(replacement.id, original!.id);
  assert.equal(replacement.objective, 'Replacement paused objective');
  assert.equal(replacement.status, 'paused');
  assert.equal(replacement.evaluationsUsed, 0);
  assert.equal(replacement.timeUsedSeconds, 0);
  assert.equal(session.displayState.get().isRunning, false);
  await goals.clear(session); assert.equal(await goals.read(session), null);
  await goals.update(session, { objective: 'Initially paused objective', status: 'paused' });
  assert.equal((await goals.read(session))?.status, 'paused');
  assert.equal(fixture.requests.length, requestStart, 'paused create/edit do not start model work');
  await goals.clear(session); await goals.clear(session); assert.equal(await goals.read(session), null);
});

test('pause suppresses the held evaluation; resume preserves identity and starts another native run', { timeout: 30_000 }, async t => {
  const { session, agent, goals, settled } = await setup(t, 'pause-resume');
  const gate = holdJudge(t);
  await goals.update(session, { objective: 'Pause and resume the native fixture objective' });
  await gate.reached.promise;
  const original = await goals.read(session);
  await goals.update(session, { status: 'paused' });
  assert.equal((await goals.read(session))?.status, 'paused');
  assert.equal(session.displayState.get().isRunning, true, 'Pause goal leaves the current chat response running');
  gate.release.resolve(); await settled();
  const paused = await goals.read(session);
  assert.equal(paused?.status, 'paused');
  assert.equal(paused?.evaluationsUsed, 0, 'native stale verdict was discarded');
  await agent.updateObjectiveOptions({ threadId: 'pause-resume', pausedReason: 'Fixture reason' });
  const requestStart = fixture.requests.length;
  await goals.update(session, { status: 'active' }); await settled();
  const resumed = await goals.read(session);
  assert.equal(resumed?.id, original?.id);
  assert.equal(resumed?.status, 'done');
  assert.equal(resumed?.evaluationsUsed, 1);
  assert.equal(resumed?.pausedReason, null);
  assert.deepEqual(fixture.requests.slice(requestStart).map(request => request.model), ['chat', 'judge']);
  await goals.update(session, { objective: 'Active replacement objective' }); await settled();
  const replacement = await goals.read(session);
  assert.notEqual(replacement?.id, resumed?.id);
  assert.equal(replacement?.status, 'done');
  assert.equal(replacement?.evaluationsUsed, 1, 'replacement owns a fresh evaluation count');
});

test('public commands serialize paused replacement before another client resumes it', { timeout: 30_000 }, async t => {
  const { session, agent, goals, settled } = await setup(t, 'serial');
  await goals.update(session, { objective: 'Initial paused objective', status: 'paused' });
  const original = agent.setObjective.bind(agent);
  const captured = deferred(); const release = deferred(); t.after(() => release.resolve());
  const replacementWrite = t.mock.method(agent, 'setObjective', async (...args: Parameters<typeof original>) => {
    const record = await original(...args); captured.resolve(); await release.promise; return record;
  });
  const editing = goals.update(session, { objective: 'Serialized replacement objective' });
  await captured.promise;
  let resumed = false;
  const resuming = goals.update(session, { status: 'active' }).then(() => { resumed = true; });
  const snapshot = goals.read(session);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(resumed, false, 'second client waits for replacement plus paused restoration');
  assert.equal(fixture.requests.some(request => JSON.stringify(request).includes('Serialized replacement objective')), false);
  release.resolve(); await editing; await resuming; replacementWrite.mock.restore();
  assert.equal((await snapshot)?.objective, 'Serialized replacement objective');
  await settled();
  assert.equal((await goals.read(session))?.status, 'done', 'resume is not overwritten by the paused edit');
});

for (const defaultModel of [false, true]) {
  test(`unset profile judge uses the ${defaultModel ? 'mode default' : 'current session'} fallback`, { timeout: 30_000 }, async t => {
    const originalSettings = await readFile(profile.settingsPath, 'utf8');
    const settings = JSON.parse(originalSettings); settings.models.goalJudgeModel = null;
    await writeFile(profile.settingsPath, JSON.stringify(settings));
    t.after(() => writeFile(profile.settingsPath, originalSettings));
    const name = `fallback-${defaultModel}`;
    const { session, agent, goals, settled } = await setup(t, name);
    if (!defaultModel) await session.model.switch('fixture/alternate');
    const model = defaultModel ? 'fixture/chat' : 'fixture/alternate';
    const requestStart = fixture.requests.length;
    if (defaultModel) {
      const empty = t.mock.method(session.model, 'get', () => '');
      await goals.update(session, { objective: 'Judge with the native session model fallback', status: 'paused' });
      empty.mock.restore();
      await goals.update(session, { status: 'active' });
    } else await goals.update(session, { objective: 'Judge with the native session model fallback' });
    await settled();
    assert.equal((await agent.getObjective({ threadId: name }))?.judgeModelId, model);
    assert.equal((await goals.read(session))?.status, 'done');
    assert.deepEqual(fixture.requests.slice(requestStart).map(request => request.model), [model.slice('fixture/'.length), model.slice('fixture/'.length)], 'real native fallback judging resolves through the registered host gateway');
  });
}

test('invalid patches and missing status-only goals reject without synthesizing native state', { timeout: 30_000 }, async t => {
  const { session, goals } = await setup(t, 'invalid');
  const invalid: unknown[] = [{}, { objective: '' }, { objective: '  ' }, { objective: 12 }, { status: 'done' }, { status: null }, { status: 'invalid' }, { extra: true }, null, []];
  for (const patch of invalid) await assert.rejects(goals.update(session, patch as GoalPatch), errorCode('BAD_REQUEST'));
  await assert.rejects(goals.update(session, { status: 'active' }), errorCode('NOT_FOUND'));
  await assert.rejects(goals.update(session, { status: 'paused' }), errorCode('NOT_FOUND'));
  assert.equal(await goals.read(session), null);
  await goals.update(session, { objective: 'Valid after rejected commands', status: 'paused' });
  assert.equal((await goals.read(session))?.status, 'paused', 'rejection does not poison serialization');
});

test('failed reminder admission surfaces failure and preserves the native objective', { timeout: 30_000 }, async t => {
  const { session, goals } = await setup(t, 'admission');
  await session.thread.setSetting({ key: CHAT_FAST_SETTING, value: true });
  const blocked = t.mock.method(session, 'sendSignal', (...[_input, options]: Parameters<typeof session.sendSignal>) => {
    assert.equal(options?.requireDelivery, true);
    assert.equal(options?.requestContext?.get('kodex.fast'), true, 'goal reminders carry the same native Fast capture as explicit Send');
    return { id: 'blocked-fixture', type: 'system-reminder' as const,
      accepted: Promise.resolve({ accepted: true as const, action: 'blocked' as const }) };
  });
  await assert.rejects(goals.update(session, { objective: 'Persisted but blocked fixture objective' }), errorCode('CONFLICT'));
  assert.equal((await goals.read(session))?.objective, 'Persisted but blocked fixture objective');
  blocked.mock.restore();
  const failure = new Error('Fixture native admission failure');
  const rejected = t.mock.method(session, 'sendSignal', () => ({ id: 'rejected-fixture', type: 'system-reminder' as const, accepted: Promise.reject(failure) }));
  await assert.rejects(goals.update(session, { status: 'active' }), error => error === failure);
  rejected.mock.restore();
  assert.equal((await goals.read(session))?.status, 'active');
  await goals.clear(session); assert.equal(await goals.read(session), null);
});

test('native storage no-op and errors surface without constructing synthetic snapshots', { timeout: 30_000 }, async t => {
  const { session, agent, goals } = await setup(t, 'storage-errors');
  const empty = t.mock.method(agent, 'setObjective', async () => undefined);
  await assert.rejects(goals.update(session, { objective: 'Unavailable native storage' }), errorCode('INTERNAL_SERVER_ERROR'));
  empty.mock.restore(); assert.equal(await goals.read(session), null);
  const failure = new Error('Fixture native storage failure');
  const read = t.mock.method(agent, 'getObjective', async () => { throw failure; });
  await assert.rejects(goals.read(session), error => error === failure);
  await assert.rejects(goals.update(session, { objective: 'Read failure objective' }), error => error === failure);
  read.mock.restore();
  const clear = t.mock.method(agent, 'clearObjective', async () => { throw failure; });
  await assert.rejects(goals.clear(session), error => error === failure);
  clear.mock.restore(); assert.equal(await goals.read(session), null);
});
