import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { startModelFixture } from './fixtures/model-server.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let pendingTitle: { started: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> } | undefined;
let root: string, profile: SpikeProfile, fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-native-concurrency-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(async request => {
    if (request.model === 'title') {
      const held = pendingTitle;
      assert.ok(held); held.started.resolve(); await held.released.promise;
      return { text: 'Late fixture generated title' };
    }
    return { text: 'Native concurrency fixture answer' };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat' },
    preferences: { thinkingLevel: 'medium' },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'local-fixture-only', models: ['chat', 'title'] }],
    lsp: false, observability: { enabled: false },
  }));
});
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function setup(t: TestContext, name: string, pinPlaceholder = true) {
  const projectPath = join(root, name); await mkdir(projectPath);
  const runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, `${name}-runtime`), modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] });
  t.after(() => runtime.dispose());
  const session = await runtime.createSession({ resourceId: `${name}-resource`, threadId: `${name}-thread` });
  if (pinPlaceholder) await session.thread.rename({ title: 'Pinned fixture placeholder' });
  return { runtime, session, threadId: session.thread.requireId() };
}
interface Trace { ordinal: number; kind: string; phase: string }
/** Passive instrumentation: return the exact native Promise, never delay a
 * storage call or invoke persistence. Promise observers still add microtask work,
 * so these measurements are not proof of all browser/network scheduling. */
async function traceNative(t: TestContext, runtime: ProjectRuntime, session: NativeSession) {
  const entries: Trace[] = []; let pendingUsage = 0; let usageStarts = 0;
  const mark = (kind: string, phase: string) => entries.push({ ordinal: entries.length, kind, phase });
  const persist = session.machinery.persistTokenUsage.bind(session.machinery);
  t.mock.method(session.machinery, 'persistTokenUsage', () => {
    usageStarts++; pendingUsage++; mark('usage', 'start');
    const promise = persist();
    void promise.then(() => { pendingUsage--; mark('usage', 'end'); }, () => { pendingUsage--; mark('usage', 'error'); });
    return promise;
  });
  const store = await runtime.storage.getStore('memory'); assert.ok(store);
  const read = store.getThreadById.bind(store), save = store.saveThread.bind(store);
  const kind = () => {
    const stack = new Error().stack ?? '';
    return stack.includes('AgentController.persistTokenUsage') ? 'usage-storage'
      : stack.includes('SessionThread.rename') ? 'rename-storage'
      : stack.includes('writeThreadMetadataValue') ? 'setting-storage' : 'other-storage';
  };
  t.mock.method(store, 'getThreadById', (input: Parameters<typeof read>[0]) => {
    const source = kind(); mark(source, 'read-start');
    const promise = read(input);
    void promise.then(() => mark(source, 'read-end'), () => mark(source, 'read-error'));
    return promise;
  });
  t.mock.method(store, 'saveThread', (input: Parameters<typeof save>[0]) => {
    const source = kind(); mark(source, 'save-start');
    const promise = save(input);
    void promise.then(() => mark(source, 'save-end'), () => mark(source, 'save-error'));
    return promise;
  });
  const unsubscribe = session.subscribe(event => { if (event.type === 'agent_end' || event.type === 'usage_update') mark('native-event', event.type); });
  t.after(unsubscribe);
  return { entries, mark, get pendingUsage() { return pendingUsage; }, get usageStarts() { return usageStarts; } };
}
async function checkRow(runtime: ProjectRuntime, threadId: string, title: string, effort: 'low' | 'high') {
  const row = await runtime.controller.queryThreadById({ threadId });
  return { missing: row === null, titleLost: row?.title !== title, effortLost: row?.metadata?.thinkingLevel !== effort };
}

test('bounded ordinary awaited Send then rename/settings evaluation', { timeout: 120_000 }, async t => {
  const { runtime, session, threadId } = await setup(t, 'sequential');
  const trace = await traceNative(t, runtime, session);
  const trials = 100; let pendingAtSendResolve = 0, titleLosses = 0, effortLosses = 0, missingRows = 0;
  for (let index = 0; index < trials; index++) {
    await session.sendMessage({ content: `SEQUENTIAL_${index}` });
    trace.mark('client', 'send-resolved');
    if (trace.pendingUsage > 0) pendingAtSendResolve++;
    const title = `Sequential name ${index}`;
    const effort = index % 2 ? 'high' : 'low';
    await session.thread.rename({ title });
    await session.state.set({ thinkingLevel: effort });
    const result = await checkRow(runtime, threadId, title, effort);
    titleLosses += Number(result.titleLost); effortLosses += Number(result.effortLost); missingRows += Number(result.missing);
  }
  const nativeUsageReads = trace.entries.filter(entry => entry.kind === 'usage-storage' && entry.phase === 'read-start').length;
  const nativeUsageWrites = trace.entries.filter(entry => entry.kind === 'usage-storage' && entry.phase === 'save-end').length;
  const endedAfterSend = trace.entries.filter(entry => entry.kind === 'usage' && entry.phase === 'end' && trace.entries.slice(0, entry.ordinal).findLast(prior => prior.kind === 'client' || prior.kind === 'usage')?.kind === 'client').length;
  t.diagnostic(JSON.stringify({ scenario: 'ordinary-sequential-awaited', trials, usageStarts: trace.usageStarts, nativeUsageReads, nativeUsageWrites, pendingAtSendResolve, endedAfterSend, titleLosses, effortLosses, missingRows, firstTrace: trace.entries.filter(entry => !entry.kind.startsWith('other-')).slice(0, 18) }));
  assert.equal(trace.usageStarts, trials); assert.equal(nativeUsageReads, trials); assert.equal(nativeUsageWrites, trials);
  assert.equal(titleLosses, 0); assert.equal(effortLosses, 0); assert.equal(missingRows, 0);
});

test('bounded awaited mutations during an ordinary active stream before its final usage', { timeout: 120_000 }, async t => {
  const { runtime, session, threadId } = await setup(t, 'active-stream');
  const trace = await traceNative(t, runtime, session);
  const trials = 30; let activeTrials = 0, titleLosses = 0, effortLosses = 0, missingRows = 0;
  for (let index = 0; index < trials; index++) {
    const marker = `ACTIVE_MUTATION_${index}`; const hold = fixture.holdNext(marker);
    const run = session.sendMessage({ content: marker });
    const title = `Active name ${index}`; const effort = index % 2 ? 'high' : 'low';
    try {
      await hold.reached;
      activeTrials += Number(session.displayState.get().isRunning);
      await session.thread.rename({ title });
      await session.state.set({ thinkingLevel: effort });
    } finally { hold.release(); await run; }
    const result = await checkRow(runtime, threadId, title, effort);
    titleLosses += Number(result.titleLost); effortLosses += Number(result.effortLost); missingRows += Number(result.missing);
  }
  t.diagnostic(JSON.stringify({ scenario: 'active-stream-awaited-before-final-usage', trials, activeTrials, usageStarts: trace.usageStarts, titleLosses, effortLosses, missingRows }));
  assert.equal(activeTrials, trials); assert.equal(trace.usageStarts, trials);
  assert.equal(titleLosses, 0); assert.equal(effortLosses, 0); assert.equal(missingRows, 0);
});

test('immediate public usage_update subscriber mutation, separately from ordinary UI timing', { timeout: 120_000 }, async t => {
  const { runtime, session, threadId } = await setup(t, 'native-subscriber');
  const trace = await traceNative(t, runtime, session);
  const trials = 100; let mutation: Promise<void> | undefined; let expectedTitle = '', expectedEffort: 'low' | 'high' = 'low';
  let activeTrials = 0, titleLosses = 0, effortLosses = 0, missingRows = 0;
  const unsubscribe = session.subscribe(event => {
    if (event.type !== 'usage_update') return;
    activeTrials += Number(session.displayState.get().isRunning);
    // This is deliberately immediate same-process event consumption. It uses
    // public APIs with no held storage reads; it does not simulate browser delay.
    mutation = (async () => { await session.thread.rename({ title: expectedTitle }); await session.state.set({ thinkingLevel: expectedEffort }); })();
  });
  t.after(unsubscribe);
  for (let index = 0; index < trials; index++) {
    mutation = undefined; expectedTitle = `Subscriber name ${index}`; expectedEffort = index % 2 ? 'high' : 'low';
    await session.sendMessage({ content: `SUBSCRIBER_${index}` });
    assert.ok(mutation); await mutation;
    const result = await checkRow(runtime, threadId, expectedTitle, expectedEffort);
    titleLosses += Number(result.titleLost); effortLosses += Number(result.effortLost); missingRows += Number(result.missing);
  }
  t.diagnostic(JSON.stringify({ scenario: 'immediate-public-event-subscriber-not-browser', trials, activeTrials, usageStarts: trace.usageStarts, titleLosses, effortLosses, missingRows }));
  assert.equal(activeTrials, trials); assert.equal(trace.usageStarts, trials);
  // This probe reports losses; it must not promote subscriber timing to normal
  // UI evidence or promote a zero count to a native synchronization guarantee.
  assert.equal(missingRows, 0);
});

// This controls only provider response latency, never the native storage path.
// It is an automatic-title overwrite, separate from the forced usage RMW proof.
test('slow native automatic title response overwrites an awaited manual rename despite its pin', { timeout: 120_000 }, async t => {
  const { loadSettings, saveSettings } = await import('@mastra/code-sdk/onboarding/settings');
  const settings = loadSettings(profile.settingsPath);
  settings.models.observerModelOverride = 'fixture/title';
  saveSettings(settings, profile.settingsPath);
  const { runtime } = await setup(t, 'late-title', false);
  const trials = 30; let titlesOverwritten = 0, pinsRetained = 0, missingRows = 0;
  for (let index = 0; index < trials; index++) {
    const session = await runtime.createSession({ resourceId: `late-title-resource-${index}`, threadId: `late-title-thread-${index}` });
    const held = { started: deferred(), released: deferred() }; pendingTitle = held;
    const generated = deferred();
    const off = session.subscribe(event => { if (event.type === 'thread_title_updated' && event.title === 'Late fixture generated title') generated.resolve(); });
    const title = `Awaited manual name ${index}`;
    try {
      await session.sendMessage({ content: `LATE_AUTOMATIC_TITLE_${index}` });
      await held.started.promise;
      await session.thread.rename({ title });
      const manual = await runtime.controller.queryThreadById({ threadId: session.thread.requireId() });
      assert.equal(manual!.title, title); assert.equal(manual!.metadata!.titlePinned, true);
    } finally { held.released.resolve(); }
    try {
      await generated.promise;
      const row = await runtime.controller.queryThreadById({ threadId: session.thread.requireId() });
      titlesOverwritten += Number(row?.title !== title);
      pinsRetained += Number(row?.metadata?.titlePinned === true);
      missingRows += Number(row === null);
    } finally { off(); pendingTitle = undefined; }
  }
  t.diagnostic(JSON.stringify({ scenario: 'slow-model-auto-title-after-awaited-rename', trials, titlesOverwritten, pinsRetained, missingRows }));
  assert.equal(titlesOverwritten, trials); assert.equal(pinsRetained, trials); assert.equal(missingRows, 0);
});
