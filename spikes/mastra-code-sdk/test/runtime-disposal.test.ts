import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime } from '../src/runtime.js';

test('runtime disposal settles and deletes every native resource/scope session without explicit session IDs', { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-runtime-disposal-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  await writeFile(profile.settingsPath, JSON.stringify({ lsp: false, observability: { enabled: false } }));
  const projectPath = join(root, 'project');
  await mkdir(projectPath);
  const runtime = await createProjectRuntime({ projectPath, runtimeRoot: join(root, 'runtime'), profile });
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const identities = [
    { resourceId: 'resource-a', threadId: 'thread-a' },
    { resourceId: 'resource-b', threadId: 'thread-b' },
    { resourceId: 'resource-a', scope: 'sibling', threadId: 'thread-a-sibling' },
  ];
  const sessions = await Promise.all(identities.map(identity => runtime.createSession(identity)));
  const memories = await Promise.all(sessions.map(async session => {
    const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
    assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function', 'native memory exposes its settle boundary');
    return memory;
  }));
  const settleSpies = [...new Set(memories)].map(memory => t.mock.method(memory, 'settled'));
  const deletions = t.mock.method(runtime.controller, 'deleteSession');
  await runtime.dispose();
  const expectedKeys = identities.map(({ resourceId, scope }) => JSON.stringify([resourceId, scope ?? null])).sort();
  const deletedKeys = deletions.mock.calls.map(call => JSON.stringify([call.arguments[0].resourceId, call.arguments[0].scope ?? null])).sort();
  assert.deepEqual(deletedKeys, expectedKeys, 'every registered native resource/scope is explicitly torn down');
  assert.equal(settleSpies.reduce((count, spy) => count + spy.mock.callCount(), 0), sessions.length, 'each session reaches its native memory settle boundary before storage closes');
  for (const { resourceId, scope } of identities) assert.equal(await runtime.controller.getSessionByResource(resourceId, scope), undefined, 'disposed sessions are removed from the native registry');
});
