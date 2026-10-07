import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { startResponsesFixture } from './fixtures/responses-server.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';

// RED: without inputProcessors, the two native requests had no session-id.
test('public CodeSDK processors send per-thread affinity across concurrent chats, tools, retries and reopen', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodex-affinity-native-test-'));
  const profile = activateProfile(resolveProfile(path.join(root, 'profile')));
  const fixture = await startResponsesFixture();
  const originalEnv = { NODE_ENV: process.env.NODE_ENV, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL };
  process.env.NODE_ENV = 'test';
  process.env.OPENAI_BASE_URL = fixture.url;
  const projectPath = path.join(root, 'project');
  await mkdir(projectPath);
  await writeFile(path.join(projectPath, 'marker.txt'), 'NATIVE_AFFINITY_MARKER');
  await writeFile(profile.authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'fake-fixture-access', refresh: 'fake-fixture-refresh', expires: Date.now() + 3_600_000 } }));
  await writeFile(profile.settingsPath, JSON.stringify({ observability: { enabled: false } }));
  let runtime: ProjectRuntime | undefined;
  const mount = () => createProjectRuntime({
    projectPath, runtimeRoot: path.join(root, 'runtime'), profile,
    modes: [{ id: 'build', defaultModelId: 'openai/gpt-6.1-sol', metadata: { default: true } }],
    subagents: [],
  });
  try {
    runtime = await mount();
    const left = await runtime.createSession({ resourceId: 'left-resource', threadId: 'stable-left', tags: { projectPath } });
    const right = await runtime.createSession({ resourceId: 'right-resource', threadId: 'stable-right', tags: { projectPath } });
    await Promise.all([left.thread.rename({ title: 'Left affinity fixture' }), right.thread.rename({ title: 'Right affinity fixture' })]);
    await Promise.all([left.sendMessage({ content: 'CONCURRENT_LEFT' }), right.sendMessage({ content: 'CONCURRENT_RIGHT' })]);
    assert.equal(fixture.requests.length, 2);
    assert.deepEqual(new Set(fixture.requests.map(request => request.sessionId)), new Set(['stable-left', 'stable-right']));
    await left.sendMessage({ content: 'READ_MARKER' });
    const toolRequests = fixture.requests.slice(2);
    assert.equal(toolRequests.length, 2, 'native view tool executes a second model step');
    assert.ok(toolRequests[1]!.body.input.some(item => item.type === 'function_call_output'));
    assert.match(JSON.stringify(await left.thread.listActiveMessages()), /NATIVE_AFFINITY_MARKER/);
    await left.sendMessage({ content: 'RETRY_LEFT' });
    assert.equal(fixture.requests.length, 6, 'native transient retry sends the same thread again');
    for (const request of fixture.requests) assert.equal(request.sessionId, request.nativeThreadId, 'native routing and ChatGPT affinity agree');
    await runtime.dispose(); runtime = undefined;
    runtime = await mount();
    const reopened = await runtime.createSession({ resourceId: 'left-resource', threadId: 'stable-left', tags: { projectPath } });
    await reopened.sendMessage({ content: 'AFTER_REOPEN' });
    assert.equal(fixture.requests.at(-1)!.sessionId, 'stable-left', 'reopen retains persisted native thread affinity');
    assert.ok(fixture.requests.at(-1)!.body.input.some(item => item.type === 'function_call_output'), 'reopen loaded the completed tool history');
  } finally {
    await runtime?.dispose();
    await fixture.close();
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
