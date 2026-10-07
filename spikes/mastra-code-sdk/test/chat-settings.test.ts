import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { activateProfile, resolveProfile, type SpikeProfile } from '../src/profile.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { createChatService, type ChatService, type ChatSnapshot } from '../src/chat-service.js';
import { openProductRegistry } from '../src/product-registry.js';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { serveRouter } from '../src/server.js';
import { startModelFixture, lastUserText } from './fixtures/model-server.js';

let root: string;
let profile: SpikeProfile;
let fixture: Awaited<ReturnType<typeof startModelFixture>>;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kodex-mastra-chat-settings-'));
  profile = activateProfile(resolveProfile(join(root, 'profile')));
  fixture = await startModelFixture(request => ({ text: `settings:${lastUserText(request)}` }));
  await writeFile(profile.settingsPath, JSON.stringify({
    models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat' },
    preferences: { thinkingLevel: 'medium' },
    customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat', 'second'] }],
    lsp: false, observability: { enabled: false },
  }));
});
after(async () => { await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function setup(name: string) {
  const path = join(root, name);
  await mkdir(path);
  const projects = [{ id: name, name, path, runtimeRoot: join(root, `${name}-runtime`) }];
  const runtimes: ProjectRuntime[] = [];
  const makeService = () => createChatService({ profile, projects, instanceId: 'settings-fixture', registryFactory: () => openProductRegistry(resolveProfile(join(root, `${name}-product-profile`))), runtimeFactory: async options => {
    const runtime = await createProjectRuntime({ ...options, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
    runtimes.push(runtime);
    return runtime;
  } });
  return { makeService, projects, runtimes };
}
async function serve(service: ChatService) {
  const server = await serveRouter(createChatRouter(service), 0);
  return { client: (): RouterClient<ChatRouter> => createORPCClient(new RPCLink({ url: `${server.url}/rpc` })), close: server.close };
}
async function until(iterator: AsyncIterator<ChatSnapshot>, predicate: (snapshot: ChatSnapshot) => boolean) {
  const deadline = AbortSignal.timeout(15_000);
  for (;;) {
    deadline.throwIfAborted();
    let reject!: () => void;
    const timeout = new Promise<never>((_, failed) => { reject = () => failed(new Error('Settings snapshot timeout')); });
    deadline.addEventListener('abort', reject, { once: true });
    try { const next = await Promise.race([iterator.next(), timeout]); assert.equal(next.done, false); if (predicate(next.value!)) return next.value!; }
    finally { deadline.removeEventListener('abort', reject); }
  }
}

test('two clients apply sparse native settings, observe coherent snapshots and use them on Send', { timeout: 60_000 }, async t => {
  const { makeService, projects, runtimes } = await setup('shared-settings');
  const service = makeService();
  const server = await serve(service);
  const first = server.client(); const second = server.client();
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await server.close(); await service.dispose(); });
  // Initially fails against the previous slice: this is a real missing RPC.
  const models = await first.listModels({ projectId: projects[0]!.id });
  const chosen = models.find(model => model.modelName === 'second');
  assert.ok(chosen?.hasApiKey);
  assert.ok(!JSON.stringify(models).includes('fixture-no-real-credential'));
  const chat = await first.createChat({ projectId: projects[0]!.id });
  const session = (await runtimes[0]!.controller.getSessionByResource((await runtimes[0]!.controller.queryThreadById({ threadId: chat.id }))!.resourceId))!;
  await session.thread.rename({ title: 'Settings fixture' });
  const watch = await second.watchChat({ chatId: chat.id }, { signal: abort.signal });
  await watch.next();
  await Promise.all([
    first.updateChatSettings({ chatId: chat.id, patch: { modelId: chosen.id } }),
    second.updateChatSettings({ chatId: chat.id, patch: { thinkingLevel: 'high' } }),
  ]);
  const shared = await until(watch, snapshot => snapshot.settings.modelId === chosen.id && snapshot.settings.thinkingLevel === 'high');
  const current = await first.getChatSettings({ chatId: chat.id });
  assert.equal(current.modelId, chosen.id); assert.equal(current.thinkingLevelOverride, 'high');
  assert.equal(current.epoch, shared.epoch); assert.ok(current.revision >= shared.revision);
  const row = await runtimes[0]!.controller.queryThreadById({ threadId: chat.id });
  assert.equal(row!.metadata!.modeModelId_build, chosen.id); assert.equal(row!.metadata!.thinkingLevel, 'high');
  await first.send({ chatId: chat.id, text: 'CHANGED_NATIVE_SETTINGS' });
  const request = await fixture.waitForRequest(request => lastUserText(request).includes('CHANGED_NATIVE_SETTINGS'));
  assert.equal(request.model, 'second');
  assert.equal((request as unknown as { reasoning_effort?: string }).reasoning_effort, 'high', 'actual provider body uses native saved thinking selection');
  await until(watch, snapshot => !snapshot.display.isRunning && snapshot.messages.some(message => message.role === 'assistant' && message.content.parts.some(part => part.type === 'text' && part.text.includes('settings:CHANGED_NATIVE_SETTINGS'))));
});

test('native settings persist and null clears thinking override across a service restart', { timeout: 60_000 }, async t => {
  const { makeService, projects } = await setup('reopen-settings');
  let service = makeService();
  t.after(() => service.dispose());
  const chat = await service.createChat({ projectId: projects[0]!.id });
  const chosen = (await service.listModels({ projectId: projects[0]!.id })).find(model => model.modelName === 'second')!;
  await service.updateChatSettings({ chatId: chat.id, patch: { modelId: chosen.id, thinkingLevel: 'xhigh' } });
  await service.dispose(); service = makeService();
  assert.equal((await service.getChatSettings({ chatId: chat.id })).modelId, chosen.id);
  assert.equal((await service.getChatSettings({ chatId: chat.id })).thinkingLevelOverride, 'xhigh');
  await service.updateChatSettings({ chatId: chat.id, patch: { thinkingLevel: null } });
  await service.dispose(); service = makeService();
  const reopened = await service.getChatSettings({ chatId: chat.id });
  assert.equal(reopened.modelId, chosen.id); assert.equal(reopened.thinkingLevelOverride, null); assert.equal(reopened.thinkingLevel, 'medium');
});

test('invalid settings reject without mutation and global defaults reject stale forms and survive reopening', { timeout: 60_000 }, async t => {
  const { makeService, projects } = await setup('default-settings');
  let service = makeService();
  let server = await serve(service);
  t.after(async () => { await server.close(); await service.dispose(); });
  let client = server.client();
  const chat = await client.createChat({ projectId: projects[0]!.id });
  const before = await client.getChatSettings({ chatId: chat.id });
  await assert.rejects(client.updateChatSettings({ chatId: chat.id, patch: { modelId: 'unconfigured/missing', thinkingLevel: 'high' } }), error => (error as { code: string }).code === 'BAD_REQUEST');
  await assert.rejects(client.updateChatSettings({ chatId: chat.id, patch: { thinkingLevel: 'banana' } } as never), error => (error as { code: string }).code === 'BAD_REQUEST');
  await assert.rejects(client.updateChatSettings({ chatId: chat.id, patch: { yolo: false } } as never), error => (error as { code: string }).code === 'BAD_REQUEST');
  assert.deepEqual(await client.getChatSettings({ chatId: chat.id }), before);
  const form = await client.getDraftDefaults();
  const chosen = (await client.listModels({ projectId: projects[0]!.id })).find(model => model.modelName === 'second')!;
  const updated = await client.updateDraftDefaults({ version: form.version, patch: { modelId: chosen.id } });
  assert.equal(updated.thinkingLevel, form.thinkingLevel, 'sparse model edit preserves effort');
  await assert.rejects(client.updateDraftDefaults({ version: form.version, patch: { thinkingLevel: 'low' } }), error => (error as { code: string }).code === 'CONFLICT');
  const changed = await client.updateDraftDefaults({ version: updated.version, patch: { thinkingLevel: 'low' } });
  assert.equal(changed.modelId, chosen.id);
  const created = await client.createChat({ projectId: projects[0]!.id });
  assert.equal((await client.getChatSettings({ chatId: created.id })).modelId, chosen.id, 'already mounted runtime captures freshly saved native defaults');
  assert.equal((await client.getChatSettings({ chatId: chat.id })).modelId, before.modelId, 'changing draft model defaults cannot rewrite existing native chats');
  await server.close(); await service.dispose(); service = makeService(); server = await serve(service); client = server.client();
  assert.equal((await client.getDraftDefaults()).modelId, chosen.id); assert.equal((await client.getDraftDefaults()).thinkingLevel, 'low');
  assert.equal((await client.getChatSettings({ chatId: created.id })).modelId, chosen.id);
});


test('external native settings edits during asynchronous validation fence a captured defaults form', { timeout: 60_000 }, async t => {
  const { makeService, projects, runtimes } = await setup('validation-fence');
  const service = makeService();
  t.after(() => service.dispose());
  const form = await service.getDraftDefaults();
  const model = (await service.listModels({ projectId: projects[0]!.id })).find(model => model.id !== form.modelId && model.hasApiKey)!;
  assert.ok(model);
  let started!: () => void; let release!: () => void;
  const validationStarted = new Promise<void>(resolve => { started = resolve; });
  const validationReleased = new Promise<void>(resolve => { release = resolve; });
  const controller = runtimes[0]!.controller;
  const list = controller.listAvailableModels.bind(controller);
  controller.listAvailableModels = async () => { const models = await list(); started(); await validationReleased; return models; };
  t.after(() => release());
  const pending = service.updateDraftDefaults({ version: form.version, patch: { modelId: model.id } });
  // Attach the rejection check before releasing the asynchronous validation.
  const rejected = assert.rejects(pending, error => (error as { code: string }).code === 'CONFLICT');
  await validationStarted;
  const sdk = await import('@mastra/code-sdk/onboarding/settings');
  const native = sdk.loadSettings(profile.settingsPath);
  native.models.modeThinkingDefaults.build = 'high';
  sdk.saveSettings(native, profile.settingsPath);
  release(); await rejected;
  const current = await service.getDraftDefaults();
  assert.equal(current.modelId, form.modelId, 'stale model draft cannot overwrite an intervening native edit');
  assert.equal(current.thinkingLevel, 'high');
});
