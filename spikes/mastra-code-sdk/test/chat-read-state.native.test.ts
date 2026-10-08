import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { abortNativeChat } from '../src/chat-archive.js';
import { createChatReadState } from '../src/chat-read-state.js';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(done => { release = done; }), release };
}

test('native terminal delivery captures complete, aborted and error identity; suspension and restart do not invent a head', { timeout: 35_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-chat-read-state-')));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const model = await startModelFixture(request => {
    if (lastUserText(request) === 'READ_QUESTION' && !request.messages.slice(request.messages.findLastIndex(message => message.role === 'user')).some(message => message.role === 'tool')) {
      return { toolCalls: [{ name: 'ask_user', id: 'read-question', arguments: { question: 'Which evidence?' } }] };
    }
    return { text: 'READ_NATIVE_FINAL' };
  });
  let rejectedRequests = 0;
  const rejectedPaths: Array<{ method: string | undefined; url: string | undefined }> = [];
  const rejecting = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the native request */ }
    rejectedRequests++; rejectedPaths.push({ method: request.method, url: request.url });
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Local fixture rejects before assistant output', type: 'invalid_request_error' } }));
  });
  rejecting.listen(0, '127.0.0.1'); await once(rejecting, 'listening');
  const address = rejecting.address(); assert.ok(address && typeof address !== 'string');
  await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false }, preferences: { yolo: true },
    models: { observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [
      { name: 'fixture', url: model.url, apiKey: 'local-not-a-real-key', models: ['chat'] },
      { name: 'failure', url: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-not-a-real-key', models: ['chat'] },
    ],
  }));
  const options = { profile, projectPath, runtimeRoot: join(root, 'runtime'), disableMcp: true, subagents: [],
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] };
  const changed: Array<[string, string]> = [];
  const tracker = createChatReadState('first-epoch', (binding, thread) => changed.push([binding, thread]));
  let runtime = await createProjectRuntime(options);
  const sessions = new Set<NativeSession>(), producers = new Map<string, ReturnType<typeof gate>>(), suspended = new Set<string>();
  const holds: Array<() => void> = [], executions: Promise<unknown>[] = [];
  tracker.observeRuntime(runtime, 'binding');
  runtime.controller.onSessionCreated(session => {
    sessions.add(session);
    session.subscribe(event => {
      const runId = session.getCurrentRunId();
      if (event.type === 'tool_suspended' && runId) suspended.add(runId);
      if (event.type === 'agent_start' && runId) suspended.delete(runId);
    });
  });
  const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
  const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
  // Fixture-only teardown observation: a native terminal is not a producer join.
  t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...input: Parameters<typeof register>) => {
    const result = register(...input);
    if (input[0].id === 'agentic-loop' && input[1]) {
      producers.set(input[1], gate()); suspended.delete(input[1]);
      const createRun = input[0].createRun.bind(input[0]);
      t.mock.method(input[0], 'createRun', async (...args: Parameters<typeof createRun>) => {
        const run = await createRun(...args);
        const start = run.start.bind(run), resume = run.resume.bind(run);
        t.mock.method(run, 'start', (...args: Parameters<typeof start>) => { const done = start(...args); executions.push(done); return done; });
        t.mock.method(run, 'resume', (...args: Parameters<typeof resume>) => { const done = resume(...args); executions.push(done); return done; });
        return run;
      });
    }
    return result;
  });
  t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
    unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.release();
  });
  async function settled() {
    let joined = -1;
    while (joined !== producers.size) {
      joined = producers.size;
      await Promise.allSettled(executions);
      await Promise.all([...producers].map(([id, done]) => suspended.has(id) ? undefined : done.promise));
    }
    for (const session of sessions) {
      const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
      if (memory && 'settled' in memory && typeof memory.settled === 'function') await memory.settled();
    }
  }
  t.after(async () => {
    for (const release of holds) release();
    tracker.dispose();
    for (const session of sessions) await abortNativeChat(session);
    await settled(); await runtime.dispose(); await model.close();
    rejecting.closeAllConnections(); await new Promise<void>((resolve, reject) => rejecting.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const target = { threadId: 'native-thread', resourceId: 'native-resource' };
  const session = await runtime.createSession(target);
  const agent = session.machinery.getAgent(), sendSignal = agent.sendSignal.bind(agent);
  // The public native wake output also joins final output processors, which can
  // continue after agent_end and the internal agentic-loop registration ends.
  t.mock.method(agent, 'sendSignal', (...args: Parameters<typeof sendSignal>) => {
    const admission = sendSignal(...args);
    const finished = admission.accepted.then(result => result.action === 'wake' ? result.output.getFullOutput() : undefined);
    executions.push(finished); void finished.catch(() => {});
    return admission;
  });
  const witnessed: Array<{ reason?: string; runId: string | null; messageId: string | null }> = [];
  session.subscribe(event => {
    if (event.type === 'agent_end') witnessed.push({ reason: event.reason, runId: session.run.getRunId(), messageId: session.displayState.get().currentMessage?.id ?? null });
  });
  await session.sendMessage({ content: 'READ_COMPLETE' }); await settled();
  const completed = tracker.read('binding', target.threadId);
  assert.ok(completed.head); assert.equal(completed.head.reason, 'complete'); assert.equal(completed.seen, false);
  assert.ok(completed.head.runId); assert.ok(completed.head.messageId);
  assert.deepEqual(completed.head, { ...witnessed[0], reason: 'complete' });
  assert.equal(session.run.getRunId(), null, 'native reset follows the synchronous terminal delivery');
  const saved = await runtime.controller.queryThreadMessages({ ...target, perPage: 20 });
  assert.ok(saved.messages.some(message => message.id === completed.head?.messageId));
  const receipt = { bindingId: 'binding', threadId: target.threadId, epoch: completed.epoch, revision: completed.revision, runId: completed.head.runId };
  assert.equal(tracker.acknowledge(receipt).outcome, 'accepted');

  const hold = model.holdNext('READ_ABORT'); holds.push(hold.release);
  const partial = gate();
  session.subscribe(event => { if (event.type === 'message_update' && event.event.type === 'text-delta' && event.event.delta.includes('started:READ_ABORT')) partial.release(); });
  const sending = session.sendMessage({ content: 'READ_ABORT', untilIdle: false });
  await hold.reached; await partial.promise; await abortNativeChat(session); hold.release(); await sending; await settled();
  const aborted = tracker.read('binding', target.threadId);
  assert.equal(aborted.head?.reason, 'aborted'); assert.equal(aborted.seen, false);
  assert.deepEqual(aborted.head, { ...witnessed[1], reason: 'aborted' });
  assert.notEqual(aborted.head?.runId, completed.head.runId);
  assert.equal(tracker.acknowledge(receipt).outcome, 'conflict');

  await session.sendMessage({ content: 'READ_QUESTION', untilIdle: false }); await settled();
  assert.equal(witnessed.at(-1)?.reason, 'suspended');
  assert.deepEqual(tracker.read('binding', target.threadId), aborted);
  const pending = [...session.displayState.get().pendingSuspensions.values()][0]; assert.ok(pending);
  const claimed = session.claimToolSuspension(pending.toolCallId); assert.equal(claimed.accepted, true);
  try { await session.respondToToolSuspension({ toolCallId: pending.toolCallId, resumeData: 'Evidence', requestContext: await session.machinery.buildRequestContext() }); }
  finally { session.releaseToolResponse(pending.toolCallId); }
  await settled();
  const resumed = tracker.read('binding', target.threadId); assert.equal(resumed.head?.reason, 'complete');
  assert.equal(resumed.head?.runId, witnessed.at(-2)?.runId, 'resuming a parked question uses the same native run');

  await session.model.switch('failure/chat');
  await session.sendMessage({ content: 'READ_ERROR' }).catch(() => {}); await settled();
  const failed = tracker.read('binding', target.threadId);
  assert.ok(rejectedRequests > 0, 'the actual local provider received native requests');
  assert.equal(failed.head?.reason, 'error'); assert.equal(failed.seen, false); assert.ok(failed.head?.runId);
  assert.notEqual(failed.head?.runId, resumed.head?.runId);
  assert.equal(failed.head?.runId, witnessed.at(-1)?.runId);
  assert.equal(session.displayState.get().currentMessage?.role, 'signal', 'native failure before output leaves the current user signal');
  assert.equal(witnessed.at(-1)?.messageId, session.displayState.get().currentMessage?.id);
  assert.equal(failed.head?.messageId, null, 'the native input signal is not a terminal assistant witness');
  assert.notEqual(failed.head?.messageId, resumed.head?.messageId, 'an error before assistant output cannot reuse the old answer ID');
  t.diagnostic(JSON.stringify({ beforeError: resumed.head, errorHead: failed.head, currentMessage: session.displayState.get().currentMessage, rejectedPaths }));
  assert.ok(changed.every(([binding, thread]) => binding === 'binding' && thread === target.threadId));
  await runtime.releaseSession({ resourceId: target.resourceId });
  assert.deepEqual(tracker.read('binding', target.threadId), failed, 'release retains the observed head within this service epoch');
  tracker.dispose(); await runtime.dispose(); sessions.clear();
  runtime = await createProjectRuntime(options);
  const restarted = createChatReadState('next-epoch', () => {}); restarted.observeRuntime(runtime, 'binding'); t.after(() => restarted.dispose());
  let activations = 0; runtime.controller.onSessionCreated(() => { activations++; });
  const requestCount = model.requests.length + rejectedRequests;
  const dormantHistory = await runtime.controller.queryThreadMessages({ ...target, perPage: 20 });
  assert.ok(dormantHistory.messages.some(message => JSON.stringify(message.content).includes('READ_NATIVE_FINAL')));
  assert.deepEqual(restarted.read('binding', target.threadId), { epoch: 'next-epoch', revision: 0, head: null, seen: null });
  assert.equal(activations, 0); assert.equal(await runtime.controller.getSessionByResource(target.resourceId), undefined);
  assert.equal(model.requests.length + rejectedRequests, requestCount, 'native history and unknown state reads do not invoke a model');
});
