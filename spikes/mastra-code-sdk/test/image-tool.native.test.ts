import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ActiveToolState } from '@mastra/core/agent-controller';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime } from '../src/runtime.js';
import { startModelFixture } from './fixtures/model-server.js';

// A valid 1x1 PNG exercises native workspace media without external image generation.
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const pngBytes = Buffer.from(pngBase64, 'base64');
const toolCallId = 'fixture-view-image';
let root: string;
let profile: SpikeProfile;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-native-image-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(request => {
    if (request.messages.some(message => message.role === 'tool')) return { text: 'Native image inspected' };
    assert.ok(request.tools?.some(tool => tool.function.name === 'view'), 'the real SDK exposes the standard workspace view tool');
    return { toolCalls: [{ name: 'view', arguments: { path: 'pixel.png' }, id: toolCallId }] };
  });
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat' },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    lsp: false, observability: { enabled: false },
  }));
});
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });

test('native workspace image view exposes tagged live media and preserves the parent tool result after restart', { timeout: 40_000 }, async t => {
  const projectPath = join(root, 'project');
  await mkdir(projectPath);
  await writeFile(join(projectPath, 'pixel.png'), pngBytes);
  const options = { profile, projectPath, runtimeRoot: join(root, 'runtime'),
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }], subagents: [] };
  let runtime = await createProjectRuntime(options);
  t.after(() => runtime.dispose());
  const target = { threadId: 'image-parent', resourceId: 'image-resource' };
  const session = await runtime.createSession(target);
  await session.thread.rename({ title: 'Image view fixture', pin: true });
  const displays: ActiveToolState[] = [];
  const off = session.subscribe(event => {
    if (event.type !== 'display_state_changed') return;
    const tool = event.displayState.activeTools.get(toolCallId);
    if (tool) displays.push(structuredClone(tool));
  });
  t.after(off);
  await session.sendMessage({ content: 'Inspect pixel.png with the workspace view tool.' });
  const memory = await session.machinery.getAgent().getMemory({ requestContext: await session.machinery.buildRequestContext() });
  assert.ok(memory && 'settled' in memory && typeof memory.settled === 'function');
  await memory.settled();
  assert.ok(displays.some(tool => tool.name === 'view' && tool.status === 'running'));
  const completed = displays.find(tool => tool.status === 'completed');
  assert.ok(completed, 'canonical display retains the completed tool result');
  const expectedMedia = { __workspaceMedia: true, text: `pixel.png (${pngBytes.length} bytes, image/png)`, mediaType: 'image/png', data: pngBase64 };
  assert.deepEqual(completed.result, expectedMedia);
  assert.notEqual(completed.isError, true);

  const readParent = async () => (await runtime.controller.queryThreadMessages({ ...target, perPage: false,
    orderBy: { field: 'createdAt', direction: 'ASC' } })).messages;
  const parentBefore = await readParent();
  const imageParts = parentBefore.flatMap(message => message.content.parts).filter(part =>
    part.type === 'tool-invocation' && part.toolInvocation.toolCallId === toolCallId && part.toolInvocation.state === 'result');
  assert.equal(imageParts.length, 1, 'the parent transcript has one native image tool invocation');
  const imagePart = imageParts[0]!;
  assert.ok(imagePart.type === 'tool-invocation');
  assert.equal(imagePart.toolInvocation.toolName, 'view');
  assert.deepEqual(imagePart.toolInvocation.result, expectedMedia);
  // Native storage also retains its model-facing media mapping; the renderer can
  // consume the tagged tool result without a Kodex image store or URL adapter.
  t.diagnostic(`Native model-facing media mapping: ${JSON.stringify(imagePart.providerMetadata?.mastra?.modelOutput)}`);
  assert.doesNotMatch(JSON.stringify(parentBefore), /\/v1\/threads\/[^"\s]+\/files\/preview|\/v1\/attachments|blob:/,
    'native media contains no legacy preview or attachment URL');
  assert.deepEqual(await readdir(projectPath), ['pixel.png'], 'view leaves no copied media asset in the project');

  await runtime.releaseSession({ resourceId: target.resourceId });
  assert.deepEqual(await readParent(), parentBefore, 'native history reload preserves the tagged image result');
  await runtime.dispose();
  await rm(join(projectPath, 'pixel.png'));
  runtime = await createProjectRuntime(options);
  let activations = 0;
  const offCreated = runtime.controller.onSessionCreated(() => { activations++; });
  t.after(offCreated);
  const requestsBefore = fixture.requests.length;
  assert.deepEqual(await readParent(), parentBefore, 'persisted image remains readable after restart and removal of the original file');
  assert.equal(activations, 0, 'read-only transcript retrieval does not activate a session');
  assert.equal(fixture.requests.length, requestsBefore, 'post-restart history never invokes the model');
});
