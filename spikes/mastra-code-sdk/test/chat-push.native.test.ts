import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@libsql/client';
import webPush from 'web-push';
import { createChatService } from '../src/chat-service.js';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import type { PushPayload } from '../src/push-sender.js';
import { startModelFixture } from './fixtures/model-server.js';

async function until<T>(read: () => Promise<T | undefined>) {
  const end = Date.now() + 5000;
  for (;;) { const value = await read(); if (value !== undefined) return value; if (Date.now() > end) throw new Error('Native notification capture did not settle'); await delay(10); }
}
test('native terminal capture delivers independently of seen and rechecks presence, preference, archive and restart', { timeout: 35_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-chat-push-')));
  const profile = activateProfile(resolveProfile(join(root, 'profile'))), cwd = join(root, 'project'); await mkdir(cwd);
  const model = await startModelFixture(() => ({ text: 'NATIVE_PUSH_ANSWER' }));
  await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false }, preferences: { yolo: true },
    models: { observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: model.url, apiKey: 'local-not-a-real-key', models: ['chat'] }],
  }));
  const sent: PushPayload[] = [], outputs: Promise<unknown>[] = [];
  let runtime!: ProjectRuntime, creations = 0, now = 0;
  const config = { ...webPush.generateVAPIDKeys(), subject: 'mailto:test@example.test', recheckDelayMs: 2000 };
  const make = () => createChatService({ profile, instanceId: 'native-push-proof', directoryHome: cwd,
    push: { config, pollIntervalMs: 0, now: () => now, sender: async (_subscription, payload) => { sent.push(payload); return 'sent'; } },
    projects: [{ id: 'project', name: 'Project', path: cwd, runtimeRoot: join(root, 'runtime') }],
    runtimeFactory: async options => {
      const mounted = await createProjectRuntime({ ...options, subagents: [], modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
      if (options.runtimeRoot === join(root, 'runtime')) runtime = mounted;
      mounted.controller.onSessionCreated(() => { creations++; }); return mounted;
    },
  });
  let service = make(), push = await service.push();
  const db = createClient({ url: pathToFileURL(join(profile.appDataDir, 'push.db')).href });
  t.after(async () => { await Promise.allSettled(outputs); db.close(); await service.dispose(); await model.close(); await rm(root, { recursive: true, force: true }); });
  await push.upsert({ endpoint: 'https://push.example.test/device', keys: { p256dh: 'fixture', auth: 'fixture' } });
  const chat = await service.createChat({ projectId: 'project' }); await service.renameChat({ chatId: chat.id, title: 'Native notification target' });
  const thread = await runtime.controller.queryThreadById({ threadId: chat.id }); assert.ok(thread);
  const session = await runtime.controller.getSessionByResource(thread.resourceId); assert.ok(session);
  function joinOutput(session: NativeSession) {
    const agent = session.machinery.getAgent(), send = agent.sendSignal.bind(agent);
    t.mock.method(agent, 'sendSignal', (...args: Parameters<typeof send>) => {
      const admission = send(...args), done = admission.accepted.then(result => result.action === 'wake' ? result.output.getFullOutput() : undefined);
      outputs.push(done); void done.catch(() => {}); return admission;
    });
  }
  joinOutput(session);
  async function row(runId: string) {
    return (await db.execute('SELECT event_json,status FROM deliveries')).rows.find(row => row.event_json && JSON.parse(String(row.event_json)).runId === runId);
  }
  async function turn() {
    await session!.sendMessage({ content: 'NATIVE_PUSH' }); await Promise.all(outputs);
    const state = (await service.listChats()).chats.find(row => row.id === chat.id)!.readState; assert.ok(state.head);
    await until(async () => await row(state.head!.runId));
    return state;
  }
  const completed = await turn();
  await service.markChatSeen({ chatId: chat.id, epoch: completed.epoch, revision: completed.revision, runId: completed.head!.runId });
  now += 2000; await push.processDue();
  assert.equal(sent.length, 1, 'seen is independent of push eligibility');
  assert.equal(sent[0]!.title, 'Native notification target'); assert.equal(sent[0]!.route, `/threads/${chat.id}`);
  await push.processDue(); assert.equal(sent.length, 1, 'one terminal event does not redeliver');
  await service.replaceChatPresence({ clientId: 'peer', visibleThreadIds: [chat.id] });
  const viewed = await turn(); now += 2000; await push.processDue();
  assert.equal((await row(viewed.head!.runId))!.status, 'skipped'); assert.equal(sent.length, 1);
  await service.replaceChatPresence({ clientId: 'peer', visibleThreadIds: [] });
  await service.setChatNotifications({ chatId: chat.id, enabled: false });
  const muted = await turn(); now += 2000; await push.processDue();
  assert.equal((await row(muted.head!.runId))!.status, 'skipped'); assert.equal(sent.length, 1);
  await service.setChatNotifications({ chatId: chat.id, enabled: true });
  await turn();
  const beforeRestart = { creations, requests: model.requests.length };
  await service.dispose(); service = make(); push = await service.push();
  assert.equal((await service.listChats()).chats.find(row => row.id === chat.id)!.readState.head, null);
  now += 2000; await push.processDue(); assert.equal(sent.length, 2, 'a captured transport job survives restart without reconstructing read state');
  assert.equal((await service.listChats()).chats.find(row => row.id === chat.id)!.readState.head, null);
  assert.equal(creations, beforeRestart.creations); assert.equal(model.requests.length, beforeRestart.requests);
  // A queued transport event must still respect current native archive metadata.
  const id = await push.enqueueTerminal({ bindingId: chat.bindingId, threadId: chat.id, runId: 'queued-before-archive', reason: 'complete' }); assert.ok(id);
  await service.archiveChat({ chatId: chat.id }); now += 2000; await push.processDue();
  assert.equal((await row('queued-before-archive'))!.status, 'skipped'); assert.equal(sent.length, 2);
});
