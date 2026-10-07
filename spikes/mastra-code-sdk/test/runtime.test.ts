import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime, type NativeSession } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

let root: string;
let profile: SpikeProfile;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
const runtimes: ProjectRuntime[] = [];
let judgeCalls = 0;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kodex-mastra-runtime-test-'));
  profile = resolveProfile(path.join(root, 'profile'));
  await activateProfile(profile);
  fixture = await startModelFixture(request => {
    if (request.model === 'judge') return { text: JSON.stringify({ decision: ++judgeCalls === 1 ? 'continue' : 'done', reason: 'Complete the deterministic second step.' }) };
    const user = lastUserText(request);
    if (user.includes('READ_MARKER') && request.messages.at(-1)?.role !== 'tool') {
      const tool = request.tools?.find(tool => tool.function.name === 'view');
      assert.ok(tool, 'the real workspace exposes its native view tool');
      return { toolCalls: [{ name: tool.function.name, arguments: { path: 'marker.txt' } }] };
    }
    return { text: `fixture:${request.messages.at(-1)?.role === 'tool' ? JSON.stringify(request.messages.at(-1)?.content) : user}` };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat', goalJudgeModel: 'fixture/judge', goalMaxTurns: Number.MAX_SAFE_INTEGER },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat', 'judge'] }],
    preferences: { yolo: true },
    observability: { enabled: false },
  }));
});

after(async () => {
  for (const runtime of runtimes.reverse()) await runtime.dispose();
  await fixture?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function project(name: string) {
  const projectPath = path.join(root, name);
  await mkdir(projectPath, { recursive: true });
  await writeFile(path.join(projectPath, 'marker.txt'), `ONLY_${name}`);
  const runtime = await createProjectRuntime({ projectPath, runtimeRoot: path.join(root, `${name}-runtime`), profile, disableMcp: true, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
  runtimes.push(runtime);
  return runtime;
}
function collect(session: NativeSession) {
  const events: AgentControllerEvent[] = [];
  const unsubscribe = session.subscribe(event => { events.push(event); });
  return { events, unsubscribe, waitFor(predicate: (event: AgentControllerEvent) => boolean) {
    if (events.some(predicate)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('Native event timeout')); }, 15_000);
      const off = session.subscribe(event => { if (predicate(event)) { clearTimeout(timer); off(); resolve(); } });
    });
  } };
}

// RED evidence: this suite initially failed importing the absent runtime module.
test('independent native sessions execute concurrently and retain separate project tools and memory', { timeout: 60_000 }, async () => {
  const [a, b] = await Promise.all([project('A'), project('B')]);
  const [sa, sb] = await Promise.all([a.createSession({ resourceId: 'resource-A', threadId: 'thread-A' }), b.createSession({ resourceId: 'resource-B', threadId: 'thread-B' })]);
  await Promise.all([sa.thread.rename({ title: 'Project A fixture' }), sb.thread.rename({ title: 'Project B fixture' })]);
  assert.notEqual(sa, sb);
  const ea = collect(sa);
  const eb = collect(sb);
  const holdA = fixture.holdNext('CONCURRENT_A');
  const holdB = fixture.holdNext('CONCURRENT_B');
  const runningA = sa.sendMessage({ content: 'CONCURRENT_A' });
  const runningB = sb.sendMessage({ content: 'CONCURRENT_B' });
  await Promise.all([holdA.reached, holdB.reached]);
  assert.equal(sa.displayState.get().isRunning, true);
  assert.equal(sb.displayState.get().isRunning, true);
  await Promise.all([ea.waitFor(event => event.type === 'message_update'), eb.waitFor(event => event.type === 'message_update')]);
  holdA.release();
  await runningA;
  assert.equal(sb.displayState.get().isRunning, true, 'finishing A leaves B running');
  holdB.release();
  await runningB;
  await Promise.all([sa.sendMessage({ content: 'READ_MARKER A' }), sb.sendMessage({ content: 'READ_MARKER B' })]);
  const [messagesA, messagesB] = await Promise.all([sa.thread.listActiveMessages(), sb.thread.listActiveMessages()]);
  const textA = JSON.stringify(messagesA);
  const textB = JSON.stringify(messagesB);
  assert.match(textA, /ONLY_A/);
  assert.doesNotMatch(textA, /ONLY_B|CONCURRENT_B/);
  assert.match(textB, /ONLY_B/);
  assert.doesNotMatch(textB, /ONLY_A|CONCURRENT_A/);
  assert.ok(ea.events.some(event => event.type === 'tool_end'), 'native workspace tool actually ran');
  assert.ok(eb.events.some(event => event.type === 'tool_end'));
  ea.unsubscribe();
  eb.unsubscribe();
});

test('two chats sharing one project and resource remain independent through session teardown', { timeout: 60_000 }, async () => {
  const runtime = await project('shared-project');
  const [left, right] = await Promise.all([
    runtime.createSession({ resourceId: 'shared-resource', scope: 'left', threadId: 'shared-left' }),
    runtime.createSession({ resourceId: 'shared-resource', scope: 'right', threadId: 'shared-right' }),
  ]);
  await Promise.all([left.thread.rename({ title: 'Left fixture' }), right.thread.rename({ title: 'Right fixture' })]);
  const leftEvents = collect(left);
  const rightEvents = collect(right);
  await left.state.set({ smartEditing: false });
  assert.equal(right.state.get().smartEditing, true);
  const leftHold = fixture.holdNext('SHARED_LEFT');
  const rightHold = fixture.holdNext('SHARED_RIGHT');
  const leftRun = left.sendMessage({ content: 'SHARED_LEFT' });
  const rightRun = right.sendMessage({ content: 'SHARED_RIGHT' });
  await Promise.all([leftHold.reached, rightHold.reached]);
  await Promise.all([leftEvents.waitFor(event => event.type === 'message_update'), rightEvents.waitFor(event => event.type === 'message_update')]);
  left.abort();
  leftHold.release();
  await leftRun;
  await leftEvents.waitFor(event => event.type === 'agent_end' && event.reason === 'aborted');
  assert.equal(right.displayState.get().isRunning, true, 'aborting left leaves right running');
  await runtime.controller.deleteSession({ resourceId: 'shared-resource', scope: 'left' });
  assert.equal(right.displayState.get().isRunning, true, 'deleting left does not stop right');
  rightHold.release();
  await rightRun;
  const leftHistory = JSON.stringify(await left.thread.listMessages({ threadId: 'shared-left' }));
  const rightHistory = JSON.stringify(await right.thread.listActiveMessages());
  assert.match(leftHistory, /SHARED_LEFT/);
  assert.doesNotMatch(leftHistory, /SHARED_RIGHT/);
  assert.match(rightHistory, /SHARED_RIGHT/);
  assert.doesNotMatch(rightHistory, /SHARED_LEFT/);
  leftEvents.unsubscribe();
  rightEvents.unsubscribe();
});

test('native Stop aborts the current run and drains an accepted queued follow-up', { timeout: 60_000 }, async () => {
  const runtime = await project('queue');
  const session = await runtime.createSession({ resourceId: 'resource-queue', threadId: 'thread-queue' });
  await session.thread.rename({ title: 'Queue fixture' });
  const monitor = collect(session);
  const { events, unsubscribe } = monitor;
  const hold = fixture.holdNext('HOLD_FOR_STOP');
  const running = session.sendMessage({ content: 'HOLD_FOR_STOP' });
  await hold.reached;
  await monitor.waitFor(event => event.type === 'message_update');
  await session.followUp({ content: 'QUEUED_AFTER_STOP' });
  assert.equal(session.displayState.get().queuedFollowUps, 1);
  session.abort();
  // Finish the fixture response even when the provider does not close its socket on abort.
  hold.release();
  await fixture.waitForRequest(request => lastUserText(request).includes('QUEUED_AFTER_STOP'));
  await running;
  await monitor.waitFor(event => event.type === 'agent_end' && event.reason === 'complete');
  assert.ok(events.some(event => event.type === 'agent_end' && event.reason === 'aborted'));
  assert.equal(session.displayState.get().queuedFollowUps, 0);
  assert.match(JSON.stringify(await session.thread.listActiveMessages()), /QUEUED_AFTER_STOP/);
  unsubscribe();
});

test('native goals continue, finish and persist independently without durable-agent mode', { timeout: 60_000 }, async () => {
  const a = await project('goal-A');
  const b = await project('goal-B');
  const [sa, sb] = await Promise.all([a.createSession({ resourceId: 'goal-resource-A', threadId: 'goal-thread-A' }), b.createSession({ resourceId: 'goal-resource-B', threadId: 'goal-thread-B' })]);
  await Promise.all([sa.thread.rename({ title: 'Goal A fixture' }), sb.thread.rename({ title: 'Goal B fixture' })]);
  await Promise.all([a.codeAgent.setObjective('Complete goal A', { threadId: 'goal-thread-A', resourceId: 'goal-resource-A', maxRuns: Number.MAX_SAFE_INTEGER }), b.codeAgent.setObjective('Keep goal B isolated', { threadId: 'goal-thread-B', resourceId: 'goal-resource-B', maxRuns: Number.MAX_SAFE_INTEGER })]);
  await sa.sendMessage({ content: 'PURSUE_GOAL_A' });
  const goalA = await a.codeAgent.getObjective({ threadId: 'goal-thread-A' });
  const goalB = await b.codeAgent.getObjective({ threadId: 'goal-thread-B' });
  assert.equal(goalA?.status, 'done');
  assert.equal(goalA?.runsUsed, 2);
  assert.equal(goalA?.maxRuns, Number.MAX_SAFE_INTEGER);
  assert.equal(goalB?.status, 'active');
  assert.equal(goalB?.runsUsed, 0);
  assert.equal(sb.displayState.get().isRunning, false);
  await a.dispose();
  const reopened = await createProjectRuntime({ projectPath: a.projectPath, runtimeRoot: a.runtimeRoot, profile, disableMcp: true, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
  runtimes.push(reopened);
  assert.equal((await reopened.codeAgent.getObjective({ threadId: 'goal-thread-A' }))?.status, 'done');
  const resumed = await reopened.createSession({ resourceId: 'goal-resource-A', threadId: 'goal-thread-A' });
  assert.match(JSON.stringify(await resumed.thread.listActiveMessages()), /PURSUE_GOAL_A/);
  assert.equal(resumed.displayState.get().isRunning, false);
  const persistedSettings = JSON.parse(await readFile(profile.settingsPath, 'utf8'));
  assert.equal(persistedSettings.experimentalAgent, null);
});


test('a fresh process preserves history/settings, loses waiting native input and stays dormant', { timeout: 60_000 }, async context => {
  const projectPath = path.join(root, 'crash-project');
  const runtimeRoot = path.join(root, 'crash-runtime');
  await mkdir(projectPath, { recursive: true });
  const children: ChildProcess[] = [];
  context.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  });
  const childFile = fileURLToPath(new URL('./fixtures/crash-child.ts', import.meta.url));
  function runChild(mode: 'queue' | 'inspect') {
    const child = spawn(process.execPath, ['--import', 'tsx', childFile, mode, profile.root, projectPath, runtimeRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let diagnostics = '';
    child.stderr!.on('data', chunk => { diagnostics += String(chunk); });
    const report = new Promise<Record<string, unknown>>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`Fixture child readiness timeout: ${diagnostics}`)), 20_000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`Fixture child exited ${code}: ${diagnostics}`)); });
      child.stdout!.on('data', chunk => {
        buffer += String(chunk);
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (parsed.type === (mode === 'queue' ? 'queued' : 'inspected')) { clearTimeout(timer); resolve(parsed); }
          } catch { /* Native SDK logs are not fixture readiness records. */ }
        }
      });
    });
    return { child, report };
  }
  const held = fixture.holdNext('IN_FLIGHT_CRASH');
  const first = runChild('queue');
  const readiness = await first.report;
  assert.equal(readiness.threadId, 'crash-thread');
  await held.reached;
  const firstExit = once(first.child, 'exit');
  assert.equal(first.child.kill('SIGKILL'), true);
  const [, signal] = await firstExit;
  assert.equal(signal, 'SIGKILL');
  const requestsBeforeRestart = fixture.requests.length;
  const second = runChild('inspect');
  const restored = await second.report;
  await once(second.child, 'exit');
  assert.equal(second.child.exitCode, 0);
  assert.ok(Array.isArray(restored.messages));
  assert.ok(restored.messages.some(message => message.role === 'assistant' && JSON.stringify(message).includes('fixture:COMPLETED_BEFORE_CRASH')), 'completed assistant output survives the process crash');
  assert.doesNotMatch(JSON.stringify(restored.messages), /QUEUED_LOST_ON_CRASH/);
  assert.equal(restored.model, 'fixture/chat', 'saved model overrides the fresh process default');
  assert.equal(restored.thinkingLevel, 'low');
  assert.equal(restored.running, false);
  assert.equal(restored.queued, 0);
  assert.equal(fixture.requests.length, requestsBeforeRestart, 'opening persisted history does not start a model run');
});
