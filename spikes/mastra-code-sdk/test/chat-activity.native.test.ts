import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { createChatService, type CatalogSnapshot, type ChatService } from '../src/chat-service.js';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { serveRouter } from '../src/server.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function until(iterator: AsyncIterator<CatalogSnapshot>, predicate: (snapshot: CatalogSnapshot) => boolean) {
  for (;;) { const next = await iterator.next(); assert.equal(next.done, false); if (predicate(next.value)) return next.value; }
}
const row = (snapshot: CatalogSnapshot, chatId: string) => {
  const value = snapshot.chats.find(chat => chat.id === chatId); assert.ok(value); return value;
};

test('two clients project native running transitions, suspended semantics and dormant restart without activating catalog chats', { timeout: 45_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-chat-activity-')));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const fixture = await startModelFixture(request => {
    if (lastUserText(request) === 'ACTIVITY_QUESTION' && !request.messages.some(message => message.role === 'tool')) {
      return { toolCalls: [{ name: 'ask_user', arguments: { question: 'Which evidence?', options: [{ label: 'First' }] }, id: 'activity-question' }] };
    }
    return { text: 'ACTIVITY_NATIVE_RESULT' };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    lsp: false, observability: { enabled: false }, preferences: { yolo: true },
    models: { observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
  }));
  const sessions = new Set<NativeSession>(), producers = new Map<string, ReturnType<typeof gate>>();
  const suspended = new Set<string>(), cleanup: Array<() => void> = [];
  let runtime!: ProjectRuntime, service!: ChatService;
  let sessionCreations = 0;
  function open() {
    service = createChatService({ profile, instanceId: 'chat-activity-proof', directoryHome: cwd,
      projects: [{ id: 'project', name: 'Project', path: cwd, runtimeRoot: join(root, 'runtime') }],
      runtimeFactory: async input => {
        const mounted = await createProjectRuntime({ ...input, subagents: [],
          modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
        });
        if (input.runtimeRoot === join(root, 'runtime')) runtime = mounted;
        mounted.controller.onSessionCreated(session => {
          sessions.add(session); sessionCreations++;
          session.subscribe(event => {
            const runId = session.getCurrentRunId();
            if (event.type === 'tool_suspended' && runId) suspended.add(runId);
            if (event.type === 'agent_start' && runId) suspended.delete(runId);
          });
        });
        const register = mounted.mastra.__registerInternalWorkflow.bind(mounted.mastra);
        const unregister = mounted.mastra.__unregisterInternalWorkflow.bind(mounted.mastra);
        // Fixture only: native terminal/Stop events do not promise producer drain.
        t.mock.method(mounted.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
          const result = register(...args);
          if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], gate());
          return result;
        });
        t.mock.method(mounted.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
          unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.release();
        });
        return mounted;
      },
    });
  }
  async function settled() {
    let joined = -1;
    while (joined !== producers.size) {
      joined = producers.size;
      await Promise.all([...producers].map(([id, done]) => suspended.has(id) ? undefined : done.promise));
    }
  }
  open();
  let server = await serveRouter(createChatRouter(service), 0);
  const client = (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  t.after(async () => {
    for (const run of cleanup) run();
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    await settled(); await server.close(); await service.dispose(); await fixture.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = client(), second = client();
  const chat = await first.createChat({ projectId: 'project' });
  const idle = await second.listChats();
  assert.equal(row(idle, chat.id).isRunning, false, 'a mounted idle chat must have an explicit native activity boolean');
  const thread = await runtime.controller.queryThreadById({ threadId: chat.id }); assert.ok(thread);
  const session = await runtime.controller.getSessionByResource(thread.resourceId); assert.ok(session);
  const watching = new AbortController(); cleanup.push(() => watching.abort());
  const peers = await Promise.all([first, second].map(peer => peer.watchCatalog(undefined, { signal: watching.signal })));
  await Promise.all(peers.map(peer => peer.next()));

  // A captured catalog read overlaps the real start event. Its old revision
  // cannot be returned with the new activity state; the native read is retried.
  const query = runtime.controller.queryThreads.bind(runtime.controller), reached = gate(), release = gate();
  cleanup.push(release.release); let queries = 0;
  const spy = t.mock.method(runtime.controller, 'queryThreads', async (...input: Parameters<typeof query>) => {
    const result = await query(...input); queries++;
    if (queries === 1) { reached.release(); await release.promise; }
    return result;
  });
  const overlap = first.listChats(); await reached.promise;
  const completionHold = fixture.holdNext('ACTIVITY_COMPLETE'); cleanup.push(completionHold.release);
  await second.send({ chatId: chat.id, text: 'ACTIVITY_COMPLETE' }); await completionHold.reached;
  const activePeers = await Promise.all(peers.map(peer => until(peer, snapshot => row(snapshot, chat.id).isRunning === true)));
  release.release(); const captured = await overlap; spy.mock.restore();
  assert.ok(queries > 1, 'a native running transition invalidates an overlapping catalog read');
  assert.equal(row(captured, chat.id).isRunning, true);
  assert.ok(captured.revision > idle.revision);
  assert.ok(activePeers.every(snapshot => snapshot.revision > idle.revision));
  assert.equal(row(await client().listChats(), chat.id).isRunning, true, 'a client that missed start events refills native activity');
  const completed = gate();
  const offEnd = session.subscribe(event => { if (event.type === 'agent_end' && event.reason === 'complete') completed.release(); }); t.after(offEnd);
  completionHold.release(); await completed.promise; await settled();
  const finishedPeers = await Promise.all(peers.map(peer => until(peer, snapshot => !row(snapshot, chat.id).isRunning)));
  assert.ok(finishedPeers.every((snapshot, index) => snapshot.revision > activePeers[index]!.revision));
  assert.equal(row(await client().listChats(), chat.id).isRunning, false);

  const stopHold = fixture.holdNext('ACTIVITY_STOP'); cleanup.push(stopHold.release);
  await first.send({ chatId: chat.id, text: 'ACTIVITY_STOP' }); await stopHold.reached;
  const stoppingPeers = await Promise.all(peers.map(peer => until(peer, snapshot => row(snapshot, chat.id).isRunning)));
  assert.deepEqual(await second.stop({ chatId: chat.id }), { accepted: true });
  const stoppedPeers = await Promise.all(peers.map(peer => until(peer, snapshot => !row(snapshot, chat.id).isRunning)));
  assert.ok(stoppedPeers.every((snapshot, index) => snapshot.revision > stoppingPeers[index]!.revision));
  assert.equal(session.displayState.get().isRunning, false);
  stopHold.release(); await settled();
  assert.ok(producers.size > 0, 'the teardown observer joined actual native producers');
  assert.equal(row(await first.listChats(), chat.id).isRunning, false);

  const parked = gate();
  const offPark = session.subscribe(event => { if (event.type === 'agent_end' && event.reason === 'suspended') parked.release(); }); t.after(offPark);
  await first.send({ chatId: chat.id, text: 'ACTIVITY_QUESTION' }); await parked.promise;
  assert.ok(session.displayState.get().pendingSuspensions.size > 0);
  assert.equal(session.displayState.get().isRunning, false, 'a parked native question is suspended rather than running');
  assert.equal(row(await second.listChats(), chat.id).isRunning, false, 'catalog uses the native boolean without inventing a pending activity state');
  const snapshot = await second.openChat({ chatId: chat.id });
  const question = snapshot.prompts.find(prompt => prompt.kind === 'question'); assert.ok(question);
  const answered = gate();
  const offAnswer = session.subscribe(event => { if (event.type === 'agent_end' && event.reason === 'complete') answered.release(); }); t.after(offAnswer);
  await first.respondPrompt({ chatId: chat.id, kind: 'question', target: question.target, answer: 'First' });
  await answered.promise; await settled();
  assert.equal(row(await first.listChats(), chat.id).isRunning, false);
  watching.abort(); await Promise.all(peers.map(peer => peer.return().catch(() => undefined)));
  const requestsBefore = fixture.requests.length, creationsBefore = sessionCreations;
  await server.close(); await service.dispose(); open();
  server = await serveRouter(createChatRouter(service), 0);
  const restarted = await client().listChats();
  assert.notEqual(restarted.epoch, idle.epoch);
  assert.equal(row(restarted, chat.id).isRunning, false);
  assert.equal(await runtime.controller.getSessionByResource(thread.resourceId), undefined);
  assert.equal(sessionCreations, creationsBefore, 'catalog refill after restart creates no native Session');
  assert.equal(fixture.requests.length, requestsBefore);
});
