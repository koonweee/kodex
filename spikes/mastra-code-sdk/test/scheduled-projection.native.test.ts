import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { abortNativeChat } from '../src/chat-archive.js';
import { readChatHistory } from '../src/chat-history.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { scheduleSessionHooks } from '../src/schedules.js';
import { createSessionProjection, type SessionSnapshot } from '../src/transport.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

let root: string, profile: SpikeProfile;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-scheduled-projection-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(request => {
    if (lastUserText(request).includes('SCHEDULE_STOP')) return { text: 'STOP_FINAL_MUST_NOT_PERSIST' };
    if (request.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('SCHEDULE_VIEW_EVIDENCE'))) return { text: 'SCHEDULE_TOOL_FINAL' };
    return { toolCalls: [{ name: 'view', arguments: { path: 'evidence.txt' }, id: 'scheduled-view' }] };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    models: { observerModelOverride: null, reflectorModelOverride: null },
    preferences: { yolo: true }, lsp: false, observability: { enabled: false },
  }));
});
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });

async function setup(t: TestContext, name: string) {
  const projectPath = join(root, name); await mkdir(projectPath);
  await writeFile(join(projectPath, 'evidence.txt'), 'SCHEDULE_VIEW_EVIDENCE');
  const sessions = new Set<NativeSession>();
  let runtime!: ProjectRuntime;
  runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, `${name}-runtime`), disableMcp: true, subagents: [],
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
    schedules: scheduleSessionHooks(async ({ agentId, resourceId, threadId }) => {
      assert.equal(agentId, runtime.codeAgent.id);
      return runtime.createSession({ resourceId, threadId });
    }),
  });
  const producers = new Map<string, { promise: Promise<void>; finish: () => void }>();
  const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
  const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
  // Fixture-only passthrough observation joins late producer writes. It is not
  // a supported public Stop/retirement fence or part of host execution.
  t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
    const result = register(...args);
    if (args[0].id === 'agentic-loop' && args[1]) {
      let finish!: () => void;
      const promise = new Promise<void>(resolve => { finish = resolve; });
      producers.set(args[1], { promise, finish });
    }
    return result;
  });
  t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
    unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.finish();
  });
  async function settled() {
    let joined = -1;
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(done => done.promise)); }
    return joined;
  }
  runtime.controller.onSessionCreated(session => { sessions.add(session); });
  const session = await runtime.createSession({ resourceId: name, threadId: name });
  await session.thread.rename({ title: name });
  const projection = createSessionProjection(session, (request, signal) => readChatHistory(runtime.controller, { resourceId: name, threadId: name }, request, signal));
  const watchAbort = new AbortController(), watch = projection.watch(watchAbort.signal);
  t.after(async () => {
    watchAbort.abort(); await watch.return().catch(() => undefined); projection.dispose();
    for (const owned of sessions) await abortNativeChat(owned);
    await settled();
    const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
    if (memory && 'settled' in memory && typeof memory.settled === 'function') await memory.settled();
    await runtime.dispose();
  });
  async function createSchedule(prompt: string) {
    const schedule = await runtime.mastra.schedules.create({ agentId: runtime.codeAgent.id, resourceId: name, threadId: name,
      prompt, cron: '0 0 1 1 *', timezone: 'UTC', status: 'paused' });
    assert.deepEqual(await runtime.mastra.schedules.get(schedule.id), schedule, 'the paused schedule is stored natively');
    return schedule;
  }
  return { runtime, session, projection, watch, createSchedule, settled };
}
async function until(watch: AsyncIterator<SessionSnapshot>, predicate: (snapshot: SessionSnapshot) => boolean) {
  const timeout = AbortSignal.timeout(5_000);
  for (;;) {
    timeout.throwIfAborted();
    let rejectTimeout!: () => void;
    const expired = new Promise<never>((_, reject) => { rejectTimeout = () => reject(new Error('Scheduled live projection did not converge')); });
    timeout.addEventListener('abort', rejectTimeout, { once: true });
    try {
      const next = await Promise.race([watch.next(), expired]);
      assert.equal(next.done, false);
      if (predicate(next.value!)) return next.value!;
    } finally { timeout.removeEventListener('abort', rejectTimeout); }
  }
}

// Characterize the existing context-only prepare hook. Direct history polling
// and injected host stream callbacks do not substitute for the live watch.
test('native scheduled wake projects live state, executes a real tool and persists its final answer', { timeout: 15_000 }, async t => {
  const f = await setup(t, 'scheduled-live');
  const initial = await f.watch.next(); assert.equal(initial.done, false);
  assert.equal(initial.value!.display.isRunning, false);
  const events: string[] = [];
  let ended!: () => void;
  const terminal = new Promise<void>(resolve => { ended = resolve; });
  const unsubscribe = f.session.subscribe(event => {
    events.push(event.type);
    if (event.type === 'agent_end' && event.reason === 'complete') ended();
  });
  t.after(unsubscribe);
  const schedule = await f.createSchedule('SCHEDULE_LIVE');
  const hold = fixture.holdNext('SCHEDULE_LIVE'); t.after(hold.release);
  const ack = await f.runtime.mastra.schedules.run(schedule.id); assert.equal(ack.scheduleId, schedule.id);
  await hold.reached;
  const live = await until(f.watch, snapshot => snapshot.display.isRunning && !!snapshot.display.currentMessage);
  assert.ok(live.revision > initial.value!.revision);
  assert.ok(events.includes('agent_start'), 'external wake emits the public Session start event');
  assert.equal(events.includes('agent_end'), false, 'the held provider has not finished');
  hold.release(); await terminal;
  const final = await until(f.watch, snapshot => !snapshot.display.isRunning && JSON.stringify(snapshot.messages).includes('SCHEDULE_TOOL_FINAL'));
  assert.ok(final.revision > live.revision);
  assert.ok(events.includes('tool_start')); assert.ok(events.includes('tool_end'));
  const tool = final.messages.flatMap(message => message.content.parts).find(part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === 'scheduled-view');
  assert.ok(tool?.type === 'tool-invocation');
  assert.equal(tool.toolInvocation.state, 'result'); assert.equal(tool.toolInvocation.toolName, 'view');
  assert.match(String(tool.toolInvocation.result), /SCHEDULE_VIEW_EVIDENCE/);
  assert.equal((await f.runtime.mastra.schedules.get(schedule.id))?.status, 'paused');
  const persisted = await f.runtime.controller.queryThreadMessages({ threadId: 'scheduled-live', resourceId: 'scheduled-live', perPage: false });
  assert.match(JSON.stringify(persisted.messages), /SCHEDULE_TOOL_FINAL/); assert.match(JSON.stringify(persisted.messages), /SCHEDULE_VIEW_EVIDENCE/);
});

test('public Stop aborts a held scheduled wake and live projection becomes idle', { timeout: 15_000 }, async t => {
  const f = await setup(t, 'scheduled-stop'); await f.watch.next();
  const ends: string[] = [];
  const unsubscribe = f.session.subscribe(event => { if (event.type === 'agent_end') ends.push(event.reason ?? 'unknown'); });
  t.after(unsubscribe);
  const schedule = await f.createSchedule('SCHEDULE_STOP');
  const hold = fixture.holdNext('SCHEDULE_STOP'); t.after(hold.release);
  await f.runtime.mastra.schedules.run(schedule.id); await hold.reached;
  const live = await until(f.watch, snapshot => snapshot.display.isRunning && !!snapshot.display.currentMessage);
  await abortNativeChat(f.session);
  const stopped = await until(f.watch, snapshot => !snapshot.display.isRunning);
  assert.ok(stopped.revision > live.revision);
  assert.ok(ends.includes('aborted'), 'Session reports abort before releasing the held provider');
  assert.equal(ends.includes('complete'), false);
  assert.equal(f.session.run.getRunId(), null); assert.equal(f.session.stream.isActive(), false);
  hold.release(); assert.ok(await f.settled() > 0, 'the fixture observed and joined an actual native producer');
  assert.equal(ends.includes('complete'), false, 'the stopped producer never completes after releasing the fixture');
  assert.equal(f.session.displayState.get().isRunning, false);
  const persisted = await f.runtime.controller.queryThreadMessages({ threadId: 'scheduled-stop', resourceId: 'scheduled-stop', perPage: false });
  assert.doesNotMatch(JSON.stringify(persisted.messages), /STOP_FINAL_MUST_NOT_PERSIST/);
  assert.equal((await f.runtime.mastra.schedules.get(schedule.id))?.status, 'paused', 'Stop does not change calendar pause');
});
