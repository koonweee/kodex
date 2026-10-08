import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureChatFastRequestContext } from '../src/chat-fast.js';
import { readChatHistory } from '../src/chat-history.js';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createProjectRuntime, type NativeSession, type ProjectRuntime } from '../src/runtime.js';
import { lastUserText, startModelFixture, type FixtureRequest } from './fixtures/model-server.js';

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const text = 'Inspect this image <pixel> & preserve the text.';
const clientId = 'attachment-client-correlation';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function imageUrls(request: FixtureRequest) {
  return request.messages.flatMap(message => Array.isArray(message.content) ? message.content.flatMap(part => {
    if (typeof part !== 'object' || !part || part.type !== 'image_url') return [];
    return [part.image_url?.url];
  }) : []);
}

test('native input image bytes, raw text and correlation persist and replay after a dormant restart', { timeout: 40_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-native-attachment-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const fixture = await startModelFixture(request => ({ text: `RECEIVED:${lastUserText(request)}` }));
  const projectPath = join(root, 'project'); await mkdir(projectPath);
  const imagePath = join(projectPath, 'pixel.png'); await writeFile(imagePath, Buffer.from(pngBase64, 'base64'));
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { observerModelOverride: null, reflectorModelOverride: null },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
    preferences: { yolo: true }, lsp: false, observability: { enabled: false },
  }));
  const options = { profile, projectPath, runtimeRoot: join(root, 'runtime'), disableMcp: true, subagents: [],
    modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] };
  const producers = new Map<string, ReturnType<typeof deferred>>();
  const sessions = new Set<NativeSession>();
  let runtime: ProjectRuntime;
  async function open() {
    runtime = await createProjectRuntime(options);
    runtime.controller.onSessionCreated(session => { sessions.add(session); });
    const register = runtime.mastra.__registerInternalWorkflow.bind(runtime.mastra);
    const unregister = runtime.mastra.__unregisterInternalWorkflow.bind(runtime.mastra);
    // Test-only passthrough producer observation joins native persistence before closing storage.
    t.mock.method(runtime.mastra, '__registerInternalWorkflow', (...args: Parameters<typeof register>) => {
      const result = register(...args);
      if (args[0].id === 'agentic-loop' && args[1]) producers.set(args[1], deferred());
      return result;
    });
    t.mock.method(runtime.mastra, '__unregisterInternalWorkflow', (id: string, runId: string) => {
      unregister(id, runId); if (id === 'agentic-loop') producers.get(runId)?.resolve();
    });
  }
  async function settled() {
    let joined = -1;
    while (joined !== producers.size) { joined = producers.size; await Promise.all([...producers.values()].map(done => done.promise)); }
  }
  t.after(async () => {
    for (const session of sessions) {
      const threadId = session.thread.getId();
      if (threadId) session.machinery.getAgent().abortThreadStream({ threadId, resourceId: session.identity.getResourceId(), clearPendingSignals: true });
      session.abort();
    }
    await settled(); await runtime?.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true });
  });
  await open();
  const target = { threadId: 'image-chat', resourceId: 'image-resource' };
  const session = await runtime!.createSession(target);
  await session.thread.rename({ title: 'Input image proof', pin: true });
  const bytes = await readFile(imagePath);
  await rm(imagePath);
  const ended = deferred();
  const off = session.subscribe(event => { if (event.type === 'agent_end') ended.resolve(); }); t.after(off);
  const signal = session.sendSignal({ type: 'user', contents: [
    { type: 'text', text }, { type: 'file', data: bytes, mediaType: 'image/png', filename: 'pixel.png' },
  ], metadata: { clientId } }, { requireDelivery: true, requestContext: await captureChatFastRequestContext(session), untilIdle: false });
  assert.equal((await signal.accepted).action, 'wake');
  await ended.promise; await settled();
  const request = fixture.requests.find(request => lastUserText(request).includes(text)); assert.ok(request);
  const sentText = request.messages.findLast(message => message.role === 'user')?.content;
  assert.ok(Array.isArray(sentText));
  assert.deepEqual(sentText.filter(part => part.type === 'text'), [{ type: 'text', text }], 'raw text reaches the provider unchanged');
  assert.deepEqual(imageUrls(request), [`data:image/png;base64,${pngBase64}`], 'native provider receives image bytes as an image, not a path or text placeholder');
  assert.equal(JSON.stringify(request.messages).includes(clientId), false);
  const saved = await readChatHistory(runtime!.controller, target);
  const user = saved.messages.find(message => message.id === signal.id); assert.ok(user);
  assert.equal(user.role, 'signal');
  assert.deepEqual(user.content.parts.filter(part => part.type === 'text').map(part => ({ type: part.type, text: part.text })), [{ type: 'text', text }]);
  const file = user.content.parts.find(part => part.type === 'file');
  assert.ok(file && 'data' in file && 'mimeType' in file && 'filename' in file);
  assert.equal(file.data, pngBase64); assert.equal(file.mimeType, 'image/png'); assert.equal(file.filename, 'pixel.png');
  assert.deepEqual((user.content.metadata?.signal as { metadata?: unknown }).metadata, { clientId });
  assert.equal(JSON.stringify(user).includes(imagePath), false, 'saved native input has no dependency on the original file');

  await runtime!.dispose(); await open();
  let activations = 0;
  const offCreated = runtime!.controller.onSessionCreated(() => { activations++; }); t.after(offCreated);
  const requestsBefore = fixture.requests.length;
  const restored = await readChatHistory(runtime!.controller, target);
  assert.deepEqual(restored.messages.find(message => message.id === signal.id), user);
  assert.equal(activations, 0); assert.equal(fixture.requests.length, requestsBefore);
  assert.equal(await runtime!.controller.getSessionByResource(target.resourceId), undefined);

  const reopened = await runtime!.createSession(target);
  await reopened.sendMessage({ content: 'REPLAY_IMAGE_FROM_HISTORY', untilIdle: false }); await settled();
  const replay = fixture.requests.find(request => lastUserText(request) === 'REPLAY_IMAGE_FROM_HISTORY'); assert.ok(replay);
  assert.deepEqual(imageUrls(replay), [`data:image/png;base64,${pngBase64}`], 'native replay reconstructs the persisted image without the original file');
  assert.equal(JSON.stringify(replay.messages).includes(clientId), false);
  assert.equal(activations, 1, 'only explicit native reopening activates a session');
});
