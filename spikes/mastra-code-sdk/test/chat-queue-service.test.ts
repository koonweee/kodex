import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { ChatQueueSnapshot } from '../src/chat-queue.js';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { AgentMessageInput, QueueAgentMessageOptions } from '@mastra/core/agent';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { createChatService, type ChatSnapshot } from '../src/chat-service.js';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { serveRouter } from '../src/server.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

let root: string, profile: SpikeProfile, fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-native-queue-service-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture();
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat', 'alternate'] }],
    lsp: false, observability: { enabled: false },
  }));
});
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function setup(name: string) {
  const path = join(root, name); await mkdir(path);
  let runtime!: ProjectRuntime;
  const service = createChatService({ profile, instanceId: 'queue-fixture', projects: [{ id: 'project', name, path, runtimeRoot: join(root, `${name}-runtime`) }],
    runtimeFactory: async options => { runtime = await createProjectRuntime({ ...options, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] }); return runtime; },
  });
  const server = await serveRouter(createChatRouter(service), 0);
  const client = (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  const first = client(), second = client();
  const chat = await first.createChat({ projectId: 'project' });
  const nativeThread = await runtime.controller.queryThreadById({ threadId: chat.id });
  const session = (await runtime.controller.getSessionByResource(nativeThread!.resourceId))!;
  await session.thread.rename({ title: name });
  const abort = new AbortController();
  return { first, second, chat, session, service,
    async watch() { return second.watchChat({ chatId: chat.id }, { signal: abort.signal }); },
    async close() { abort.abort(); await server.close(); await service.dispose(); },
  };
}
async function until(watch: AsyncIterator<ChatSnapshot>, predicate: (snapshot: ChatSnapshot) => boolean) {
  const timeout = AbortSignal.timeout(15_000);
  for (;;) {
    timeout.throwIfAborted();
    let expired!: () => void;
    const deadline = new Promise<never>((_, reject) => { expired = () => reject(new Error('Queue snapshot timeout')); });
    timeout.addEventListener('abort', expired, { once: true });
    try { const next = await Promise.race([watch.next(), deadline]); assert.equal(next.done, false); if (predicate(next.value!)) return next.value!; }
    finally { timeout.removeEventListener('abort', expired); }
  }
}
const command = (chatId: string, queue: ChatSnapshot['queue'], id: string) => ({ chatId, epoch: queue.epoch, revision: queue.revision, id });

test('two clients edit/remove/reorder canonical queue rows with stale guards and native settings/identities', { timeout: 60_000 }, async t => {
  const env = await setup('queue-edit'); t.after(env.close);
  const watch = await env.watch(); const initial = await until(watch, () => true);
  assert.deepEqual(initial.queue.rows, []);
  const hold = fixture.holdNext('SERVICE_QUEUE_HEAD'); t.after(() => hold.release());
  await env.first.send({ chatId: env.chat.id, text: 'SERVICE_QUEUE_HEAD' }); await hold.reached;
  for (const text of ['SERVICE_QUEUE_A', 'SERVICE_QUEUE_B', 'SERVICE_QUEUE_C']) {
    const accepted = await env.first.queue({ chatId: env.chat.id, text });
    assert.equal(accepted.accepted, true); assert.equal(accepted.outcome, 'applied');
  }
  const queued = await until(watch, snapshot => snapshot.queue.rows.length === 3);
  assert.ok(queued.revision > initial.revision); assert.ok(queued.queue.revision > initial.queue.revision);
  const [a, b, c] = queued.queue.rows;
  await env.first.updateChatSettings({ chatId: env.chat.id, patch: { modelId: 'fixture/alternate' } });
  const edited = await env.first.editQueued({ ...command(env.chat.id, queued.queue, b!.id), input: { text: 'SERVICE_QUEUE_B_CHANGED' } });
  assert.equal(edited.outcome, 'applied');
  const visible = await until(watch, snapshot => snapshot.queue.rows.some(row => row.input.text === 'SERVICE_QUEUE_B_CHANGED'));
  assert.deepEqual(visible.queue.rows.map(row => row.id), queued.queue.rows.map(row => row.id));
  assert.equal(visible.queue.rows[0]!.nativeSignalId, a!.nativeSignalId);
  const stale = await env.second.removeQueued(command(env.chat.id, queued.queue, c!.id));
  assert.equal(stale.outcome, 'conflict');
  const wrongEpoch = await env.second.removeQueued({ ...command(env.chat.id, visible.queue, c!.id), epoch: 'old-service-epoch' });
  assert.equal(wrongEpoch.outcome, 'conflict');
  const reordered = await env.first.reorderQueued({ chatId: env.chat.id, epoch: visible.queue.epoch, revision: visible.queue.revision, ids: [c!.id, a!.id, b!.id] });
  assert.equal(reordered.outcome, 'applied');
  const reorderedPeer = await until(watch, snapshot => snapshot.queue.rows[0]?.id === c!.id);
  const removed = await env.second.removeQueued(command(env.chat.id, reorderedPeer.queue, a!.id));
  assert.equal(removed.outcome, 'applied');
  const final = await until(watch, snapshot => snapshot.queue.rows.length === 2);
  const nativeIds = final.queue.rows.map(row => row.nativeSignalId);
  hold.release();
  const finished = await until(watch, snapshot => !snapshot.display.isRunning && snapshot.queue.rows.length === 0 && JSON.stringify(snapshot.messages).includes('fixture:SERVICE_QUEUE_B_CHANGED'));
  const requests = fixture.requests.filter(request => lastUserText(request).startsWith('SERVICE_QUEUE_') && !lastUserText(request).includes('HEAD'));
  assert.deepEqual(requests.map(request => [lastUserText(request), request.model]), [['SERVICE_QUEUE_C', 'chat'], ['SERVICE_QUEUE_B_CHANGED', 'alternate']]);
  for (const id of nativeIds) assert.ok(finished.messages.some(message => message.id === id));
  assert.deepEqual((await env.first.openChat({ chatId: env.chat.id })).queue.rows, []);
});

test('existing Send inspects native pending work server-side while other callers retain native interjections', { timeout: 60_000 }, async t => {
  const env = await setup('queue-routing'); t.after(env.close); const watch = await env.watch(); await watch.next();
  const hold = fixture.holdNext('ROUTING_HEAD'); t.after(() => hold.release());
  await env.first.send({ chatId: env.chat.id, text: 'ROUTING_HEAD' }); await hold.reached;
  await env.first.queue({ chatId: env.chat.id, text: 'ROUTING_QUEUED_A' });
  const appended = await env.second.send({ chatId: env.chat.id, text: 'ROUTING_SEND_B', queueIfPending: true });
  assert.equal(appended.accepted, true); assert.ok('outcome' in appended && appended.outcome === 'applied');
  const queued = await until(watch, snapshot => snapshot.queue.rows.length === 2);
  assert.deepEqual(queued.queue.rows.map(row => row.input.text), ['ROUTING_QUEUED_A', 'ROUTING_SEND_B']);
  assert.deepEqual(await env.first.send({ chatId: env.chat.id, text: 'ROUTING_NATIVE_INTERJECTION' }), { accepted: true });
  assert.equal((await env.second.openChat({ chatId: env.chat.id })).queue.rows.length, 2);
  hold.release();
  const finished = await until(watch, snapshot => !snapshot.display.isRunning && snapshot.queue.rows.length === 0 && JSON.stringify(snapshot.messages).includes('fixture:ROUTING_SEND_B'));
  assert.ok(finished.messages.some(message => JSON.stringify(message.content).includes('ROUTING_NATIVE_INTERJECTION')));
  for (const text of ['ROUTING_QUEUED_A', 'ROUTING_SEND_B']) assert.equal(fixture.requests.filter(request => lastUserText(request) === text).length, 1);
  await assert.rejects(env.first.send({ chatId: env.chat.id, text: 'bad', queueIfPending: 'yes' } as never), { code: 'BAD_REQUEST' });
  await assert.rejects(env.first.reorderQueued({ chatId: env.chat.id, epoch: queued.queue.epoch, revision: -1, ids: [] }), { code: 'BAD_REQUEST' });
});

test('two clients retain uncertain/recoverable replacement input without retry and explicit dismissal cannot replay it', { timeout: 60_000 }, async t => {
  const env = await setup('queue-recovery'); t.after(env.close); const watch = await env.watch(); await watch.next();
  const hold = fixture.holdNext('RECOVERY_HEAD'); t.after(() => hold.release());
  await env.first.send({ chatId: env.chat.id, text: 'RECOVERY_HEAD' }); await hold.reached;
  await env.first.queue({ chatId: env.chat.id, text: 'RECOVERY_A' }); await env.first.queue({ chatId: env.chat.id, text: 'RECOVERY_B' });
  const before = await until(watch, snapshot => snapshot.queue.rows.length === 2);
  const agent = env.session.machinery.getAgent(); const original = agent.queueMessage.bind(agent);
  agent.queueMessage = <OUTPUT>(message: AgentMessageInput, target: QueueAgentMessageOptions<OUTPUT>) => { const actual = original<OUTPUT>(message, target); void actual.accepted.catch(() => undefined); throw new Error('private post-enqueue fixture failure'); };
  let edited: Awaited<ReturnType<typeof env.first.editQueued>>;
  try { edited = await env.first.editQueued({ ...command(env.chat.id, before.queue, before.queue.rows[0]!.id), input: { text: 'RECOVERY_A_CHANGED' } }); }
  finally { agent.queueMessage = original; }
  assert.equal(edited.outcome, 'uncertain');
  const saved = await until(watch, snapshot => snapshot.queue.rows[0]?.status === 'uncertain');
  assert.deepEqual(saved.queue.rows.map(row => [row.input.text, row.status, row.nativeSignalId]), [['RECOVERY_A_CHANGED', 'uncertain', null], ['RECOVERY_B', 'recoverable', null]]);
  assert.equal(JSON.stringify(saved.queue).includes('private'), false);
  assert.equal((await env.second.editQueued({ ...command(env.chat.id, saved.queue, saved.queue.rows[1]!.id), input: { text: 'AUTO_RETRY_FORBIDDEN' } })).outcome, 'conflict');
  const dismissed = await env.second.dismissQueued(command(env.chat.id, saved.queue, saved.queue.rows[1]!.id));
  assert.equal(dismissed.outcome, 'applied'); hold.release();
  await until(watch, snapshot => !snapshot.display.isRunning && JSON.stringify(snapshot.messages).includes('fixture:RECOVERY_A_CHANGED'));
  assert.deepEqual(fixture.requests.map(lastUserText).filter(text => text.startsWith('RECOVERY_') && text !== 'RECOVERY_HEAD'), ['RECOVERY_A_CHANGED']);
  const after = await env.first.openChat({ chatId: env.chat.id });
  assert.equal(after.queue.rows[0]!.status, 'uncertain', 'unknown native ID is never reconciled by text');
});

test('native extension pending work affects Send routing without inventing untracked public queue rows', { timeout: 60_000 }, async t => {
  const env = await setup('queue-external'); t.after(env.close); const watch = await env.watch(); await watch.next();
  const hold = fixture.holdNext('EXTERNAL_HEAD'); t.after(() => hold.release());
  await env.first.send({ chatId: env.chat.id, text: 'EXTERNAL_HEAD' }); await hold.reached;
  const native = env.session.machinery.getAgent().queueMessage('EXTERNAL_NATIVE_WAITING', {
    resourceId: env.session.identity.getResourceId(), threadId: env.session.thread.requireId(),
    ifIdle: { streamOptions: await env.session.machinery.buildStreamOptions({ abortSignal: new AbortController().signal }) },
  });
  await native.accepted;
  const external = await env.second.openChat({ chatId: env.chat.id });
  assert.equal(external.display.queuedFollowUps, 1);
  assert.deepEqual(external.queue.rows, [], 'native queue count is independent from tracked input identities');
  assert.equal(external.queue.partial, true); assert.equal(external.queue.nativeCount, 1);
  const appended = await env.first.send({ chatId: env.chat.id, text: 'EXTERNAL_BROWSER_APPEND', queueIfPending: true });
  assert.ok('outcome' in appended && appended.outcome === 'applied');
  const partial = await env.second.openChat({ chatId: env.chat.id });
  assert.deepEqual(partial.queue.rows.map(row => row.input.text), ['EXTERNAL_BROWSER_APPEND']);
  assert.equal(partial.queue.partial, true);
  assert.equal((await env.first.editQueued({ ...command(env.chat.id, partial.queue, partial.queue.rows[0]!.id), input: { text: 'UNSAFE_SUFFIX_EDIT' } })).outcome, 'conflict');
  hold.release();
  const finished = await until(watch, snapshot => !snapshot.display.isRunning && snapshot.queue.rows.length === 0 && JSON.stringify(snapshot.messages).includes('fixture:EXTERNAL_BROWSER_APPEND'));
  assert.ok(finished.messages.some(message => message.id === native.signal.id));
  assert.deepEqual(fixture.requests.map(lastUserText).filter(text => text.startsWith('EXTERNAL_') && text !== 'EXTERNAL_HEAD'), ['EXTERNAL_NATIVE_WAITING', 'EXTERNAL_BROWSER_APPEND']);
});

test('a fresh gateway process loses volatile pending rows, retains completed native history and stays dormant', { timeout: 60_000 }, async t => {
  const projectPath = join(root, 'queue-crash-project'), runtimeRoot = join(root, 'queue-crash-runtime');
  await mkdir(projectPath);
  const children: ChildProcess[] = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } });
  const file = fileURLToPath(new URL('./fixtures/chat-queue-restart.ts', import.meta.url));
  function child(mode: 'queue' | 'inspect') {
    const worker = fork(file, [mode, profile.root, projectPath, runtimeRoot], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(worker);
    const report = new Promise<{ type: string; chatId?: string; queue?: ChatQueueSnapshot; snapshot?: ChatSnapshot }>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Disposable queue fixture readiness timeout')); }, 25_000);
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Disposable queue fixture exited before readiness')); });
      worker.on('message', value => { const data = value as { type: string }; if (data.type === (mode === 'queue' ? 'queued' : 'inspected')) { clearTimeout(timer); resolve(value as Awaited<typeof report>); } });
    });
    return { worker, report };
  }
  const held = fixture.holdNext('QUEUE_CRASH_ACTIVE'); t.after(() => held.release());
  const initial = child('queue'); const accepted = await initial.report; await held.reached;
  assert.equal(accepted.queue!.rows[0]!.input.text, 'QUEUE_CRASH_WAITING');
  assert.equal(accepted.queue!.rows[0]!.status, 'queued'); assert.ok(accepted.queue!.rows[0]!.nativeSignalId);
  const killed = once(initial.worker, 'exit'); assert.equal(initial.worker.kill('SIGKILL'), true); await killed;
  const requestsBefore = fixture.requests.length;
  const reopened = child('inspect'); const exited = once(reopened.worker, 'exit'); const inspected = await reopened.report; await exited;
  assert.equal(reopened.worker.exitCode, 0); const snapshot = inspected.snapshot!;
  assert.equal(snapshot.chat.id, accepted.chatId);
  assert.notEqual(snapshot.queue.epoch, accepted.queue!.epoch);
  assert.deepEqual(snapshot.queue.rows, []); assert.equal(snapshot.queue.nativeCount, 0); assert.equal(snapshot.display.isRunning, false);
  assert.ok(snapshot.messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('fixture:QUEUE_CRASH_COMPLETED')));
  assert.equal(JSON.stringify(snapshot.messages).includes('QUEUE_CRASH_WAITING'), false);
  assert.equal(fixture.requests.length, requestsBefore, 'fresh inventory/history reads never restart lost queued work');
});
