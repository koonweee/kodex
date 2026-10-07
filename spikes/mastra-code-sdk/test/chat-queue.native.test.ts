import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import type { AgentMessageInput, QueueAgentMessageOptions } from '@mastra/core/agent';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';
import { createChatQueue } from '../src/chat-queue.js';

let root: string;
let runtime: ProjectRuntime;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kodex-native-queue-proof-'));
  const profile = activateProfile(resolveProfile(path.join(root, 'profile')));
  fixture = await startModelFixture();
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: null, goalMaxTurns: Number.MAX_SAFE_INTEGER },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat', 'alternate'] }],
    observability: { enabled: false },
  }));
  const projectPath = path.join(root, 'project');
  await mkdir(projectPath);
  runtime = await createProjectRuntime({ projectPath, runtimeRoot: path.join(root, 'runtime'), profile,
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] });
});
after(async () => { await runtime?.dispose(); await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });

async function heldSession(name: string, missAdmission = false) {
  const session = await runtime.createSession({ resourceId: `resource-${name}`, threadId: `thread-${name}` });
  await session.thread.rename({ title: name });
  let currentInput = '';
  const completedInputs: string[] = [];
  const completions = new Set<(input: string) => void>();
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'message_start' && event.message.role === 'signal') currentInput = JSON.stringify(event.message.content);
    if (event.type === 'agent_end' && event.reason === 'complete') {
      completedInputs.push(currentInput);
      for (const complete of completions) complete(currentInput);
    }
  });
  const completed = async (text: string) => {
    if (!completedInputs.some(input => input.includes(text))) await new Promise<void>((resolve, reject) => {
      const listener = (input: string) => { if (input.includes(text)) { clearTimeout(timer); completions.delete(listener); resolve(); } };
      const timer = setTimeout(() => { completions.delete(listener); reject(new Error('Native queued run did not complete')); }, 15_000);
      completions.add(listener);
    });
    const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
    if (memory && 'settled' in memory && typeof memory.settled === 'function') await memory.settled();
  };
  const hold = fixture.holdNext(`HEAD_${name}`);
  const running = session.sendMessage({ content: `HEAD_${name}` });
  await hold.reached;
  const observed = missAdmission ? new Proxy(session, { get(target, key) {
    if (key === 'subscribe') return (callback: Parameters<typeof session.subscribe>[0]) => target.subscribe(event => { if (event.type !== 'message_start') callback(event); });
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } }) : session;
  const queue = createChatQueue(observed, { epoch: 'native-fixture' });
  return { session, hold, running, queue, completed, unsubscribe };
}
function requestsWith(prefix: string) { return fixture.requests.map(lastUserText).filter(text => text.startsWith(prefix)); }
const text = (text: string) => ({ text });

test('native middle edit and reorder preserve row identities, prefix, complete suffix and captured model settings', { timeout: 30_000 }, async t => {
  const { session, hold, running, queue, completed, unsubscribe } = await heldSession('production-edit');
  t.after(() => { hold.release(); queue.dispose(); unsubscribe(); });
  const ids: string[] = [];
  for (const value of ['NATIVE_A', 'NATIVE_B', 'NATIVE_C', 'NATIVE_D']) ids.push((await queue.enqueue(text(value))).rowId);
  const before = queue.snapshot();
  const nativeA = before.rows[0]!.nativeSignalId;
  assert.equal(session.displayState.get().queuedFollowUps, 4);
  await session.model.switch({ modelId: 'fixture/alternate' });
  const edited = await queue.edit({ id: ids[1]!, input: text('NATIVE_B_CHANGED'), revision: before.revision });
  assert.equal(edited.outcome, 'applied');
  assert.equal(edited.snapshot.rows[0]!.nativeSignalId, nativeA);
  assert.deepEqual(edited.snapshot.rows.map(row => row.id), ids);
  assert.equal((await queue.remove({ id: ids[2]!, revision: before.revision })).outcome, 'conflict', 'second client must review newer queue before mutating');
  assert.equal((await queue.reorder({ ids: [ids[3]!, ids[0]!, ids[1]!, ids[2]!], revision: queue.snapshot().revision })).outcome, 'applied');
  const finalIds = queue.snapshot().rows.map(row => row.nativeSignalId);
  hold.release();
  await completed('NATIVE_C'); await running;
  const requests = fixture.requests.filter(request => lastUserText(request).startsWith('NATIVE_'));
  assert.deepEqual(requests.map(request => ({ text: lastUserText(request), model: request.model })), [
    { text: 'NATIVE_D', model: 'chat' }, { text: 'NATIVE_A', model: 'chat' },
    { text: 'NATIVE_B_CHANGED', model: 'alternate' }, { text: 'NATIVE_C', model: 'chat' },
  ]);
  const history = await session.thread.listActiveMessages();
  for (const id of finalIds) assert.ok(history.some(message => message.id === id), 'native queued input identity persists');
  assert.deepEqual(queue.snapshot().rows, [], 'exact native admission clears projected rows');
});

test('native confirmed remove and steering retain other queued work exactly once', { timeout: 30_000 }, async t => {
  const { session, hold, running, queue, completed, unsubscribe } = await heldSession('production-steer');
  t.after(() => { hold.release(); queue.dispose(); unsubscribe(); });
  const a = await queue.enqueue(text('NATIVE_STEER_A'));
  const b = await queue.enqueue(text('NATIVE_STEER_B'));
  const discarded = await queue.enqueue(text('NATIVE_STEER_REMOVED'));
  assert.equal((await queue.remove({ id: discarded.rowId, revision: queue.snapshot().revision })).outcome, 'applied');
  const steered = await queue.steer({ id: a.rowId, revision: queue.snapshot().revision });
  assert.equal(steered.outcome, 'applied');
  assert.equal(steered.snapshot.rows.find(row => row.id === a.rowId)?.status, 'steering');
  assert.equal(steered.snapshot.rows.find(row => row.id === b.rowId)?.status, 'queued');
  assert.equal((await queue.dismiss({ id: a.rowId, revision: queue.snapshot().revision })).outcome, 'conflict');
  hold.release();
  await Promise.all([completed('NATIVE_STEER_A'), completed('NATIVE_STEER_B')]); await running;
  const userInputs = (await session.thread.listActiveMessages()).filter(message => message.role === 'signal').map(message => JSON.stringify(message.content));
  assert.equal(userInputs.filter(value => value.includes('NATIVE_STEER_A')).length, 1);
  assert.equal(userInputs.filter(value => value.includes('NATIVE_STEER_B')).length, 1);
  assert.equal(userInputs.filter(value => value.includes('NATIVE_STEER_REMOVED')).length, 0);
});

test('a second client with pre-admission revision cannot edit an input now running', { timeout: 30_000 }, async t => {
  const { hold, running, queue, completed, unsubscribe } = await heldSession('production-race');
  const next = fixture.holdNext('NATIVE_RACE_A');
  t.after(() => { hold.release(); next.release(); queue.dispose(); unsubscribe(); });
  const a = await queue.enqueue(text('NATIVE_RACE_A')); await queue.enqueue(text('NATIVE_RACE_B'));
  const captured = queue.snapshot();
  hold.release(); await next.reached;
  assert.equal((await queue.edit({ id: a.rowId, input: text('NATIVE_RACE_CHANGED'), revision: captured.revision })).outcome, 'conflict');
  next.release(); await completed('NATIVE_RACE_B'); await running;
  assert.deepEqual(requestsWith('NATIVE_RACE_'), ['NATIVE_RACE_A', 'NATIVE_RACE_B']);
});

test('native queue wakes an idle session without a host dispatcher', { timeout: 30_000 }, async t => {
  const session = await runtime.createSession({ resourceId: 'resource-native-idle', threadId: 'thread-native-idle' });
  await session.thread.rename({ title: 'Native idle queue' });
  const queue = createChatQueue(session, { epoch: 'idle-fixture' });
  t.after(() => queue.dispose());
  let resolve!: () => void;
  const ended = new Promise<void>(done => { resolve = done; });
  const off = session.subscribe(event => { if (event.type === 'agent_end') resolve(); });
  t.after(off);
  const result = await queue.enqueue(text('NATIVE_IDLE_QUEUE'));
  assert.equal(result.outcome, 'applied');
  await ended;
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  if (memory && 'settled' in memory && typeof memory.settled === 'function') await memory.settled();
  assert.deepEqual(requestsWith('NATIVE_IDLE_'), ['NATIVE_IDLE_QUEUE']);
  assert.deepEqual(queue.snapshot().rows, []);
  assert.ok((await session.thread.listActiveMessages()).some(message => JSON.stringify(message.content).includes('NATIVE_IDLE_QUEUE')));
});

test('real native exact-ID persistence resolves uncertain admission after missed live input events without replay', { timeout: 30_000 }, async t => {
  const { session, hold, running, queue, completed, unsubscribe } = await heldSession('receipt', true);
  t.after(() => { hold.release(); queue.dispose(); unsubscribe(); });
  const agent = session.machinery.getAgent(); const original = agent.queueMessage.bind(agent);
  agent.queueMessage = ((message: AgentMessageInput, target: QueueAgentMessageOptions<unknown>) => {
    const native = original(message, target);
    return { ...native, accepted: native.accepted.then(() => { throw new Error('Fixture acknowledgment was lost'); }) };
  }) as typeof agent.queueMessage;
  let submitted: Awaited<ReturnType<typeof queue.enqueue>>;
  try { submitted = await queue.enqueue(text('NATIVE_RECEIPT_INPUT')); } finally { agent.queueMessage = original; }
  assert.equal(submitted.outcome, 'uncertain'); const row = submitted.snapshot.rows[0]!;
  assert.equal((await queue.reconcile({ id: row.id, revision: queue.snapshot().revision })).outcome, 'uncertain', 'absence never authorizes replay');
  hold.release(); await completed('NATIVE_RECEIPT_INPUT'); await running;
  assert.equal(queue.snapshot().rows[0]?.status, 'uncertain', 'live admission was deliberately missed');
  const resolved = await queue.reconcile({ id: row.id, revision: queue.snapshot().revision });
  assert.equal(resolved.outcome, 'applied'); assert.deepEqual(resolved.snapshot.rows, []);
  assert.deepEqual(requestsWith('NATIVE_RECEIPT_'), ['NATIVE_RECEIPT_INPUT']);
});

test('native memory-only signal persistence and an early exact-ID user event cannot claim execution admission', { timeout: 30_000 }, async t => {
  const { session, hold, running, queue, unsubscribe } = await heldSession('persist-lookalike');
  t.after(() => { hold.release(); queue.dispose(); unsubscribe(); });
  const agent = session.machinery.getAgent(); const original = agent.queueMessage.bind(agent);
  agent.queueMessage = ((message: AgentMessageInput, target: QueueAgentMessageOptions<unknown>) => {
    const native = agent.sendMessage(message, { resourceId: session.identity.getResourceId(), threadId: session.thread.requireId(), ifActive: { behavior: 'persist' }, ifIdle: { behavior: 'persist', streamOptions: target.ifIdle?.streamOptions } });
    return { ...native, accepted: native.accepted.then(async decision => {
      await native.persisted;
      const memory = await agent.getMemory({ requestContext: await session.machinery.buildRequestContext() });
      const store = await memory!.storage!.getStore('memory');
      const persisted = (await store!.listMessagesById({ messageIds: [native.signal.id] })).messages[0]!;
      session.emit({ type: 'message_start', message: persisted }); // The same data-only event emitted by native sendSignalToThread.
      return decision;
    }) };
  }) as typeof agent.queueMessage;
  let submitted: Awaited<ReturnType<typeof queue.enqueue>>;
  try { submitted = await queue.enqueue(text('NATIVE_MEMORY_ONLY_INPUT')); } finally { agent.queueMessage = original; }
  const row = submitted.snapshot.rows[0]!;
  assert.equal(submitted.outcome, 'uncertain'); assert.equal(row.status, 'uncertain'); assert.ok(row.nativeSignalId);
  const resolved = await queue.reconcile({ id: row.id, revision: queue.snapshot().revision });
  assert.equal(resolved.outcome, 'uncertain'); assert.equal(resolved.snapshot.rows[0]?.id, row.id);
  assert.ok((await session.thread.listActiveMessages()).some(message => message.id === row.nativeSignalId), 'the native persisted lookalike exists');
  assert.deepEqual(requestsWith('NATIVE_MEMORY_ONLY_'), [], 'no model execution happened for the persisted signal');
  hold.release(); await running;
});
