import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { abortNativeChat } from '../src/chat-archive.js';
import { readNativePrompts, respondNativePrompt } from '../src/chat-prompts.js';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
let profileRoot: string, profile: SpikeProfile;
before(async () => {
  profileRoot = await mkdtemp(join(tmpdir(), 'kodex-prompt-retirement-profile-'));
  profile = activateProfile(resolveProfile(profileRoot));
});
after(async () => { await rm(profileRoot, { recursive: true, force: true }); });

for (const retirement of ['stop', 'archive'] as const) {
  test(`an admitted native question resume held in request-context preparation versus ${retirement}`, { timeout: 30_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), `kodex-prompt-${retirement}-`));
    const projectPath = join(root, 'project'); await mkdir(projectPath);
    const heldContext = deferred(), releaseContext = deferred(), peerRequested = deferred(), releasePeer = deferred();
    const trace: unknown[] = [], executions: Promise<unknown>[] = [], responses: Promise<void>[] = [];
    let targetRequests = 0, peerRequests = 0;
    const fixture = await startModelFixture(async request => {
      const text = lastUserText(request);
      if (text.includes('UNRELATED_PEER')) {
        peerRequests++; peerRequested.resolve(); await releasePeer.promise;
        return { text: 'UNRELATED_PEER_COMPLETED' };
      }
      assert.ok(text.includes('PROMPT_RETIREMENT'));
      targetRequests++;
      if (JSON.stringify(request.messages).includes('User answered: ADMITTED_NATIVE_ANSWER')) {
        return { text: 'RESUMED_AFTER_RETIREMENT' };
      }
      return { toolCalls: [{ name: 'ask_user', id: 'retirement-question', arguments: { question: 'Which native evidence?' } }] };
    });
    await writeFile(profile.settingsPath, JSON.stringify({
      models: { observerModelOverride: null, reflectorModelOverride: null },
      customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
      preferences: { yolo: true }, lsp: false, observability: { enabled: false },
    }));
    const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'), subagents: [],
      modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
    const sessions: NativeSession[] = [];
    const producers = new Map<string, ReturnType<typeof deferred>>(), retainedSuspended = new Set<string>();
    const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
    const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
    // Fixture-only joins for already-started native workflow persistence. These
    // observers never decide admission, Stop, retirement, or response completion.
    t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
      const result = register(...args);
      if (args[0].id === 'agentic-loop' && args[1]) {
        producers.set(args[1], deferred());
        const createRun = args[0].createRun.bind(args[0]);
        t.mock.method(args[0], 'createRun', async (...input: Parameters<typeof createRun>) => {
          const run = await createRun(...input), start = run.start.bind(run), resume = run.resume.bind(run);
          t.mock.method(run, 'start', (...values: Parameters<typeof start>) => { const work = start(...values); executions.push(work); return work; });
          t.mock.method(run, 'resume', (...values: Parameters<typeof resume>) => { const work = resume(...values); executions.push(work); return work; });
          return run;
        });
      }
      return result;
    });
    t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
      unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.resolve();
    });
    async function joinProducers() {
      let joined = -1;
      while (joined !== producers.size) {
        joined = producers.size;
        await Promise.allSettled(executions); await Promise.allSettled(responses);
        await Promise.all([...producers].map(([runId, done]) => retainedSuspended.has(runId) ? undefined : done.promise));
      }
    }
    const target = await runtime.createSession({ resourceId: 'prompt-owner', threadId: 'prompt-owner' });
    const peer = await runtime.createSession({ resourceId: 'unrelated-peer', threadId: 'unrelated-peer' });
    sessions.push(target, peer);
    await target.thread.rename({ title: 'Prompt owner', pin: true });
    await peer.thread.rename({ title: 'Unrelated peer', pin: true });
    target.subscribe(event => {
      trace.push({ event });
      const runId = target.getCurrentRunId();
      if (event.type === 'agent_start' && runId) retainedSuspended.delete(runId);
      if (event.type === 'tool_suspended' && runId) retainedSuspended.add(runId);
    });
    const actualRespond = target.respondToToolSuspension.bind(target);
    t.mock.method(target, 'respondToToolSuspension', (...args: Parameters<typeof actualRespond>) => {
      const response = actualRespond(...args); responses.push(response); return response;
    });
    let peerRun: Promise<void> | undefined;
    t.after(async () => {
      releaseContext.resolve(); releasePeer.resolve();
      for (const session of sessions) {
        const threadId = session.thread.getId();
        if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
        session.abort();
      }
      await peerRun; await joinProducers(); await runtime.dispose(); await fixture.close();
      await writeFile(join(root, 'trace.json'), JSON.stringify({ retirement, targetRequests, peerRequests, trace, requests: fixture.requests }, null, 2));
      for (const directory of ['project', 'runtime']) await rm(join(root, directory), { recursive: true, force: true });
    });
    await target.sendMessage({ content: 'PROMPT_RETIREMENT: ask for evidence.', untilIdle: false });
    await Promise.allSettled(executions);
    const prompt = readNativePrompts(target).find(prompt => prompt.kind === 'question'); assert.ok(prompt && prompt.kind === 'question');
    const original = target.machinery;
    let contextHeld = false;
    target.setMachinery({ ...original, buildRequestContext: async input => {
      const context = await original.buildRequestContext(input);
      if (!contextHeld && !target.suspensions.hasPending()) {
        contextHeld = true; heldContext.resolve(); await releaseContext.promise;
      }
      return context;
    } });
    peerRun = peer.sendMessage({ content: 'UNRELATED_PEER: keep running.', untilIdle: false });
    void peerRun.catch(() => {}); await peerRequested.promise;
    assert.deepEqual(await respondNativePrompt(target, { kind: 'question', target: prompt.target, answer: 'ADMITTED_NATIVE_ANSWER' }), { accepted: true });
    await heldContext.promise;
    assert.equal(target.suspensions.hasPending(), false, 'the exact native response claim has already consumed its parked prompt');
    assert.equal(readNativePrompts(target).length, 0);
    assert.equal(targetRequests, 1, 'native resumed model has not started before the held public context boundary');
    await abortNativeChat(target);
    if (retirement === 'archive') await runtime.releaseSession({ resourceId: prompt.target.resourceId });
    trace.push({ retirementAcknowledged: true, threadId: target.thread.getId(), abortRequested: target.run.isAbortRequested() });
    assert.equal(peer.displayState.get().isRunning, true, 'an unrelated native conversation keeps its own active run');
    releaseContext.resolve(); await Promise.allSettled(responses);
    t.diagnostic(`Prompt retirement trace: ${join(root, 'trace.json')}; target model requests=${targetRequests}`);
    assert.equal(targetRequests, 1, `${retirement} prevents a resumed model request after it acknowledges retirement`);
    assert.equal(readNativePrompts(target).length, 0); assert.equal(target.suspensions.hasPending(), false);
    if (retirement === 'archive') {
      assert.equal(await runtime.controller.getSessionByResource(prompt.target.resourceId), undefined);
      assert.equal(target.thread.getId(), null);
    } else assert.equal(await runtime.controller.getSessionByResource(prompt.target.resourceId), target);
    releasePeer.resolve(); await peerRun; await joinProducers();
    const saved = await runtime.controller.queryThreadMessages({ threadId: prompt.target.threadId, resourceId: prompt.target.resourceId });
    assert.ok(JSON.stringify(saved.messages).includes('Which native evidence?'), 'retirement preserves the original native prompt history');
    assert.equal(peerRequests, 1);
    assert.ok(JSON.stringify(await peer.thread.listActiveMessages()).includes('UNRELATED_PEER_COMPLETED'));
  });
}
