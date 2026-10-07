import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { Memory } from '@mastra/memory';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession } from '../src/runtime.js';
import { startModelFixture } from './fixtures/model-server.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let root: string;
let profile: SpikeProfile;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-native-title-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(request => ({ text: request.model === 'observer'
    ? '<observations>\n- 🔴 The user discussed a fixture title.\n</observations>\n<current-task>Fixture task</current-task>\n<suggested-response>Continue fixture</suggested-response>\n<thread-title>OM candidate title</thread-title>'
    : request.model === 'title' ? 'Automatic fixture title' : 'Native fixture answer' }));
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: 'fixture/title', reflectorModelOverride: 'fixture/observer' },
    preferences: { thinkingLevel: 'medium' },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat', 'alternate', 'title', 'observer'] }],
    lsp: false, observability: { enabled: false },
  }));
});
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function setup(t: TestContext, name: string) {
  const projectPath = join(root, name);
  await mkdir(projectPath);
  const options = { profile, projectPath, runtimeRoot: join(root, `${name}-runtime`), modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] };
  let runtime = await createProjectRuntime(options);
  t.after(() => runtime.dispose());
  return { get runtime() { return runtime; }, async reopen() { await runtime.dispose(); runtime = await createProjectRuntime(options); return runtime; } };
}
async function memoryOf(session: NativeSession) {
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  assert.ok(memory && 'omEngine' in memory && 'settled' in memory, 'the mounted native default Memory is used');
  return memory as Memory;
}

test('blocking native setup pins a nonempty placeholder before Send; manual rename preserves settings and survives reopen', { timeout: 40_000 }, async t => {
  const setupResult = await setup(t, 'pinned-placeholder');
  const runtime = setupResult.runtime;
  const unseeded = await runtime.createSession({ resourceId: 'unseeded-resource', threadId: 'unseeded-thread' });
  const automatic = deferred();
  const off = unseeded.subscribe(event => { if (event.type === 'thread_title_updated') automatic.resolve(); });
  t.after(off);
  await unseeded.sendMessage({ content: 'CONTROL_AUTO_TITLE' });
  await automatic.promise;
  assert.equal((await runtime.controller.queryThreadById({ threadId: 'unseeded-thread' }))!.title, 'Automatic fixture title');
  assert.ok(fixture.requests.some(request => request.model === 'title'), 'control proves automatic title generation is enabled');

  let setupFinished = false;
  const unsubscribe = runtime.controller.onSessionCreated(async session => {
    if (session.identity.getResourceId() !== 'pinned-resource') return;
    await session.model.switch('fixture/alternate', { thinkingLevel: 'high' });
    await session.thread.rename({ title: 'New chat' });
    setupFinished = true;
  }, { blocking: true });
  const session = await runtime.createSession({ resourceId: 'pinned-resource', threadId: 'pinned-thread' });
  unsubscribe();
  assert.equal(setupFinished, true, 'createSession awaits public blocking setup');
  const beforeSend = await runtime.controller.queryThreadById({ threadId: 'pinned-thread' });
  assert.equal(beforeSend!.title, 'New chat');
  assert.equal(beforeSend!.metadata!.titlePinned, true);
  assert.equal(beforeSend!.metadata!.thinkingLevel, 'high');
  assert.equal(beforeSend!.metadata!.currentModelId, 'fixture/alternate');
  const requestStart = fixture.requests.length;
  await session.sendMessage({ content: 'PINNED_FIRST_USER' });
  await (await memoryOf(session)).settled();
  assert.deepEqual(fixture.requests.slice(requestStart).map(request => request.model), ['alternate'], 'nonempty pinned title suppresses the separate generator request');
  assert.ok((await session.thread.listActiveMessages()).some(message => {
    const signal = message.content.metadata?.signal as { type?: string } | undefined;
    const userAuthored = message.role === 'user' || (message.role === 'signal' && (signal?.type === 'user' || signal?.type === 'user-message'));
    return userAuthored && message.content.parts.some(part => part.type === 'text' && part.text === 'PINNED_FIRST_USER');
  }));
  const events: unknown[] = [];
  const offRename = session.subscribe(event => { if (event.type === 'thread_title_updated') events.push(event); });
  await session.thread.rename({ title: 'Manual native name' });
  offRename();
  assert.ok(events.some(event => (event as { threadId: string; title: string }).threadId === 'pinned-thread' && (event as { title: string }).title === 'Manual native name'));
  const renamed = await runtime.controller.queryThreadById({ threadId: 'pinned-thread' });
  assert.equal(renamed!.title, 'Manual native name');
  assert.equal(renamed!.metadata!.thinkingLevel, 'high');
  assert.equal(renamed!.metadata!.currentModelId, 'fixture/alternate');
  const reopened = await setupResult.reopen();
  const restored = await reopened.createSession({ resourceId: 'pinned-resource', threadId: 'pinned-thread' });
  const persisted = await reopened.controller.queryThreadById({ threadId: 'pinned-thread' });
  assert.equal(persisted!.title, 'Manual native name');
  assert.equal(persisted!.metadata!.titlePinned, true);
  assert.equal(restored.state.get().thinkingLevel, 'high');
  assert.equal(restored.model.get(), 'fixture/alternate');
});

test('real native OM extracts a new title but preserves pinned names', { timeout: 40_000 }, async t => {
  const { loadSettings, saveSettings } = await import('@mastra/code-sdk/onboarding/settings');
  const settings = loadSettings(profile.settingsPath);
  settings.models.observerModelOverride = 'fixture/observer';
  saveSettings(settings, profile.settingsPath);
  const { runtime } = await setup(t, 'om-title');
  for (const pin of [false, true]) {
    const threadId = `om-thread-${pin}`; const resourceId = `om-resource-${pin}`;
    const session = await runtime.createSession({ threadId, resourceId });
    await session.thread.rename({ title: 'Existing native name', pin });
    await session.sendMessage({ content: `OM_OBSERVE_${pin}: remember the fixture title discussion. ${'fixture '.repeat(4000)}` });
    await (await memoryOf(session)).settled();
    // Native per-record overrides below the buffering floor are ignored.
    // Reconfigure the native instance after the run; stored input remains below
    // its original 6000-token buffer threshold and above this manual threshold.
    await session.state.set({ observationThreshold: 10_000 });
    const memory = await memoryOf(session);
    await memory.updateObservationalMemoryConfig({ threadId, resourceId, config: {
      observation: { messageTokens: 2100 },
      reflection: { observationTokens: 100_000 },
    } });
    // Isolate the unrelated embedding dependency through its public method:
    // default CodeSDK vector indexing would download FastEmbed into real HOME.
    const indexing = t.mock.method(memory, 'indexObservation', async () => {});
    const engine = await memory.omEngine;
    assert.ok(engine);
    const result = await engine.observe({ threadId, resourceId, requestContext: await session.machinery.buildRequestContext() });
    assert.equal(result.observed, true, 'actual native observation ran, so the pin check is not vacuous');
    const row = await runtime.controller.queryThreadById({ threadId });
    const om = (row!.metadata!.mastra as { om: { threadTitle: string } }).om;
    assert.equal(om.threadTitle, 'OM candidate title', 'native extractor received a different candidate');
    assert.equal(row!.title, pin ? 'Existing native name' : 'OM candidate title');
    assert.equal(row!.metadata!.titlePinned, pin);
    assert.ok(indexing.mock.callCount() > 0, 'actual native extraction reached vector indexing');
    indexing.mock.restore();
  }
});

/** Hold one real native storage read after it has captured a row; all writes remain native. */
async function holdNextThreadRead(t: TestContext, runtime: Awaited<ReturnType<typeof createProjectRuntime>>, threadId: string) {
  const store = await runtime.storage.getStore('memory');
  assert.ok(store);
  const original = store.getThreadById.bind(store);
  const captured = deferred(); const release = deferred(); let armed = true;
  const mocked = t.mock.method(store, 'getThreadById', async (input: Parameters<typeof original>[0]) => {
    const row = await original(input);
    if (armed && input.threadId === threadId) { armed = false; captured.resolve(); await release.promise; }
    return row;
  });
  t.after(() => { release.resolve(); mocked.mock.restore(); });
  return { captured: captured.promise, release: release.resolve };
}

// Characterizes pinned native RMW gaps; these are not coordination guarantees.
test('native rename overwrites a concurrently saved different-key setting from its stale row', { timeout: 30_000 }, async t => {
  const { runtime } = await setup(t, 'rename-setting-race');
  const threadId = 'rename-setting-thread';
  const session = await runtime.createSession({ resourceId: 'rename-setting-resource', threadId });
  await session.state.set({ thinkingLevel: 'medium' });
  await session.thread.rename({ title: 'Before name' });
  const gate = await holdNextThreadRead(t, runtime, threadId);
  const renaming = session.thread.rename({ title: 'Manual name' });
  try {
    await gate.captured;
    await session.state.set({ thinkingLevel: 'high' });
    assert.equal((await runtime.controller.queryThreadById({ threadId }))!.metadata!.thinkingLevel, 'high', 'intervening native setting really persisted');
  } finally { gate.release(); await renaming; }
  const row = await runtime.controller.queryThreadById({ threadId });
  assert.equal(row!.title, 'Manual name');
  assert.equal(row!.metadata!.thinkingLevel, 'medium', 'native rename restored stale metadata');
  assert.equal(session.state.get().thinkingLevel, 'high', 'live state now disagrees with the native persisted setting');
});

test('native token-usage persistence overwrites an intervening manual name and title pin', { timeout: 30_000 }, async t => {
  const { runtime } = await setup(t, 'usage-rename-race');
  const threadId = 'usage-rename-thread';
  const session = await runtime.createSession({ resourceId: 'usage-rename-resource', threadId });
  await session.thread.rename({ title: 'Before name', pin: false });
  session.addUsage({ promptTokens: 10, completionTokens: 3, totalTokens: 13 });
  const gate = await holdNextThreadRead(t, runtime, threadId);
  const savingUsage = session.machinery.persistTokenUsage();
  try {
    await gate.captured;
    await session.thread.rename({ title: 'Manual survivor' });
    const renamed = await runtime.controller.queryThreadById({ threadId });
    assert.equal(renamed!.title, 'Manual survivor'); assert.equal(renamed!.metadata!.titlePinned, true);
  } finally { gate.release(); await savingUsage; }
  const row = await runtime.controller.queryThreadById({ threadId });
  assert.deepEqual(row!.metadata!.tokenUsage, session.getTokenUsage(), 'real native usage writer completed');
  assert.equal(row!.title, 'Before name', 'native usage persistence restored its captured old title');
  assert.equal(row!.metadata!.titlePinned, false, 'native usage persistence restored its captured old pin');
});
