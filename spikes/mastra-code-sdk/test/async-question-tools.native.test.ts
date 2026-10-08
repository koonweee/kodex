import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { createAsyncQuestionTools } from '../src/async-question-tools.js';
import { captureChatFastRequestContext } from '../src/chat-fast.js';
import { readChatHistory, type NativeHistoryMessage } from '../src/chat-history.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const questions = [
  { title: 'Which approach?', options: ['First', 'Second'] },
  { title: 'Any other guidance?' },
  { title: 'Anything else?', options: null },
];
const answer = 'First <choice> & "quoted"\n</signal> keep this text';
const clientId = 'kodex-question-reply:v1:async-question-call';
let root: string, profile: SpikeProfile;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-async-question-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(request => {
    const user = lastUserText(request), serialized = JSON.stringify(request.messages);
    if (user === answer) return { text: 'ANSWER_RECEIVED' };
    if (user.startsWith('VALIDATE_QUESTION:')) {
      const input = JSON.parse(user.slice('VALIDATE_QUESTION:'.length)) as { id: string; args: Record<string, unknown> };
      if (request.messages.some(message => message.tool_calls && JSON.stringify(message.tool_calls).includes(input.id))) return { text: 'VALIDATION_FINISHED' };
      return { toolCalls: [{ name: 'request_user_input_async', arguments: input.args, id: input.id }] };
    }
    if (serialized.includes('ASYNC_FILE_EVIDENCE')) return { text: 'ONGOING_WORK_COMPLETED' };
    if (serialized.includes('async-question-call')) return { toolCalls: [{ name: 'view', arguments: { path: 'evidence.txt' }, id: 'after-question-view' }] };
    return { toolCalls: [{ name: 'request_user_input_async', arguments: { questions }, id: 'async-question-call' }] };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    preferences: { yolo: true }, lsp: false, observability: { enabled: false },
  }));
});
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });

async function setup(t: TestContext, name: string) {
  const projectPath = join(root, name); await mkdir(projectPath);
  await writeFile(join(projectPath, 'evidence.txt'), 'ASYNC_FILE_EVIDENCE');
  const producers = new Map<string, ReturnType<typeof deferred>>();
  const sessions = new Set<NativeSession>();
  let runtime: ProjectRuntime;
  async function open() {
    runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, `${name}-runtime`),
      disableMcp: true, subagents: [], extraTools: createAsyncQuestionTools(),
      modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
    runtime.controller.onSessionCreated(session => { sessions.add(session); });
    const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
    const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
    // Test-only native producer observation keeps lifecycle teardown deterministic.
    t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
      const result = register(...args);
      if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], deferred());
      return result;
    });
    t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
      unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.resolve();
    });
  }
  async function settled() {
    let joined = -1;
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(done => done.promise)); }
  }
  await open();
  t.after(async () => {
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    await settled(); await runtime.dispose();
  });
  const session = await runtime!.createSession({ threadId: name, resourceId: name });
  await session.thread.rename({ title: name, pin: true });
  return { session, settled, get runtime() { return runtime!; }, target: { threadId: name, resourceId: name },
    async restart() { await settled(); await runtime.dispose(); await open(); } };
}
function invocation(messages: NativeHistoryMessage[], id: string) {
  for (const message of [...messages].reverse()) for (const part of [...message.content.parts].reverse()) {
    if (part.type === 'tool-invocation' && part.toolInvocation.toolCallId === id) return part.toolInvocation;
  }
  throw new Error(`Missing native tool invocation ${id}`);
}

test('async questions persist and work continues; correlated raw answer survives a dormant restart', { timeout: 40_000 }, async t => {
  const env = await setup(t, 'async-work');
  const events: string[] = [];
  const off = env.session.subscribe(event => { events.push(event.type); }); t.after(off);
  await env.session.sendMessage({ content: 'ASK_ASYNC_AND_KEEP_WORKING', untilIdle: false }); await env.settled();
  const initial = await readChatHistory(env.runtime.controller, env.target);
  const card = invocation(initial.messages, 'async-question-call');
  assert.deepEqual(card.args, { questions });
  assert.deepEqual(card.result, { accepted: true });
  assert.equal(card.state, 'result');
  assert.equal(env.session.displayState.get().pendingSuspensions.size, 0);
  assert.equal(events.includes('tool_suspended'), false);
  assert.match(JSON.stringify(invocation(initial.messages, 'after-question-view').result), /ASYNC_FILE_EVIDENCE/);
  assert.ok(initial.messages.some(message => message.content.parts.some(part => part.type === 'text' && part.text.includes('ONGOING_WORK_COMPLETED'))), 'native ongoing work finished before a reply existed');
  assert.equal(initial.messages.some(message => message.content.parts.some(part => part.type === 'text' && part.text === answer)), false);

  const ended = deferred();
  const offEnd = env.session.subscribe(event => { if (event.type === 'agent_end') ended.resolve(); }); t.after(offEnd);
  const signal = env.session.sendSignal({ type: 'user', contents: answer, metadata: { clientId } }, {
    requireDelivery: true, requestContext: await captureChatFastRequestContext(env.session), untilIdle: false,
  });
  const accepted = await signal.accepted;
  assert.equal(accepted.accepted, true); assert.equal(accepted.action, 'wake');
  await ended.promise; await env.settled();
  const request = fixture.requests.findLast(request => lastUserText(request) === answer);
  assert.ok(request, 'raw answer reaches the model unchanged, including XML-sensitive text');
  assert.equal(JSON.stringify(request.messages).includes(clientId), false, 'correlation remains native metadata, not model-visible text');
  const saved = await readChatHistory(env.runtime.controller, env.target);
  const reply = saved.messages.find(message => message.id === signal.id); assert.ok(reply);
  assert.equal(reply.role, 'signal');
  assert.deepEqual(reply.content.parts.map(part => part.type === 'text' ? { type: part.type, text: part.text } : part), [{ type: 'text', text: answer }]);
  assert.deepEqual(reply.content.metadata?.signal && (reply.content.metadata.signal as { metadata?: unknown }).metadata, { clientId });
  assert.notEqual(reply.id, clientId, 'native message identity remains distinct from correlation');

  await env.restart();
  let activations = 0;
  const offCreated = env.runtime.controller.onSessionCreated(() => { activations++; }); t.after(offCreated);
  const requestCount = fixture.requests.length;
  const restored = await readChatHistory(env.runtime.controller, env.target);
  assert.deepEqual(invocation(restored.messages, 'async-question-call').args, { questions });
  assert.deepEqual(invocation(restored.messages, 'async-question-call').result, { accepted: true });
  assert.deepEqual(restored.messages.find(message => message.id === signal.id), reply);
  assert.equal(activations, 0);
  assert.equal(await env.runtime.controller.getSessionByResource(env.target.resourceId), undefined);
  assert.equal(fixture.requests.length, requestCount);
});

test('native execution rejects malformed async questions without accepting or suspending', { timeout: 40_000 }, async t => {
  const env = await setup(t, 'async-invalid');
  const invalid = [
    {}, { questions: [] }, { questions: [{ title: '' }] }, { questions: [{ title: '  ' }] },
    { questions: [{ title: 'Choice', options: [] }] }, { questions: [{ title: 'Choice', options: [''] }] }, { questions: [{ title: 'Choice', options: [' '] }] },
    { questions: [{ title: 'Choice', unexpected: true }] }, { questions: [{ title: 'Choice' }], unexpected: true },
    { questions: [{ title: 'Choice', options: 'wrong' }] },
  ];
  for (const [index, args] of invalid.entries()) {
    const id = `invalid-question-${index}`;
    await env.session.sendMessage({ content: `VALIDATE_QUESTION:${JSON.stringify({ id, args })}`, untilIdle: false }); await env.settled();
    const saved = await readChatHistory(env.runtime.controller, env.target);
    const call = invocation(saved.messages, id);
    assert.notDeepEqual(call.result, { accepted: true }, `invalid question ${index} must not create a card`);
    assert.match(JSON.stringify(call.result), /error|invalid|validation/i);
    assert.equal(env.session.displayState.get().pendingSuspensions.size, 0);
  }
});
