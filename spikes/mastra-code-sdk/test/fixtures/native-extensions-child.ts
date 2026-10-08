import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activateProfile, resolveProfile } from '../../src/profile.js';
import { createHostModelGateways } from '../../src/model-gateways.js';
import { lastUserText, startModelFixture } from './model-server.js';
import type { ExtensionOptions, FixtureProvider } from './native-extensions-plugin.js';
import type { NativeSession } from '../../src/runtime.js';

const root = process.argv[2]!;
assert.equal(homedir(), join(root, 'outside-home'));
const profile = activateProfile(resolveProfile(join(root, 'profile')));
// Native imports follow profile activation. No credentials or nonlocal model.
const { prepareAgentControllerMount } = await import('@mastra/code-sdk');
const { Mastra } = await import('@mastra/core/mastra');
const namespace = '.kodex-mastra-spike';
const trace = join(root, 'extension-trace.jsonl'), gate = join(root, 'release-tools');
await writeFile(trace, '');
interface Trace { kind: string; event?: string; marker?: string; label?: string; cwd: string; scope?: string;
  threadId?: string; resourceId?: string; sessionId?: string; activeSession?: string | null;
  hook_event_name?: string; session_id?: string; run_id?: string; tool_name?: string; tool_input?: { label?: string } }
async function rows(): Promise<Trace[]> { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Trace); }
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('Extension fixture observation timed out'); await pause(10); }
}
function report(step: string, evidence?: unknown) { process.stdout.write(`EXTENSION ${step}${evidence === undefined ? '' : ` ${JSON.stringify(evidence)}`}\n`); }
const pluginHelper = pathToFileURL(fileURLToPath(new URL('./native-extensions-plugin.ts', import.meta.url))).href;
async function entry(base: string, options: Pick<ExtensionOptions, 'id' | 'name' | 'marker'>) {
  const directory = join(base, namespace, 'plugins', 'sources', options.id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  const path = join(directory, 'index.ts');
  await writeFile(path, `import { fixturePlugin } from ${JSON.stringify(pluginHelper)};\nexport default fixturePlugin(${JSON.stringify({ ...options, trace, gate })});\n`);
  return { path: directory, entry: 'index.ts', specifier: directory, source: 'local', enabled: true };
}
async function registry(base: string, id: string, name: string, marker: string) {
  const record = await entry(base, { id, name, marker });
  await writeFile(join(base, namespace, 'plugins', 'plugins.json'), JSON.stringify({ plugins: { [id]: record } }));
  return join(record.path, record.entry);
}
const events = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'AgentStart', 'AgentEnd', 'Stop'];
const hookFixture = fileURLToPath(new URL('./native-extensions-hook.mjs', import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function hooks(base: string, scope: string) {
  const command = [process.execPath, hookFixture, trace, scope].map(quote).join(' ');
  await mkdir(join(base, namespace), { recursive: true });
  await writeFile(join(base, namespace, 'hooks.json'), JSON.stringify(Object.fromEntries(events.map(event => [event, [{ type: 'command', command }]]))));
}
const projectA = join(root, 'project-a'), projectB = join(root, 'project-b');
await Promise.all([
  registry(profile.homeDir, 'global', 'extension_global', 'global-v1'),
  registry(projectA, 'project-a', 'extension_project_a', 'a-v1'),
  registry(projectB, 'project-b', 'extension_project_b', 'b-v1'),
  registry(homedir(), 'outside', 'extension_outside', 'outside'),
  hooks(profile.homeDir, 'global'), hooks(projectA, 'a'), hooks(projectB, 'b'), hooks(homedir(), 'outside'),
]);
const model = await startModelFixture(request => {
  const prompt = lastUserText(request);
  if (!prompt.startsWith('EXT:')) return { text: 'Local fixture auxiliary result' };
  const current = request.messages.slice(request.messages.findLastIndex(message => message.role === 'user'));
  if (current.some(message => message.role === 'tool')) return { text: `EXTENSION_FINAL:${prompt}` };
  const [, name, label, held] = prompt.split(':');
  return { toolCalls: [{ name: name!, arguments: { label: label!, held: held === 'held' } }] };
});
await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false }, preferences: { yolo: true },
  models: { observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: null },
  customProviders: [{ name: 'fixture', url: model.url, apiKey: 'local-not-a-real-key', models: ['chat'] }],
}));
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') throw new Error('Extension fixture forbids nonloopback HTTP');
  return realFetch(input, init);
};
async function mount(cwd: string, key: string) {
  const runtimeRoot = join(root, `runtime-${key}`); await mkdir(runtimeRoot);
  const prepared = await prepareAgentControllerMount({ cwd, homeDir: profile.homeDir, settingsPath: profile.settingsPath, configDir: namespace,
    storage: { backend: 'libsql', url: `file:${join(runtimeRoot, 'native.db')}`, vectorUrl: `file:${join(runtimeRoot, 'vectors.db')}`, isRemote: false },
    initialState: { yolo: true, homeDir: profile.homeDir, skipGlobalInstructions: true }, omScope: 'thread',
    disableEnvFile: true, disableGithubSignals: true, disableMcp: true, disablePlugins: false, disableHooks: false,
    crossAgentSignals: false, scheduleTools: false, intervalHandlers: [], subagents: [],
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
  });
  const gateways = await createHostModelGateways(profile.settingsPath, prepared.base.authStorage);
  const mastra = new Mastra({ ...prepared.mastraArgs, gateways }); await prepared.finalize();
  return { ...prepared.base, mastra, cwd, key };
}
const runtimes: Awaited<ReturnType<typeof mount>>[] = [], sessions: NativeSession[] = [], outputs: Promise<unknown>[] = [];
let completed = false;
try {
  const a = await mount(projectA, 'a'); runtimes.push(a);
  const b = await mount(projectB, 'b'); runtimes.push(b);
  const managerA = a.pluginManager!, managerB = b.pluginManager!;
  assert.ok(managerA && managerB); assert.notEqual(managerA, managerB);
  for (const [runtime, expected] of [[a, ['extension_global', 'extension_project_a']], [b, ['extension_global', 'extension_project_b']]] as const) {
    const loaded = runtime.pluginManager!.getLoadedPlugins();
    assert.ok(loaded.every(plugin => plugin.status === 'active'), JSON.stringify(loaded.map(plugin => ({ id: plugin.id, status: plugin.status, error: plugin.error }))));
    assert.deepEqual(Object.keys(runtime.pluginManager!.getPluginTools()).sort(), [...expected].sort());
    assert.deepEqual(runtime.hookManager?.getConfigPaths(), { global: join(profile.homeDir, namespace, 'hooks.json'), project: join(runtime.cwd, namespace, 'hooks.json') });
    for (let index = 1; index <= 2; index++) {
      const session = await runtime.controller.createSession({ resourceId: `resource-${runtime.key}${index}`, threadId: `thread-${runtime.key}${index}`, tags: { projectPath: runtime.cwd } });
      sessions.push(session); await session.thread.rename({ title: `Extension ${runtime.key}${index}`, pin: true });
      // Observe the public wake result without changing native admission or output.
      const agent = session.machinery.getAgent(), send = agent.sendSignal.bind(agent);
      mock.method(agent, 'sendSignal', (...args: Parameters<typeof send>) => {
        const admission = send(...args);
        const output = admission.accepted.then(result => result.action === 'wake' ? result.output.getFullOutput() : undefined);
        outputs.push(output); void output.catch(() => {}); return admission;
      });
    }
  }
  const provider = (runtime: typeof a, id: string) => runtime.pluginManager!.getPluginSignalProviders().find(row => row.pluginId === id)!.value as FixtureProvider;
  const globalA = provider(a, 'global'), globalB = provider(b, 'global');
  assert.notEqual(globalA, globalB, 'global entry factories allocate a provider for each manager');
  await until(() => globalA.polls > 0 && globalB.polls > 0);
  report('native discovery', runtimes.map(runtime => ({ cwd: runtime.cwd, tools: Object.keys(runtime.pluginTools) })));
  const sends = sessions.map(session => session.sendMessage({ content: `EXT:extension_global:${session.thread.requireId()}:held` }));
  try {
    await until(async () => (await rows()).filter(row => row.kind === 'tool' && row.event === 'entered').length === 4);
    assert.ok(sessions.every(session => session.displayState.get().isRunning), 'all four native Sessions overlap inside actual plugin tools');
    const entered = (await rows()).filter(row => row.kind === 'tool' && row.event === 'entered');
    for (const row of entered) {
      const session = sessions.find(session => session.thread.getId() === row.label)!; assert.ok(session);
      assert.equal(row.threadId, session.thread.getId()); assert.equal(row.resourceId, session.identity.getResourceId());
      assert.equal(row.sessionId, session.identity.getId()); assert.equal(row.cwd, session.state.get().projectPath);
      assert.equal(row.activeSession, null, 'mounted native getter is undefined, without inventing an active Session');
      assert.equal(row.scope, 'global'); assert.equal(row.marker, 'global-v1');
    }
    report('concurrent origins', entered);
  } finally { await writeFile(gate, 'release'); await Promise.allSettled(sends); }
  await Promise.all(outputs);
  const automatic = (await rows()).filter(row => row.kind === 'hook');
  assert.deepEqual([...new Set(automatic.map(row => row.hook_event_name))].sort(), ['PostToolUse', 'PreToolUse']);
  assert.equal(automatic.length, 16, 'each actual call runs global plus owning-project pre/post hooks');
  for (const row of automatic) {
    assert.equal(row.session_id, 'session-init'); assert.equal(row.run_id, undefined);
    assert.equal(row.tool_name, 'extension_global');
    assert.ok(row.scope === 'global' || row.scope === (row.cwd === projectA ? 'a' : 'b'));
  }
  for (const session of sessions) {
    const label = session.thread.requireId();
    const callHooks = automatic.filter(row => row.tool_input?.label === label);
    const ownScope = session.state.get().projectPath === projectA ? 'a' : 'b';
    assert.deepEqual(callHooks.map(row => [row.hook_event_name, row.scope]), [['PreToolUse', 'global'], ['PreToolUse', ownScope], ['PostToolUse', 'global'], ['PostToolUse', ownScope]]);
  }
  report('automatic hooks', { events: [...new Set(automatic.map(row => row.hook_event_name))], sessionIds: [...new Set(automatic.map(row => row.session_id))], runIdsPresent: automatic.some(row => row.run_id !== undefined) });
  // Valid lifecycle configuration exists, but the multi-Session mount does not
  // dispatch these automatically. Calling the native manager explicitly works.
  await a.hookManager!.runSessionStart();
  assert.equal((await rows()).filter(row => row.hook_event_name === 'SessionStart').length, 2);

  async function use(session: NativeSession, name: string, label: string, marker: string) {
    await session.sendMessage({ content: `EXT:${name}:${label}:free` }); await Promise.all(outputs);
    const result = (await rows()).findLast(row => row.kind === 'tool' && row.label === label && row.event === 'returned');
    assert.ok(result); assert.equal(result.marker, marker); assert.equal(result.threadId, session.thread.getId());
    const saved = await (session === sessions[0] ? a : b).controller.queryThreadMessages({ threadId: session.thread.requireId(), resourceId: session.identity.getResourceId(), perPage: 30 });
    assert.ok(JSON.stringify(saved.messages).includes(marker), 'actual native tool result is saved in the owning chat');
  }
  await use(sessions[0]!, 'extension_project_a', 'a-before', 'a-v1');
  await use(sessions[2]!, 'extension_project_b', 'b-before', 'b-v1');
  const oldProvider = provider(a, 'project-a'), peerProvider = provider(b, 'project-b');
  const entryA = join(projectA, namespace, 'plugins', 'sources', 'project-a', 'index.ts');
  await writeFile(entryA, `import { fixturePlugin } from ${JSON.stringify(pluginHelper)};\nexport default fixturePlugin(${JSON.stringify({ id: 'project-a', name: 'extension_project_a', marker: 'a-v2', trace, gate })});\n`);
  await managerA.reload();
  const nextProvider = provider(a, 'project-a'); assert.notEqual(nextProvider, oldProvider);
  assert.equal(oldProvider.stopped, true); assert.equal(peerProvider.stopped, false);
  const oldPolls = oldProvider.polls; await until(() => nextProvider.polls > 1); assert.equal(oldProvider.polls, oldPolls);
  await use(sessions[0]!, 'extension_project_a', 'a-after', 'a-v2');
  await use(sessions[2]!, 'extension_project_b', 'b-after', 'b-v1');
  report('reload', { changed: 'a-v2', peer: 'b-v1', oldProviderStopped: oldProvider.stopped });
  a.stopPluginSignalProviders(); b.stopPluginSignalProviders();
  assert.ok([globalA, globalB, nextProvider, peerProvider].every(provider => provider.stopped));
  const stoppedPolls = nextProvider.polls;
  await managerA.reload(); assert.equal(nextProvider.polls, stoppedPolls);
  assert.equal(provider(a, 'project-a').polls, 0, 'stopped lane does not restart providers on manager reload');
  report('native provider cleanup', { stopped: true, reloadRestartsLane: false });
  completed = true;
} finally {
  await writeFile(gate, 'release'); await Promise.allSettled(outputs);
  for (const runtime of runtimes) {
    runtime.stopPluginSignalProviders(); runtime.threadScheduler.stop();
    runtime.stopNotificationDispatch();
    // Public disable/reload collects only the disposable fixture's file watches;
    // the manager has no public dispose, so this is not a host-retirement claim.
    for (const plugin of runtime.pluginManager!.getLoadedPlugins()) await runtime.pluginManager!.setEnabled(plugin.id, plugin.scope, false);
    for (const session of sessions.filter(session => session.state.get().projectPath === runtime.cwd)) {
      const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
      if (memory && 'settled' in memory && typeof memory.settled === 'function') await memory.settled();
      await runtime.controller.deleteSession({ resourceId: session.identity.getResourceId() });
    }
    await runtime.mastra.shutdown(); await runtime.storageMaintenance.closeStorage?.();
  }
  mock.restoreAll(); await model.close(); globalThis.fetch = realFetch;
}
assert.equal(completed, true);
const finalHooks = (await rows()).filter(row => row.kind === 'hook');
assert.deepEqual([...new Set(finalHooks.map(row => row.hook_event_name))].sort(), ['PostToolUse', 'PreToolUse', 'SessionStart']);
assert.equal(finalHooks.filter(row => row.hook_event_name === 'SessionStart').length, 2, 'only the explicit manager lifecycle call ran');
assert.equal(finalHooks.filter(row => row.hook_event_name === 'SessionEnd').length, 0, 'native deletion does not add lifecycle dispatch for this mount');
report('EXTENSION_PROOF_COMPLETE');
process.exit(0);
