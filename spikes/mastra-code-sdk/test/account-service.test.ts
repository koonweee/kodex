import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthStorage } from '@mastra/code-sdk/auth/index';
import { createAccountService } from '../src/account-service.js';

test('two account observers converge after an external native CLI login and host logout', { timeout: 10_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'kodex-account-watch-'));
  const path = join(root, 'auth.json');
  const service = createAccountService(new AuthStorage(path), path, 'epoch');
  t.after(() => { service.dispose(); rmSync(root, { recursive: true, force: true }); });
  const signal = AbortSignal.timeout(8000);
  const first = service.watch(signal), second = service.watch(signal);
  assert.equal((await first.next()).value?.authenticated, false);
  assert.equal((await second.next()).value?.authenticated, false);
  // Request .next directly: breaking a for-await would close this observer.
  const waitFor = async (iterator: typeof first, authenticated: boolean) => {
    for (;;) { const next = await iterator.next(); if (next.done) throw new Error('Closed'); if (next.value.authenticated === authenticated) return next.value; }
  };
  const loginReads = [waitFor(first, true), waitFor(second, true)];
  const cli = new AuthStorage(path);
  await cli.addAccount('openai-codex', { access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 60_000 }, { label: 'CLI account' });
  const accounts = await Promise.all(loginReads);
  assert.ok(accounts.every(value => value.account?.label === 'CLI account'));
  const logoutReads = [waitFor(first, false), waitFor(second, false)];
  service.logout();
  const loggedOut = await Promise.all(logoutReads);
  assert.ok(loggedOut.every(value => value.revision > accounts[0]!.revision));
  service.dispose();
});
