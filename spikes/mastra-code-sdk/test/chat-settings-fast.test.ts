import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createFastProcessor } from '../src/chat-settings.js';
import { startResponsesFixture } from './fixtures/responses-server.js';

test('supported native processor forwards Fast to the actual Responses wire without replaying other defaults', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-mastra-fast-wire-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const fixture = await startResponsesFixture();
  const original = { NODE_ENV: process.env.NODE_ENV, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL };
  // The same upstream test seam as the native affinity proof. No fetch patch,
  // real tokens, external provider request or production home is involved.
  process.env.NODE_ENV = 'test'; process.env.OPENAI_BASE_URL = fixture.url;
  try {
    await writeFile(profile.authPath, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'fake-fixture-access', refresh: 'fake-fixture-refresh', expires: Date.now() + 3_600_000 } }));
    const [{ Agent }, { AuthStorage }, { openaiCodexProvider }] = await Promise.all([
      import('@mastra/core/agent'), import('@mastra/code-sdk/auth/storage'), import('@mastra/code-sdk/providers/openai-codex'),
    ]);
    let fast = true;
    const processor = createFastProcessor(() => fast);
    const agent = new Agent({ id: 'fast-wire-fixture', name: 'Fast wire fixture', instructions: 'Return fixture output.',
      model: openaiCodexProvider('gpt-6.1-sol', { authStorage: new AuthStorage(profile.authPath), thinkingLevel: 'high' }),
      inputProcessors: [processor],
    });
    await (await agent.stream('FAST_ON')).consumeStream();
    const enabled = fixture.requests.at(-1)!.body as typeof fixture.requests[number]['body'] & { service_tier?: string; reasoning?: { effort?: string }; store?: boolean };
    assert.equal(enabled.service_tier, 'fast', 'real native Responses provider receives the processor option');
    assert.equal(enabled.reasoning?.effort, 'high', 'native Codex middleware retains existing reasoning');
    assert.equal(enabled.store, false, 'native Codex middleware retains its store policy');
    fast = false;
    await (await agent.stream('FAST_OFF')).consumeStream();
    assert.equal((fixture.requests.at(-1)!.body as { service_tier?: string }).service_tier, undefined, 'disabled Fast does not replay a tier default');
  } finally {
    await fixture.close();
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
