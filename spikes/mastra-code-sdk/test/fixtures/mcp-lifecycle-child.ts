import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { McpManager } from '@mastra/code-sdk/mcp/manager';
import type { RequestContext } from '@mastra/core/request-context';
import { activateProfile, resolveProfile } from '../../src/profile.js';
import { createProjectRuntime } from '../../src/runtime.js';

const [mode, root] = process.argv.slice(2) as [string, string];
const emit = (event: string, details: Record<string, unknown> = {}) => process.stdout.write(`${JSON.stringify({ at: Date.now(), event, ...details })}\n`);
const profile = activateProfile(resolveProfile(join(root, 'profile')));
await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false }, models: { observerModelOverride: null, reflectorModelOverride: null, goalJudgeModel: null } }));
const projectPath = join(root, 'project');
await mkdir(join(projectPath, '.kodex-mastra-spike'), { recursive: true });
const discovery = mode.includes('discovery');
const silent = mode.includes('silent') || mode.includes('during-');
const server = mode === 'missing' ? { command: join(root, 'missing-executable') } : {
  command: process.execPath,
  args: ['--import', 'tsx', fileURLToPath(new URL('./mcp-lifecycle-server.ts', import.meta.url)), silent ? discovery ? 'silent-discovery' : 'silent-initialize' : 'responsive', join(root, 'server-trace.jsonl')],
};
await writeFile(join(projectPath, '.kodex-mastra-spike', 'mcp.json'), JSON.stringify({ mcpServers: { lifecycle: server } }));
const runtime = mode.startsWith('runtime-')
  ? await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'), disableMcp: false, subagents: [] })
  : undefined;
const { createMcpManager } = await import('@mastra/code-sdk/mcp/manager');
const manager: McpManager = runtime?.mcpManager ?? createMcpManager(projectPath, '.kodex-mastra-spike');
let initSettled = false;
emit('init-start');
const initialization = manager.initInBackground().then(result => { initSettled = true; emit('init-settled', { result }); return result; });

if (mode.includes('during-')) {
  // Finite fixture-only observation: wait for the actual silent initialize RPC,
  // rather than racing disconnect against import/spawn scheduling.
  let observed = false;
  for (let attempt = 0; attempt < 400 && !observed; attempt++) {
    const trace = await readFile(join(root, 'server-trace.jsonl'), 'utf8').catch(() => '');
    observed = trace.includes(discovery ? '"method":"server/discover"' : '"method":"initialize"');
    if (!observed) await delay(10);
  }
  assert.equal(observed, true, 'native stdio handshake reached the silent fixture');
  emit('init-pending', { initSettled, statuses: manager.getServerStatuses() });
  assert.equal(initSettled, false);
  emit('disconnect-start', { runtime: Boolean(runtime) });
  if (runtime) await runtime.dispose(); else await manager.disconnect();
  emit('disconnect-settled', { statuses: manager.getServerStatuses(), resources: process.getActiveResourcesInfo() });
  if (mode.endsWith('-exit')) {
    // One explicit characterization of the native CLI's whole-process shutdown.
    // Other cases return naturally or leave the old init pending for observation.
    emit('entrypoint-exit');
    process.exit(0);
  }
  await initialization;
} else {
  const result = await initialization;
  if (!silent && mode !== 'missing') {
    assert.equal(result.connected.length, 1); assert.equal(result.totalTools, 1);
    const tool = manager.getTools().lifecycle_probe_lifecycle;
    assert.ok(tool && typeof tool.execute === 'function');
    const { RequestContext: NativeRequestContext } = await import('@mastra/core/request-context');
    const execute = tool.execute as (input: Record<string, never>, context: { requestContext: RequestContext }) => Promise<unknown>;
    const output = await execute({}, { requestContext: new NativeRequestContext() });
    assert.deepEqual(output, { content: [{ type: 'text', text: 'NATIVE_MCP_LIFECYCLE' }] });
    emit('tool-result', { output });
  }
  if (mode === 'missing') {
    assert.equal(result.connected.length, 0); assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0]?.connected, false); assert.ok(result.failed[0]?.error);
    assert.deepEqual(manager.getTools(), {});
  }
  emit('disconnect-start', { runtime: Boolean(runtime) });
  if (runtime) await runtime.dispose(); else await manager.disconnect();
  emit('disconnect-settled', { statuses: manager.getServerStatuses(), resources: process.getActiveResourcesInfo() });
}
emit('finished', { resources: process.getActiveResourcesInfo() });
// Deliberately return naturally. The parent watchdog characterizes any leaked
// handles and kills only this fixture's independently owned process group.
