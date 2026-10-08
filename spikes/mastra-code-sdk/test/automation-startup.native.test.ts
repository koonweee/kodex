import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChatService } from '../src/chat-service.js';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { startModelFixture } from './fixtures/model-server.js';

test('pinned native direct-agent startup advances an overdue calendar before its delivery subscriber exists', { timeout: 20_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-automation-startup-')));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const model = await startModelFixture(() => ({ text: 'BOOT_SCHEDULE_ANSWER' }));
  await writeFile(profile.settingsPath, JSON.stringify({
    customProviders: [{ name: 'fixture', url: model.url, apiKey: 'fake-local-key', models: ['chat'] }],
    models: { observerModelOverride: null, reflectorModelOverride: null }, preferences: { yolo: true },
    lsp: false, observability: { enabled: false },
  }));
  const runtimes: ProjectRuntime[] = [];
  let preparations = 0;
  const makeService = () => createChatService({ profile, instanceId: 'automation-startup', directoryHome: root,
    runtimeFactory: async options => {
      const prepare = options.schedules?.prepare;
      const runtime = await createProjectRuntime({ ...options, subagents: [],
        modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
        schedules: { ...options.schedules, async prepare(input) {
          preparations++;
          return prepare?.(input);
        } },
      });
      runtimes.push(runtime); return runtime;
    },
  });
  let service = makeService();
  t.after(async () => { await service.dispose(); await model.close(); await rm(root, { recursive: true, force: true }); });
  const chat = await service.createChat({});
  const original = runtimes[0]!;
  const thread = await original.controller.queryThreadById({ threadId: chat.id }); assert.ok(thread);
  const schedule = await original.mastra.schedules.create({ agentId: original.codeAgent.id,
    threadId: thread.id, resourceId: thread.resourceId, prompt: 'BOOT_SCHEDULE_WAKE',
    cron: '0 0 1 1 *', timezone: 'UTC', status: 'paused', metadata: { kodexAutomation: 1 } });
  // Stop the public workers before changing persisted timing so the first
  // service cannot consume the due fire intended for the next native boot.
  await original.mastra.stopWorkers();
  const originalStore = await original.mastra.getStorage()?.getStore('schedules'); assert.ok(originalStore);
  const overdue = Date.now() - 60_000;
  await originalStore.updateSchedule(schedule.id, { status: 'active', nextFireAt: overdue });
  await service.dispose(); service = makeService();
  await service.initializeAutomations();
  const reopened = runtimes.at(-1)!; assert.notEqual(reopened, original);
  const claimed = await reopened.mastra.schedules.get(schedule.id); assert.ok(claimed);
  assert.ok(claimed.nextFireAt > overdue, 'native boot tick actually claimed and advanced the overdue fire');
  assert.ok(typeof claimed.lastFireAt === 'number' && claimed.lastFireAt > overdue);
  // Native stopWorkers joins any admitted dispatch. This is an actual claim
  // witness plus a dispatch boundary, not a timer-based absence assertion.
  await reopened.mastra.stopWorkers();
  const store = await reopened.mastra.getStorage()?.getStore('schedules'); assert.ok(store);
  const triggers = await store.listTriggers(schedule.id, { limit: 10 });
  t.diagnostic(JSON.stringify({ preparations, modelRequests: model.requests.length, triggers,
    overdue, nextFireAt: claimed.nextFireAt, lastFireAt: claimed.lastFireAt }));
  assert.equal(preparations, 0, 'pinned startup fire is lost before the host prepare hook');
  assert.equal(model.requests.length, 0, 'lost native startup fire never reaches the model');
  assert.deepEqual(triggers, [], 'native agent worker never records a delivery outcome');
  assert.equal(await reopened.controller.getSessionByResource(thread.resourceId), undefined,
    'lost startup publication does not activate the saved target');
});
