import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { AUTOMATION_WORKFLOW_ID } from '../src/automation-workflow.js';
import { createChatService } from '../src/chat-service.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

test('host initializes stored schedules without a browser and binds a native wake to the shared chat projection', { timeout: 20_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-automation-host-')));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const model = await startModelFixture(request => ({ text: `SCHEDULED_ANSWER:${lastUserText(request)}` }));
  await writeFile(profile.settingsPath, JSON.stringify({
    customProviders: [{ name: 'fixture', url: model.url, apiKey: 'fake-local-key', models: ['chat'] }],
    models: { observerModelOverride: null, reflectorModelOverride: null },
    preferences: { yolo: true }, lsp: false, observability: { enabled: false },
  }));
  const runtimes: ProjectRuntime[] = [];
  const makeService = () => createChatService({ profile, instanceId: 'automation-host', directoryHome: root,
    runtimeFactory: async options => {
      const runtime = await createProjectRuntime({ ...options, subagents: [],
        modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
      runtimes.push(runtime); return runtime;
    },
  });
  let service = makeService();
  const stopped = new AbortController();
  t.after(async () => { stopped.abort(); await service.dispose(); await model.close(); await rm(root, { recursive: true, force: true }); });
  const chat = await service.createChat({});
  const firstRuntime = runtimes[0]!;
  const nativeThread = await firstRuntime.controller.queryThreadById({ threadId: chat.id });
  assert.ok(nativeThread);
  const schedule = await service.automations.create({ name: 'Host wake', targetThreadId: nativeThread.id,
    prompt: 'HOST_SCHEDULE_WAKE', cron: '0 0 1 1 *', timezone: 'UTC' });
  await service.automations.pause({ id: schedule.id });
  await service.dispose(); service = makeService();
  await service.initializeAutomations();
  const runtime = runtimes.at(-1)!;
  assert.notEqual(runtime, firstRuntime);
  assert.equal(await runtime.controller.getSessionByResource(nativeThread.resourceId), undefined);
  await t.test('a malformed scheduled resource fails without activating its dormant target', async () => {
    const wrongResource = `${nativeThread.resourceId}:wrong-resource`;
    const requestsBefore = model.requests.length;
    const run = await runtime.mastra.getWorkflow(AUTOMATION_WORKFLOW_ID).createRun({ resourceId: wrongResource });
    const result = await run.start({ inputData: { name: 'Malformed', targetThreadId: nativeThread.id, prompt: 'HOST_MALFORMED_RESOURCE' } });
    assert.equal(result.status, 'failed', 'the native delivery step rejects the mismatched resource');
    assert.equal(model.requests.length, requestsBefore, 'a rejected target does not contact the provider');
    assert.equal(await runtime.controller.getSessionByResource(wrongResource), undefined);
    assert.equal(await runtime.controller.getSessionByResource(nativeThread.resourceId), undefined,
      'checking a malformed schedule must not mount the valid dormant target');
  });
  const hold = model.holdNext('HOST_SCHEDULE_WAKE'); t.after(hold.release);
  await runtime.mastra.schedules.run(schedule.id); await hold.reached;
  const first = service.watchChat({ chatId: nativeThread.id }, stopped.signal);
  const second = service.watchChat({ chatId: nativeThread.id }, stopped.signal);
  const live = await Promise.all([first.next(), second.next()]);
  for (const snapshot of live) { assert.equal(snapshot.done, false); assert.equal(snapshot.value!.display.isRunning, true); }
  const session = await runtime.controller.getSessionByResource(nativeThread.resourceId); assert.ok(session);
  const ended = new Promise<void>(resolve => {
    const off = session.subscribe(event => { if (event.type === 'agent_end') { off(); resolve(); } });
  });
  hold.release(); await ended;
  for (const watch of [first, second]) {
    for (;;) {
      const row = await watch.next(); assert.equal(row.done, false);
      if (!row.value!.display.isRunning && JSON.stringify(row.value!.messages).includes('started:HOST_SCHEDULE_WAKE')) break;
    }
  }
  stopped.abort(); await Promise.all([first.return(), second.return()]);
  assert.equal((await runtime.mastra.schedules.get(schedule.id))?.status, 'paused');

  await t.test('ChatService.stop aborts a scheduled wake for both watchers before provider release', { timeout: 10_000 }, async t => {
    const producers = new Map<string, { promise: Promise<void>; finish: () => void }>();
    const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
    const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
    // Fixture-only passthrough joins late persistence after Stop. Public Stop
    // acknowledgment and the idle projection are not a producer-drain promise.
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
      while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(row => row.promise)); }
    }
    const stoppingChat = await service.createChat({});
    const thread = await runtime.controller.queryThreadById({ threadId: stoppingChat.id }); assert.ok(thread);
    const stoppingSession = await runtime.controller.getSessionByResource(thread.resourceId); assert.ok(stoppingSession);
    const abort = new AbortController();
    const peers = [service.watchChat({ chatId: thread.id }, abort.signal), service.watchChat({ chatId: thread.id }, abort.signal)];
    const stopHold = model.holdNext('HOST_SCHEDULE_STOP');
    t.after(async () => {
      stopHold.release(); abort.abort();
      await Promise.all(peers.map(watch => watch.return().catch(() => undefined)));
      stoppingSession.abort(); await settled();
    });
    const ends: string[] = [];
    let reportAbort!: () => void;
    const aborted = new Promise<void>(resolve => { reportAbort = resolve; });
    const off = stoppingSession.subscribe(event => {
      if (event.type === 'agent_end') { ends.push(event.reason ?? 'unknown'); if (event.reason === 'aborted') reportAbort(); }
    });
    t.after(off);
    const stoppingSchedule = await service.automations.create({ name: 'Host stop', targetThreadId: thread.id,
      prompt: 'HOST_SCHEDULE_STOP', cron: '0 0 1 1 *', timezone: 'UTC' });
    await service.automations.pause({ id: stoppingSchedule.id });
    await runtime.mastra.schedules.run(stoppingSchedule.id); await stopHold.reached;
    const livePeers = await Promise.all(peers.map(watch => watch.next()));
    for (const row of livePeers) { assert.equal(row.done, false); assert.equal(row.value!.display.isRunning, true); }
    assert.deepEqual(await service.stop({ chatId: thread.id }), { accepted: true });
    const idlePeers = await Promise.all(peers.map(async watch => {
      for (;;) {
        const row = await watch.next(); assert.equal(row.done, false);
        if (!row.value!.display.isRunning) return row.value!;
      }
    }));
    for (let i = 0; i < idlePeers.length; i++) assert.ok(idlePeers[i]!.revision > livePeers[i]!.value!.revision);
    await aborted;
    assert.ok(ends.includes('aborted'), 'the native run aborts before its held provider is released');
    assert.equal(ends.includes('complete'), false);
    stopHold.release(); await settled();
    assert.ok(producers.size > 0, 'fixture observed a real native producer before joining its writes');
    assert.equal(ends.includes('complete'), false, 'releasing the provider cannot complete the stopped run');
    assert.equal(stoppingSession.displayState.get().isRunning, false);
    assert.equal(stoppingSession.run.getRunId(), null);
    // Partial aborted text may persist; no saved-input durability or public
    // producer-drain guarantee follows from the Stop acknowledgment.
    assert.equal((await runtime.mastra.schedules.get(stoppingSchedule.id))?.status, 'paused');
    assert.equal((await runtime.mastra.schedules.get(schedule.id))?.status, 'paused');
  });
});
