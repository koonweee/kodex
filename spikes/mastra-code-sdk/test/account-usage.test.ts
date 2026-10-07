import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthStorage } from '@mastra/code-sdk/auth/index';
import { readAccountUsage } from '../src/account-usage.js';
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'kodex-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new AuthStorage(join(root, 'auth.json'));
  await storage.addAccount('openai-codex', { access: 'private-access', refresh: 'private-refresh', accountId: 'fixture-provider-account', expires: Date.now() + 60_000 });
  return storage;
}
const body = { rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1800000000 }, secondary_window: null }, secret: 'do-not-project' };
test('usage reuses native credentials and projects only real provider windows', async t => {
  const storage = await fixture(t);
  const original = storage.getOAuthCredential.bind(storage);
  let reads = 0;
  storage.getOAuthCredential = async (...args) => { reads++; return original(...args); };
  const result = await readAccountUsage(storage, { fetch: async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer private-access');
    assert.equal(headers.get('ChatGPT-Account-Id'), 'fixture-provider-account');
    return Response.json(body);
  } });
  assert.equal(reads, 1);
  assert.deepEqual(result?.primary, { usedPercent: 12, windowDurationMins: 300, resetsAt: 1800000000 });
  assert.equal(result?.secondary, null);
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.equal(JSON.stringify(result).includes('do-not-project'), false);
});
test('usage failures never surface response bodies and absent or malformed limits do not become zero', async t => {
  const storage = await fixture(t);
  await assert.rejects(readAccountUsage(storage, { fetch: async () => new Response('private-access', { status: 401 }) }), /^Error: Unable to read ChatGPT usage\.$/);
  await assert.rejects(readAccountUsage(storage, { fetch: async () => Response.json({ rate_limit: { primary_window: { used_percent: 'bad' } } }) }), /Invalid ChatGPT usage response/);
  const empty = await readAccountUsage(storage, { fetch: async () => Response.json({ rate_limit: null }) });
  assert.equal(empty?.primary, null);
  assert.equal(empty?.secondary, null);
});
test('logout during usage read fences the previous account response', async t => {
  const storage = await fixture(t);
  await assert.rejects(readAccountUsage(storage, { fetch: async () => { storage.logout('openai-codex'); return Response.json(body); } }), /Account changed/);
  let fetched = false;
  assert.equal(await readAccountUsage(storage, { fetch: async () => { fetched = true; return Response.json(body); } }), null);
  assert.equal(fetched, false);
});
