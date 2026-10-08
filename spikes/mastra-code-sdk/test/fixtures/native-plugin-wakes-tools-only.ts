import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activateProfile, resolveProfile } from '../../src/profile.js';
import { createHostModelGateways } from '../../src/model-gateways.js';
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
async function writeEntry(marker: string) {
  await writeFile(join(entry, 'index.ts'), `import { wakePlugin } from ${JSON.stringify(helper)};\nexport default wakePlugin(${JSON.stringify(trace)}, ${JSON.stringify(marker)}, {resourceId:'resource-tools-one',threadId:'thread-tools-one'});\n`);
}
await writeEntry('v1');
await writeFile(join(profile.homeDir, namespace, 'plugins', 'plugins.json'), JSON.stringify({ plugins: {
  'wake-proof': { path: entry, entry: 'index.ts', specifier: entry, source: 'local', enabled: true },
} }));
const labels = new Set<string>();
const model = await startModelFixture(request => {
  const label = /TOOLS_PROBE:([a-z-]+)/.exec(lastUserText(request))?.[1];
  if (!label || !request.tools?.some(tool => tool.function.name === 'wake_probe')) return { text: 'Local auxiliary result' };
  if (labels.has(label)) return { text: `TOOLS_FINAL:${label}` };
  labels.add(label); return { toolCalls: [{ name: 'wake_probe', arguments: { label } }] };
});
await writeFile(profile.settingsPath, JSON.stringify({ backgroundTools: { enabled: true }, lsp: false,
  observability: { enabled: false }, preferences: { yolo: true }, models: { observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: null },
  customProviders: [{ name: 'fixture', url: model.url, apiKey: 'local-not-a-real-key', models: ['chat'] }],
}));
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Plugin tool proof forbids nonloopback HTTP');
  return realFetch(input, init);
};
const prepared = await prepareAgentControllerMount({ cwd: project, homeDir: profile.homeDir, settingsPath: profile.settingsPath, configDir: namespace,
  storage: { backend: 'libsql', url: `file:${join(root, 'native.db')}`, vectorUrl: `file:${join(root, 'vectors.db')}`, isRemote: false },
  initialState: { yolo: true, homeDir: profile.homeDir, skipGlobalInstructions: true }, omScope: 'thread',
  disableEnvFile: true, disableGithubSignals: true, disableMcp: true, disablePlugins: false, disableHooks: true,
  crossAgentSignals: false, scheduleTools: false, intervalHandlers: [], subagents: [],
  modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
});
const manager = prepared.base.pluginManager!;
const firstProvider = manager.getPluginSignalProviders()[0]!.value as WakeProvider;
assert.equal(firstProvider.starts, 0); assert.equal(firstProvider.isConnected, false);
// Supported native lifecycle composition; no contribution filtering, facade,
// routing override, or post-start race used to suppress provider activity.
prepared.base.stopPluginSignalProviders();
const gateways = await createHostModelGateways(profile.settingsPath, prepared.base.authStorage);
const mastra = new Mastra({ ...prepared.mastraArgs, gateways }); await prepared.finalize();
const base = { ...prepared.base, mastra }, providers = [firstProvider], sessions: NativeSession[] = [], outputs: Promise<unknown>[] = [];
const agent = base.codeAgent, stream = agent.stream.bind(agent);
mock.method(agent, 'stream', (...args: Parameters<typeof stream>) => {
  const result = stream(...args), output = Promise.resolve(result).then(value => value.getFullOutput());
  outputs.push(output); void output.catch(() => {}); return result;
});
async function joinOutputs() { let joined = -1; while (joined !== outputs.length) { joined = outputs.length; await Promise.allSettled(outputs.slice()); } }
async function settle(session: NativeSession) {
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  if (memory && 'settled' in memory && typeof memory.settled === 'function') await memory.settled();
}
function inactive() {
  for (const provider of providers) {
    assert.equal(provider.isConnected, false); assert.equal(provider.starts, 0); assert.equal(provider.polls, 0); assert.equal(provider.notifications, 0);
  }
}
interface Result { marker: string; label: string; threadId: string; resourceId: string; backgroundTaskId: string | null }
const rows = async (): Promise<Result[]> => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Result);
async function use(session: NativeSession, label: string, marker: string) {
  await session.sendMessage({ content: `TOOLS_PROBE:${label}` }); await joinOutputs(); await settle(session);
  const result = (await rows()).find(row => row.label === label); assert.ok(result);
  assert.equal(result.marker, marker); assert.equal(result.threadId, session.thread.getId()); assert.equal(result.resourceId, session.identity.getResourceId());
  assert.equal(result.backgroundTaskId, null);
  inactive(); return result;
}
let completed = false;
try {
  inactive();
  for (const name of ['one', 'two']) {
    const session = await base.controller.createSession({ resourceId: `resource-tools-${name}`, threadId: `thread-tools-${name}`, tags: { projectPath: project } });
    sessions.push(session); await session.thread.rename({ title: name, pin: true });
  }
  const initial = await Promise.all(sessions.map((session, index) => use(session, `before-${index === 0 ? 'one' : 'two'}`, 'v1')));
  await writeEntry('v2-reloaded'); await manager.reload();
  const nextProvider = manager.getPluginSignalProviders()[0]!.value as WakeProvider;
  assert.notEqual(nextProvider, firstProvider); providers.push(nextProvider);
  inactive();
  const updated = await Promise.all(sessions.map((session, index) => use(session, `after-${index === 0 ? 'one' : 'two'}`, 'v2-reloaded')));
  const notifications = await base.storage.getStore('notifications'); assert.ok(notifications);
  for (const session of sessions) assert.equal((await notifications.listNotifications({ threadId: session.thread.requireId() })).length, 0);
  process.stdout.write(`PLUGIN_TOOLS_ONLY ${JSON.stringify({ initial, updated, providerStarts: providers.map(provider => provider.starts),
    providerPolls: providers.map(provider => provider.polls), notifications: providers.map(provider => provider.notifications) })}\n`);
  completed = true;
} finally {
  base.stopPluginSignalProviders(); base.threadScheduler.stop(); await base.stopNotificationDispatch();
  await joinOutputs(); await mastra.backgroundTaskManager?.shutdown(); await joinOutputs();
  for (const plugin of manager.getLoadedPlugins()) await manager.setEnabled(plugin.id, plugin.scope, false);
  for (const session of sessions) { await settle(session); await base.controller.deleteSession({ resourceId: session.identity.getResourceId() }); }
  mock.restoreAll(); await mastra.shutdown(); await base.storageMaintenance.closeStorage?.(); await model.close(); globalThis.fetch = realFetch;
}
assert.equal(completed, true);
process.stdout.write('PLUGIN_TOOLS_ONLY_PROOF_COMPLETE\n');
// Explicit process collection after supported cleanup is not a universal drain.
process.exit(0);
