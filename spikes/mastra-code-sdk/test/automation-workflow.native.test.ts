import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAsyncQuestionTools } from '../src/async-question-tools.js';
import { createChatService } from '../src/chat-service.js';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

test('a persisted workflow schedule delivers an overdue boot fire through normal chat input and SDK toolsets', { timeout: 20_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-automation-workflow-')));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const model = await startModelFixture(request => request.messages.some(message => message.role === 'tool')
    ? { text: 'WORKFLOW_SCHEDULE_ANSWER' }
    : { toolCalls: [{ name: 'view', arguments: { path: 'scheduled-evidence.txt' }, id: 'workflow-scheduled-view' }] });
  await writeFile(profile.settingsPath, JSON.stringify({
    customProviders: [{ name: 'fixture', url: model.url, apiKey: 'fake-local-key', models: ['chat'] }],
    models: { observerModelOverride: null, reflectorModelOverride: null }, preferences: { yolo: true },
    lsp: false, observability: { enabled: false },
  }));
  const runtimes: ProjectRuntime[] = [];
  const makeService = () => createChatService({ profile, instanceId: 'automation-workflow', directoryHome: root,
    runtimeFactory: async options => {
      const runtime = await createProjectRuntime({ ...options, subagents: [],
        extraTools: createAsyncQuestionTools(),
        modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
      runtimes.push(runtime); return runtime;
    },
  });
  let service = makeService();
  const abort = new AbortController();
  const hold = model.holdNext('WORKFLOW_BOOT_WAKE');
  t.after(async () => { hold.release(); abort.abort(); await service.dispose(); await model.close(); await rm(root, { recursive: true, force: true }); });
  const chat = await service.createChat({});
  const original = runtimes[0]!;
  const thread = await original.controller.queryThreadById({ threadId: chat.id }); assert.ok(thread);
  await writeFile(join(original.projectPath, 'scheduled-evidence.txt'), 'REAL_WORKFLOW_FILE_EVIDENCE');
  const schedule = await service.automations.create({ name: 'Boot delivery', targetThreadId: thread.id,
    prompt: 'WORKFLOW_BOOT_WAKE', cron: '0 0 1 1 *', timezone: 'UTC' });
  await service.automations.pause({ id: schedule.id });
  await original.mastra.stopWorkers();
  const originalStore = await original.mastra.getStorage()?.getStore('schedules'); assert.ok(originalStore);
  const overdue = Date.now() - 60_000;
  await originalStore.updateSchedule(schedule.id, { status: 'active', nextFireAt: overdue });
  assert.equal(model.requests.length, 0);
  await service.dispose(); service = makeService();
  await service.initializeAutomations(); await hold.reached;
  const reopened = runtimes.at(-1)!; assert.notEqual(reopened, original);
  const native = await reopened.mastra.schedules.get(schedule.id); assert.ok(native);
  assert.ok(native.nextFireAt > overdue, 'the recreated native scheduler claims its already-due calendar');
  assert.equal(model.requests.length, 1, 'the boot fire reaches the held provider once');
  const request = model.requests.find(request => lastUserText(request).includes('WORKFLOW_BOOT_WAKE')); assert.ok(request);
  const tools = request.tools?.map(tool => tool.function.name) ?? [];
  for (const name of ['view', 'ask_user', 'submit_plan', 'task_write', 'request_user_input_async']) {
    assert.ok(tools.includes(name), `normal native Session dispatch exposes ${name}`);
  }
  const session = await reopened.controller.getSessionByResource(thread.resourceId); assert.ok(session);
  assert.equal(session.displayState.get().isRunning, true, 'the held scheduled request is a mounted native run');
  const peers = [service.watchChat({ chatId: thread.id }, abort.signal), service.watchChat({ chatId: thread.id }, abort.signal)];
  t.after(async () => { abort.abort(); await Promise.all(peers.map(watch => watch.return().catch(() => undefined))); });
  const live = await Promise.all(peers.map(watch => watch.next()));
  for (const row of live) { assert.equal(row.done, false); assert.equal(row.value!.display.isRunning, true); }
  const ended = new Promise<void>(resolve => {
    const off = session.subscribe(event => { if (event.type === 'agent_end' && event.reason === 'complete') { off(); resolve(); } });
    t.after(off);
  });
  hold.release(); await ended;
  for (const watch of peers) {
    for (;;) {
      const row = await watch.next(); assert.equal(row.done, false);
      if (!row.value!.display.isRunning && JSON.stringify(row.value!.messages).includes('WORKFLOW_SCHEDULE_ANSWER')) break;
    }
  }
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  if (memory && 'settled' in memory && typeof memory.settled === 'function') await memory.settled();
  const saved = await reopened.controller.queryThreadMessages({ threadId: thread.id, resourceId: thread.resourceId, perPage: false });
  assert.match(JSON.stringify(saved), /REAL_WORKFLOW_FILE_EVIDENCE/);
  assert.match(JSON.stringify(saved), /WORKFLOW_SCHEDULE_ANSWER/);
  const store = await reopened.mastra.getStorage()?.getStore('schedules'); assert.ok(store);
  const triggers = await store.listTriggers(schedule.id);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0]!.scheduledFireAt, overdue);
  assert.equal(triggers[0]!.outcome, 'published', 'workflow schedule history records native publication, not chat completion');
});
