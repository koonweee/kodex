import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { createChatService } from '../src/chat-service.js';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { serveRouter } from '../src/server.js';
import { startModelFixture } from './fixtures/model-server.js';

function gate() { let release!: () => void; return { promise: new Promise<void>(done => { release = done; }), release }; }

test('two HTTP clients read canonical badges and metadata-only presence, including archive and dormant restart', { timeout: 35_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-chat-notifications-')));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const model = await startModelFixture(() => ({ text: 'BADGE_NATIVE_FINAL' }));
  await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false }, preferences: { yolo: true },
    models: { observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: model.url, apiKey: 'local-not-a-real-key', models: ['chat'] }],
  }));
  const runtimes: ProjectRuntime[] = [], outputs: Promise<unknown>[] = [], release: Array<() => void> = [];
  let creations = 0;
  const makeService = () => createChatService({ profile, instanceId: 'notification-proof', directoryHome: cwd,
    projects: [{ id: 'project', name: 'Project', path: cwd, runtimeRoot: join(root, 'runtime') }],
    runtimeFactory: async input => {
      const runtime = await createProjectRuntime({ ...input, subagents: [], modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
      runtimes.push(runtime); runtime.controller.onSessionCreated(() => { creations++; }); return runtime;
    },
  });
  let service = makeService(), server = await serveRouter(createChatRouter(service), 0);
  const client = (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  t.after(async () => {
    for (const done of release) done();
    await Promise.allSettled(outputs); await server.close(); await service.dispose(); await model.close(); await rm(root, { recursive: true, force: true });
  });
  const first = client(), second = client();
  const empty = await first.getUnreadBadge();
  assert.deepEqual(empty, { epoch: (await second.listChats()).epoch, revision: empty.revision, count: 0 });
  assert.equal((await second.getUnreadBadge()).count, 0); assert.equal(creations, 0); assert.equal(model.requests.length, 0);
  assert.deepEqual(await first.replaceChatPresence({ clientId: 'tab', visibleThreadIds: [] }), { accepted: true });
  for (const invalid of [{ clientId: '', visibleThreadIds: [] }, { clientId: 'tab', visibleThreadIds: [''] }, { clientId: 'tab', visibleThreadIds: ['missing'], bindingId: 'browser-choice' }]) {
    await assert.rejects(first.replaceChatPresence(invalid as never), { code: 'BAD_REQUEST' });
  }
  await assert.rejects(first.replaceChatPresence({ clientId: 'tab', visibleThreadIds: ['missing'] }), { code: 'NOT_FOUND' });
  assert.equal(creations, 0); assert.equal(model.requests.length, 0);

  const chat = await first.createChat({ projectId: 'project' });
  assert.equal((await second.getUnreadBadge()).count, null, 'an idle native chat does not establish a known completion head');
  const runtime = runtimes.find(runtime => runtime.runtimeRoot === join(root, 'runtime')); assert.ok(runtime);
  const thread = await runtime.controller.queryThreadById({ threadId: chat.id }); assert.ok(thread);
  const session = await runtime.controller.getSessionByResource(thread.resourceId); assert.ok(session);
  const agent = session.machinery.getAgent(), sendSignal = agent.sendSignal.bind(agent);
  t.mock.method(agent, 'sendSignal', (...args: Parameters<typeof sendSignal>) => {
    const admission = sendSignal(...args);
    const finished = admission.accepted.then(result => result.action === 'wake' ? result.output.getFullOutput() : undefined);
    outputs.push(finished); void finished.catch(() => {}); return admission;
  });
  await session.sendMessage({ content: 'BADGE_COMPLETE' }); await Promise.allSettled(outputs);
  const unread = await first.getUnreadBadge(); assert.equal(unread.count, 1); assert.ok(unread.revision > empty.revision);
  assert.deepEqual(await second.getUnreadBadge(), unread);
  await first.setChatNotifications({ chatId: chat.id, enabled: false });
  assert.equal((await second.getUnreadBadge()).count, 1, 'notification preferences do not change read state');
  await first.replaceChatPresence({ clientId: 'first', visibleThreadIds: [chat.id] });
  await second.replaceChatPresence({ clientId: 'second', visibleThreadIds: [chat.id] });
  assert.equal((await first.getUnreadBadge()).count, 1, 'presence itself does not mark a head seen');
  const terminal = (await second.listChats()).chats.find(row => row.id === chat.id)!.readState; assert.ok(terminal.head);
  await first.markChatSeen({ chatId: chat.id, epoch: terminal.epoch, revision: terminal.revision, runId: terminal.head.runId });
  assert.equal((await second.getUnreadBadge()).count, 0);
  const unknown = await second.createChat({ projectId: 'project' }); assert.equal((await first.getUnreadBadge()).count, null);
  const beforeArchiveQuery = runtime.controller.queryThreads.bind(runtime.controller), archiveReached = gate(), archiveHeld = gate(); release.push(archiveHeld.release);
  let archiveReads = 0;
  const archiveObservation = t.mock.method(runtime.controller, 'queryThreads', async (...args: Parameters<typeof beforeArchiveQuery>) => {
    const result = await beforeArchiveQuery(...args); archiveReads++;
    if (archiveReads === 1) { archiveReached.release(); await archiveHeld.promise; }
    return result;
  });
  const obsoletePresence = second.replaceChatPresence({ clientId: 'second', visibleThreadIds: [chat.id, unknown.id] });
  void obsoletePresence.catch(() => {});
  await archiveReached.promise; await first.archiveChat({ chatId: unknown.id }); archiveHeld.release();
  await assert.rejects(obsoletePresence, { code: 'CONFLICT' }); archiveObservation.mock.restore();
  assert.equal((await second.getUnreadBadge()).count, 0);
  await assert.rejects(second.replaceChatPresence({ clientId: 'second', visibleThreadIds: [chat.id, unknown.id] }), { code: 'CONFLICT' });

  // Release native pane ownership, then prove the presence route and badge read
  // use metadata without remounting a Session or requesting another model run.
  await runtime.releaseSession({ resourceId: thread.resourceId });
  const before = { creations, requests: model.requests.length };
  const query = runtime.controller.queryThreads.bind(runtime.controller), reached = gate(), held = gate(); release.push(held.release);
  let calls = 0;
  const observation = t.mock.method(runtime.controller, 'queryThreads', async (...args: Parameters<typeof query>) => {
    const result = await query(...args); calls++;
    if (calls === 1) { reached.release(); await held.promise; }
    return result;
  });
  const older = first.replaceChatPresence({ clientId: 'tab', visibleThreadIds: [chat.id] }); await reached.promise;
  assert.deepEqual(await second.replaceChatPresence({ clientId: 'tab', visibleThreadIds: [] }), { accepted: true }, 'clearing does not wait for an earlier native metadata read');
  assert.equal(calls, 1, 'empty presence replacement makes no native lookup');
  held.release(); assert.deepEqual(await older, { accepted: true }); observation.mock.restore();
  assert.equal((await second.getUnreadBadge()).count, 0);
  assert.equal(creations, before.creations); assert.equal(model.requests.length, before.requests);
  assert.equal(await runtime.controller.getSessionByResource(thread.resourceId), undefined);
  await server.close(); await service.dispose();
  service = makeService(); server = await serveRouter(createChatRouter(service), 0);
  const restarted = client();
  const afterRestart = await restarted.getUnreadBadge();
  assert.notEqual(afterRestart.epoch, empty.epoch); assert.equal(afterRestart.count, null, 'accepted native-only restart begins unknown, including formerly seen work');
  assert.equal(creations, before.creations); assert.equal(model.requests.length, before.requests);
  await restarted.archiveChat({ chatId: chat.id });
  assert.equal((await restarted.getUnreadBadge()).count, 0, 'the complete known-empty eligible inventory can clear the badge');
  assert.equal(creations, before.creations); assert.equal(model.requests.length, before.requests);
});
