import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activateProfile, resolveProfile } from '../../src/profile.js';
import { applyChildSessionPolicy } from '../../src/child-policy.js';
import { createHostModelGateways } from '../../src/model-gateways.js';
import { KODEX_CHILD_TAG, KODEX_CHILD_VERSION } from '../../src/child-relation.js';
import type { NativeSession } from '../../src/runtime.js';
import type { WakeProvider } from './native-plugin-wakes-plugin.js';
import { lastUserText, startModelFixture } from './model-server.js';

const root = process.argv[2]!;
assert.equal(homedir(), join(root, 'outside-home'));
const profile = activateProfile(resolveProfile(join(root, 'profile')));
const { prepareAgentControllerMount } = await import('@mastra/code-sdk');
const { Mastra } = await import('@mastra/core/mastra');
const namespace = '.kodex-mastra-spike', project = join(root, 'project'), trace = join(root, 'trace.jsonl');
await mkdir(project); await writeFile(trace, '');
const entry = join(profile.homeDir, namespace, 'plugins', 'sources', 'wake-proof');
await mkdir(entry, { recursive: true });
await writeFile(join(entry, 'package.json'), JSON.stringify({ type: 'module' }));
const helper = pathToFileURL(fileURLToPath(new URL('./native-plugin-wakes-plugin.ts', import.meta.url))).href;
await writeFile(join(entry, 'index.ts'), `import { wakePlugin } from ${JSON.stringify(helper)};\nexport default wakePlugin(${JSON.stringify(trace)});\n`);
await writeFile(join(profile.homeDir, namespace, 'plugins', 'plugins.json'), JSON.stringify({ plugins: {
  'wake-proof': { path: entry, entry: 'index.ts', specifier: entry, source: 'local', enabled: true },
} }));
const calls = new Map<string, number>(), schemas = new Map<string, boolean>();
const model = await startModelFixture(request => {
  const label = /WAKE_PROBE:([a-z-]+)/.exec(lastUserText(request))?.[1];
  const tool = request.tools?.find(tool => tool.function.name === 'wake_probe');
  if (!label || !tool) return { text: 'Local auxiliary result' };
  if (!calls.has(label)) {
    calls.set(label, 1); schemas.set(label, JSON.stringify(tool.function.parameters).includes('_background'));
    return { toolCalls: [{ name: 'wake_probe', arguments: { label, _background: { enabled: true } }, id: `probe-${label}` }] };
  }
  return { text: `WAKE_FINAL:${label}` };
});
await writeFile(profile.settingsPath, JSON.stringify({ backgroundTools: { enabled: true }, lsp: false,
  observability: { enabled: false }, preferences: { yolo: true }, models: { observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: null },
  customProviders: [{ name: 'fixture', url: model.url, apiKey: 'local-not-a-real-key', models: ['chat'] }],
}));
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Plugin wake proof forbids nonloopback HTTP');
  return realFetch(input, init);
};
const prepared = await prepareAgentControllerMount({ cwd: project, homeDir: profile.homeDir, settingsPath: profile.settingsPath, configDir: namespace,
  storage: { backend: 'libsql', url: `file:${join(root, 'native.db')}`, vectorUrl: `file:${join(root, 'vectors.db')}`, isRemote: false },
  initialState: { yolo: true, homeDir: profile.homeDir, skipGlobalInstructions: true }, omScope: 'thread',
  disableEnvFile: true, disableGithubSignals: true, disableMcp: true, disablePlugins: false, disableHooks: true,
  crossAgentSignals: false, scheduleTools: false, intervalHandlers: [], subagents: [],
  modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
});
const gateways = await createHostModelGateways(profile.settingsPath, prepared.base.authStorage);
const mastra = new Mastra({ ...prepared.mastraArgs, gateways }); await prepared.finalize();
const base = { ...prepared.base, mastra };
const provider = base.pluginManager!.getPluginSignalProviders()[0]!.value as WakeProvider;
assert.equal(provider.id, 'fixture-wakes');
interface Result { label: string; threadId: string | null; resourceId: string | null; projectPath: string | null; sessionId: string | null; backgroundTaskId: string | null; text: string }
const rows = async (): Promise<Result[]> => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Result);
const sessions: NativeSession[] = [], outputs: Promise<unknown>[] = [];
const scopes = new Map<NativeSession, string | undefined>();
let created = 0, completed = false;
const offCreated = base.controller.onSessionCreated(() => { created++; });
const agent = base.codeAgent, stream = agent.stream.bind(agent);
// Public output observation only: all native arguments, admissions and outputs
// are returned unchanged, including background-completion continuation runs.
mock.method(agent, 'stream', (...args: Parameters<typeof stream>) => {
  const result = stream(...args);
  const output = Promise.resolve(result).then(value => value.getFullOutput());
  outputs.push(output); void output.catch(() => {});
  return result;
});
async function joinOutputs() {
  let joined = -1;
  while (joined !== outputs.length) { joined = outputs.length; await Promise.allSettled(outputs.slice()); }
}
async function settle(session: NativeSession) {
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  if (memory && 'settled' in memory && typeof memory.settled === 'function') await memory.settled();
}
function report(step: string, evidence: unknown) { process.stdout.write(`PLUGIN_WAKE ${step} ${JSON.stringify(evidence)}\n`); }
async function session(name: string, tags = {}, scope?: string, resourceId = `resource-${name}`) {
  const value = await base.controller.createSession({ resourceId, threadId: `thread-${name}`, scope, tags: { projectPath: project, ...tags } });
  sessions.push(value); scopes.set(value, scope); await value.thread.rename({ title: name, pin: true }); return value;
}
async function fire(target: NativeSession, label: string) {
  await provider.fire({ resourceId: target.identity.getResourceId(), threadId: target.thread.requireId() }, label);
  await joinOutputs(); await settle(target);
  const result = (await rows()).find(row => row.label === label);
  assert.ok(result, `Missing actual probe result for ${label}`);
  assert.equal(result.threadId, target.thread.getId()); assert.equal(result.resourceId, target.identity.getResourceId());
  assert.equal(result.projectPath, project);
  const taskId = result.backgroundTaskId;
  if (taskId) {
    const task = await mastra.backgroundTaskManager!.waitForNextTask([taskId], { timeoutMs: 10_000 });
    assert.equal(task.status, 'completed');
    await joinOutputs(); await settle(target);
  }
  return result;
}
try {
  const one = await session('ordinary-one'), two = await session('ordinary-two');
  // Real Session input first establishes the same native model/thread state as
  // production's ordinary chat path; subsequent provider wakes start while idle.
  await Promise.all([one.sendMessage({ content: 'Initialize one' }), two.sendMessage({ content: 'Initialize two' })]);
  await joinOutputs();
  const ordinary = await Promise.all([fire(one, 'ordinary-one'), fire(two, 'ordinary-two')]);
  assert.ok(ordinary.every(row => row.backgroundTaskId));
  report('ordinary concurrent idle wakes', ordinary);
  const child = await session('child', { [KODEX_CHILD_TAG]: KODEX_CHILD_VERSION, parentThreadId: one.thread.requireId(),
    parentResourceId: one.identity.getResourceId(), parentSessionScope: '', parentTaskId: 'fixture-child' });
  await applyChildSessionPolicy(child);
  await child.sendMessage({ content: 'WAKE_PROBE:child-direct' }); await joinOutputs(); await settle(child);
  const direct = (await rows()).find(row => row.label === 'child-direct'); assert.ok(direct);
  assert.equal(schemas.get('child-direct'), false); assert.equal(direct.backgroundTaskId, null);
  assert.equal((await mastra.backgroundTaskManager!.listTasks({ threadId: child.thread.requireId(), resourceId: child.identity.getResourceId() })).tasks.length, 0);
  const wake = await fire(child, 'child-wake');
  assert.equal(schemas.get('child-wake'), true, 'provider wake bypasses the public Session disableBackgroundTasks option');
  assert.ok(wake.backgroundTaskId, 'actual native tool execution adopts background work on the provider path');
  report('child Session versus provider', { direct, wake, directBackgroundSchema: schemas.get('child-direct'), wakeBackgroundSchema: schemas.get('child-wake') });
  const childTarget = { resourceId: child.identity.getResourceId(), threadId: child.thread.requireId() };
  await base.controller.deleteSession({ resourceId: childTarget.resourceId });
  assert.equal(await base.controller.getSessionByResource(childTarget.resourceId), undefined);
  const beforeCreated = created, beforeRequests = model.requests.length;
  await provider.fire(childTarget, 'released-child'); await joinOutputs();
  assert.equal(created, beforeCreated, 'native wake does not recreate a released Session');
  const notifications = await base.storage.getStore('notifications'); assert.ok(notifications);
  const retained = await notifications.listNotifications({ threadId: childTarget.threadId });
  report('released child native outcome', { newSessions: created - beforeCreated, modelRequests: model.requests.length - beforeRequests,
    records: retained.filter(row => row.summary === 'WAKE_PROBE:released-child').map(row => ({ status: row.status, error: row.lastDeliveryError ?? null })),
    probe: (await rows()).find(row => row.label === 'released-child') ?? null });
  const dormant = retained.filter(row => row.summary === 'WAKE_PROBE:released-child');
  assert.equal(dormant.length, 1); assert.equal(dormant[0]!.status, 'pending');
  assert.match(dormant[0]!.lastDeliveryError ?? '', /without a controller session context/);
  assert.equal(model.requests.length, beforeRequests);
  assert.equal((await rows()).some(row => row.label === 'released-child'), false, 'bare dormant wake has no initialized controller context for this native mount');
  const fork = await session('scoped-sibling', {}, 'fixture-sibling', one.identity.getResourceId());
  await applyChildSessionPolicy(fork);
  await fork.sendMessage({ content: 'Initialize scoped fork' }); await joinOutputs();
  const scoped = await fire(fork, 'scoped-sibling');
  assert.equal(schemas.get('scoped-sibling'), true);
  assert.ok(scoped.backgroundTaskId);
  report('scoped same-resource provider wake', { result: scoped, ordinaryThreadUnchanged: one.thread.getId() === 'thread-ordinary-one',
    scopedPolicyBypassed: true });
  assert.equal(one.thread.getId(), 'thread-ordinary-one');
  completed = true;
} finally {
  base.stopPluginSignalProviders(); base.threadScheduler.stop(); await base.stopNotificationDispatch();
  await joinOutputs();
  await mastra.backgroundTaskManager?.shutdown(); await joinOutputs();
  for (const plugin of base.pluginManager!.getLoadedPlugins()) await base.pluginManager!.setEnabled(plugin.id, plugin.scope, false);
  for (const value of sessions) {
    await settle(value);
    await base.controller.deleteSession({ resourceId: value.identity.getResourceId(), scope: scopes.get(value) });
  }
  offCreated(); mock.restoreAll();
  await mastra.shutdown(); await base.storageMaintenance.closeStorage?.();
  await model.close(); globalThis.fetch = realFetch;
}
assert.equal(completed, true);
process.stdout.write('PLUGIN_WAKE_PROOF_COMPLETE\n');
// Like the existing extension fixture: explicit exit after awaited native APIs
// is watchdog hygiene, not proof of a universal producer/preparation drain.
process.exit(0);
