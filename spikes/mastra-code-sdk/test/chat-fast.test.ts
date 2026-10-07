import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createChatService, type ChatSnapshot } from '../src/chat-service.js';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { serveRouter } from '../src/server.js';
import { startResponsesFixture } from './fixtures/responses-server.js';

async function until(watch: AsyncIterator<ChatSnapshot>, predicate: (snapshot: ChatSnapshot) => boolean) {
  for (;;) { const next = await watch.next(); assert.equal(next.done, false); if (predicate(next.value!)) return next.value!; }
}
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Local Fast fixture request timeout');
}

test('two clients share native Fast metadata, preserve queue-captured pricing and reopen saved settings', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-native-fast-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const fixture = await startResponsesFixture();
  const original = { NODE_ENV: process.env.NODE_ENV, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL };
  process.env.NODE_ENV = 'test'; process.env.OPENAI_BASE_URL = fixture.url;
  const abort = new AbortController();
  let runtime: ProjectRuntime;
  let service: ReturnType<typeof createChatService> | undefined;
  let server: Awaited<ReturnType<typeof serveRouter>> | undefined;
  try {
    await mkdir(join(root, 'project'));
    await writeFile(profile.authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'fake-fixture-access', refresh: 'fake-fixture-refresh', expires: Date.now() + 3_600_000 } }));
    await writeFile(profile.settingsPath, JSON.stringify({ models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat' }, preferences: { thinkingLevel: 'medium' },
      customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }], lsp: false, observability: { enabled: false } }));
    const makeService = () => createChatService({ profile, instanceId: 'native-fast-fixture',
      projects: [{ id: 'project', name: 'Project', path: join(root, 'project'), runtimeRoot: join(root, 'runtime') }],
      runtimeFactory: async options => {
        const mounted = await createProjectRuntime({ ...options, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] });
        // Global draft settings now mount a separate standalone runtime.
        if (options.projectPath === join(root, 'project')) runtime = mounted;
        return mounted;
      },
    });
    service = makeService(); server = await serveRouter(createChatRouter(service), 0);
    const client = () => createORPCClient<RouterClient<ChatRouter>>(new RPCLink({ url: `${server!.url}/rpc` }));
    let first = client(); let second = client();
    const model = (await first.listModels({ projectId: 'project' })).find(model => model.modelName === 'gpt-5.4' && model.provider.endsWith('openai'))!;
    assert.ok(model?.hasApiKey);
    const chat = await first.createChat({ projectId: 'project', settings: { modelId: model.id } });
    const other = await second.createChat({ projectId: 'project', settings: { modelId: model.id } });
    const nativeSession = async (id: string) => {
      const row = await runtime!.controller.queryThreadById({ threadId: id });
      return (await runtime!.controller.getSessionByResource(row!.resourceId))!;
    };
    const session = await nativeSession(chat.id);
    await session.thread.rename({ title: 'Fast fixture' });
    await (await nativeSession(other.id)).thread.rename({ title: 'Fast release fixture' });
    const watch = await second.watchChat({ chatId: chat.id }, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45_000)]) });
    const before = await watch.next();
    assert.equal((before.value as ChatSnapshot).settings.fast, false);
    await first.updateChatSettings({ chatId: chat.id, patch: { fast: true } });
    await until(watch, snapshot => snapshot.settings.fast);
    await assert.rejects(second.updateChatSettings({ chatId: chat.id, patch: { fast: 'yes' } } as never), error => (error as { code: string }).code === 'BAD_REQUEST');
    await assert.rejects(second.updateDraftDefaults({ version: (await second.getDraftDefaults()).version, patch: { fast: true } }), error => (error as { code: string }).code === 'BAD_REQUEST');
    await assert.rejects(second.updateChatSettings({ chatId: chat.id, patch: { modelId: 'fixture/chat' } }), error => (error as { code: string }).code === 'BAD_REQUEST');
    assert.equal((await first.getChatSettings({ chatId: chat.id })).modelId, model.id);
    const row = await runtime!.controller.queryThreadById({ threadId: chat.id });
    assert.equal(row!.metadata!.kodexFast, true);
    assert.equal(row!.metadata!.projectPath, join(root, 'project'));
    assert.equal(row!.metadata!.modeModelId_build, model.id);
    assert.equal(row!.title, 'Fast fixture');

    await first.send({ chatId: chat.id, text: 'CONCURRENT_FAST_ACTIVE' });
    await waitFor(() => fixture.requests.length === 1);
    assert.equal((fixture.requests[0]!.body as { service_tier?: string }).service_tier, 'fast');
    await first.queue({ chatId: chat.id, text: 'QUEUED_FAST_CAPTURED' });
    await until(watch, snapshot => snapshot.display.queuedFollowUps === 1);
    await second.updateChatSettings({ chatId: chat.id, patch: { fast: false } });
    await until(watch, snapshot => !snapshot.settings.fast);
    await second.send({ chatId: other.id, text: 'CONCURRENT_FAST_RELEASE' });
    await until(watch, snapshot => !snapshot.display.isRunning && snapshot.display.queuedFollowUps === 0 && snapshot.messages.filter(message => message.role === 'assistant').length >= 2);
    const queued = fixture.requests.find(request => JSON.stringify(request.body.input.findLast(input => input.role === 'user')).includes('QUEUED_FAST_CAPTURED'))!;
    assert.ok(queued);
    assert.equal((queued.body as { service_tier?: string }).service_tier, 'fast', 'later shared metadata changes cannot reprice native queued stream options');
    await first.send({ chatId: chat.id, text: 'FAST_DISABLED' });
    await until(watch, snapshot => !snapshot.display.isRunning && snapshot.messages.filter(message => message.role === 'assistant').length >= 3);
    assert.equal((fixture.requests.at(-1)!.body as { service_tier?: string }).service_tier, undefined);
    assert.equal((fixture.requests.at(-1)!.body as { reasoning?: { effort?: string } }).reasoning?.effort, 'medium');

    await second.updateChatSettings({ chatId: chat.id, patch: { fast: true } });
    abort.abort(); await server.close(); await service.dispose();
    service = makeService(); server = await serveRouter(createChatRouter(service), 0); first = client(); second = client();
    assert.equal((await first.getChatSettings({ chatId: chat.id })).fast, true, 'native Fast metadata survives service restart');
    assert.equal((await second.openChat({ chatId: chat.id })).settings.fast, true);
    const draft = await first.createChat({ projectId: 'project', settings: { modelId: model.id, fast: true } });
    assert.equal((await second.openChat({ chatId: draft.id })).settings.fast, true);
  } finally {
    abort.abort(); await server?.close(); await fixture.close(); await service?.dispose();
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
