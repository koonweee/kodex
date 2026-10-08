import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { RequestContext } from '@mastra/core/request-context';
import { createChatRouter } from '../src/chat-router.js';
import { createChatService, type ChatService } from '../src/chat-service.js';
import { createMcpRouter } from '../src/mcp-router.js';
import { createMcpService } from '../src/mcp-service.js';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { openProductRegistry } from '../src/product-registry.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { serveRouter } from '../src/server.js';

const makeRouter = (service: ChatService) => ({ ...createChatRouter(service), ...createMcpRouter(service.mcp) });
type Client = RouterClient<ReturnType<typeof makeRouter>>;
type Rows = Awaited<ReturnType<Client['nativeMcpList']>>;
type Watched = { epoch: string; revision: number; rows: Rows };
const namespace = '.kodex-mastra-spike';
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
async function editConfig(path: string, markers: Record<string, string>) {
  await mkdir(dirname(path), { recursive: true });
  const servers = Object.fromEntries(Object.entries(markers).map(([name, marker]) => [name, {
    command: process.execPath, args: ['--import', 'tsx', fileURLToPath(new URL('./fixtures/mcp-stdio-server.ts', import.meta.url)), marker],
  }]));
  const temporary = `${path}.fixture-tmp`;
  await writeFile(temporary, JSON.stringify({ mcpServers: servers })); await rename(temporary, path);
}
function binding(rows: Rows, bindingId: string) { const row = rows.find(value => value.bindingId === bindingId); assert.ok(row); return row; }
function names(row: Rows[number]) { return row.servers.flatMap(server => server.toolNames).sort(); }
async function until(iterator: AsyncIterator<Watched>, predicate: (snapshot: Watched) => boolean) {
  for (;;) {
    const next = await iterator.next(); assert.equal(next.done, false);
    process.stdout.write(`MCP snapshot: ${JSON.stringify({ revision: next.value.revision, rows: next.value.rows.map(row => ({ bindingId: row.bindingId, projectId: row.projectId, cwd: row.cwd, phase: row.phase, tools: names(row) })) })}\n`);
    if (predicate(next.value)) return next.value;
  }
}
async function execute(runtime: ProjectRuntime, name: string, marker: string) {
  const tools = runtime.mcpManager?.getTools(); assert.ok(tools);
  const tool = tools[name]; assert.ok(tool && typeof tool.execute === 'function');
  const { RequestContext: NativeRequestContext } = await import('@mastra/core/request-context');
  const run = tool.execute as (input: Record<string, never>, context: { requestContext: RequestContext }) => Promise<unknown>;
  assert.deepEqual(await run({}, { requestContext: new NativeRequestContext() }), { content: [{ type: 'text', text: marker }] });
}

async function nativeServiceProof(root: string) {
  const report = (step: string) => process.stdout.write(`MCP proof: ${step}\n`);
  assert.equal(homedir(), join(root, 'synthetic-home'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false }, models: { observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: null } }));
  const oldA = join(root, 'project-a'), nextA = join(root, 'project-a-next'), cwdB = join(root, 'project-b');
  const global = join(homedir(), namespace, 'mcp.json');
  const config = (cwd: string) => join(cwd, namespace, 'mcp.json');
  await Promise.all([
    editConfig(global, { common: 'global_initial' }),
    editConfig(config(oldA), { shared: 'a_initial', removed: 'a_removed' }),
    editConfig(config(nextA), { shared: 'a_next' }),
    editConfig(config(cwdB), { shared: 'b_initial' }),
  ]);
  const registryProfile = resolveProfile(join(root, 'product'));
  const runtimes: ProjectRuntime[] = []; let sessionCreations = 0;
  const make = () => createChatService({ profile, instanceId: 'mcp-service-proof', directoryHome: root,
    projects: [{ id: 'a', name: 'A', path: oldA, runtimeRoot: join(root, 'runtime-a') }, { id: 'b', name: 'B', path: cwdB, runtimeRoot: join(root, 'runtime-b') }],
    registryFactory: () => openProductRegistry(registryProfile, { standaloneCwd: root }),
    runtimeFactory: async options => {
      const runtime = await createProjectRuntime({ ...options, disableMcp: false, subagents: [] });
      runtime.controller.onSessionCreated(() => { sessionCreations++; }); runtimes.push(runtime); return runtime;
    },
  });
  let service = make(), server = await serveRouter(makeRouter(service), 0);
  const client = (): Client => createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
  const watching = new AbortController();
  try {
    const first = client(), second = client();
    const peers = await Promise.all([first, second].map(peer => peer.nativeMcpWatch(undefined, { signal: watching.signal })));
    report('initial watch');
    const initial = await Promise.all(peers.map(peer => until(peer, snapshot => snapshot.rows.length === 2 && snapshot.rows.every(row => row.phase === 'ready' && row.servers.every(status => status.connected)))));
    report('initial ready');
    assert.deepEqual(initial[0]!.rows, initial[1]!.rows, 'two HTTP subscriptions converge through native inventory');
    const a = initial[0]!.rows.find(row => row.projectId === 'a')!, b = initial[0]!.rows.find(row => row.projectId === 'b')!;
    assert.ok(a && b); assert.notEqual(a.bindingId, b.bindingId);
    assert.equal(a.cwd, oldA); assert.equal(a.paths?.project, config(oldA)); assert.equal(a.paths?.global, global);
    assert.deepEqual(names(a), ['common_probe_global_initial', 'removed_probe_a_removed', 'shared_probe_a_initial']);
    assert.deepEqual(names(b), ['common_probe_global_initial', 'shared_probe_b_initial']);
    assert.equal(sessionCreations, 0, 'native MCP inventory/background setup mounts no chat Session');
    const runtimeA = runtimes.find(runtime => runtime.projectPath === oldA)!, runtimeB = runtimes.find(runtime => runtime.projectPath === cwdB)!;
    await execute(runtimeA, 'shared_probe_a_initial', 'a_initial');
    await Promise.all([editConfig(global, { common: 'global_edited' }), editConfig(config(oldA), { shared: 'a_edited' })]);
    assert.deepEqual(names(binding(await second.nativeMcpList(), a.bindingId)), names(a), 'file edits alone do not rebuild native tools');
    assert.deepEqual(await first.nativeMcpReload({ bindingId: a.bindingId }), [{ bindingId: a.bindingId, error: null }]);
    report('targeted reload acknowledged');
    const targeted = await Promise.all(peers.map(peer => until(peer, snapshot => names(binding(snapshot.rows, a.bindingId)).join(',') === 'common_probe_global_edited,shared_probe_a_edited')));
    for (let index = 0; index < targeted.length; index++) {
      assert.ok(targeted[index]!.revision > initial[index]!.revision);
      assert.deepEqual(names(binding(targeted[index]!.rows, b.bindingId)), names(b), 'targeted reload leaves another retained manager unchanged');
    }
    await execute(runtimeA, 'shared_probe_a_edited', 'a_edited'); await execute(runtimeB, 'common_probe_global_initial', 'global_initial');
    report('targeted converged');
    const globallyReloaded = await second.nativeMcpReload({});
    assert.deepEqual(new Set(globallyReloaded.map(row => row.bindingId)), new Set([a.bindingId, b.bindingId]));
    assert.ok(globallyReloaded.every(row => row.error === null));
    const globalPeers = await Promise.all(peers.map(peer => until(peer, snapshot => names(binding(snapshot.rows, b.bindingId)).includes('common_probe_global_edited'))));
    assert.deepEqual(globalPeers[0]!.rows, globalPeers[1]!.rows);
    await execute(runtimeB, 'common_probe_global_edited', 'global_edited');

    report('global converged');
    await first.updateProject({ projectId: 'a', patch: { name: 'Renamed A', roots: [nextA] } });
    await second.listModels({ projectId: 'a' }); // Admits the new execution binding without creating a chat.
    report('new binding created');
    const moved = await Promise.all(peers.map(peer => until(peer, snapshot => snapshot.rows.length === 3 && snapshot.rows.some(row => row.cwd === nextA && row.phase === 'ready' && names(row).includes('shared_probe_a_next')))));
    const next = moved[0]!.rows.find(row => row.cwd === nextA)!;
    assert.notEqual(next.bindingId, a.bindingId); assert.equal(next.projectId, 'a');
    for (const snapshot of moved) {
      const retained = binding(snapshot.rows, a.bindingId);
      assert.equal(retained.cwd, oldA); assert.equal(retained.projectId, 'a'); assert.equal(retained.projectName, 'Renamed A');
      assert.equal(retained.paths?.project, config(oldA)); assert.deepEqual(names(retained), names(binding(targeted[0]!.rows, a.bindingId)));
    }
    assert.equal(runtimes.find(runtime => runtime.projectPath === oldA), runtimeA, 'root edits retain the old native manager/cwd');
    report('root change converged');
    await first.deleteProject({ projectId: 'a' });
    const detached = await Promise.all(peers.map(peer => until(peer, snapshot => snapshot.rows.filter(row => [a.bindingId, next.bindingId].includes(row.bindingId)).every(row => row.projectId === null && row.projectName === null))));
    for (const snapshot of detached) {
      assert.equal(binding(snapshot.rows, a.bindingId).cwd, oldA); assert.equal(binding(snapshot.rows, next.bindingId).cwd, nextA);
      assert.equal(binding(snapshot.rows, b.bindingId).projectId, 'b');
    }
    await assert.rejects(second.nativeMcpReload({ bindingId: 'not-a-binding' }), { code: 'NOT_FOUND' });
    report('delete converged');
    watching.abort(); await Promise.all(peers.map(peer => peer.return().catch(() => undefined)));
    report('watches closed');
    await server.close(); await service.dispose();
    report('old service disposed');
    await Promise.all([editConfig(global, { common: 'global_restart' }), editConfig(config(oldA), { shared: 'a_restart' }), editConfig(config(nextA), { shared: 'next_restart' }), editConfig(config(cwdB), { shared: 'b_restart' })]);
    service = make(); server = await serveRouter(makeRouter(service), 0);
    const restartAbort = new AbortController();
    try {
      const restartedWatch = await client().nativeMcpWatch(undefined, { signal: restartAbort.signal });
      report('restart watch');
      const restarted = await until(restartedWatch, snapshot => snapshot.rows.length === 3 && snapshot.rows.every(row => row.phase === 'ready' && row.servers.every(status => status.connected)));
      report('restart ready');
      assert.deepEqual(new Set(restarted.rows.map(row => row.bindingId)), new Set([a.bindingId, b.bindingId, next.bindingId]));
      for (const [id, cwd, marker] of [[a.bindingId, oldA, 'a_restart'], [next.bindingId, nextA, 'next_restart'], [b.bindingId, cwdB, 'b_restart']] as const) {
        const row = binding(restarted.rows, id); assert.equal(row.cwd, cwd);
        assert.deepEqual(names(row), ['common_probe_global_restart', `shared_probe_${marker}`]);
        assert.equal(row.projectId, id === b.bindingId ? 'b' : null, 'deleted CLI seed does not reattach old native bindings');
        await execute(runtimes.filter(runtime => runtime.projectPath === cwd).at(-1)!, `shared_probe_${marker}`, marker);
      }
      assert.equal(sessionCreations, 0, 'inventory, reload, root edits and recreation never mount chat Sessions');
      restartAbort.abort(); await restartedWatch.return().catch(() => undefined);
    } finally { restartAbort.abort(); }
  } finally { report('final cleanup'); watching.abort(); await server.close(); await service.dispose(); report('complete'); }
}

if (process.env.KODEX_MCP_SERVICE_FIXTURE === '1') {
  await nativeServiceProof(process.argv[2]!);
  // Match the accepted native CLI/backend entrypoint shutdown after assertions
  // and awaited cleanup. This is not a native producer-join proof; the parent
  // still owns watchdog cleanup for this disposable process group.
  process.exit(0);
} else {
  test('two HTTP clients observe actual native MCP reloads, retained binding identity and edited-file recreation', { timeout: 50_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kodex-mcp-service-'))); await mkdir(join(root, 'synthetic-home'));
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), root], {
      env: { ...process.env, HOME: join(root, 'synthetic-home'), KODEX_MCP_SERVICE_FIXTURE: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    const killOwnGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    const watchdog = setTimeout(() => { timedOut = true; killOwnGroup(); }, 40_000);
    t.after(async () => { clearTimeout(watchdog); killOwnGroup(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    assert.equal(timedOut, false, `${stdout}\n${stderr}`); assert.equal(exit.code, 0, `${stdout}\n${stderr}`);
  });

  test('closing HTTP transport abandons a held reload response while the retained operation continues', { timeout: 5_000 }, async t => {
    const entered = gate(), release = gate(), completed = gate();
    let nativeFinished = false;
    const lifetime = new AbortController();
    const service = createMcpService({ assertActive() {}, signal: lifetime.signal, sources: async () => [{ bindingId: 'held', projectId: null, projectName: null, cwd: '/fixture', mcp: {
      snapshot: () => ({ phase: 'ready' as const, servers: [], skipped: [], paths: { project: '/fixture/mcp.json', global: '/fixture/global.json', claude: '/fixture/claude.json' } }),
      async reload() { entered.release(); await release.promise; nativeFinished = true; completed.release(); },
    } }] });
    const server = await serveRouter(createMcpRouter(service), 0);
    t.after(async () => { release.release(); lifetime.abort(); await server.close(); });
    const peer: RouterClient<ReturnType<typeof createMcpRouter>> = createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
    const request = peer.nativeMcpReload({ bindingId: 'held' }); void request.catch(() => {});
    await entered.promise; await server.close();
    assert.equal(nativeFinished, false, 'closing HTTP does not cancel or join the retained native reload');
    await assert.rejects(request);
    release.release(); await completed.promise; assert.equal(nativeFinished, true);
  });
}
