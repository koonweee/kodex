import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveChatThreadRoute } from '../src/chat-thread-route.js';
import { ownsThread, type NativeThread } from '../src/chat-projects.js';
import type { RuntimeBinding } from '../src/product-registry.js';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { startModelFixture } from './fixtures/model-server.js';
const binding: RuntimeBinding = { id: 'binding', projectId: 'project', cwd: '/owned', runtimeRoot: '/runtime' };
function thread(id: string, resourceId: string, metadata: Record<string, unknown>): NativeThread {
  return { id, resourceId, title: id, createdAt: new Date(0), updatedAt: new Date(0), metadata };
}
const root = thread('root', 'root-resource', { projectPath: binding.cwd });
function child(id: string, parent: NativeThread, extra: Record<string, unknown> = {}) {
  return thread(id, `${id}-resource`, { projectPath: binding.cwd, kodexChild: '1', parentThreadId: parent.id,
    parentResourceId: parent.resourceId, parentSessionScope: '', parentTaskId: `${id}-task`, ...extra });
}
function fork(id: string, parent: NativeThread, extra: Record<string, unknown> = {}) {
  return thread(id, parent.resourceId!, { forkedSubagent: true, parentThreadId: parent.id, ...extra });
}
test('route metadata identifies ordinary roots and mixed descendants without admitting them as ordinary chats', () => {
  const fresh = child('child', root), inherited = fork('fork', fresh), leaf = child('leaf', inherited);
  const rows = [leaf, inherited, root, fresh];
  assert.deepEqual(resolveChatThreadRoute(binding, rows, root.id), { kind: 'ordinary', thread: root, root, ancestors: [] });
  assert.deepEqual(resolveChatThreadRoute(binding, rows, leaf.id), { kind: 'child', thread: leaf, root, ancestors: [root, fresh, inherited] });
  assert.deepEqual(resolveChatThreadRoute(binding, rows, inherited.id), { kind: 'fork', thread: inherited, root, ancestors: [root, fresh] });
  assert.equal(ownsThread(binding, leaf), false); assert.equal(ownsThread(binding, inherited), false);
  // Native ordinary fork provenance is not subagent ownership.
  const ordinary = thread('ordinary-copy', root.resourceId!, { projectPath: binding.cwd, parentThreadId: root.id });
  assert.equal(resolveChatThreadRoute(binding, [ordinary], ordinary.id)?.kind, 'ordinary');
});
test('route metadata fails closed on malformed, conflicting, foreign, cyclic, orphan and ambiguous ancestry', () => {
  const fresh = child('fresh', root);
  const invalid = [
    child('bad-resource', root, { parentResourceId: 'foreign' }), child('bad-path', root, { projectPath: '/foreign' }),
    child('bad-scope', root, { parentSessionScope: 'scope' }), child('bad-version', root, { kodexChild: '2' }),
    child('bad-task', root, { parentTaskId: '' }), child('bad-parent', root, { parentThreadId: 1 }),
    fork('conflict', root, { kodexChild: '1' }), fork('fork-path', root, { projectPath: '/foreign' }),
    thread('fork-resource', 'foreign', { forkedSubagent: true, parentThreadId: root.id }),
    thread('malformed-root', root.resourceId!, { projectPath: binding.cwd, forkedSubagent: 'true' }),
  ];
  for (const bad of invalid) {
    assert.equal(resolveChatThreadRoute(binding, [root, bad], bad.id), null, bad.id);
    const leaf = child(`${bad.id}-leaf`, bad);
    assert.equal(resolveChatThreadRoute(binding, [root, bad, leaf], leaf.id), null, `${bad.id} cannot bridge ancestry`);
  }
  assert.equal(resolveChatThreadRoute(binding, [fresh], fresh.id), null, 'missing root');
  assert.equal(resolveChatThreadRoute(binding, [root, fresh], 'missing'), null);
  assert.equal(resolveChatThreadRoute({ ...binding, cwd: '/foreign' }, [root, fresh], fresh.id), null);
  assert.equal(resolveChatThreadRoute(binding, [root, fresh, { ...root, resourceId: 'conflicting-root' }], fresh.id), null);
  assert.equal(resolveChatThreadRoute(binding, [root, fresh, { ...fresh, metadata: { ...fresh.metadata, parentThreadId: 'missing' } }], fresh.id), null);
  const a = thread('a', 'cycle', { forkedSubagent: true, parentThreadId: 'b' });
  const b = thread('b', 'cycle', { forkedSubagent: true, parentThreadId: 'a' });
  assert.equal(resolveChatThreadRoute(binding, [root, a, b], a.id), null);
});
test('resolves stored native route metadata across restart without Session creation or model work', { timeout: 30_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'kodex-native-thread-route-'));
  const profile = activateProfile(resolveProfile(join(temporary, 'profile')));
  const cwd = join(temporary, 'project'); await mkdir(cwd);
  const fixture = await startModelFixture(); let runtime: ProjectRuntime | undefined;
  t.after(async () => { await runtime?.dispose(); await fixture.close(); await rm(temporary, { recursive: true, force: true }); });
  await writeFile(profile.settingsPath, JSON.stringify({ models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: null, reflectorModelOverride: null }, customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }], lsp: false, observability: { enabled: false } }));
  const nativeBinding = { ...binding, cwd, runtimeRoot: join(temporary, 'runtime') };
  const nativeRoot = thread('native-root', 'native-resource', { projectPath: cwd });
  const nativeFork = fork('native-fork', nativeRoot);
  const nativeChild = child('native-child', nativeFork, { projectPath: cwd });
  async function mount() { runtime = await createProjectRuntime({ profile, projectPath: cwd, runtimeRoot: nativeBinding.runtimeRoot,
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] }); }
  await mount(); const memory = await runtime!.storage.getStore('memory'); assert.ok(memory);
  for (const row of [nativeRoot, nativeFork, nativeChild]) await memory.saveThread({ thread: row });
  let activations = 0;
  const read = async () => {
    const off = runtime!.controller.onSessionCreated(() => { activations++; });
    try {
      const rows = await runtime!.controller.queryThreads({ includeForkedSubagents: true });
      const result = resolveChatThreadRoute(nativeBinding, rows, nativeChild.id); assert.ok(result);
      assert.equal(result.kind, 'child'); assert.equal(result.root.id, nativeRoot.id);
      assert.deepEqual(result.ancestors.map(row => row.id), [nativeRoot.id, nativeFork.id]);
      assert.equal(ownsThread(nativeBinding, result.thread), false);
      for (const row of [nativeRoot, nativeFork, nativeChild]) assert.equal(await runtime!.controller.getSessionByResource(row.resourceId!), undefined);
    } finally { off(); }
  };
  await read(); await runtime!.dispose(); runtime = undefined; await mount(); await read();
  assert.equal(activations, 0); assert.equal(fixture.requests.length, 0);
});
