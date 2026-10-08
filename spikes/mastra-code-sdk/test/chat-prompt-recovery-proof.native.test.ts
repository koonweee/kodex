import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import { createChatService } from '../src/chat-service.js';
import { readNativePrompts, type PromptResponse, type NativePromptTarget } from '../src/chat-prompts.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { openProductRegistry } from '../src/product-registry.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
const modes = [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }, { id: 'plan', defaultModelId: 'fixture/chat' }];
interface ParkedReport { target: NativePromptTarget; kind: 'question' | 'plan'; nativeRun: unknown }

if (process.argv[2] === 'producer') {
  const [profileRoot, root, kind] = process.argv.slice(3); assert.ok(profileRoot && root && (kind === 'question' || kind === 'plan'));
  const profile = activateProfile(resolveProfile(profileRoot)), projectPath = join(root, 'project');
  const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'), modes, subagents: [] });
  const session = await runtime.createSession({ threadId: `recovery-${kind}`, resourceId: `recovery-${kind}-resource` });
  await session.thread.rename({ title: `Recovery ${kind}`, pin: true });
  if (kind === 'plan') await session.mode.switch({ modeId: 'plan' });
  const ended = gate();
  session.subscribe(event => { if (event.type === 'agent_end' && event.reason === 'suspended') ended.release(); });
  await session.thread.ensureCurrentSubscription();
  // Consume the actual public stream through workflow snapshot persistence;
  // the Session independently projects its real thread subscription events.
  const stream = await session.machinery.getAgent().stream(`RECOVERY_${kind.toUpperCase()}`, { ...await session.machinery.buildStreamOptions({}), untilIdle: false });
  const reader = stream.fullStream.getReader();
  try { for (;;) { const next = await reader.read(); if (next.done) break; } } finally { reader.releaseLock(); }
  await ended.promise;
  const prompt = readNativePrompts(session).find(prompt => prompt.kind === kind); assert.ok(prompt?.target);
  const target = prompt.target;
  const native = await session.machinery.getAgent().listSuspendedRuns({ threadId: session.thread.requireId(), resourceId: session.identity.getResourceId(), perPage: 1, page: 0 });
  assert.equal(native.total, 1); assert.equal(native.runs[0]?.runId, target.runId);
  await new Promise<void>((resolve, reject) => process.send!({ target, kind, nativeRun: native.runs[0] } satisfies ParkedReport, undefined, undefined, error => error ? reject(error) : resolve()));
  await new Promise(() => {}); // The test parent kills only this disposable producer.
} else {
  let profile: SpikeProfile, profileRoot: string;
  before(async () => { profileRoot = await mkdtemp(join(tmpdir(), 'kodex-prompt-recovery-profile-')); profile = activateProfile(resolveProfile(profileRoot)); });
  after(async () => { await rm(profileRoot, { recursive: true, force: true }); });
  for (const kind of ['question', 'plan'] as const) test(`cold native ${kind} suspension is not an actionable prompt after reopening; fresh input still runs`, { timeout: 30_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), `kodex-prompt-recovery-${kind}-`)), projectPath = join(root, 'project'); await mkdir(projectPath);
    await writeFile(join(projectPath, 'plan.md'), '# Native recovery proof plan');
    let runtime!: ProjectRuntime;
    const trace: unknown[] = [];
    const fixture = await startModelFixture(request => {
      const user = lastUserText(request); trace.push({ model: user });
      if (user.includes('FRESH_AFTER_RESTART')) return { text: 'FRESH_NATIVE_RESTART_RESULT' };
      if (JSON.stringify(request.messages).includes('User answered:')) return { text: 'OLD_QUESTION_MUST_NOT_RESUME' };
      return { toolCalls: [{ name: kind === 'plan' ? 'submit_plan' : 'ask_user', arguments: kind === 'plan' ? { path: 'plan.md' } : { question: 'Which persisted evidence?' }, id: `recovery-${kind}-tool` }] };
    });
    await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false }, models: { observerModelOverride: null, reflectorModelOverride: null }, customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'local', models: ['chat'] }] }));
    const worker = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'producer', profileRoot, root, kind], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    assert.ok(worker.stdout && worker.stderr);
    let output = ''; worker.stdout.on('data', chunk => { output += chunk; }); worker.stderr.on('data', chunk => { output += chunk; });
    const parked = new Promise<ParkedReport>((resolve, reject) => { worker.once('message', value => resolve(value as ParkedReport)); worker.once('exit', (code, signal) => reject(new Error(`Producer exited before durable suspension: ${code}/${signal} ${output}`))); });
    let service: ReturnType<typeof createChatService> | undefined;
    t.diagnostic(`Prompt recovery trace: ${join(root, 'trace.json')}`);
    t.after(async () => {
      if (worker.exitCode === null && worker.signalCode === null) { const exit = once(worker, 'exit'); worker.kill('SIGKILL'); await exit; }
      await service?.dispose(); await fixture.close();
      await writeFile(join(root, 'trace.json'), JSON.stringify({ output, requests: fixture.requests, trace }, null, 2));
      for (const directory of ['project', 'runtime', 'product']) await rm(join(root, directory), { recursive: true, force: true });
    });
    const old = await parked; trace.push({ old }); assert.equal(fixture.requests.length, 1);
    const exit = once(worker, 'exit'); worker.kill('SIGKILL'); await exit;
    service = createChatService({ profile, instanceId: 'recovery-proof', directoryHome: projectPath, registryFactory: () => openProductRegistry(resolveProfile(join(root, 'product'))),
      projects: [{ id: 'recovery', name: 'Recovery', path: projectPath, runtimeRoot: join(root, 'runtime') }],
      runtimeFactory: async input => { runtime = await createProjectRuntime({ ...input, modes, subagents: [] }); return runtime; } });
    const snapshot = await service.openChat({ chatId: old.target.threadId });
    assert.deepEqual(snapshot.prompts, [], 'reopening projects persisted history without re-registering process-local suspension prompts');
    const retainedHistory = JSON.stringify(snapshot.messages);
    assert.ok(retainedHistory.includes(`RECOVERY_${kind.toUpperCase()}`), 'reopened native history retains the pre-crash user input');
    assert.ok(retainedHistory.includes(old.target.toolCallId), 'reopened native history retains the original suspended tool invocation');
    assert.equal(snapshot.display.pendingSuspensions.size, 0);
    const session = await runtime.controller.getSessionByResource(old.target.resourceId); assert.ok(session);
    assert.equal(session.identity.getId(), old.target.sessionId, 'native default Session ID is reused; it is not a runtime nonce');
    assert.equal(session.suspensions.hasPending(), false);
    const discovered = await session.machinery.getAgent().listSuspendedRuns({ threadId: old.target.threadId, resourceId: old.target.resourceId, perPage: 1, page: 0 });
    trace.push({ discovered }); assert.equal(discovered.total, 1); assert.equal(discovered.runs.length, 1);
    const saved = discovered.runs[0]!; assert.equal(saved.runId, old.target.runId); assert.equal(saved.threadId, old.target.threadId); assert.equal(saved.resourceId, old.target.resourceId);
    assert.ok(saved.toolCalls.some(tool => tool.toolCallId === old.target.toolCallId && tool.toolName === (kind === 'plan' ? 'submit_plan' : 'ask_user') && !tool.requiresApproval));
    const wrongOwner = await session.machinery.getAgent().listSuspendedRuns({ threadId: old.target.threadId, resourceId: 'unrelated-resource', perPage: 1, page: 0 });
    assert.deepEqual(wrongOwner, { runs: [], total: 0 }, 'native discovery filters both owner fields');
    const response: PromptResponse = kind === 'plan' ? { kind: 'plan', target: old.target, action: 'approved' } : { kind: 'question', target: old.target, answer: 'STALE_ANSWER' };
    await assert.rejects(service.respondPrompt({ chatId: old.target.threadId, ...response }), { code: 'CONFLICT' });
    assert.equal(fixture.requests.length, 1, 'stale response does not resume a native persisted run');
    let freshRunId: string | null = null;
    const completed = gate(); session.subscribe(event => { trace.push({ runId: session.getCurrentRunId(), event }); if (event.type === 'agent_start') freshRunId = session.getCurrentRunId(); if (event.type === 'agent_end' && event.reason === 'complete') completed.release(); });
    await service.send({ chatId: old.target.threadId, text: 'FRESH_AFTER_RESTART' }); await completed.promise;
    const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() }); assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function'); await memory.settled();
    assert.equal(fixture.requests.length, 2, 'fresh user input gets its own actual model request');
    assert.ok(freshRunId); assert.notEqual(freshRunId, old.target.runId, 'fresh input starts a new native run rather than resuming the old suspension');
    const afterFreshInput = await session.machinery.getAgent().listSuspendedRuns({ threadId: old.target.threadId, resourceId: old.target.resourceId, perPage: 1, page: 0 });
    trace.push({ afterFreshInput });
    assert.equal(afterFreshInput.total, 1); assert.equal(afterFreshInput.runs[0]?.runId, old.target.runId, 'fresh input leaves the old native snapshot inert in storage');
    assert.ok(JSON.stringify(await session.thread.listActiveMessages()).includes('FRESH_NATIVE_RESTART_RESULT'));
    assert.deepEqual((await service.openChat({ chatId: old.target.threadId })).prompts, []);
  });
}
