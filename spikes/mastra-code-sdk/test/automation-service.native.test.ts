import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { before, after, test, type TestContext } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { ORPCError, type RouterClient } from '@orpc/server';
import { createAutomationService } from '../src/automation-service.js';
import { AUTOMATION_WORKFLOW_ID, createAutomationWorkflow, type AutomationDelivery } from '../src/automation-workflow.js';
import { createAutomationRouter } from '../src/automation-router.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { serveRouter } from '../src/server.js';
import { startModelFixture } from './fixtures/model-server.js';

let root: string, profile: SpikeProfile;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-native-automation-crud-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture();
  await writeFile(profile.settingsPath, JSON.stringify({
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    models: { observerModelOverride: null, reflectorModelOverride: null }, preferences: { yolo: true }, lsp: false, observability: { enabled: false },
  }));
});
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });

async function setup(t: TestContext, name: string, deliver: AutomationDelivery = async () => ({ accepted: true })) {
  const paths = ['a', 'b'].map(id => join(root, `${name}-${id}`));
  for (const path of paths) await mkdir(path);
  let runtimes: ProjectRuntime[] = [];
  async function open() {
    runtimes = await Promise.all(paths.map((projectPath, index) => createProjectRuntime({ projectPath,
      runtimeRoot: join(root, `${name}-runtime-${index}`), profile, disableMcp: true,
      workflows: { [AUTOMATION_WORKFLOW_ID]: createAutomationWorkflow(deliver) },
      modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
    })));
  }
  await open();
  const targets = ['target-a', 'target-b'];
  for (let i = 0; i < runtimes.length; i++) {
    const session = await runtimes[i]!.createSession({ resourceId: targets[i], threadId: targets[i] });
    await session.thread.rename({ title: targets[i]! });
  }
  t.after(async () => { for (const runtime of runtimes) await runtime.dispose(); });
  const service = createAutomationService({ runtimes: async () => runtimes,
    async resolveTarget(chatId) {
      const index = targets.indexOf(chatId);
      if (index === -1) throw new ORPCError('NOT_FOUND', { message: 'Chat or project not found.' });
      const runtime = runtimes[index]!, thread = await runtime.controller.queryThreadById({ threadId: chatId });
      assert.ok(thread);
      return { runtime, thread };
    },
  });
  return { service, get runtimes() { return runtimes; }, async restart() {
    for (const runtime of runtimes) await runtime.dispose(); await open();
  } };
}

const input = (targetThreadId = 'target-a') => ({ name: 'Native calendar', prompt: 'Inspect the project', targetThreadId, cron: '0 0 1 1 *', timezone: 'UTC' });
const code = (expected: string) => (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;

test('two typed clients share native automation CRUD and dormant retained schedules after runtime recreation', { timeout: 20_000 }, async t => {
  const f = await setup(t, 'crud');
  const router = createAutomationRouter(f.service), server = await serveRouter(router, 0);
  t.after(() => server.close());
  const client = (): RouterClient<typeof router> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  const a = client(), b = client();
  const disconnected = new AbortController(); t.after(() => disconnected.abort());
  const watchA = (await a.watchAutomations(undefined, { signal: disconnected.signal }))[Symbol.asyncIterator]();
  const watchB = (await b.watchAutomations(undefined, { signal: disconnected.signal }))[Symbol.asyncIterator]();
  for (const row of await Promise.all([watchA.next(), watchB.next()])) assert.deepEqual(row.value?.rows, []);
  const beforeRequests = fixture.requests.length;
  assert.deepEqual(await a.listAutomations(), []);
  const first = await a.createAutomation(input()), second = await b.createAutomation(input('target-b'));
  for (const watch of [watchA, watchB]) {
    let row = await watch.next();
    while (row.value?.rows.length !== 2) row = await watch.next();
    assert.deepEqual(new Set(row.value.rows.map(item => item.id)), new Set([first.id, second.id]));
  }
  disconnected.abort();
  assert.notEqual(first.id, second.id); assert.equal(first.status, 'active');
  assert.deepEqual(new Set((await b.listAutomations()).map(row => row.id)), new Set([first.id, second.id]));
  const native = await f.runtimes[0]!.mastra.schedules.get(first.id);
  assert.ok(native && native.workflowId === AUTOMATION_WORKFLOW_ID);
  assert.equal(native.metadata?.kodexAutomation, 1);
  assert.equal(native.resourceId, 'target-a');
  assert.deepEqual(native.inputData, { name: input().name, prompt: input().prompt, targetThreadId: 'target-a' });
  assert.equal('metadata' in first, false); assert.equal('resourceId' in first, false);
  const changed = await b.updateAutomation({ id: first.id, patch: { prompt: 'Edited native prompt' } });
  assert.equal(changed.name, first.name); assert.equal(changed.cron, first.cron); assert.equal(changed.prompt, 'Edited native prompt');
  assert.equal((await a.updateAutomation({ id: first.id, patch: { targetThreadId: 'target-b' } })).targetThreadId, 'target-b');
  assert.equal((await b.updateAutomation({ id: first.id, patch: { targetThreadId: 'target-a' } })).targetThreadId, 'target-a');
  assert.equal((await a.pauseAutomation({ id: first.id })).status, 'paused');
  assert.equal((await b.resumeAutomation({ id: first.id })).status, 'active');
  await assert.rejects(a.updateAutomation({ id: first.id, patch: { cron: 'invalid cron /private/path' } }), code('BAD_REQUEST'));
  await assert.rejects(a.createAutomation({ ...input(), timezone: 'Not/A_Timezone' }), code('BAD_REQUEST'));
  await assert.rejects(a.createAutomation({ ...input(), targetThreadId: 'not-a-chat' }), code('NOT_FOUND'));
  for (const malformed of [{ ...input(), name: '' }, { ...input(), metadata: { kodexAutomation: 1 } }, { ...input(), cron: 1 }]) {
    await assert.rejects(a.createAutomation(malformed as never), code('BAD_REQUEST'));
  }
  await assert.rejects(a.updateAutomation({ id: first.id, patch: {} }), code('BAD_REQUEST'));
  await assert.rejects(a.updateAutomation({ id: first.id, patch: { targetThreadId: 'not-a-chat' } }), code('NOT_FOUND'));
  await assert.rejects(a.pauseAutomation({ id: first.id, status: 'paused' } as never), code('BAD_REQUEST'));
  const unchanged = (await b.listAutomations()).find(row => row.id === first.id);
  assert.equal(unchanged?.cron, first.cron); assert.equal(unchanged?.prompt, changed.prompt);
  assert.equal((await b.listAutomations()).length, 2, 'invalid edits and creates leave native definitions unchanged');
  await a.pauseAutomation({ id: first.id }); await b.pauseAutomation({ id: second.id });
  const before = await a.listAutomations(); await f.restart();
  assert.deepEqual(await b.listAutomations(), before);
  for (const runtime of f.runtimes) {
    assert.equal(await runtime.controller.getSessionByResource('target-a'), undefined);
    assert.equal(await runtime.controller.getSessionByResource('target-b'), undefined);
  }
  assert.equal(fixture.requests.length, beforeRequests, 'CRUD/history reads do not execute or activate target models');
  assert.deepEqual(await b.deleteAutomation({ id: first.id }), { id: first.id });
  assert.equal(await f.runtimes[0]!.mastra.schedules.get(first.id), null);
  await assert.rejects(a.pauseAutomation({ id: first.id }), code('NOT_FOUND'));
  assert.deepEqual((await a.listAutomations()).map(row => row.id), [second.id]);
});

test('automation inventory and mutations exclude foreign native rows while history preserves bounded native outcomes safely', { timeout: 20_000 }, async t => {
  const f = await setup(t, 'ownership');
  const runtime = f.runtimes[0]!;
  const automation = await f.service.create(input()); await f.service.pause({ id: automation.id });
  const unowned = await runtime.mastra.schedules.create({ agentId: runtime.codeAgent.id, threadId: 'target-a', resourceId: 'target-a',
    name: 'Unowned', prompt: 'Native other owner', cron: input().cron, timezone: 'UTC', status: 'paused' });
  const store = await runtime.mastra.getStorage()?.getStore('schedules'); assert.ok(store);
  const owned = await store.getSchedule(automation.id); assert.ok(owned && owned.target.type === 'workflow');
  await store.createSchedule({ ...owned, id: 'schedule_wrong-workflow', target: { ...owned.target, workflowId: 'foreign-workflow' } });
  await store.createSchedule({ ...owned, id: 'schedule_missing-resource', target: { ...owned.target, resourceId: undefined } });
  await store.createSchedule({ ...owned, id: 'schedule_wrong-marker', metadata: { kodexAutomation: true } });
  await store.createSchedule({ ...owned, id: 'schedule_bad-payload', target: { ...owned.target, inputData: { ...input(), targetThreadId: 42 } } });
  for (const id of [unowned.id, 'schedule_wrong-workflow', 'schedule_missing-resource', 'schedule_wrong-marker', 'schedule_bad-payload']) {
    await assert.rejects(f.service.pause({ id }), code('NOT_FOUND'));
    await assert.rejects(f.service.runs({ id }), code('NOT_FOUND'));
    await assert.rejects(f.service.remove({ id }), code('NOT_FOUND'));
    assert.ok(await store.getSchedule(id), 'rejecting a foreign row never deletes or modifies it');
  }
  assert.deepEqual((await f.service.list()).map(row => row.id), [automation.id]);
  await store.updateSchedule(automation.id, { status: 'completed' });
  assert.equal((await f.service.list())[0]?.status, 'completed', 'native completed schedules remain visible');
  await assert.rejects(f.service.resume({ id: automation.id }), code('CONFLICT'));
  const outcomes = ['succeeded', 'delivered', 'failed'] as const;
  for (let i = 0; i < 101; i++) await store.recordTrigger({ id: `native-trigger-${i}`, scheduleId: automation.id,
    runId: `native-run-${i}`, scheduledFireAt: i, actualFireAt: i, outcome: outcomes[i % outcomes.length]!,
    triggerKind: 'manual', error: i % 3 === 2 ? '/private/auth.json secret-provider-body' : undefined,
    metadata: { privateProviderPayload: 'do not expose' } });
  const history = await f.service.runs({ id: automation.id });
  assert.equal(history.length, 100); assert.equal(history[0]?.id, 'native-trigger-100');
  assert.equal(history.at(-1)?.id, 'native-trigger-1');
  assert.deepEqual(new Set(history.map(row => row.outcome)), new Set(outcomes));
  assert.doesNotMatch(JSON.stringify(history), /private|auth\.json|secret-provider-body|privateProviderPayload/);
  assert.ok(history.find(row => row.outcome === 'failed')?.error);
  assert.equal(history[0]?.runId, 'native-run-100');
  await store.recordTrigger({ id: 'native-unclaimed', scheduleId: automation.id, runId: null, scheduledFireAt: 102, actualFireAt: 102, outcome: 'published' });
  const unknown = (await f.service.runs({ id: automation.id })).find(row => row.id === 'native-unclaimed'); assert.ok(unknown);
  assert.equal(unknown.deliveryStatus, undefined); assert.equal(unknown.error, undefined, 'missing native execution state stays unknown');
  await f.service.remove({ id: automation.id });
  assert.deepEqual(await store.listTriggers(automation.id), [], 'native deletion also removes native trigger history');
});

test('a native completed transition during inventory reading does not duplicate the same automation', { timeout: 20_000 }, async t => {
  const f = await setup(t, 'completion-read');
  const automation = await f.service.create(input()), runtime = f.runtimes[0]!;
  const store = await runtime.mastra.getStorage()?.getStore('schedules'); assert.ok(store);
  const original = store.listSchedules.bind(store);
  let changed!: () => void;
  const transitioned = new Promise<void>(resolve => { changed = resolve; });
  let change = true;
  t.mock.method(store, 'listSchedules', async (...args: Parameters<typeof original>) => {
    const filter = args[0];
    if (filter?.status === 'completed') await transitioned;
    const rows = await original(...args);
    if (change && filter?.workflowId === AUTOMATION_WORKFLOW_ID && filter.status === undefined) {
      change = false;
      // Real native storage changes after this read captured its original rows.
      await store.updateSchedule(automation.id, { status: 'completed' }); changed();
    }
    return rows;
  });
  const rows = await f.service.list();
  assert.equal(rows.filter(row => row.id === automation.id).length, 1);
  assert.equal((await runtime.mastra.schedules.get(automation.id))?.status, 'completed');
});


test('workflow retargeting keeps its native identity and history while concurrent sparse edits preserve every field', { timeout: 20_000 }, async t => {
  const f = await setup(t, 'retarget');
  const automation = await f.service.create(input()); await f.service.pause({ id: automation.id });
  const source = f.runtimes[0]!, destination = f.runtimes[1]!;
  const store = await source.mastra.getStorage()?.getStore('schedules'); assert.ok(store);
  await store.recordTrigger({ id: 'retained-trigger', scheduleId: automation.id, runId: 'native-published-run',
    scheduledFireAt: 1, actualFireAt: 1, outcome: 'published' });
  const history = await f.service.runs({ id: automation.id });
  const before = await source.mastra.schedules.get(automation.id);
  await assert.rejects(f.service.update({ id: automation.id, patch: { targetThreadId: 'not-a-chat', name: 'Must not save' } }), code('NOT_FOUND'));
  assert.deepEqual(await source.mastra.schedules.get(automation.id), before, 'target validation precedes any native write');
  await Promise.all([
    f.service.update({ id: automation.id, patch: { targetThreadId: 'target-b', name: 'Retargeted calendar' } }),
    f.service.update({ id: automation.id, patch: { prompt: 'Concurrent prompt edit' } }),
  ]);
  const saved = (await f.service.list()).find(row => row.id === automation.id); assert.ok(saved);
  assert.equal(saved.targetThreadId, 'target-b'); assert.equal(saved.name, 'Retargeted calendar');
  assert.equal(saved.prompt, 'Concurrent prompt edit'); assert.equal(saved.status, 'paused');
  const native = await source.mastra.schedules.get(automation.id); assert.ok(native);
  assert.equal(native.resourceId, 'target-b');
  assert.equal(await destination.mastra.schedules.get(automation.id), null, 'retargeting does not copy or migrate the native schedule');
  assert.deepEqual(await f.service.runs({ id: automation.id }), history);
  assert.equal(fixture.requests.length, 0, 'retargeting never submits model work');
});


test('native workflow dispatch status distinguishes accepted input from failure without changing published trigger outcomes', { timeout: 20_000 }, async t => {
  const calls: Array<{ targetThreadId: string; prompt: string; resourceId?: string }> = [];
  const f = await setup(t, 'delivery-status', async input => {
    calls.push(input);
    if (input.prompt === 'FAIL_DISPATCH') throw new Error('/private/auth.json secret rejected delivery');
    return { accepted: true };
  });
  for (const [prompt, expected] of [['FAIL_DISPATCH', 'failed'], ['ACCEPT_DISPATCH', 'success']] as const) {
    const automation = await f.service.create({ ...input(), prompt }); await f.service.pause({ id: automation.id });
    const runtime = f.runtimes[0]!, workflow = runtime.mastra.getWorkflow(AUTOMATION_WORKFLOW_ID);
    const ack = await runtime.mastra.schedules.run(automation.id);
    const deadline = Date.now() + 5_000;
    let settled = false;
    while (Date.now() < deadline) {
      const run = await workflow.getWorkflowRunById(ack.claimId, { withNestedWorkflows: false, fields: ['result'] });
      if (run?.status === expected) { settled = true; break; }
      await delay(10);
    }
    assert.ok(settled, `the actual native dispatch workflow persists ${expected}`);
    const history = await f.service.runs({ id: automation.id });
    assert.equal(history.length, 1); assert.equal(history[0]!.outcome, 'published');
    assert.equal((history[0] as { deliveryStatus?: string }).deliveryStatus, expected);
    assert.equal(Boolean(history[0]!.error), expected === 'failed');
    assert.doesNotMatch(JSON.stringify(history), /private|auth\.json|secret rejected/);
  }
  assert.deepEqual(calls, ['FAIL_DISPATCH', 'ACCEPT_DISPATCH'].map(prompt => ({ targetThreadId: 'target-a', prompt, resourceId: 'target-a' })));
  assert.equal(fixture.requests.length, 0, 'dispatch status is not a claim about a completed model response');
});
