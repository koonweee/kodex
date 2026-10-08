import assert from 'node:assert/strict';
import { before, after, test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '@mastra/memory';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime, type NativeSession } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
let profile: SpikeProfile, profileRoot: string;
before(async () => { profileRoot = await mkdtemp(join(tmpdir(), 'kodex-compaction-profile-')); profile = activateProfile(resolveProfile(profileRoot)); });
after(async () => { await rm(profileRoot, { recursive: true, force: true }); });
async function nativeMemory(session: NativeSession): Promise<Memory> {
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  assert.ok(memory && 'omEngine' in memory && 'persistMessages' in memory && 'getContext' in memory);
  return memory as Memory;
}
async function sendComplete(session: NativeSession, text: string) {
  const completed = gate();
  const unsubscribe = session.subscribe(event => { if (event.type === 'agent_end' && event.reason === 'complete') completed.release(); });
  try {
    await session.thread.ensureCurrentSubscription();
    const stream = await session.machinery.getAgent().stream(text, { ...await session.machinery.buildStreamOptions({}), untilIdle: false });
    const reader = stream.fullStream.getReader();
    try { for (;;) { const next = await reader.read(); if (next.done) break; } } finally { reader.releaseLock(); }
    await completed.promise; await (await nativeMemory(session)).settled();
  }
  finally { unsubscribe(); }
}
async function setup(t: TestContext, observerHold?: ReturnType<typeof gate>) {
  const root = await mkdtemp(join(tmpdir(), 'kodex-compaction-proof-')), projectPath = join(root, 'project'); await mkdir(projectPath);
  const trace: unknown[] = [];
  let heldObserver = false;
  const fixture = await startModelFixture(async request => {
    trace.push({ model: request.model, user: lastUserText(request) });
    if (request.model === 'judge' && observerHold && !heldObserver) { heldObserver = true; await observerHold.promise; }
    if (request.model === 'judge') return { text: '<observations>\n🔴 COMPACT_NATIVE_FACT: choose native storage and preserve isolation.\n</observations>\n<current-task>Prove native compaction</current-task>\n<suggested-response>Continue from native facts</suggested-response>' };
    return { text: 'NATIVE_CHAT_RESULT' };
  });
  await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false }, models: { observerModelOverride: 'fixture/judge', reflectorModelOverride: 'fixture/judge' }, customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'local', models: ['chat', 'judge'] }] }));
  let runtime: ProjectRuntime | undefined;
  t.diagnostic(`Native compaction trace: ${join(root, 'trace.json')}`);
  t.after(async () => { observerHold?.release(); await runtime?.dispose(); await fixture.close(); await writeFile(join(root, 'trace.json'), JSON.stringify({ trace, requests: fixture.requests }, null, 2)); for (const directory of ['project', 'runtime']) await rm(join(root, directory), { recursive: true, force: true }); });
  runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'), modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] });
  return { root, fixture, runtime, trace };
}

test('native manual observation respects normal thresholds and reflection no-ops without observations', { timeout: 30_000 }, async t => {
  const { runtime, fixture, trace } = await setup(t);
  const session = await runtime.createSession({ threadId: 'compact-small', resourceId: 'compact-small-resource' });
  await session.thread.rename({ title: 'Small compaction', pin: true });
  await sendComplete(session, 'SMALL_COMPACTION_HISTORY');
  const memory = await nativeMemory(session), om = await memory.omEngine; assert.ok(om);
  const owner = { threadId: session.thread.requireId(), resourceId: session.identity.getResourceId() };
  const config = om.config, status = await om.getStatus(owner); trace.push({ config, status });
  assert.equal(config.scope, 'thread'); assert.equal(config.observation.messageTokens, 30_000);
  assert.ok(status.pendingTokens > 0 && status.pendingTokens < status.threshold); assert.equal(status.shouldObserve, false);
  const requestContext = await session.machinery.buildRequestContext();
  const observed = await om.observe({ ...owner, requestContext });
  const reflected = await om.reflect(owner.threadId, owner.resourceId, undefined, requestContext);
  const finalized = await om.finalize(owner); trace.push({ observed, reflected, finalized });
  assert.equal(observed.observed, false); assert.equal(reflected.reflected, false); assert.equal(finalized.observed, false); assert.equal(finalized.activated, false);
  assert.equal(fixture.requests.length, 1, 'manual native calls below threshold do not invoke a summary model');
  assert.ok(JSON.stringify(await session.thread.listActiveMessages()).includes('SMALL_COMPACTION_HISTORY'));
  assert.deepEqual(om.config, config, 'manual calls preserve normal future thresholds');
});

test('eligible native manual observation and reflection persist compact context without deleting transcript or affecting another session', { timeout: 60_000 }, async t => {
  const observerHold = gate();
  const { runtime, fixture, trace } = await setup(t, observerHold);
  const session = await runtime.createSession({ threadId: 'compact-large', resourceId: 'compact-large-resource' });
  const sibling = await runtime.createSession({ threadId: 'compact-sibling', resourceId: 'compact-sibling-resource' });
  await session.thread.rename({ title: 'Large compaction', pin: true }); await sibling.thread.rename({ title: 'Unrelated sibling', pin: true });
  await sendComplete(session, 'COMPACT_ORIGINAL_INPUT'); await sendComplete(sibling, 'SIBLING_UNRELATED_INPUT');
  const memory = await nativeMemory(session), om = await memory.omEngine; assert.ok(om);
  const owner = { threadId: session.thread.requireId(), resourceId: session.identity.getResourceId() };
  // Seed real native stored history beyond its unchanged default threshold. No
  // fake OM record, summary, cursor, or model result replaces the native engine.
  const text = Array.from({ length: 12_000 }, (_, index) => `COMPACT_RAW_EVIDENCE_${index} native storage fact ${index}.`).join('\n');
  await memory.persistMessages([{ id: 'compact-persisted-source', threadId: owner.threadId, resourceId: owner.resourceId, role: 'user', createdAt: new Date(), content: { format: 2, parts: [{ type: 'text', text }] } }]);
  const status = await om.getStatus(owner); trace.push({ status }); assert.ok(status.pendingTokens >= status.threshold); assert.equal(status.shouldObserve, true);
  const requestContext = await session.machinery.buildRequestContext();
  let operationCompleted = false;
  const observation = om.observe({ ...owner, requestContext }).then(result => { operationCompleted = true; return result; });
  await fixture.waitForRequest(request => request.model === 'judge');
  assert.equal(operationCompleted, false, 'public observation completion waits for actual observer result and native persistence');
  const peer = await runtime.controller.getSessionByResource(owner.resourceId); assert.equal(peer, session);
  const peerMemory = await nativeMemory(peer), peerOm = await peerMemory.omEngine; assert.ok(peerOm);
  const peerObservation = peerOm.observe({ ...owner, requestContext: await peer.machinery.buildRequestContext() });
  observerHold.release();
  const [result, concurrent] = await Promise.all([observation, peerObservation]); trace.push({ result, concurrent });
  assert.equal(concurrent.observed, false, 'native same-scope lock prevents duplicate observation after first client advances cursor');
  assert.equal(result.observed, true); assert.ok(result.record.activeObservations.includes('COMPACT_NATIVE_FACT'));
  assert.ok(result.record.observedMessageIds?.includes('compact-persisted-source'));
  assert.equal(fixture.requests.filter(request => request.model === 'judge').length, 1);
  assert.equal((await peerOm.getRecord(owner.threadId, owner.resourceId))?.activeObservations, result.record.activeObservations, 'second client reads canonical shared native record');
  assert.equal((await om.getRecord(sibling.thread.requireId(), sibling.identity.getResourceId()))?.activeObservations ?? '', '');
  const reflected = await om.reflect(owner.threadId, owner.resourceId, undefined, requestContext); trace.push({ reflected });
  assert.equal(reflected.reflected, true); assert.ok(reflected.record.generationCount > result.record.generationCount);
  const compacted = await memory.getContext(owner); assert.equal(compacted.hasObservations, true); assert.ok(compacted.systemMessage?.includes('COMPACT_NATIVE_FACT'));
  assert.equal(JSON.stringify(compacted.messages).includes('COMPACT_RAW_EVIDENCE_11999'), false, 'next native context excludes observed raw history');
  await sendComplete(session, 'AFTER_MANUAL_COMPACTION');
  const actor = fixture.requests.findLast(request => request.model === 'chat')!;
  assert.ok(JSON.stringify(actor.messages).includes('COMPACT_NATIVE_FACT')); assert.equal(JSON.stringify(actor.messages).includes('COMPACT_RAW_EVIDENCE_11999'), false);
  const retained = await memory.recall({ threadId: owner.threadId, resourceId: owner.resourceId, perPage: 20, page: 0 });
  assert.ok(JSON.stringify(retained.messages).includes('COMPACT_RAW_EVIDENCE_11999'), 'compaction does not delete canonical transcript');
  assert.ok(JSON.stringify(await sibling.thread.listActiveMessages()).includes('SIBLING_UNRELATED_INPUT'));
  await runtime.releaseSession({ resourceId: owner.resourceId });
  const reopened = await runtime.createSession(owner), reopenedMemory = await nativeMemory(reopened), reopenedOm = await reopenedMemory.omEngine; assert.ok(reopenedOm);
  assert.ok((await reopenedOm.getRecord(owner.threadId, owner.resourceId))?.activeObservations.includes('COMPACT_NATIVE_FACT'), 'native observation survives binding recreation');
});
