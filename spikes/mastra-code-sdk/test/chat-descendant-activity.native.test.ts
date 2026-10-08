import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
import { startModelFixture } from './fixtures/model-server.js';

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function until(iterator: AsyncIterator<CatalogSnapshot>, matches: (snapshot: CatalogSnapshot) => boolean) {
  for (;;) { const next = await iterator.next(); assert.equal(next.done, false); if (matches(next.value)) return next.value; }
}
function descendant(snapshot: CatalogSnapshot, id: string) {
  const row = snapshot.pinnedDescendants.find(chat => chat.id === id); assert.ok(row); return row;
}
function parent(snapshot: CatalogSnapshot) {
  const row = snapshot.chats.find(chat => chat.id === 'parent'); assert.ok(row); return row;
}

test('two catalog clients observe host child and scoped fork native activity without opening handles or activating dormant descendants', { timeout: 45_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-descendant-activity-')));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const fixture = await startModelFixture(() => ({ text: 'DESCENDANT_ACTIVITY_RESULT' }));
  await writeFile(profile.settingsPath, JSON.stringify({
    lsp: false, observability: { enabled: false }, preferences: { yolo: true },
    models: { observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
  }));
  const sessions = new Set<NativeSession>(), producers = new Map<string, ReturnType<typeof gate>>();
  const cleanup: Array<() => void> = [];
  let runtime!: ProjectRuntime, service!: ChatService, mounts = 0;
  function open() {
    service = createChatService({ profile, instanceId: 'descendant-activity-proof', directoryHome: root,
      runtimeFactory: async input => {
        const mounted = await createProjectRuntime({ ...input, subagents: [],
          modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
        });
        runtime = mounted;
        mounted.controller.onSessionCreated(session => { sessions.add(session); mounts++; });
        const register = mounted.mastra.__registerInternalWorkflow.bind(mounted.mastra);
        const unregister = mounted.mastra.__unregisterInternalWorkflow.bind(mounted.mastra);
        // Fixture teardown joins native producers; Stop is not a producer-drain promise.
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
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(done => done.promise)); }
  }
  open();
  let server = await serveRouter(createChatRouter(service), 0);
  const client = (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  t.after(async () => {
    for (const release of cleanup) release();
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    await settled(); await server.close(); await service.dispose(); await fixture.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = client(), second = client();
  await first.listModels({ projectId: null });
  const store = await runtime.storage.getStore('memory'); assert.ok(store);
  const now = new Date();
  const save = (id: string, resourceId: string, metadata: Record<string, unknown>) => store.saveThread({ thread: { id, resourceId, title: id, createdAt: now, updatedAt: now, metadata } });
  await save('parent', 'parent-resource', { projectPath: root });
  await save('child', 'child-resource', { projectPath: root, kodexChild: '1', parentThreadId: 'parent', parentResourceId: 'parent-resource', parentSessionScope: '', parentTaskId: 'activity-child-task' });
  await save('fork', 'parent-resource', { forkedSubagent: true, parentThreadId: 'parent' });
  await first.setChatPinned({ chatId: 'child', pinned: true });
  await second.setChatPinned({ chatId: 'fork', pinned: true });
  const dormant = await first.listChats();
  for (const id of ['child', 'fork']) assert.equal(descendant(dormant, id).isRunning, false, 'dormant pinned descendants expose an explicit native activity boolean');
  assert.equal(parent(dormant).isRunning, false);
  assert.equal(mounts, 0, 'pinning and catalog reads create no native Session');
  assert.equal(fixture.requests.length, 0);

  // These host bindings match child-tool creation: no openChat/watchChat handle.
  const idleParent = await runtime.createSession({ resourceId: 'parent-resource', threadId: 'parent' });
  const child = await runtime.createSession({ resourceId: 'child-resource', threadId: 'child' });
  const scope = 'activity/arbitrary-fork-scope';
  const fork = await runtime.createSession({ resourceId: 'parent-resource', threadId: 'fork', scope });
  assert.notEqual(fork, idleParent); assert.equal(idleParent.thread.getId(), 'parent');
  const watching = new AbortController(); cleanup.push(() => watching.abort());
  const peers = await Promise.all([first, second].map(peer => peer.watchCatalog(undefined, { signal: watching.signal })));
  await Promise.all(peers.map(peer => peer.next()));

  const childHold = fixture.holdNext('CHILD_ACTIVITY_COMPLETE'); cleanup.push(childHold.release);
  await child.sendSignal({ type: 'user', contents: 'CHILD_ACTIVITY_COMPLETE' }, { untilIdle: false, requireDelivery: true }).accepted;
  await childHold.reached;
  const active = await Promise.all(peers.map(peer => until(peer, snapshot => descendant(snapshot, 'child').isRunning === true)));
  for (const snapshot of active) {
    assert.ok(snapshot.revision > dormant.revision);
    assert.equal(parent(snapshot).isRunning, false);
    assert.equal(descendant(snapshot, 'fork').isRunning, false, 'the unrelated scoped fork stays idle');
  }
  assert.equal(descendant(await client().listChats(), 'child').isRunning, true, 'a peer that missed the native start converges through catalog refill');

  const forkHold = fixture.holdNext('FORK_ACTIVITY_STOP'); cleanup.push(forkHold.release);
  await fork.sendSignal({ type: 'user', contents: 'FORK_ACTIVITY_STOP' }, { untilIdle: false, requireDelivery: true }).accepted;
  await forkHold.reached;
  const bothActive = await Promise.all(peers.map(peer => until(peer, snapshot => descendant(snapshot, 'fork').isRunning === true)));
  for (const snapshot of bothActive) { assert.equal(descendant(snapshot, 'child').isRunning, true); assert.equal(parent(snapshot).isRunning, false); }
  const mountsBeforeStop = mounts;
  assert.deepEqual(await second.stop({ chatId: 'fork' }), { accepted: true });
  const forkStopped = await Promise.all(peers.map(peer => until(peer, snapshot => descendant(snapshot, 'fork').isRunning === false)));
  for (let index = 0; index < forkStopped.length; index++) {
    const snapshot = forkStopped[index]!;
    assert.ok(snapshot.revision > bothActive[index]!.revision);
    assert.equal(descendant(snapshot, 'child').isRunning, true, 'stopping a scoped fork leaves the child run active');
    assert.equal(parent(snapshot).isRunning, false);
  }
  assert.equal(mounts, mountsBeforeStop, 'Stop adopts the existing scoped native binding');
  assert.equal(fork.displayState.get().isRunning, false); assert.equal(idleParent.thread.getId(), 'parent');
  forkHold.release();
  const completed = gate();
  const off = child.subscribe(event => { if (event.type === 'agent_end' && event.reason === 'complete') completed.release(); }); t.after(off);
  childHold.release(); await completed.promise; await settled();
  const finished = await Promise.all(peers.map(peer => until(peer, snapshot => descendant(snapshot, 'child').isRunning === false)));
  for (let index = 0; index < finished.length; index++) {
    assert.ok(finished[index]!.revision > forkStopped[index]!.revision);
    assert.equal(descendant(finished[index]!, 'fork').isRunning, false);
    assert.equal(parent(finished[index]!).isRunning, false);
  }
  watching.abort(); await Promise.all(peers.map(peer => peer.return().catch(() => undefined)));
  const requestsBefore = fixture.requests.length, mountsBefore = mounts;
  await server.close(); await service.dispose(); open(); server = await serveRouter(createChatRouter(service), 0);
  const restarted = await client().listChats();
  assert.notEqual(restarted.epoch, dormant.epoch);
  assert.deepEqual(restarted.pinnedChatIds, dormant.pinnedChatIds);
  assert.equal(parent(restarted).isRunning, false);
  for (const id of ['child', 'fork']) assert.equal(descendant(restarted, id).isRunning, false);
  assert.equal(await runtime.controller.getSessionByResource('child-resource'), undefined);
  assert.equal(await runtime.controller.getSessionByResource('parent-resource', scope), undefined);
  assert.equal(mounts, mountsBefore, 'catalog refill after restart mounts no dormant descendants');
  assert.equal(fixture.requests.length, requestsBefore, 'catalog refill after restart initiates no model request');
});
