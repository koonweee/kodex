import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession } from '../src/runtime.js';
import { abortNativeChat } from '../src/chat-archive.js';
import { createChatQueue } from '../src/chat-queue.js';
import { startModelFixture } from './fixtures/model-server.js';

async function deadline<T>(pending: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native archive teardown did not settle')), 15_000); })]); }
  finally { clearTimeout(timer); }
}
async function settled(session: NativeSession) {
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function');
  await memory.settled();
}
function completedInput(session: NativeSession, marker: string) {
  let current = '', off = () => {}, finish = () => {};
  const pending = new Promise<void>(resolve => {
    finish = resolve;
    off = session.subscribe(event => {
      if (event.type === 'message_start' && event.message.role === 'signal') current = JSON.stringify(event.message.content);
      if (event.type === 'agent_end' && event.reason === 'complete' && current.includes(marker)) resolve();
    });
  });
  const guarded = deadline(pending).finally(() => off());
  void guarded.catch(() => {}); // Preserve rejection for the later await without leaking failed-test activity.
  return { pending: guarded, dispose: () => { off(); finish(); } };
}

test('public archive teardown aborts the gateway Session.sendSignal native run and clears tracked/raw inputs without deleting history or disturbing a same-database peer', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-native-archive-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const fixture = await startModelFixture();
  await writeFile(profile.settingsPath, JSON.stringify({ models: { observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fake-local-key', models: ['chat'] }], lsp: false, observability: { enabled: false } }));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'),
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] });
  const selected = await runtime.createSession({ resourceId: 'archive-selected-resource', threadId: 'archive-selected-thread' });
  const peer = await runtime.createSession({ resourceId: 'archive-peer-resource', threadId: 'archive-peer-thread' });
  await selected.thread.rename({ title: 'Selected retained native name' });
  await peer.thread.rename({ title: 'Peer retained native name' });
  const selectedHold = fixture.holdNext('ARCHIVE_ACTIVE_HELD');
  const peerHold = fixture.holdNext('ARCHIVE_PEER_HELD');
  const queue = createChatQueue(selected, { epoch: 'archive-fixture' });
  t.after(async () => { selectedHold.release(); peerHold.release(); queue.dispose(); await runtime.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }); });
  await selected.sendMessage({ content: 'ARCHIVE_COMPLETED_HISTORY' }); await settled(selected);
  await peer.sendMessage({ content: 'ARCHIVE_PEER_HISTORY' }); await settled(peer);
  const retained = await selected.thread.listActiveMessages();
  assert.ok(retained.some(message => message.role === 'assistant' && message.content.parts.some(part => part.type === 'text' && part.text.includes('ARCHIVE_COMPLETED_HISTORY'))));
  const selectedTarget = { resourceId: selected.identity.getResourceId(), threadId: selected.thread.requireId() };
  const peerTarget = { resourceId: peer.identity.getResourceId(), threadId: peer.thread.requireId() };
  const agent = selected.machinery.getAgent();
  assert.equal(agent, peer.machinery.getAgent(), 'both sessions share the same native agent/database');
  selected.ensureFollowUpBinding(agent, selectedTarget.resourceId, selectedTarget.threadId);
  peer.ensureFollowUpBinding(agent, peerTarget.resourceId, peerTarget.threadId);
  const queueCounts: number[] = [];
  const offCount = agent.subscribeThreadEvents(selectedTarget, event => { queueCounts.push(event.count); }); t.after(offCount);
  // Observe (and return unchanged) the native submission made by ordinary
  // Session.sendSignal. Its public Agent output lets this proof join the run
  // after deleteSession detaches the Session observer. No storage/promise holds.
  const sendSignal = agent.sendSignal.bind(agent);
  let observed: ReturnType<typeof agent.sendSignal> | undefined;
  const observation = t.mock.method(agent, 'sendSignal', (...args: Parameters<typeof agent.sendSignal>) => {
    const native = sendSignal(...args);
    observed = native;
    return native;
  });
  const selectedSubmission = selected.sendSignal({ content: 'ARCHIVE_ACTIVE_HELD' }, { requireDelivery: true });
  assert.equal((await selectedSubmission.accepted).action, 'wake');
  try { await selectedHold.reached; } finally { observation.mock.restore(); }
  assert.ok(selected.run.isRunning(), 'ordinary Session run control is active before archive');
  assert.ok(selected.run.getRunId());
  assert.ok(observed, 'ordinary Session submission reached the public native Agent');
  const admission = await observed.accepted; assert.equal(admission.action, 'wake');
  if (admission.action !== 'wake') throw new Error('Local archive fixture did not own the native run');
  const finished = admission.output.getFullOutput();
  void finished.catch(() => {});
  const streamOptions = await selected.machinery.buildStreamOptions({});
  const peerRun = peer.sendMessage({ content: 'ARCHIVE_PEER_HELD' });
  void peerRun.catch(() => {});
  await peerHold.reached;
  const peerRunId = agent.getActiveThreadRunId(peerTarget); assert.ok(peerRunId);
  const waiting = ['ARCHIVE_TRACKED_A', 'ARCHIVE_TRACKED_B'];
  for (const text of waiting) assert.equal((await queue.enqueue({ text })).outcome, 'applied');
  const trackedIds = queue.snapshot().rows.map(row => row.nativeSignalId!);
  const raw = agent.queueMessage('ARCHIVE_RAW_QUEUE', { ...selectedTarget, ifIdle: { behavior: 'wake', streamOptions } });
  assert.equal((await raw.accepted).action, 'deliver');
  const signal = agent.sendSignal({ type: 'reactive', contents: 'ARCHIVE_RAW_REACTIVE' }, { ...selectedTarget, ifActive: { behavior: 'deliver' } });
  assert.equal((await signal.accepted).action, 'deliver');
  const peerDone = completedInput(peer, 'ARCHIVE_PEER_QUEUED'); t.after(peerDone.dispose);
  const peerOptions = await peer.machinery.buildStreamOptions({});
  const peerQueued = agent.queueMessage('ARCHIVE_PEER_QUEUED', { ...peerTarget, ifIdle: { behavior: 'wake', streamOptions: peerOptions } });
  assert.equal((await peerQueued.accepted).action, 'deliver');
  assert.equal(queueCounts.at(-1), 3, 'tracked and raw user input are all pending before teardown');
  assert.equal(peer.displayState.get().queuedFollowUps, 1);

  await abortNativeChat(selected);
  assert.equal(selected.stream.isActive(), false, 'public Session teardown settles while the model response is held');
  assert.equal(agent.getActiveThreadRunId(selectedTarget), undefined, 'the native selected run is already inactive before Session deletion');
  queue.dispose();
  assert.equal(await runtime.controller.deleteSession({ resourceId: selectedTarget.resourceId }), true);
  const stopped = await deadline(finished);
  assert.equal(stopped.finishReason, 'aborted', 'native generation ended while the fixture response remained held');
  assert.equal(selected.run.isRunning(), false, 'Session run ownership ends during public teardown');
  selectedHold.release();
  assert.equal(queueCounts.at(-1), 0, 'native clear covers extension-owned rows as well as Kodex rows');
  assert.equal(await runtime.controller.getSessionByResource(selectedTarget.resourceId), undefined);
  assert.deepEqual(agent.cancelQueuedMessages({ ...selectedTarget, signalIds: [...trackedIds, raw.signal.id, signal.signal.id] }).cancelledSignalIds, []);
  assert.equal(agent.getActiveThreadRunId(peerTarget), peerRunId, 'selected teardown leaves the unrelated native run active');
  assert.equal(peer.displayState.get().queuedFollowUps, 1);
  assert.equal(await runtime.controller.getSessionByResource(peerTarget.resourceId), peer);
  const stored = await runtime.controller.queryThreadById({ threadId: selectedTarget.threadId });
  assert.equal(stored!.title, 'Selected retained native name');
  const history = await runtime.controller.queryThreadMessages({ ...selectedTarget, perPage: 40, orderBy: { field: 'createdAt', direction: 'ASC' } });
  for (const message of retained) assert.ok(history.messages.some(row => row.id === message.id), 'completed native history survives Session teardown');
  const pendingIds = [...trackedIds, raw.signal.id, signal.signal.id];
  assert.ok(history.messages.every(message => !pendingIds.includes(message.id)), 'cleared waiting inputs were not persisted as delivered work');

  peerHold.release(); await deadline(peerRun); await peerDone.pending; await settled(peer);
  const peerHistory = await peer.thread.listActiveMessages();
  assert.ok(peerHistory.some(message => message.id === peerQueued.signal.id), 'unrelated queued work still executes and persists');
  // Read-only archive inventory and native reopen do not wake canceled input.
  const requestCount = fixture.requests.length;
  const reopened = await runtime.createSession({ resourceId: selectedTarget.resourceId, threadId: selectedTarget.threadId });
  assert.equal(fixture.requests.length, requestCount);
  assert.equal(reopened.displayState.get().queuedFollowUps, 0);
  await reopened.sendMessage({ content: 'ARCHIVE_EXPLICIT_REOPEN' }); await settled(reopened);
  for (const marker of [...waiting, 'ARCHIVE_RAW_QUEUE', 'ARCHIVE_RAW_REACTIVE']) assert.ok(fixture.requests.every(request => !JSON.stringify(request.messages).includes(marker)), 'no canceled input leaks into later native model requests');
  assert.ok((await reopened.thread.listActiveMessages()).some(message => message.id === retained.find(message => message.role === 'assistant')!.id));
});
