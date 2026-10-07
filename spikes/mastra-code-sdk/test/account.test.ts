import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthStorage } from '@mastra/code-sdk/auth/index';
import { readAccount, logoutAccount } from '../src/account.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'kodex-account-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { storage: new AuthStorage(join(root, 'auth.json')), path: join(root, 'auth.json') };
}
test('account projection uses native active identity without exposing OAuth credentials', async t => {
  const { storage } = fixture(t);
  assert.deepEqual(readAccount(storage), { authenticated: false, account: null });
  await storage.addAccount('openai-codex', { access: 'private-access', refresh: 'private-refresh', expires: 1 }, { label: 'Personal account' });
  const result = readAccount(storage);
  assert.equal(result.authenticated, true);
  assert.equal(result.account?.label, 'Personal account');
  assert.equal(result.account?.needsRefresh, true);
  assert.ok(result.account?.id);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});
test('another native CLI writer and logout converge through native storage, leaving other providers intact', async t => {
  const { storage, path } = fixture(t);
  const cli = new AuthStorage(path);
  await cli.addAccount('openai-codex', { access: 'cli-access', refresh: 'cli-refresh', expires: Date.now() + 60_000 }, { label: 'CLI account' });
  cli.set('unrelated-provider', { type: 'api_key', key: 'other-provider-secret' });
  assert.equal(readAccount(storage).account?.label, 'CLI account');
  assert.deepEqual(logoutAccount(storage), { authenticated: false, account: null });
  const reopened = new AuthStorage(path);
  assert.equal(reopened.isLoggedIn('openai-codex'), false);
  assert.deepEqual(reopened.listAccounts('openai-codex'), []);
  assert.equal(reopened.has('unrelated-provider'), true);
});
