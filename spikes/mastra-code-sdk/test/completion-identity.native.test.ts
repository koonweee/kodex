import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test, type TestContext } from 'node:test';
import { createTool } from '@mastra/core/tools';
import { abortNativeChat } from '../src/chat-archive.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}
type Terminal = { reason?: string; runId: string | null; currentMessageId?: string };
let root: string, profile: SpikeProfile;
before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-completion-identity-')));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function setup(t: TestContext, kind: 'final' | 'abort' | 'suspend') {
  const projectPath = join(root, kind); await mkdir(projectPath);
  let toolsExecuted = 0;
  const model = await startModelFixture(request => {
    const latestUser = request.messages.findLastIndex(message => message.role === 'user');
    const current = request.messages.slice(latestUser);
    if (kind === 'suspend') return current.some(message => message.role === 'tool')
      ? { text: 'NATIVE_RESUMED_FINAL' }
      : { toolCalls: [{ name: 'ask_user', id: 'native-question', arguments: { question: 'Which evidence?' } }] };
    if (lastUserText(request).includes('TOOL_COMPLETION')) return current.some(message => message.role === 'tool')
      ? { text: 'NATIVE_TOOL_FINAL' }
      : { toolCalls: [{ name: 'completion_probe', id: 'native-completion-tool', arguments: {} }] };
    return { text: 'NATIVE_PLAIN_FINAL' };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    customProviders: [{ name: 'fixture', url: model.url, apiKey: 'fake-local-key', models: ['chat'] }],
    models: { observerModelOverride: null, reflectorModelOverride: null }, preferences: { yolo: true },
    lsp: false, observability: { enabled: false },
  }));
  const options = { profile, projectPath, runtimeRoot: join(root, `${kind}-runtime`), subagents: [], disableMcp: true,
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
    extraTools: { completion_probe: createTool({ id: 'completion_probe', description: 'Native completion probe',
      inputSchema: { type: 'object', properties: {} }, execute: async () => { toolsExecuted++; return { evidence: 'NATIVE_TOOL_RESULT' }; } }) } };
  const target = { threadId: `${kind}-thread`, resourceId: `${kind}-resource` };
  const producers = new Map<string, ReturnType<typeof deferred>>(), executions: Promise<unknown>[] = [];
  const suspended = new Set<string>(), sessions = new Set<NativeSession>();
  const terminals: Terminal[] = [], messageEnds: string[] = [], unsubscribe: Array<() => void> = [];
  const partialSeen = deferred();
  const terminalEvents: string[] = [], terminalGates: Array<{ reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }> = [];
  let nextTerminalGate: typeof terminalGates[number] | undefined;
  let runtime: ProjectRuntime, activations = 0;
  async function open() {
    runtime = await createProjectRuntime(options);
    runtime.controller.onSessionCreated(session => { sessions.add(session); activations++; });
    const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
    const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
    // Test-only passthrough teardown observation. Capability assertions below use
    // public Session, memory and storage reads, never this producer bookkeeping.
    t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
      const result = register(...args);
      if (args[0].id === 'agentic-loop' && args[1]) {
        producers.set(args[1], deferred()); suspended.delete(args[1]);
        const createRun = args[0].createRun.bind(args[0]);
        t.mock.method(args[0], 'createRun', async (...input: Parameters<typeof createRun>) => {
          const run = await createRun(...input);
          const start = run.start.bind(run), resume = run.resume.bind(run);
          t.mock.method(run, 'start', (...values: Parameters<typeof start>) => { const done = start(...values); executions.push(done); return done; });
          t.mock.method(run, 'resume', (...values: Parameters<typeof resume>) => { const done = resume(...values); executions.push(done); return done; });
          return run;
        });
      }
      return result;
    });
    t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
      unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.resolve();
    });
  }
  async function settle() {
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
  async function summaries() {
    const store = await runtime.mastra.getStorage()?.getStore('workflows'); assert.ok(store);
    const resource = await store.listWorkflowRuns({ resourceId: target.resourceId, page: 0, perPage: 20, summary: true });
    const thread = await store.listWorkflowRuns({ resourceId: target.resourceId, threadId: target.threadId, page: 0, perPage: 20, summary: true });
    return { resource: resource.runs, thread: thread.runs };
  }
  t.after(async () => {
    for (const gate of terminalGates) gate.release.resolve();
    for (const off of unsubscribe) off();
    for (const session of sessions) await abortNativeChat(session);
    await settle(); await runtime?.dispose(); await model.close();
  });
  await open();
  const session = await runtime!.createSession(target);
  await session.thread.rename({ title: 'Native completion proof', pin: true });
  unsubscribe.push(session.onBeforeAgentEnd(async event => {
    terminals.push({ reason: event.reason, runId: session.run.getRunId(), currentMessageId: session.displayState.get().currentMessage?.id });
    const gate = nextTerminalGate; nextTerminalGate = undefined;
    if (gate) { gate.reached.resolve(); await gate.release.promise; }
  }));
  unsubscribe.push(session.subscribe(event => {
    if (event.type === 'agent_end') terminalEvents.push(event.reason ?? 'unknown');
    if (event.type === 'message_end') messageEnds.push(event.id);
    if (event.type === 'message_update' && event.event.type === 'text-delta' && event.event.delta.includes('started:ABORT_COMPLETION')) partialSeen.resolve();
    if (event.type === 'tool_suspended') { const id = session.run.getRunId(); if (id) suspended.add(id); }
  }));
  async function history() { return (await runtime!.controller.queryThreadMessages({ ...target, perPage: 40 })).messages; }
  async function reopen() {
    for (const off of unsubscribe.splice(0)) off();
    await settle(); await runtime!.dispose();
    const script = `
      import { activateProfile, resolveProfile } from ${JSON.stringify(new URL('../src/profile.js', import.meta.url).href)};
      import { createProjectRuntime } from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).href)};
      const profile = activateProfile(resolveProfile(${JSON.stringify(profile.root)}));
      const runtime = await createProjectRuntime({ profile, projectPath: ${JSON.stringify(projectPath)}, runtimeRoot: ${JSON.stringify(options.runtimeRoot)}, subagents: [], disableMcp: true, modes: ${JSON.stringify(options.modes)} });
      let activations = 0; runtime.controller.onSessionCreated(() => { activations++; });
      try {
        const messages = (await runtime.controller.queryThreadMessages({ ...${JSON.stringify(target)}, perPage: 40 })).messages;
        const workflows = await runtime.mastra.getStorage().getStore('workflows');
        const resource = await workflows.listWorkflowRuns({ resourceId: ${JSON.stringify(target.resourceId)}, page: 0, perPage: 20, summary: true });
        const thread = await workflows.listWorkflowRuns({ ...${JSON.stringify(target)}, page: 0, perPage: 20, summary: true });
        console.log('COMPLETION_COLD_READ:' + JSON.stringify({ messages, activations, resource: resource.runs, thread: thread.runs, mounted: !!(await runtime.controller.getSessionByResource(${JSON.stringify(target.resourceId)})) }));
      } finally { await runtime.dispose(); }
    `;
    const requestsBeforeColdRead = model.requests.length;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const line = stdout.split('\n').find(line => line.startsWith('COMPLETION_COLD_READ:'));
    assert.ok(line, `Cold reader did not report: ${stdout} ${stderr}`);
    const cold = JSON.parse(line.slice('COMPLETION_COLD_READ:'.length));
    assert.equal(cold.activations, 0); assert.equal(cold.mounted, false);
    assert.equal(model.requests.length, requestsBeforeColdRead);
    assert.deepEqual(cold.resource, []); assert.deepEqual(cold.thread, []);
    await open();
    const before = { activations, requests: model.requests.length };
    const saved = await history();
    assert.equal(activations, before.activations); assert.equal(model.requests.length, before.requests);
    assert.equal(await runtime!.controller.getSessionByResource(target.resourceId), undefined);
    assert.deepEqual(cold.messages, JSON.parse(JSON.stringify(saved)), 'cold process and dormant recreated runtime read identical native history');
    return saved;
  }
  return { session, model, terminals, terminalEvents, messageEnds, partialSeen: partialSeen.promise, settle, history, summaries, reopen,
    holdNextTerminal() { const gate = { reached: deferred(), release: deferred() }; nextTerminalGate = gate; terminalGates.push(gate); return { reached: gate.reached.promise, release: gate.release.resolve }; },
    get toolsExecuted() { return toolsExecuted; } };
}

function assertNoPersistedTerminalIdentity(messages: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['history']>>) {
  for (const message of messages) {
    assert.equal(message.content.metadata?.stopReason, undefined);
    assert.equal(message.content.metadata?.runId, undefined);
    assert.equal('status' in message, false, 'native message rows do not supply terminal run status');
  }
}

test('plain and tool-bearing final IDs persist, but native terminal reason and completion headers do not', { timeout: 35_000 }, async t => {
  const env = await setup(t, 'final');
  const held = env.holdNextTerminal();
  const running = env.session.sendMessage({ content: 'PLAIN_COMPLETION' });
  await held.reached;
  assert.equal(env.terminals[0]?.reason, 'complete'); assert.ok(env.terminals[0]?.runId);
  assert.deepEqual(env.terminalEvents, [], 'the public awaited beforeEnd hook runs before native agent_end is exposed');
  held.release(); await running; await env.settle();
  assert.deepEqual(env.terminalEvents, ['complete']);
  const plain = (await env.history()).find(message => message.role === 'assistant' && JSON.stringify(message.content).includes('NATIVE_PLAIN_FINAL'));
  assert.ok(plain); assert.equal(plain.id, env.messageEnds.at(-1)); assert.equal(env.terminals[0]?.currentMessageId, plain.id);
  await env.session.sendMessage({ content: 'TOOL_COMPLETION' }); await env.settle();
  const saved = await env.history();
  const final = saved.find(message => message.role === 'assistant' && JSON.stringify(message.content).includes('NATIVE_TOOL_FINAL'));
  const tool = saved.find(message => message.content.parts.some(part => part.type === 'tool-invocation'));
  assert.ok(final); assert.ok(tool); assert.match(JSON.stringify(tool.content), /NATIVE_TOOL_RESULT/);
  assert.equal(final.id, tool.id, 'the pinned native memory merges tool invocation and final text into one assistant row');
  assert.equal(env.toolsExecuted, 1); assert.equal(final.id, env.messageEnds.at(-1)); assert.equal(env.terminals[1]?.currentMessageId, final.id);
  assert.deepEqual(env.terminals.map(event => event.reason), ['complete', 'complete']);
  assert.ok(env.terminals.every(event => event.runId)); assert.notEqual(env.terminals[0]!.runId, env.terminals[1]!.runId);
  assertNoPersistedTerminalIdentity(saved);
  assert.deepEqual(await env.summaries(), { resource: [], thread: [] }, 'terminal agentic-loop snapshots are deleted, not retained completion headers');
  assert.deepEqual(await env.reopen(), saved); assert.deepEqual(await env.summaries(), { resource: [], thread: [] });
  t.diagnostic('Native final IDs match live message IDs and survive dormant runtime recreation; terminal reason/runId exist only in the live Session observation. No timestamp or UUID order is asserted.');
});

test('an observed aborted partial reopens with a different saved message ID and no retained terminal status', { timeout: 35_000 }, async t => {
  const env = await setup(t, 'abort');
  await env.session.sendMessage({ content: 'BEFORE_ABORT_COMPLETION' }); await env.settle();
  const completed = await env.history(); assert.ok(completed.some(message => message.role === 'assistant'));
  const hold = env.model.holdNext('ABORT_COMPLETION');
  t.after(hold.release);
  const started = env.session.sendMessage({ content: 'ABORT_COMPLETION', untilIdle: false });
  await hold.reached; await env.partialSeen; await abortNativeChat(env.session); hold.release(); await started; await env.settle();
  const saved = await env.history();
  assert.deepEqual(env.terminals.map(event => event.reason), ['complete', 'aborted']); assert.ok(env.terminals[1]?.runId);
  assert.notEqual(env.terminals[0]!.runId, env.terminals[1]!.runId);
  assertNoPersistedTerminalIdentity(saved);
  assert.deepEqual(await env.summaries(), { resource: [], thread: [] });
  const reopened = await env.reopen();
  const partial = reopened.find(message => message.role === 'assistant' && JSON.stringify(message.content).includes('started:ABORT_COMPLETION'));
  assert.ok(partial, 'native retirement retained the actually observed partial answer');
  assert.notEqual(partial.id, env.terminals[1]!.currentMessageId, 'native abort persistence creates a different saved message ID from the live aborted message');
  assert.equal(reopened.some(message => message.id === env.terminals[1]!.currentMessageId), false);
  for (const message of completed) assert.deepEqual(reopened.find(row => row.id === message.id), message);
  assertNoPersistedTerminalIdentity(reopened);
  assert.deepEqual(await env.summaries(), { resource: [], thread: [] });
  t.diagnostic(JSON.stringify({ terminals: env.terminals, partialSavedId: partial.id, immediateSavedIds: saved.map(message => message.id) }));
});

test('native suspension is live and resumable, with a retained workflow only while parked', { timeout: 35_000 }, async t => {
  const env = await setup(t, 'suspend');
  await env.session.sendMessage({ content: 'SUSPEND_COMPLETION', untilIdle: false }); await env.settle();
  assert.deepEqual(env.terminals.map(event => event.reason), ['suspended']);
  const pending = [...env.session.displayState.get().pendingSuspensions.values()][0]; assert.ok(pending);
  const parked = await env.summaries();
  t.diagnostic(JSON.stringify({ terminals: env.terminals, pending, parked: { resource: parked.resource.map(run => ({ runId: run.runId, workflowName: run.workflowName, status: (typeof run.snapshot === 'string' ? JSON.parse(run.snapshot) : run.snapshot)?.status })), thread: parked.thread.map(run => ({ runId: run.runId, workflowName: run.workflowName, status: (typeof run.snapshot === 'string' ? JSON.parse(run.snapshot) : run.snapshot)?.status })) } }));
  assert.ok(parked.resource.some(run => run.runId === env.terminals[0]!.runId && (typeof run.snapshot === 'string' ? JSON.parse(run.snapshot) : run.snapshot)?.status === 'suspended'));
  assert.ok(parked.thread.some(run => run.runId === env.terminals[0]!.runId));
  assertNoPersistedTerminalIdentity(await env.history());
  const claimed = env.session.claimToolSuspension(pending.toolCallId); assert.equal(claimed.accepted, true);
  try { await env.session.respondToToolSuspension({ toolCallId: pending.toolCallId, resumeData: 'NATIVE_ANSWER', requestContext: await env.session.machinery.buildRequestContext() }); }
  finally { env.session.releaseToolResponse(pending.toolCallId); }
  await env.settle();
  assert.deepEqual(env.terminals.map(event => event.reason), ['suspended', 'complete']);
  assert.equal(env.terminals[0]!.runId, env.terminals[1]!.runId, 'native resumption continues the suspended run identity');
  const saved = await env.history();
  const final = saved.find(message => message.role === 'assistant' && JSON.stringify(message.content).includes('NATIVE_RESUMED_FINAL'));
  assert.ok(final); assert.equal(final.id, env.messageEnds.at(-1)); assertNoPersistedTerminalIdentity(saved);
  assert.deepEqual(await env.summaries(), { resource: [], thread: [] });
  assert.deepEqual(await env.reopen(), saved);
});
