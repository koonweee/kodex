import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { ORPCError } from '@orpc/server';
import { createTool } from '@mastra/core/tools';
import { abortNativeChat } from '../src/chat-archive.js';
import { readNativePrompts, respondNativePrompt, type NativePrompt } from '../src/chat-prompts.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime } from '../src/runtime.js';
import { startModelFixture } from './fixtures/model-server.js';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
let root: string, profile: SpikeProfile;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-native-prompts-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });
const options = [{ label: 'First', description: 'Use first evidence' }, { label: 'Second', description: 'Use second evidence' }];

async function setup(t: TestContext, name: string, kind: 'question' | 'multi' | 'approval' | 'plan' | 'unsupported') {
  const projectPath = join(root, name); await mkdir(projectPath);
  await writeFile(join(projectPath, 'evidence.txt'), 'PROMPT_NATIVE_FILE_EVIDENCE');
  await writeFile(join(projectPath, 'plan.md'), '# A native plan\nRead evidence.txt.');
  const suspended = new Set<string>(), executions: Promise<unknown>[] = [], responses: Promise<void>[] = [], producers = new Map<string, ReturnType<typeof deferred>>();
  const resumeGate = { reached: deferred(), release: deferred() };
  let holdResume = false;
  let approvedExecutions = 0;
  const fixture = await startModelFixture(async request => {
    const userIndex = request.messages.findLastIndex(message => message.role === 'user');
    const current = request.messages.slice(userIndex), serialized = JSON.stringify(request.messages);
    if (kind === 'unsupported' && current.some(message => message.role === 'tool')) return { text: 'UNSUPPORTED_FIXTURE_FINISHED' };
    const completed = kind === 'approval'
      ? current.some(message => message.role === 'tool')
      : /User answered:|Plan approved\.|Plan was not approved\./.test(serialized);
    if (completed) {
      if (holdResume) { resumeGate.reached.resolve(); await resumeGate.release.promise; }
      return { text: 'NATIVE_PROMPT_RESUMED_FINAL' };
    }
    const toolName = kind === 'approval' ? 'prompt_approval' : kind === 'plan' ? 'submit_plan' : kind === 'unsupported' ? 'unknown_prompt' : 'ask_user';
    return { toolCalls: [{ name: toolName, id: 'reused-native-prompt', arguments: kind === 'approval' ? { path: 'evidence.txt' }
      : kind === 'plan' ? { path: 'plan.md' }
      : kind === 'unsupported' ? {} : { question: 'Which evidence?', options,
        selectionMode: kind === 'multi' ? 'multi_select' : 'single_select' } }] };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    preferences: { yolo: true }, lsp: false, observability: { enabled: false },
  }));
  const approval = createTool({ id: 'prompt_approval', description: 'Actual native approval gate fixture', requireApproval: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async () => { approvedExecutions++; return { content: await readFile(join(projectPath, 'evidence.txt'), 'utf8') }; } });
  const unknown = createTool({ id: 'unknown_prompt', description: 'Native unsupported suspension fixture',
    inputSchema: { type: 'object', properties: {} },
    execute: async (_input, context) => { if (context.agent?.resumeData !== undefined) return { content: 'User answered: CLEANUP' }; await context.agent?.suspend?.({ unsupported: true }); } });
  const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, `${name}-runtime`), subagents: [],
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } },
      { id: 'plan', defaultModelId: 'fixture/chat' }],
    extraTools: { unknown_prompt: unknown, prompt_approval: approval } });
  const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
  const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
  // Test-only producer teardown, never part of the prompt helper.
  t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
    const result = register(...args);
    if (args[0].id === 'agentic-loop' && args[1]) {
      producers.set(args[1], deferred()); suspended.delete(args[1]);
      const createRun = args[0].createRun.bind(args[0]);
      t.mock.method(args[0], 'createRun', async (...input: Parameters<typeof createRun>) => {
        const run = await createRun(...input);
        const startRun = run.start.bind(run), resumeRun = run.resume.bind(run);
        t.mock.method(run, 'start', (...values: Parameters<typeof startRun>) => {
          const completion = startRun(...values); executions.push(completion); return completion;
        });
        t.mock.method(run, 'resume', (...values: Parameters<typeof resumeRun>) => {
          const completion = resumeRun(...values); executions.push(completion); return completion;
        });
        return run;
      });
    }
    return result;
  });
  t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
    unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.resolve();
  });
  const session = await runtime.createSession({ threadId: name, resourceId: name });
  await session.thread.rename({ title: name, pin: true });
  const respond = session.respondToToolSuspension.bind(session);
  t.mock.method(session, 'respondToToolSuspension', (...input: Parameters<typeof respond>) => {
    const response = respond(...input); responses.push(response); return response;
  });
  const toolResults: unknown[] = [];
  const ends: string[] = [], pending = deferred();
  let terminal = deferred();
  const off = session.subscribe(event => {
    const runId = session.getCurrentRunId();
    if (event.type === 'agent_start') {
      if (ends.at(-1) !== 'suspended') terminal = deferred();
    }
    if (event.type === 'tool_suspended') { if (runId) suspended.add(runId); pending.resolve(); }
    if (event.type === 'tool_approval_required') pending.resolve();
    if (event.type === 'tool_end') toolResults.push(event.result);
    if (event.type === 'agent_end') {
      ends.push(event.reason ?? 'unknown');
      if (event.reason !== 'suspended') terminal.resolve();
    }
  });
  async function joinProducers() {
    let joined = -1;
    while (joined !== producers.size) {
      joined = producers.size;
      await Promise.allSettled(executions);
      await Promise.all([...producers].map(([id, done]) => suspended.has(id) ? undefined : done.promise));
      await Promise.allSettled(responses);
    }
  }
  t.after(async () => {
    resumeGate.release.resolve();
    await abortNativeChat(session); await started;
    // Stop can leave the suspended producer finishing its snapshot; join the public
    // workflow run's existing start promise in the test observer before close.
    await joinProducers(); off(); await runtime.dispose(); await fixture.close();
  });
  if (kind === 'approval') {
    await session.state.set({ yolo: false });
    await session.permissions.setForTool({ toolName: 'prompt_approval', policy: 'ask' });
  }
  if (kind === 'plan') await session.mode.switch({ modeId: 'plan' });
  const started = session.sendMessage({ content: 'INITIAL_NATIVE_PROMPT', untilIdle: false });
  void started.catch(() => {});
  await pending.promise;
  if (kind !== 'approval') { await started; await Promise.allSettled(executions); }
  return { runtime, session, fixture, started, ends, toolResults, joinProducers,
    get approvedExecutions() { return approvedExecutions; },
    get terminal() { return terminal.promise; },
    holdResume() { holdResume = true; return { reached: resumeGate.reached.promise, release: resumeGate.release.resolve }; } };
}
function knownPrompt<K extends 'question' | 'approval' | 'plan'>(prompts: NativePrompt[], kind: K): Extract<NativePrompt, { kind: K }> {
  const prompt = prompts.find(prompt => prompt.kind === kind); assert.ok(prompt);
  return prompt as Extract<NativePrompt, { kind: K }>;
}
const conflict = (error: unknown) => error instanceof ORPCError && error.code === 'CONFLICT';
const badRequest = (error: unknown) => error instanceof ORPCError && error.code === 'BAD_REQUEST';

test('two callers contend for one native question; short acknowledgment precedes resumed completion', { timeout: 35_000 }, async t => {
  const env = await setup(t, 'question', 'question');
  const prompt = knownPrompt(readNativePrompts(env.session), 'question');
  assert.equal(prompt.question, 'Which evidence?'); assert.deepEqual(prompt.options, options);
  assert.equal(prompt.selectionMode, 'single_select');
  assert.equal(prompt.target.sessionId, env.session.identity.getId());
  const originalRun = env.session.suspensions.get({ toolCallId: prompt.target.toolCallId });
  assert.equal(prompt.target.runId, originalRun?.runId);
  await assert.rejects(respondNativePrompt(env.session, { kind: 'question', target: prompt.target, answer: ['wrong shape'] }), badRequest);
  const held = env.holdResume();
  const results = await Promise.allSettled([
    respondNativePrompt(env.session, { kind: 'question', target: prompt.target, answer: 'WINNING_ANSWER' }),
    respondNativePrompt(env.session, { kind: 'question', target: prompt.target, answer: 'LOSING_ANSWER' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const losing = results.find(result => result.status === 'rejected'); assert.ok(losing && losing.status === 'rejected'); assert.ok(conflict(losing.reason));
  await held.reached;
  assert.ok(env.session.displayState.get().isRunning, 'helper returned while native resumed model is held');
  assert.equal(readNativePrompts(env.session).length, 0);
  assert.equal(env.fixture.requests.length, 2);
  assert.match(JSON.stringify(env.fixture.requests.at(-1)!.messages), /User answered: WINNING_ANSWER/);
  assert.doesNotMatch(JSON.stringify(env.fixture.requests.at(-1)!.messages), /LOSING_ANSWER/);
  held.release(); await env.terminal; await env.joinProducers();
  assert.ok(env.ends.includes('complete'));
  assert.equal(env.session.claimToolResponse(prompt.target.toolCallId), true, 'response claim was released after native completion');
  env.session.releaseToolResponse(prompt.target.toolCallId);
  await assert.rejects(respondNativePrompt(env.session, { kind: 'question', target: prompt.target, answer: 'STALE' }), conflict);
});

test('multi-select preserves labels and custom array text through actual native resume', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'multi', 'multi');
  const prompt = knownPrompt(readNativePrompts(env.session), 'question');
  assert.equal(prompt.selectionMode, 'multi_select');
  await assert.rejects(respondNativePrompt(env.session, { kind: 'question', target: prompt.target, answer: 'wrong shape' }), badRequest);
  await respondNativePrompt(env.session, { kind: 'question', target: prompt.target, answer: ['Second', 'Custom guidance'] });
  await env.terminal; await env.joinProducers();
  assert.match(JSON.stringify(env.fixture.requests.at(-1)!.messages), /User answered: Second, Custom guidance/);
});

test('Stop and same toolCallId replacement reject the old run and session identities', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'stale', 'question');
  const old = knownPrompt(readNativePrompts(env.session), 'question');
  const contextReached = deferred(), contextRelease = deferred(); t.after(() => contextRelease.resolve());
  const buildContext = env.session.machinery.buildRequestContext.bind(env.session.machinery);
  let holdOnce = true;
  t.mock.method(env.session.machinery, 'buildRequestContext', async (...input: Parameters<typeof buildContext>) => {
    if (holdOnce) { holdOnce = false; contextReached.resolve(); await contextRelease.promise; }
    return buildContext(...input);
  });
  const waitingReply = respondNativePrompt(env.session, { kind: 'question', target: old.target, answer: 'BEFORE_CONTEXT_RETURN' });
  void waitingReply.catch(() => {}); await contextReached.promise;
  await abortNativeChat(env.session);
  assert.equal(readNativePrompts(env.session).length, 0);
  await assert.rejects(respondNativePrompt(env.session, { kind: 'question', target: old.target, answer: 'AFTER_STOP' }), conflict);
  const parkedAgain = deferred();
  const offParked = env.session.subscribe(event => { if (event.type === 'tool_suspended') parkedAgain.resolve(); }); t.after(offParked);
  await env.session.sendMessage({ content: 'REPLACEMENT_NATIVE_PROMPT', untilIdle: false });
  await parkedAgain.promise;
  const fresh = knownPrompt(readNativePrompts(env.session), 'question');
  assert.equal(fresh.target.toolCallId, old.target.toolCallId); assert.notEqual(fresh.target.runId, old.target.runId);
  contextRelease.resolve(); await assert.rejects(waitingReply, conflict);
  await assert.rejects(respondNativePrompt(env.session, { kind: 'question', target: old.target, answer: 'OLD_RUN' }), conflict);
  await assert.rejects(respondNativePrompt(env.session, { kind: 'question', target: { ...fresh.target, sessionId: 'other-session' }, answer: 'OTHER_SESSION' }), conflict);
  await assert.rejects(respondNativePrompt(env.session, { kind: 'question', target: { ...fresh.target, threadId: 'other-thread' }, answer: 'OTHER_THREAD' }), conflict);
  await assert.rejects(respondNativePrompt(env.session, { kind: 'question', target: { ...fresh.target, resourceId: 'other-resource' }, answer: 'OTHER_RESOURCE' }), conflict);
  assert.equal(env.fixture.requests.length, 2);
  assert.deepEqual(knownPrompt(readNativePrompts(env.session), 'question').target, fresh.target, 'losing stale responses leave the replacement prompt untouched');
  assert.doesNotMatch(JSON.stringify(env.fixture.requests), /BEFORE_CONTEXT_RETURN|AFTER_STOP|OLD_RUN|OTHER_SESSION|OTHER_THREAD|OTHER_RESOURCE/);
});

for (const decision of ['approve', 'decline', 'always_allow_category'] as const) {
  test(`ordinary native ask-policy approval ${decision} clears exactly its live gate`, { timeout: 30_000 }, async t => {
    const env = await setup(t, `approval-${decision}`, 'approval');
    const prompt = knownPrompt(readNativePrompts(env.session), 'approval');
    assert.equal(prompt.toolName, 'prompt_approval'); assert.deepEqual(prompt.args, { path: 'evidence.txt' });
    assert.equal(env.session.displayState.get().isRunning, true);
    assert.equal(env.approvedExecutions, 0);
    const results = await Promise.allSettled([
      respondNativePrompt(env.session, { kind: 'approval', target: prompt.target, decision }),
      respondNativePrompt(env.session, { kind: 'approval', target: prompt.target, decision }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(readNativePrompts(env.session).length, 0);
    await env.started; await env.joinProducers();
    assert.equal(env.ends.at(-1), 'complete');
    assert.equal(env.approvedExecutions, decision === 'decline' ? 0 : 1);
    const history = JSON.stringify(await env.session.thread.listActiveMessages());
    if (decision === 'decline') assert.doesNotMatch(history, /PROMPT_NATIVE_FILE_EVIDENCE/);
    else assert.match(history, /PROMPT_NATIVE_FILE_EVIDENCE/);
    await assert.rejects(respondNativePrompt(env.session, { kind: 'approval', target: prompt.target, decision }), conflict);
  });
}

for (const action of ['approved', 'rejected'] as const) {
  test(`native plan ${action} resumes with decision and optional feedback`, { timeout: 30_000 }, async t => {
    const env = await setup(t, `plan-${action}`, 'plan');
    const prompt = knownPrompt(readNativePrompts(env.session), 'plan');
    assert.equal(prompt.path, 'plan.md'); assert.equal(prompt.plan, undefined, 'helper performs no file read');
    await respondNativePrompt(env.session, { kind: 'plan', target: prompt.target, action, ...(action === 'rejected' && { feedback: 'Use second evidence' }) });
    if (action === 'approved') await env.terminal;
    await env.joinProducers();
    assert.equal(readNativePrompts(env.session).length, 0);
    if (action === 'approved') assert.match(JSON.stringify(await env.session.thread.listActiveMessages()), /Plan approved/);
    else {
      assert.match(JSON.stringify(env.toolResults), /Use second evidence/);
      assert.equal(env.fixture.requests.length, 1, 'native rejection processor stops before another model request');
    }
  });
}

test('unknown suspension and detached approval remain visible and non-actionable', { timeout: 30_000 }, async t => {
  const env = await setup(t, 'unsupported', 'unsupported');
  const prompt = readNativePrompts(env.session).find(prompt => prompt.kind === 'unsupported'); assert.ok(prompt);
  assert.equal(prompt.toolName, 'unknown_prompt'); assert.ok(prompt.target);
  await assert.rejects(respondNativePrompt(env.session, { kind: 'question', target: prompt.target, answer: 'UNSUPPORTED' }), badRequest);
  const detachedGate = env.session.approval.arm({ toolName: 'view', toolCallId: 'detached-approval', threadId: 'detached-thread', runId: 'detached-run' });
  env.session.emit({ type: 'tool_approval_required', toolName: 'view', toolCallId: 'detached-approval', threadId: 'detached-thread', args: { path: 'evidence.txt' } });
  const detached = readNativePrompts(env.session).find(prompt => prompt.kind === 'unsupported' && prompt.toolCallId === 'detached-approval');
  assert.ok(detached && detached.kind === 'unsupported'); assert.equal(detached.target, null);
  const fake = { ...prompt.target, toolCallId: 'detached-approval', runId: 'detached-run' };
  await assert.rejects(respondNativePrompt(env.session, { kind: 'approval', target: fake, decision: 'approve' }), conflict);
  assert.equal(env.session.approval.isArmed({ toolCallId: 'detached-approval' }), true);
  env.session.respondToToolApproval({ toolCallId: 'detached-approval', decision: 'decline' }); await detachedGate;
  assert.equal(env.fixture.requests.length, 1);
});
