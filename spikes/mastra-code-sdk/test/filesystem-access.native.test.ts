import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture } from './fixtures/model-server.js';

test('native unrestricted files work for parent, child, reopen, inline and forked agents', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-fs-access-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const projectPath = join(root, 'project');
  // SDK defaults already allow the OS temp directory. Use a disposable home
  // directory to prove access beyond both the project and native temp grants.
  const outside = await mkdtemp(join(homedir(), '.kodex-fs-access-test-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(projectPath);
  let kind = 'parent';
  const fixture = await startModelFixture(request => {
    const user = lastUserText(request);
    const messages = request.messages.slice(request.messages.findLastIndex(message => message.role === 'user'));
    assert.ok(!request.tools?.some(tool => tool.function.name === 'request_access'), 'unnecessary access prompt tool is absent');
    if (messages.some(message => message.role === 'tool')) return { text: 'IO_COMPLETE' };
    if (user === 'DELEGATE') return { toolCalls: [{ name: 'subagent', id: 'child-call', arguments: { agentType: 'execute', task: 'WRITE_OUTSIDE', modelId: 'fixture/chat', forked: kind === 'forked' } }] };
    return { toolCalls: [{ name: 'write_file', id: 'outside-write', arguments: { path: join(outside, `${kind}.txt`), content: 'outside write' } }] };
  });
  t.after(async () => { await fixture.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(profile.settingsPath, JSON.stringify({ models: { observerModelOverride: null, reflectorModelOverride: null }, customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture', models: ['chat'] }], lsp: false, observability: { enabled: false } }));
  const options = { profile, projectPath, runtimeRoot: join(root, 'runtime'), modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] };
  let runtime = await createProjectRuntime(options);
  t.after(() => runtime.dispose());
  for (kind of ['parent', 'native-child', 'reopened', 'inline', 'forked']) {
    if (kind === 'reopened') {
      const previous = await runtime.controller.getSessionByResource('parent-resource');
      await previous!.thread.setSetting({ key: 'sandboxAllowedPaths', value: [] });
      await previous!.state.set({ sandboxAllowedPaths: [] });
      await runtime.dispose();
      runtime = await createProjectRuntime(options);
    }
    const session = kind === 'native-child'
      ? await runtime.controller.createSession({ resourceId: 'child-resource', threadId: 'child-thread', scope: 'native-child' })
      : await runtime.createSession({ resourceId: 'parent-resource', threadId: 'parent-thread' });
    await session.thread.rename({ title: kind });
    let suspensions = 0;
    const off = session.subscribe(event => { if (event.type === 'tool_suspended') suspensions++; });
    await session.sendMessage({ content: kind === 'inline' || kind === 'forked' ? 'DELEGATE' : 'WRITE_OUTSIDE' });
    off();
    assert.equal(suspensions, 0);
    assert.equal(session.displayState.get().pendingSuspensions.size, 0);
    assert.equal(await readFile(join(outside, `${kind}.txt`), 'utf8'), 'outside write', kind);
    assert.equal(String(await session.getWorkspace()!.filesystem!.readFile(join(outside, `${kind}.txt`))), 'outside write');
  }
});
