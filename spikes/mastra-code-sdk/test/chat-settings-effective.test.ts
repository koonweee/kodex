import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createChatService } from '../src/chat-service.js';
import { createProjectRuntime, type ProjectRuntime } from '../src/runtime.js';
import { startResponsesFixture } from './fixtures/responses-server.js';

test('native OpenAI effective thinking clamps a retained override after switching models', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-effective-thinking-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const fixture = await startResponsesFixture();
  const original = { NODE_ENV: process.env.NODE_ENV, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL };
  process.env.NODE_ENV = 'test'; process.env.OPENAI_BASE_URL = fixture.url;
  let service: ReturnType<typeof createChatService> | undefined;
  let runtime: ProjectRuntime;
  try {
    await mkdir(join(root, 'project'));
    await writeFile(profile.authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'fake-fixture-access', refresh: 'fake-fixture-refresh', expires: Date.now() + 3_600_000 } }));
    await writeFile(profile.settingsPath, JSON.stringify({
      models: { modeDefaults: { build: 'fixture/chat' }, observerModelOverride: 'fixture/chat', reflectorModelOverride: 'fixture/chat' },
      preferences: { thinkingLevel: 'medium' },
      customProviders: [{ name: 'fixture', url: fixture.url, apiKey: 'fixture-no-real-credential', models: ['chat'] }],
      lsp: false, observability: { enabled: false },
    }));
    service = createChatService({ profile, instanceId: 'effective-thinking-fixture',
      projects: [{ id: 'project', name: 'Project', path: join(root, 'project'), runtimeRoot: join(root, 'runtime') }],
      runtimeFactory: async options => { runtime = await createProjectRuntime({ ...options, modes: [{ id: 'build', defaultModelId: 'fixture/chat', metadata: { default: true } }] }); return runtime; },
    });
    const models = await service.listModels({ projectId: 'project' });
    const openai = models.find(model => model.modelName === 'gpt-5.4' && model.provider.endsWith('openai'))!;
    assert.ok(openai?.hasApiKey, 'native authenticated catalog contains GPT-5.4');
    const chat = await service.createChat({ projectId: 'project', settings: { thinkingLevel: 'max' } });
    const row = await runtime!.controller.queryThreadById({ threadId: chat.id });
    await (await runtime!.controller.getSessionByResource(row!.resourceId))!.thread.rename({ title: 'Effective thinking fixture' });
    await service.updateChatSettings({ chatId: chat.id, patch: { modelId: openai.id } });
    const current = await service.getChatSettings({ chatId: chat.id });
    assert.equal(current.thinkingLevelOverride, 'max', 'model switch preserves the native persisted override');
    assert.equal(current.thinkingLevel, 'xhigh', 'display matches native provider clamping');
    assert.equal(current.thinkingLevels.includes('max'), false, 'gateway catalog prefix cannot bypass native thinking restrictions');
    const abort = new AbortController();
    const watch = service.watchChat({ chatId: chat.id }, abort.signal);
    try {
      await watch.next();
      await service.send({ chatId: chat.id, text: 'EFFECTIVE_THINKING' });
      for await (const snapshot of watch) {
        if (!snapshot.display.isRunning && snapshot.messages.some(message => message.role === 'assistant')) break;
      }
      const body = fixture.requests.at(-1)!.body as { reasoning?: { effort?: string } };
      assert.equal(body.reasoning?.effort, current.thinkingLevel, 'actual Responses wire matches the public effective level');
    } finally { abort.abort(); await watch.return(); }
    await service.updateChatSettings({ chatId: chat.id, patch: { thinkingLevel: 'off' } });
    assert.equal((await service.getChatSettings({ chatId: chat.id })).thinkingLevel, 'low', 'GPT-5 Codex OAuth maps off to low');
    const form = await service.getDraftDefaults();
    const defaults = await service.updateDraftDefaults({ version: form.version, patch: { modelId: openai.id, thinkingLevel: 'off' } });
    assert.equal(defaults.thinkingLevel, 'low', 'saving the raw native default succeeds while reporting its effective OAuth level');
    // Native API-key mode deliberately omits off instead of applying OAuth's floor.
    await writeFile(profile.authPath, JSON.stringify({ 'openai-codex': { type: 'api_key', key: 'fake-fixture-key' } }));
    assert.equal((await service.getChatSettings({ chatId: chat.id })).thinkingLevel, 'off');
    assert.equal((await service.getDraftDefaults()).thinkingLevel, 'off');
  } finally {
    await service?.dispose(); await fixture.close();
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
