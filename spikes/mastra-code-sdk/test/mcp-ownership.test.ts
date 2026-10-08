import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { McpServerConfig } from '@mastra/code-sdk/mcp/types';
import type { RequestContext } from '@mastra/core/request-context';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';

const namespace = '.kodex-mastra-spike';
const fixture = fileURLToPath(new URL('./fixtures/mcp-stdio-server.ts', import.meta.url));
const server = (marker: string): McpServerConfig => ({ command: process.execPath, args: ['--import', 'tsx', fixture, marker] });

// This is a deliberate external file edit, not a claimed SDK configuration writer.
async function editConfig(path: string, markers: Record<string, string>) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.fixture-tmp`;
  await writeFile(temporaryPath, JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(markers).map(([name, marker]) => [name, server(marker)])) }));
  await rename(temporaryPath, path);
}

async function toolNames(runtime: ProjectRuntime, session: NativeSession) {
  // Resolve the mounted native agent's dynamic tools against the existing session.
  // No model turn is needed to inspect the same factory used for subsequent runs.
  const tools = await runtime.codeAgent.listTools({ requestContext: await session.machinery.buildRequestContext() });
  return Object.keys(tools).filter(name => name.includes('_probe_')).sort();
}

async function inspectMcpOwnership(root: string) {
  assert.equal(homedir(), join(root, 'synthetic-home'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false } }));
  const globalPath = join(homedir(), namespace, 'mcp.json');
  const projectA = join(root, 'project-a');
  const projectB = join(root, 'project-b');
  const projectPathA = join(projectA, namespace, 'mcp.json');
  await Promise.all([
    editConfig(globalPath, { shared: 'global', globalOnly: 'global_only' }),
    editConfig(join(homedir(), '.mastracode', 'mcp.json'), { stock: 'stock_home' }),
    editConfig(join(profile.homeDir, namespace, 'mcp.json'), { profile: 'profile_home' }),
    editConfig(join(projectA, '.mcp.json'), { shared: 'root_file' }),
    editConfig(projectPathA, { shared: 'project_a', aOnly: 'a_only' }),
    editConfig(join(projectB, namespace, 'mcp.json'), { shared: 'project_b', bOnly: 'b_only' }),
  ]);
  const runtimes: ProjectRuntime[] = [];
  const { createMcpManager } = await import('@mastra/code-sdk/mcp/manager');
  let restarted: ReturnType<typeof createMcpManager> | undefined;
  try {
    const a = await createProjectRuntime({ projectPath: projectA, runtimeRoot: join(root, 'runtime-a'), profile, disableMcp: false });
    runtimes.push(a);
    const b = await createProjectRuntime({ projectPath: projectB, runtimeRoot: join(root, 'runtime-b'), profile, disableMcp: false });
    runtimes.push(b);
    const sa = await a.createSession({ resourceId: 'mcp-resource-a', threadId: 'mcp-thread-a' });
    const sb = await b.createSession({ resourceId: 'mcp-resource-b', threadId: 'mcp-thread-b' });
    assert.ok(a.mcpManager);
    assert.ok(b.mcpManager);
    assert.ok(a.mcp && b.mcp);
    await Promise.all([a.mcp.ready, b.mcp.ready]);
    assert.equal(a.mcp.snapshot().phase, 'ready');
    assert.equal(b.mcp.snapshot().phase, 'ready');
    assert.deepEqual(await toolNames(a, sa), ['aOnly_probe_a_only', 'globalOnly_probe_global_only', 'shared_probe_project_a']);
    assert.deepEqual(await toolNames(b, sb), ['bOnly_probe_b_only', 'globalOnly_probe_global_only', 'shared_probe_project_b']);
    assert.equal(a.mcpManager.getConfigPaths().global, globalPath);
    assert.equal(a.mcpManager.getConfigPaths().project, projectPathA);
    const tools = await a.codeAgent.listTools({ requestContext: await sa.machinery.buildRequestContext() });
    const sharedTool = tools.shared_probe_project_a;
    assert.ok(sharedTool && 'execute' in sharedTool && typeof sharedTool.execute === 'function');
    const execute = sharedTool.execute as (input: Record<string, never>, context: { requestContext: RequestContext }) => Promise<unknown>;
    const result = await execute({}, { requestContext: await sa.machinery.buildRequestContext() });
    assert.deepEqual(result, { content: [{ type: 'text', text: 'project_a' }] }, 'native MCP tool executes the project winner');

    await Promise.all([
      editConfig(globalPath, { shared: 'new_global', globalFresh: 'global_fresh' }),
      editConfig(projectPathA, { shared: 'edited_a', aFresh: 'a_fresh' }),
    ]);
    assert.deepEqual(await toolNames(a, sa), ['aOnly_probe_a_only', 'globalOnly_probe_global_only', 'shared_probe_project_a'], 'external edits need an explicit native reload');
    await a.mcp.reload();
    assert.deepEqual(await toolNames(a, sa), ['aFresh_probe_a_fresh', 'globalFresh_probe_global_fresh', 'shared_probe_edited_a'], 'existing session resolves new tools and drops removed tools');
    assert.deepEqual(await toolNames(b, sb), ['bOnly_probe_b_only', 'globalOnly_probe_global_only', 'shared_probe_project_b'], 'other project controller has not reloaded yet');
    await b.mcp.reload();
    assert.deepEqual(await toolNames(b, sb), ['bOnly_probe_b_only', 'globalFresh_probe_global_fresh', 'shared_probe_project_b'], 'second controller converges after its native reload');

    const beforeToggle = await readFile(projectPathA, 'utf8');
    const status = await a.mcpManager.setServerDisabled('shared', true);
    assert.equal(status.disabled, true);
    assert.deepEqual(await toolNames(a, sa), ['aFresh_probe_a_fresh', 'globalFresh_probe_global_fresh']);
    assert.equal(await readFile(projectPathA, 'utf8'), beforeToggle, 'native enable/disable persists app state without rewriting configuration');
    await b.mcp.reload();
    assert.ok((await toolNames(b, sb)).includes('shared_probe_project_b'), 'project disable does not affect another project');
    await a.mcpManager.disconnect();
    restarted = createMcpManager(projectA, namespace);
    await restarted.init();
    assert.equal(restarted.getServerStatuses().find(status => status.name === 'shared')?.disabled, true, 'disable survives native manager recreation');
    assert.deepEqual(Object.keys(restarted.getTools()).sort(), ['aFresh_probe_a_fresh', 'globalFresh_probe_global_fresh'], 'restart reads the edited config and durable native disable state');
    await restarted.inheritServer('shared');
    assert.ok(restarted.getTools().shared_probe_edited_a, 'native inherit restores the effective configured server');
    await restarted.disconnect();
    restarted = undefined;

    // Removing the namespaced project winner falls back through the root file
    // to the same namespaced global source after each explicit reload.
    await editConfig(projectPathA, {});
    await a.mcp.reload();
    assert.ok((await toolNames(a, sa)).includes('shared_probe_root_file'));
    await rm(join(projectA, '.mcp.json'));
    await a.mcp.reload();
    assert.deepEqual(await toolNames(a, sa), ['globalFresh_probe_global_fresh', 'shared_probe_new_global']);
  } finally {
    await restarted?.disconnect();
    for (const runtime of runtimes.reverse()) await runtime.dispose();
  }
}

if (process.env.KODEX_MCP_OWNERSHIP_FIXTURE === '1') {
  await inspectMcpOwnership(process.argv[2]!);
  // Native MCP teardown can leave the fixture process alive after shutdown.
  // Exit this disposable child only after every assertion and awaited cleanup.
  if (process.env.KODEX_MCP_OWNERSHIP_DIAGNOSTICS === '1') {
    process.stderr.write(JSON.stringify(process.getActiveResourcesInfo()) + '\n');
  }
  process.exit(0);
} else {
  test('native MCP namespace, project precedence, external edits, reload and persisted disable state have predictable ownership', { timeout: 90_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-mcp-ownership-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'synthetic-home'));
    await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), root], {
      env: { ...process.env, HOME: join(root, 'synthetic-home'), KODEX_MCP_OWNERSHIP_FIXTURE: '1' },
      timeout: 80_000,
      maxBuffer: 1024 * 1024,
    });
  });
}
