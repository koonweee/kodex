import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyChildSessionPolicy } from '../src/child-policy.js';
import { createChildTools } from '../src/child-tools.js';
import { readChildRelation } from '../src/child-relation.js';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
const nestedTools = ['delegate_child', 'message_child', 'subagent', 'create-workflow', 'run-workflow', 'create_thread'];

// Public Session policy and native provider requests are the behavior under test.
// Producer passthrough observation is strictly fixture cleanup before storage close.
test('reapplying child policy restores reopened native sessions without changing parent policy or retained history', { timeout: 40_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-child-policy-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const fixture = await startModelFixture(request => {
    const child = lastUserText(request).includes('CHILD_POLICY');
    const names = request.tools?.map(tool => tool.function.name) ?? [];
    const view = request.tools?.find(tool => tool.function.name === 'view'); assert.ok(view);
    if (child) {
      assert.ok(nestedTools.every(name => !names.includes(name)), 'native provider tools exclude denied nested operations');
      assert.equal(JSON.stringify(view.function.parameters).includes('_background'), false, 'native provider tool schema disables background tasks for this child');
    } else {
      assert.ok(names.includes('delegate_child') && names.includes('message_child') && names.includes('subagent'), 'ordinary native sessions retain delegation tools');
      assert.equal(JSON.stringify(view.function.parameters).includes('_background'), true, 'ordinary native sessions remain background-enabled');
    }
    return { text: child ? 'CHILD_POLICY_RESULT' : 'ORDINARY_POLICY_RESULT' };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    preferences: { yolo: true }, backgroundTools: { enabled: true }, lsp: false, observability: { enabled: false },
  }));
  let runtime!: ProjectRuntime;
  const sessions = new Set<NativeSession>(), producers = new Map<string, ReturnType<typeof deferred>>();
  t.after(async () => {
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    await settled(); await runtime?.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true });
  });
  runtime = await createProjectRuntime({ profile, projectPath, runtimeRoot: join(root, 'runtime'), disableMcp: true,
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }],
    extraTools: createChildTools({ getRuntime: () => runtime }) });
  runtime.controller.onSessionCreated(session => { sessions.add(session); });
  const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
  const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
  t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
    const result = register(...args);
    if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], deferred());
    return result;
  });
  t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
    unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.resolve();
  });
  async function settled() {
    let joined = -1;
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(done => done.promise)); }
  }
  async function run(session: NativeSession, text: string) {
    await session.sendMessage({ content: text }); await settled();
    const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
    if (memory && 'settled' in memory && typeof memory.settled === 'function') await memory.settled();
  }
  const parent = await runtime.createSession({ resourceId: 'parent-resource', threadId: 'parent-thread' });
  const peer = await runtime.createSession({ resourceId: 'peer-resource', threadId: 'peer-thread' });
  const target = { resourceId: 'child-resource', threadId: 'child-thread' };
  const tags = { kodexChild: '1', parentThreadId: 'parent-thread', parentResourceId: 'parent-resource', parentSessionScope: '', parentTaskId: 'policy-task' };
  const child = await runtime.createSession({ ...target, tags });
  for (const [session, title] of [[parent, 'Policy parent'], [peer, 'Policy peer'], [child, 'Policy child']] as const) await session.thread.rename({ title, pin: true });
  const parentMachinery = parent.machinery, peerMachinery = peer.machinery, baseline = child.machinery;
  assert.equal(child.resolveToolApproval('delegate_child'), 'allow');
  await applyChildSessionPolicy(child);
  for (const toolName of nestedTools) assert.equal(child.resolveToolApproval(toolName), 'deny', toolName);
  assert.equal((await child.machinery.buildStreamOptions({})).disableBackgroundTasks, true);
  assert.equal(child.machinery.buildSharedRunOptions().disableBackgroundTasks, true);
  const installed = child.machinery;
  await Promise.all([applyChildSessionPolicy(child), applyChildSessionPolicy(child)]);
  assert.equal(child.machinery, installed, 'repeat application keeps the installed machinery rather than stacking wrappers');
  await child.permissions.setForTool({ toolName: 'delegate_child', policy: 'allow' });
  await applyChildSessionPolicy(child);
  assert.equal(child.resolveToolApproval('delegate_child'), 'deny', 'explicit reapplication restores edited deny rules');
  // The SDK can replace public machinery. Reapplication wraps the new baseline,
  // rather than a remembered Session flag incorrectly treating it as configured.
  child.setMachinery(baseline);
  await applyChildSessionPolicy(child);
  assert.equal((await child.machinery.buildStreamOptions({})).disableBackgroundTasks, true);
  assert.equal(child.machinery.buildSharedRunOptions().disableBackgroundTasks, true);
  assert.equal(parent.machinery, parentMachinery); assert.equal(peer.machinery, peerMachinery);
  assert.deepEqual(parent.permissions.getRules(), { tools: {}, categories: {} });
  assert.deepEqual(peer.permissions.getRules(), { tools: {}, categories: {} });
  await run(child, 'CHILD_POLICY_INITIAL');
  const before = (await runtime.controller.queryThreadMessages({ ...target, perPage: false })).messages;
  assert.ok(JSON.stringify(before).includes('CHILD_POLICY_RESULT'));
  await runtime.releaseSession({ resourceId: target.resourceId });
  assert.equal(child.thread.getId(), null); assert.equal(await runtime.controller.getSessionByResource(target.resourceId), undefined);
  const reopened = await runtime.createSession(target); assert.notEqual(reopened, child);
  assert.deepEqual(reopened.permissions.getRules(), { tools: {}, categories: {} });
  assert.equal(reopened.resolveToolApproval('delegate_child'), 'allow');
  assert.equal((await reopened.machinery.buildStreamOptions({})).disableBackgroundTasks, undefined);
  assert.equal(reopened.machinery.buildSharedRunOptions().disableBackgroundTasks, undefined);
  await applyChildSessionPolicy(reopened);
  for (const toolName of nestedTools) assert.equal(reopened.resolveToolApproval(toolName), 'deny');
  assert.deepEqual((await runtime.controller.queryThreadMessages({ ...target, perPage: false })).messages, before, 'policy reapplication does not rewrite native history');
  assert.deepEqual(readChildRelation((await runtime.controller.queryThreadById({ threadId: target.threadId }))?.metadata), { parentThreadId: 'parent-thread', parentResourceId: 'parent-resource', parentSessionScope: '', parentTaskId: 'policy-task' });
  await run(reopened, 'CHILD_POLICY_REOPEN');
  await run(parent, 'PARENT_POLICY_UNCHANGED'); await run(peer, 'PEER_POLICY_UNCHANGED');
  assert.equal(fixture.requests.length, 4); assert.ok(producers.size > 0, 'cleanup observes and joins actual native producers');
});
