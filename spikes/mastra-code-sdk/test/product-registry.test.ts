import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { resolveProfile } from '../src/profile.js';
import { openProductRegistry, ProductRegistryError } from '../src/product-registry.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'kodex-registry-'));
  const profile = resolveProfile(join(root, 'profile'));
  const standaloneCwd = join(root, 'gateway-home');
  const stores: Awaited<ReturnType<typeof openProductRegistry>>[] = [];
  t.after(async () => { for (const store of stores) await store.close(); await rm(root, { recursive: true, force: true }); });
  const open = async () => { const store = await openProductRegistry(profile, { standaloneCwd }); stores.push(store); return store; };
  return { root, profile, standaloneCwd, open };
}
const hasCode = (code: ProductRegistryError['code']) => (error: unknown) => error instanceof ProductRegistryError && error.code === code;

test('CLI seeds preserve native binding paths once, and deleted seeds do not return after reload', async t => {
  const { root, open } = await fixture(t);
  const seed = { id: 'existing-cli-id', name: 'Seed', path: join(root, 'old-cwd'), runtimeRoot: join(root, 'old-native-db') };
  const first = await open();
  await first.seedProjects([seed]);
  const project = (await first.snapshot()).projects[0]!;
  assert.equal(project.id, seed.id);
  assert.deepEqual(project.roots, [seed.path]);
  const binding = await first.executionBinding(project.id);
  assert.equal(binding.cwd, seed.path);
  assert.equal(binding.runtimeRoot, seed.runtimeRoot);
  await mkdir(binding.runtimeRoot, { recursive: true });
  await writeFile(join(binding.runtimeRoot, 'native.db'), 'native data stays native');
  await first.updateProject({ id: project.id, patch: { name: 'Renamed' } });
  const second = await open();
  await second.seedProjects([seed]);
  assert.equal((await second.snapshot()).projects[0]!.name, 'Renamed');
  await second.deleteProject({ id: project.id });
  await first.seedProjects([seed]);
  assert.deepEqual((await first.snapshot()).projects, []);
  assert.deepEqual(await first.listBindings(), [{ ...binding, projectId: null }]);
  assert.equal(await readFile(join(binding.runtimeRoot, 'native.db'), 'utf8'), 'native data stays native');
  await first.close();
  await second.close();
  const reopened = await open();
  await reopened.seedProjects([seed]);
  assert.deepEqual((await reopened.snapshot()).projects, []);
  assert.deepEqual(await reopened.listBindings(), [{ ...binding, projectId: null }]);
});

test('create keys survive reload and deletion without reassignment when the same path is recreated', async t => {
  const { root, open } = await fixture(t);
  const first = await open();
  const request = { createKey: 'browser-attempt-1', name: 'First', roots: [join(root, 'project')] };
  const project = await first.createProject(request);
  const oldBinding = await first.executionBinding(project.id);
  const second = await open();
  assert.deepEqual(await second.createProject(request), project);
  assert.equal((await second.snapshot()).projects.length, 1);
  await assert.rejects(second.createProject({ ...request, name: 'Different' }), hasCode('CONFLICT'));
  await second.deleteProject({ id: project.id });
  await assert.rejects(first.createProject(request), hasCode('NOT_FOUND'));
  const recreated = await first.createProject({ ...request, createKey: 'browser-attempt-2' });
  const newBinding = await first.executionBinding(recreated.id);
  assert.notEqual(recreated.id, project.id);
  assert.notEqual(newBinding.id, oldBinding.id);
  assert.notEqual(newBinding.runtimeRoot, oldBinding.runtimeRoot);
  assert.equal(newBinding.cwd, oldBinding.cwd);
  assert.equal((await first.listBindings()).find(row => row.id === oldBinding.id)!.projectId, null);
});

test('sparse root updates retain previous native bindings and enforce single-root execution only', async t => {
  const { root, open } = await fixture(t);
  const store = await open();
  let project = await store.createProject({ createKey: 'roots', name: 'Roots', roots: [] });
  await assert.rejects(store.executionBinding(project.id), hasCode('INVALID_PROJECT_ROOTS'));
  project = await store.updateProject({ id: project.id, patch: { roots: [join(root, 'a'), join(root, 'b')] } });
  await assert.rejects(store.executionBinding(project.id), hasCode('INVALID_PROJECT_ROOTS'));
  project = await store.updateProject({ id: project.id, patch: { roots: [join(root, 'a')] } });
  const oldBinding = await store.executionBinding(project.id);
  const second = await open();
  const renamed = await second.updateProject({ id: project.id, patch: { name: 'Updated' } });
  assert.deepEqual(renamed.roots, project.roots);
  assert.deepEqual(await store.executionBinding(project.id), oldBinding);
  project = await store.updateProject({ id: project.id, patch: { roots: [join(root, 'b')] } });
  const nextBinding = await store.executionBinding(project.id);
  assert.equal(project.name, 'Updated');
  assert.notEqual(nextBinding.id, oldBinding.id);
  assert.equal(nextBinding.cwd, join(root, 'b'));
  assert.equal((await store.listBindings()).find(row => row.id === oldBinding.id)!.projectId, project.id);
  assert.equal((await store.listBindings()).find(row => row.id === oldBinding.id)!.cwd, join(root, 'a'));
  await store.updateProject({ id: project.id, patch: { roots: [join(root, 'a')] } });
  assert.deepEqual(await second.executionBinding(project.id), oldBinding);
});

test('ordered sparse mutations converge across clients; missing move targets cannot partially reorder', async t => {
  const { open } = await fixture(t);
  const first = await open();
  const second = await open();
  const a = await first.createProject({ createKey: 'a', name: 'A', roots: [] });
  const b = await second.createProject({ createKey: 'b', name: 'B', roots: [] });
  const c = await first.createProject({ createKey: 'c', name: 'C', roots: [] });
  const initial = await second.snapshot();
  await first.moveProjectBefore({ id: c.id, beforeId: a.id });
  assert.deepEqual((await second.snapshot()).projects.map(row => row.id), [c.id, a.id, b.id]);
  const revision = (await second.snapshot()).revision;
  assert.ok(revision > initial.revision);
  await assert.rejects(second.moveProjectBefore({ id: b.id, beforeId: 'missing' }), hasCode('NOT_FOUND'));
  assert.equal((await first.snapshot()).revision, revision);
  await second.moveProjectBefore({ id: c.id, beforeId: null });
  assert.deepEqual((await first.snapshot()).projects.map(row => row.id), [a.id, b.id, c.id]);
});

test('standalone binding uses gateway home, persists independently, and invalid creates leave no request key', async t => {
  const { standaloneCwd, open } = await fixture(t);
  const first = await open();
  const standalone = await first.executionBinding(null);
  assert.equal(standalone.projectId, null);
  assert.equal(standalone.cwd, standaloneCwd);
  const second = await open();
  assert.deepEqual(await second.executionBinding(null), standalone);
  await assert.rejects(first.createProject({ createKey: 'invalid', name: 'Bad', roots: [standaloneCwd, standaloneCwd] }), hasCode('INVALID_INPUT'));
  assert.deepEqual((await second.snapshot()).projects, []);
  const valid = await second.createProject({ createKey: 'invalid', name: 'Fixed', roots: [] });
  assert.equal(valid.name, 'Fixed');
  assert.deepEqual((await first.snapshot()).projects, [valid]);
});

test('concurrent retry and sparse writes share atomic SQLite ownership without duplicate projects or bindings', async t => {
  const { root, open } = await fixture(t);
  const first = await open();
  const second = await open();
  const request = { createKey: 'same-attempt', name: 'Concurrent', roots: [join(root, 'a')] };
  const [a, b, c] = await Promise.all([first.createProject(request), second.createProject(request), first.createProject(request)]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  const [bindingA, bindingB] = await Promise.all([first.executionBinding(a.id), second.executionBinding(a.id)]);
  assert.deepEqual(bindingA, bindingB);
  await Promise.all([
    first.updateProject({ id: a.id, patch: { name: 'Renamed' } }),
    second.updateProject({ id: a.id, patch: { roots: [join(root, 'b')] } }),
  ]);
  assert.deepEqual((await first.snapshot()).projects, [{ ...a, name: 'Renamed', roots: [join(root, 'b')] }]);
  assert.equal((await second.listBindings()).length, 1);
});

test('seed batch failure rolls back membership and seed memory; default standalone cwd is the real gateway home', async t => {
  const { root, open } = await fixture(t);
  const store = await open();
  const seeds = [
    { id: 'one', name: 'One', path: join(root, 'one'), runtimeRoot: join(root, 'shared-native-root') },
    { id: 'two', name: 'Two', path: join(root, 'two'), runtimeRoot: join(root, 'shared-native-root') },
  ];
  await assert.rejects(store.seedProjects(seeds));
  assert.deepEqual(await store.snapshot(), { revision: 0, projects: [] });
  assert.deepEqual(await store.listBindings(), []);
  await store.seedProjects([seeds[0]!]);
  assert.equal((await store.snapshot()).projects[0]!.id, 'one');
  const defaultStore = await openProductRegistry(resolveProfile(join(root, 'default-profile')));
  t.after(() => defaultStore.close());
  assert.equal((await defaultStore.executionBinding(null)).cwd, homedir());
});


test('chat pin order is global, retry-safe and atomically rejects an invalid before target', async t => {
  const { open } = await fixture(t); const first = await open(); const second = await open();
  const a = await first.createProject({ createKey: 'pins-a', name: 'A', roots: [] });
  const b = await first.createProject({ createKey: 'pins-b', name: 'B', roots: [] });
  await first.updateProject({ id: a.id, patch: { roots: ['/project-a'] } });
  await first.updateProject({ id: b.id, patch: { roots: ['/project-b'] } });
  const bindings = [await first.executionBinding(a.id), await first.executionBinding(b.id), await first.executionBinding(null)];
  const identities = bindings.map((binding, index) => ({ bindingId: binding.id, threadId: `native-${index}` }));
  for (const identity of identities) await first.setChatPinned({ ...identity, pinned: true });
  const order = async () => (await second.chatMetadataSnapshot()).entries.filter(row => row.pinPosition !== null).sort((a, b) => a.pinPosition! - b.pinPosition!).map(row => row.threadId);
  assert.deepEqual(await order(), ['native-0', 'native-1', 'native-2']);
  await second.setChatPinned({ ...identities[1]!, pinned: true });
  assert.deepEqual(await order(), ['native-0', 'native-1', 'native-2']);
  await first.setChatPinned({ ...identities[2]!, pinned: true, before: identities[1] });
  assert.deepEqual(await order(), ['native-0', 'native-2', 'native-1']);
  const before = await first.chatMetadataSnapshot();
  await assert.rejects(second.setChatPinned({ ...identities[0]!, pinned: true, before: { bindingId: bindings[0]!.id, threadId: 'not-pinned' } }), hasCode('CONFLICT'));
  assert.deepEqual(await first.chatMetadataSnapshot(), before);
  await assert.rejects(first.setChatPinned({ ...identities[1]!, pinned: false, before: null }), hasCode('INVALID_INPUT'));
  await first.setChatPinned({ ...identities[2]!, pinned: false });
  assert.deepEqual(await order(), ['native-0', 'native-1']);
  await first.setChatPinned({ ...identities[0]!, pinned: true, before: null });
  assert.deepEqual(await order(), ['native-1', 'native-0']);
});

test('chat notification metadata stays independent from project ownership and same-path recreation', async t => {
  const { root, open } = await fixture(t); const first = await open();
  const project = await first.createProject({ createKey: 'chat-metadata', name: 'Metadata', roots: [join(root, 'cwd')] });
  const old = await first.executionBinding(project.id); const identity = { bindingId: old.id, threadId: 'native-chat' };
  await Promise.all([first.setChatPinned({ ...identity, pinned: true }), first.setChatNotifications({ ...identity, enabled: false })]);
  await first.deleteProject({ id: project.id });
  const recreated = await first.createProject({ createKey: 'recreated-metadata', name: 'New', roots: [old.cwd] });
  const fresh = await first.executionBinding(recreated.id);
  await first.close(); const reopened = await open();
  assert.notEqual(old.id, fresh.id);
  assert.deepEqual((await reopened.chatMetadataSnapshot()).entries, [{ ...identity, pinPosition: 0, notificationsEnabled: false, archived: false }]);
  assert.equal((await reopened.listBindings()).find(row => row.id === old.id)!.projectId, null);
  await assert.rejects(reopened.setChatNotifications({ bindingId: 'missing-binding', threadId: 'native-chat', enabled: false }), hasCode('NOT_FOUND'));
  assert.equal((await reopened.chatMetadataSnapshot()).entries.length, 1);
});


test('archive metadata is durable and idempotent while preserving pin and notification preferences', async t => {
  const { open } = await fixture(t); const first = await open(), second = await open();
  const binding = await first.executionBinding(null);
  const identity = { bindingId: binding.id, threadId: 'retained-native-history' };
  await first.setChatPinned({ ...identity, pinned: true });
  await first.setChatNotifications({ ...identity, enabled: false });
  await first.archiveChat(identity);
  const archived = await second.chatMetadataSnapshot();
  assert.deepEqual(archived.entries, [{ ...identity, pinPosition: 0, notificationsEnabled: false, archived: true }]);
  await second.archiveChat(identity);
  assert.deepEqual(await first.chatMetadataSnapshot(), archived);
  await first.close(); const reopened = await open();
  assert.deepEqual(await reopened.chatMetadataSnapshot(), archived);
  await assert.rejects(reopened.archiveChat({ ...identity, bindingId: 'missing-binding' }), hasCode('NOT_FOUND'));
});
