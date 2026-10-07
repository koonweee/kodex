import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime, type NativeSession } from '../src/runtime.js';
import { scheduleSessionHooks } from '../src/schedules.js';
import { startModelFixture } from './fixtures/model-server.js';

let root: string;
let profile: SpikeProfile;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
const runtimes: ProjectRuntime[] = [];

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kodex-mastra-schedules-test-'));
  profile = activateProfile(resolveProfile(path.join(root, 'profile')));
  fixture = await startModelFixture(request => ({ text: `fixture:${JSON.stringify(request.messages)}` }));
  await writeFile(profile.settingsPath, JSON.stringify({
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    models: { observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat' },
    preferences: { yolo: true }, observability: { enabled: false },
  }));
});

after(async () => {
  for (const runtime of runtimes.reverse()) await runtime.dispose();
  await fixture?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function open(name: string) {
  const projectPath = path.join(root, name);
  await mkdir(projectPath, { recursive: true });
  let runtime!: ProjectRuntime;
  runtime = await createProjectRuntime({
    projectPath, runtimeRoot: path.join(root, `${name}-runtime`), profile, disableMcp: true,
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
    schedules: scheduleSessionHooks(async ({ agentId, resourceId, threadId }) => {
      assert.equal(agentId, runtime.codeAgent.id);
      return runtime.createSession({ id: resourceId, resourceId, threadId });
    }),
  });
  runtimes.push(runtime);
  return runtime;
}

async function eventually(check: () => Promise<boolean>, message: string, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(message);
}

async function hasAssistantReply(session: NativeSession, marker: string) {
  return (await session.thread.listActiveMessages()).some(message => message.role === 'assistant' && JSON.stringify(message.content).includes(marker));
}

async function trigger(runtime: ProjectRuntime, id: string, fireAt: number, timeout = 8_000) {
  const store = await runtime.mastra.getStorage()?.getStore('schedules');
  assert.ok(store);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const row = (await store.listTriggers(id)).find(row => row.scheduledFireAt === fireAt);
    if (row) return row;
    await delay(20);
  }
  assert.fail('native schedule did not record its trigger before the deadline');
}

// RED evidence: bare CodeSDK native schedules cannot wake without Session context.
test('native schedules persist across runtime recreation and wake their idle conversation', { timeout: 30_000 }, async () => {
  const first = await open('idle');
  const initialSession = await first.createSession({ id: 'idle-session', resourceId: 'idle-resource', threadId: 'idle-thread' });
  await initialSession.thread.rename({ title: 'Idle schedule proof' });
  const schedule = await first.mastra.schedules.create({
    id: 'idle-proof', agentId: first.codeAgent.id, threadId: 'idle-thread', resourceId: 'idle-resource',
    prompt: 'SCHEDULE_IDLE', cron: '0 0 1 1 *', timezone: 'UTC', status: 'paused',
  });
  await first.dispose();
  const requestCount = fixture.requests.length;
  const reopened = await open('idle');
  assert.deepEqual(await reopened.mastra.schedules.get(schedule.id), schedule);
  assert.equal(fixture.requests.length, requestCount, 'restoring a paused schedule does not execute a model');
  assert.equal(await reopened.controller.getSessionByResource('idle-resource'), undefined, 'the restored target remains unloaded until a schedule fire');
  const ack = await reopened.mastra.schedules.run(schedule.id);
  assert.equal(ack.scheduleId, schedule.id, 'fire acknowledgment identifies the schedule, not completed execution');
  const outcome = await trigger(reopened, schedule.id, ack.scheduledFireAt);
  assert.equal(outcome.outcome, 'succeeded', outcome.error);
  const session = await reopened.controller.getSessionByResource('idle-resource');
  assert.ok(session, 'the native preparation hook activates the unloaded target');
  // Native trigger outcome 'succeeded' acknowledges a wake, before model completion.
  await eventually(async () => !session.displayState.get().isRunning && await hasAssistantReply(session, 'SCHEDULE_IDLE'), 'the scheduled run did not finish and persist its assistant answer');
  assert.ok(fixture.requests.slice(requestCount).some(request => JSON.stringify(request.messages).includes('SCHEDULE_IDLE')));
  assert.match(JSON.stringify(await session.thread.listActiveMessages()), /SCHEDULE_IDLE/);
  assert.equal((await reopened.mastra.schedules.get(schedule.id))?.status, 'paused', 'manual fire preserves calendar pause');
});

test('native schedule joins the target active run without waking another conversation', { timeout: 30_000 }, async () => {
  const runtime = await open('active');
  const session = await runtime.createSession({ id: 'active-session', resourceId: 'active-resource', threadId: 'active-thread' });
  await session.thread.rename({ title: 'Active schedule proof' });
  const other = await runtime.createSession({ id: 'other-session', resourceId: 'other-resource', threadId: 'other-thread' });
  const schedule = await runtime.mastra.schedules.create({
    agentId: runtime.codeAgent.id, threadId: 'active-thread', resourceId: 'active-resource',
    prompt: 'SCHEDULE_ACTIVE', cron: '0 0 1 1 *', timezone: 'UTC', status: 'paused',
  });
  const hold = fixture.holdNext('BASE_ACTIVE');
  const running = session.sendMessage({ content: 'BASE_ACTIVE' });
  try {
    await hold.reached;
    const activeRunId = session.getCurrentRunId();
    assert.ok(activeRunId);
    const ack = await runtime.mastra.schedules.run(schedule.id);
    const outcome = await trigger(runtime, schedule.id, ack.scheduledFireAt);
    assert.equal(outcome.outcome, 'delivered', outcome.error);
    assert.equal(outcome.runId, activeRunId, 'delivery joins the existing run');
    assert.equal(other.displayState.get().isRunning, false);
  } finally {
    hold.release();
    await running;
  }
  assert.ok(fixture.requests.some(request => JSON.stringify(request.messages).includes('SCHEDULE_ACTIVE')));
  assert.match(JSON.stringify(await session.thread.listActiveMessages()), /SCHEDULE_ACTIVE/);
  await eventually(async () => !session.displayState.get().isRunning && await hasAssistantReply(session, 'SCHEDULE_ACTIVE'), 'the active conversation did not finish and persist its scheduled assistant answer');
  assert.doesNotMatch(JSON.stringify(await other.thread.listActiveMessages()), /SCHEDULE_ACTIVE|BASE_ACTIVE/);
});

// The native scheduler polls every ten seconds by default. Use a real future
// six-part calendar expression; no manual run, direct tick, or custom timer.
test('native calendar worker rehydrates an active schedule and wakes an unloaded chat after restart', { timeout: 35_000 }, async () => {
  const first = await open('calendar');
  const initial = await first.createSession({ id: 'calendar-session', resourceId: 'calendar-resource', threadId: 'calendar-thread' });
  await initial.thread.rename({ title: 'Calendar restart proof' });
  const fireDate = new Date(Date.now() + 5_000);
  const cron = `${fireDate.getUTCSeconds()} ${fireDate.getUTCMinutes()} ${fireDate.getUTCHours()} ${fireDate.getUTCDate()} ${fireDate.getUTCMonth() + 1} *`;
  const saved = await first.mastra.schedules.create({
    id: 'calendar-proof', agentId: first.codeAgent.id, threadId: 'calendar-thread', resourceId: 'calendar-resource',
    prompt: 'SCHEDULE_CALENDAR', cron, timezone: 'UTC', status: 'active',
  });
  assert.ok(saved.nextFireAt > Date.now(), 'the first calendar fire is still in the future');
  await first.dispose();
  const reopened = await open('calendar');
  assert.deepEqual(await reopened.mastra.schedules.get(saved.id), saved);
  assert.equal(await reopened.controller.getSessionByResource('calendar-resource'), undefined);
  const outcome = await trigger(reopened, saved.id, saved.nextFireAt, 20_000);
  assert.equal(outcome.outcome, 'succeeded', outcome.error);
  assert.equal(outcome.triggerKind, 'schedule-fire', 'the native worker fired the persisted calendar row');
  assert.ok(outcome.actualFireAt >= saved.nextFireAt);
  const session = await reopened.controller.getSessionByResource('calendar-resource');
  assert.ok(session, 'the timer fire loads its target without an explicit browser attach');
  await eventually(async () => !session.displayState.get().isRunning && await hasAssistantReply(session, 'SCHEDULE_CALENDAR'), 'calendar wake did not persist its assistant answer');
  const updated = await reopened.mastra.schedules.get(saved.id);
  assert.equal(updated?.status, 'active');
  assert.ok(updated && updated.nextFireAt > saved.nextFireAt, 'native recurrence advances after the calendar fire');
  await reopened.mastra.schedules.pause(saved.id);
});
