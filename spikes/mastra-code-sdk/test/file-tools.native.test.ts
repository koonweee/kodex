import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ActiveToolState } from '@mastra/core/agent-controller';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime } from '../src/runtime.js';
import { startModelFixture } from './fixtures/model-server.js';

const initial = 'export const value = 1;\nexport const extra = 3;\n';
const updated = 'export const value = 2;\nexport const extra = 3;\n';
const calls = [
  { name: 'view', arguments: { path: 'example.ts', offset: 1, limit: 1 }, id: 'file-read' },
  { name: 'string_replace_lsp', arguments: { path: 'example.ts', old_string: 'value = 1', new_string: 'value = 2' }, id: 'file-replace' },
  { name: 'view', arguments: { path: 'example.ts' }, id: 'file-read-before-noop' },
  { name: 'ast_smart_edit', arguments: { path: 'example.ts', transform: 'rename', targetName: 'MissingIdentifier', newName: 'unused' }, id: 'file-noop' },
  { name: 'view', arguments: { path: 'example.ts' }, id: 'file-read-before-missing' },
  { name: 'string_replace_lsp', arguments: { path: 'example.ts', old_string: 'ABSENT_STRING', new_string: 'unexpected' }, id: 'file-missing-string' },
  { name: 'view', arguments: { path: 'example.ts' }, id: 'file-read-before-ambiguous' },
  { name: 'string_replace_lsp', arguments: { path: 'example.ts', old_string: 'export const', new_string: 'unexpected' }, id: 'file-ambiguous-string' },
  { name: 'write_file', arguments: { path: 'notes.txt', content: 'Native write proof\n' }, id: 'file-write' },
  { name: 'delete_file', arguments: { path: 'notes.txt' }, id: 'file-delete' },
  { name: 'view', arguments: { path: 'missing.txt' }, id: 'file-read-error' },
];
let root: string;
let profile: SpikeProfile;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-native-files-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(request => {
    const index = request.messages.filter(message => message.role === 'tool').length;
    const call = calls[index];
    if (!call) return { text: 'Native file tools finished; failures and no-op retained.' };
    assert.ok(request.tools?.some(tool => tool.function.name === call.name), `the pinned native SDK exposes ${call.name}`);
    return { toolCalls: [call] };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat' },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    lsp: false, observability: { enabled: false },
  }));
});
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });

test('pinned native file tools retain string summaries, normal-return failures and no-op results through restart', { timeout: 60_000 }, async t => {
  const projectPath = join(root, 'project');
  await mkdir(projectPath);
  await writeFile(join(projectPath, 'example.ts'), initial);
  const options = { profile, projectPath, runtimeRoot: join(root, 'runtime'),
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] };
  let runtime = await createProjectRuntime(options);
  t.after(() => runtime.dispose());
  const target = { threadId: 'file-parent', resourceId: 'file-resource' };
  const session = await runtime.createSession(target);
  await session.thread.rename({ title: 'File tools fixture', pin: true });
  const live = new Map<string, ActiveToolState>();
  const running = new Set<string>();
  const off = session.subscribe(event => {
    if (event.type !== 'display_state_changed') return;
    for (const [id, tool] of event.displayState.activeTools) {
      if (tool.status === 'running') running.add(id);
      live.set(id, structuredClone(tool));
    }
  });
  t.after(off);
  await session.sendMessage({ content: 'Exercise the native file tools in order, preserving failed replacement and no-op results.' });
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function');
  await memory.settled();
  for (const call of calls) assert.ok(running.has(call.id), `${call.id} passed through native running display state`);
  assert.equal(await readFile(join(projectPath, 'example.ts'), 'utf8'), updated, 'native successful edit applied; failed replacements and AST no-op did not alter it');
  assert.deepEqual(await readdir(projectPath), ['example.ts'], 'native write and delete leave no capture store or copied assets');
  const result = (id: string) => {
    const tool = live.get(id);
    assert.ok(tool, `${id} has a live native result`);
    assert.equal(tool.status, 'completed');
    assert.notEqual(tool.isError, true);
    assert.equal(typeof tool.result, 'string');
    return tool.result as string;
  };
  assert.match(result('file-read'), /example\.ts \(lines 1-1 of 3, \d+ bytes\)/);
  assert.match(result('file-read'), /1→export const value = 1;/);
  assert.doesNotMatch(result('file-read'), /export const extra/);
  assert.match(result('file-replace'), /Replaced 1 occurrence in example\.ts/);
  assert.match(result('file-noop'), /No changes made to example\.ts/);
  assert.match(result('file-missing-string'), /not found/i);
  assert.match(result('file-ambiguous-string'), /unique|found.*2|occurs.*2/i);
  assert.equal(result('file-write'), 'Wrote 19 bytes to notes.txt');
  assert.equal(result('file-delete'), 'Deleted notes.txt');
  assert.equal(live.get('file-read-error')?.isError, true, 'a thrown native read error remains distinguishable from normal-return replacement failures');

  const readHistory = async () => (await runtime.controller.queryThreadMessages({ ...target, perPage: false,
    orderBy: { field: 'createdAt', direction: 'ASC' } })).messages;
  const before = await readHistory();
  for (const call of calls) {
    const parts = before.flatMap(message => message.content.parts).filter(part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === call.id);
    assert.equal(parts.length, 1, `${call.id} has one persisted invocation`);
    const part = parts[0]!;
    assert.ok(part.type === 'tool-invocation');
    assert.equal(part.toolInvocation.toolName, call.name);
    assert.deepEqual(part.toolInvocation.args, call.arguments);
    if (call.id !== 'file-read-error') assert.equal(part.toolInvocation.result, live.get(call.id)?.result, 'saved history retains the full native string without rewriting it');
  }
  await runtime.releaseSession({ resourceId: target.resourceId });
  assert.deepEqual(await readHistory(), before);
  await runtime.dispose();
  await rm(join(projectPath, 'example.ts'));
  runtime = await createProjectRuntime(options);
  let activations = 0;
  const offCreated = runtime.controller.onSessionCreated(() => { activations++; });
  t.after(offCreated);
  const requestsBefore = fixture.requests.length;
  assert.deepEqual(await readHistory(), before, 'restart preserves native results without reading current filesystem contents');
  assert.equal(activations, 0, 'read-only persisted history does not activate the session');
  assert.equal(fixture.requests.length, requestsBefore, 'restart history retrieval does not invoke the model');
});
