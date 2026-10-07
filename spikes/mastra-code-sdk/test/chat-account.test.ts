import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { activateProfile, resolveProfile } from '../src/profile.js';
import { createChatService } from '../src/chat-service.js';
import { createChatRouter, type ChatRouter } from '../src/chat-router.js';
import { serveRouter } from '../src/server.js';

test('account RPC observers use dedicated native auth and converge on CLI login and logout', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-account-rpc-'));
  const profile = activateProfile(resolveProfile(join(root, 'profile')));
  const service = createChatService({ profile, instanceId: 'account-test', projects: [] });
  const server = await serveRouter(createChatRouter(service), 0);
  const abort = new AbortController();
  try {
    const client = () => createORPCClient<RouterClient<ChatRouter>>(new RPCLink({ url: `${server.url}/rpc` }));
    const first = client(), second = client();
    const a = await first.watchAccount(undefined, { signal: abort.signal });
    const b = await second.watchAccount(undefined, { signal: abort.signal });
    const initialA = await a.next(), initialB = await b.next();
    if (initialA.done || initialB.done) throw new Error('Account observer closed before its initial snapshot');
    assert.equal(initialA.value.authenticated, false);
    assert.equal(initialB.value.authenticated, false);
    const nextState = async (stream: typeof a, authenticated: boolean) => {
      for (;;) { const next = await stream.next(); if (next.done) throw new Error('Observer closed'); if (next.value.authenticated === authenticated) return next.value; }
    };
    const reads = [nextState(a, true), nextState(b, true)];
    const { AuthStorage } = await import('@mastra/code-sdk/auth/index');
    const cli = new AuthStorage(profile.authPath);
    await cli.addAccount('openai-codex', { access: 'fake-access', refresh: 'fake-refresh', expires: Date.now() + 60_000 }, { label: 'Fixture login' });
    const loggedIn = await Promise.all(reads);
    assert.equal(loggedIn[0]?.account?.label, 'Fixture login');
    assert.equal(loggedIn[1]?.account?.id, loggedIn[0]?.account?.id);
    assert.equal(JSON.stringify(loggedIn).includes('fake-access'), false);
    const signedOut = [nextState(a, false), nextState(b, false)];
    await second.logoutAccount();
    assert.ok((await Promise.all(signedOut)).every(state => !state.account));
    assert.equal((await first.getAccount()).authenticated, false);
    assert.equal(await first.getAccountUsage(), null);
    const { getGlobalAuthStorage } = await import('@mastra/code-sdk/agents/mastracode-gateway');
    assert.equal(getGlobalAuthStorage().isLoggedIn('openai-codex'), false, 'runtime credential instance also observes logout');
    const retiring = createChatService({ profile, instanceId: 'retiring', projects: [] });
    const rejected = assert.rejects(retiring.getAccount(), /shutting down/);
    await retiring.dispose();
    await rejected;
    await assert.rejects(retiring.getAccount(), /shutting down/);
  } finally {
    abort.abort();
    await server.close();
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
