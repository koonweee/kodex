import assert from 'node:assert/strict';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { activateProfile, resolveProfile } from '../../src/profile.js';
import { startOAuthFixture } from './mcp-oauth-server.js';

const [mode, root] = process.argv.slice(2) as [string, string];
assert.equal(homedir(), join(root, 'synthetic-home'));
const emit = (event: string, details: Record<string, unknown> = {}) => process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
const profile = activateProfile(resolveProfile(join(root, 'profile')));
// Guard every native fetch: no external discovery, login or metadata request.
const nativeFetch = globalThis.fetch;
const forbidden: string[] = [];
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    forbidden.push(url.origin);
    throw new Error('Fixture forbids external HTTP');
  }
  return nativeFetch(input, options);
};
const server = await startOAuthFixture();
const reserve = createServer();
await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
const callbackPort = (reserve.address() as AddressInfo).port;
await new Promise<void>(resolve => reserve.close(() => resolve()));
const project = join(root, 'project');
await mkdir(join(project, '.kodex-mastra-spike'), { recursive: true });
await writeFile(join(project, '.kodex-mastra-spike', 'mcp.json'), JSON.stringify({ mcpServers: { secured: {
  url: `${server.origin}/mcp`, oauth: { clientId: 'fixture-client', redirectUrl: `http://127.0.0.1:${callbackPort}/callback`, scopes: ['probe'] },
} } }));
const { createMcpManager } = await import('@mastra/code-sdk/mcp/manager');
let manager = createMcpManager(project, '.kodex-mastra-spike');
function startAuth() {
  let receive!: (url: string) => void;
  const url = new Promise<string>(resolve => { receive = resolve; });
  const callbacks = { count: 0 };
  const result = manager.authenticateServer('secured', { timeoutMs: 2_000, onAuthorizationUrl(value) { callbacks.count++; receive(value); } });
  return { url, result, callbacks };
}
async function complete(url: string) {
  const authorization = new URL(url);
  assert.equal(authorization.origin, server.origin);
  assert.ok(authorization.searchParams.get('state'));
  const redirect = new URL(authorization.searchParams.get('redirect_uri')!);
  assert.equal(redirect.hostname, '127.0.0.1');
  assert.equal(redirect.pathname, '/callback');
  // Wrong callback state must not consume the active native flow.
  const wrong = new URL(redirect);
  wrong.searchParams.set('state', 'wrong'); wrong.searchParams.set('code', 'not-issued');
  assert.equal((await fetch(wrong)).status, 400);
  const response = await fetch(url, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const callback = await fetch(response.headers.get('location')!);
  assert.equal(callback.status, 200);
}
async function assertCallbackClosed(redirect: string) {
  await assert.rejects(fetch(redirect, { signal: AbortSignal.timeout(500) }), error =>
    error instanceof TypeError && ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(
      (error.cause as NodeJS.ErrnoException | undefined)?.code ?? ''),
  'native callback connection is refused or closed; an observation timeout does not establish closure');
}
async function execute(revision: string) {
  const tool = manager.getTools()[`secured_probe_${revision}`];
  assert.ok(tool && typeof tool.execute === 'function');
  const { RequestContext } = await import('@mastra/core/request-context');
  const result = await tool.execute!({}, { requestContext: new RequestContext() });
  assert.deepEqual(result, { content: [{ type: 'text', text: `AUTHENTICATED_${revision}` }] });
}
try {
  const initialization = await manager.initInBackground();
  assert.equal(initialization.failed.length, 1);
  assert.equal(manager.getServerStatuses()[0]!.needsAuth, true);
  assert.deepEqual(manager.getTools(), {});
  emit('initial-needs-auth', { status: manager.getServerStatuses()[0] });
  if (mode === 'cancel-during-connect') {
    const gate = server.holdNextResource();
    const pending = startAuth();
    await gate.entered;
    let cancelSettled = false, authSettled = false;
    void pending.result.then(() => { authSettled = true; });
    const cancellation = manager.cancelServerAuthentication('secured').then(value => { cancelSettled = true; return value; });
    try {
      assert.equal(pending.callbacks.count, 0);
      await delay(250);
      emit('held-connect-cancellation', { cancelSettled, authSettled, callbacks: pending.callbacks.count });
      assert.equal(cancelSettled, false, 'native cancellation waits for outstanding connection response');
      assert.equal(authSettled, false);
      assert.equal(pending.callbacks.count, 0);
    } finally { gate.release(); }
    assert.equal(await cancellation, true);
    const result = await pending.result;
    emit('held-connect-released', { result, callbacks: pending.callbacks.count });
    assert.equal(result.cancelled, true);
    assert.equal(result.needsAuth, true);
    assert.equal(pending.callbacks.count, 1, 'native connect can emit a late URL after cancellation was requested');
    const staleUrl = new URL(await pending.url);
    await assertCallbackClosed(staleUrl.searchParams.get('redirect_uri')!);
    const retry = startAuth();
    await complete(await retry.url);
    assert.equal((await retry.result).connected, true);
    await execute('before');
    emit('retry-connected');
  } else {
    const flow = startAuth();
    const url = await flow.url;
    assert.equal(manager.getServerStatuses()[0]!.authenticating, true);
    emit('authorization-url', { callbackPort: new URL(new URL(url).searchParams.get('redirect_uri')!).port });
    if (mode === 'success') {
      server.setRevision('authorized');
      await complete(url);
      const result = await flow.result;
      assert.equal(result.connected, true);
      assert.deepEqual(result.toolNames, ['secured_probe_authorized']);
      assert.equal(manager.getServerStatuses()[0]!.authenticating, undefined);
      await execute('authorized');
      const authCounts = { authorize: server.counts.authorize, token: server.counts.token };
      await manager.disconnect();
      manager = createMcpManager(project, '.kodex-mastra-spike');
      await manager.initInBackground();
      assert.equal(manager.getServerStatuses()[0]!.connected, true);
      await execute('authorized');
      assert.deepEqual({ authorize: server.counts.authorize, token: server.counts.token }, authCounts, 'recreated native manager reuses persisted access token without another authorization');
      const files = await readdir(join(profile.appDataDir, 'mcp-oauth'));
      assert.equal(files.length, 1);
      assert.equal((await stat(join(profile.appDataDir, 'mcp-oauth', files[0]!))).mode & 0o777, 0o600);
      emit('persisted-recreated', { tokenFiles: files.length, authCounts });
    } else if (mode === 'cancel-retry-duplicate') {
      let duplicateUrl = false;
      const duplicate = await manager.authenticateServer('secured', { onAuthorizationUrl() { duplicateUrl = true; } });
      assert.match(duplicate.error!, /already in progress/);
      assert.equal(duplicateUrl, false);
      assert.equal(manager.getServerStatuses()[0]!.authenticating, true);
      assert.equal(await manager.cancelServerAuthentication('secured'), true);
      const cancelled = await flow.result;
      assert.equal(cancelled.connected, false);
      assert.equal(cancelled.cancelled, true);
      assert.equal(cancelled.needsAuth, true);
      assert.equal(manager.getServerStatuses()[0]!.authenticating, undefined);
      assert.equal(await manager.cancelServerAuthentication('secured'), false);
      await assertCallbackClosed(new URL(url).searchParams.get('redirect_uri')!);
      emit('cancelled', { duplicate, status: cancelled });
      const retry = startAuth();
      const retryUrl = await retry.url;
      assert.notEqual(new URL(retryUrl).searchParams.get('state'), new URL(url).searchParams.get('state'));
      await complete(retryUrl);
      assert.equal((await retry.result).connected, true);
      await execute('before');
      emit('retry-connected');
    } else {
      const mutation = mode === 'reload-during-auth' ? manager.reload() : manager.setServerDisabled('secured', true);
      const oldResult = await flow.result;
      await mutation;
      const status = manager.getServerStatuses()[0]!;
      emit('mutation-settled', { mode, oldResult, status });
      assert.equal(oldResult.connected, false);
      assert.equal(status.authenticating, undefined);
      assert.deepEqual(manager.getTools(), {});
      if (mode === 'disable-during-auth') {
        assert.equal(status.disabled, true);
        const refused = await manager.authenticateServer('secured');
        assert.match(refused.error!, /disabled/);
        await manager.setServerDisabled('secured', false);
      } else assert.equal(status.needsAuth, true);
      const retry = startAuth();
      await complete(await retry.url);
      assert.equal((await retry.result).connected, true);
      await execute('before');
      emit('retry-connected');
    }
  }
  assert.deepEqual(forbidden, []);
  emit('finished', { counts: server.counts });
} finally {
  await manager.disconnect();
  await server.close();
  emit('cleanup-settled');
}
// Native entrypoint owns final process exit; watchdog cleanup proves no semantics.
process.exit(0);
