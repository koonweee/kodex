import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpService } from '../src/mcp-service.js';

test('reload reaches retained bindings and two observers converge on native snapshots', async () => {
  let generation = 0;
  const loaded: string[] = [];
  const sources = async () => ['current', 'retained'].map(bindingId => ({
    bindingId, projectId: bindingId === 'current' ? 'project' : null,
    projectName: bindingId === 'current' ? 'Project' : null, cwd: `/${bindingId}`,
    mcp: {
      authenticateServer: async () => ({ authorizationUrl: null, error: null }), cancelServerAuthentication: async () => false,
      setServerEnabled: async () => {}, inheritServer: async () => {},
      snapshot: () => ({ phase: 'ready' as const, servers: [{ name: 'local', connected: true, toolCount: 1, toolNames: [`probe_${generation}`], transport: 'stdio' as const }], skipped: [], paths: { project: '/project/mcp.json', global: '/home/mcp.json', claude: '/project/settings.local.json' } }),
      reload: async () => { loaded.push(bindingId); generation++; },
    },
  }));
  const lifetime = new AbortController();
  const service = createMcpService({ sources, assertActive() {}, signal: lifetime.signal });
  const peers = [service.watch(), service.watch()];
  const first = await Promise.all(peers.map(peer => peer.next()));
  assert.notEqual(first[0].value!.epoch, first[1].value!.epoch);
  assert.deepEqual(await service.reload({}), [{ bindingId: 'current', error: null }, { bindingId: 'retained', error: null }]);
  assert.deepEqual(loaded, ['current', 'retained']);
  for (const peer of peers) {
    const next = await peer.next(); assert.equal(next.done, false);
    assert.equal(next.value!.revision, 2);
    assert.deepEqual(next.value!.rows.map(row => row.servers[0]?.toolNames), [['probe_2'], ['probe_2']]);
    assert.equal(next.value!.rows[1].projectId, null);
  }
  assert.deepEqual((await service.list()).map(row => row.bindingId), ['current', 'retained']);
  lifetime.abort(); await Promise.all(peers.map(peer => peer.return()));
});

test('binding selection rejects unknown IDs and preserves safe per-binding reload outcomes', async () => {
  let calls = 0;
  const service = createMcpService({ signal: new AbortController().signal, assertActive() {}, sources: async () => [
    { bindingId: 'disabled', projectId: null, projectName: null, cwd: '/disabled', mcp: undefined },
    { bindingId: 'failed', projectId: null, projectName: null, cwd: '/failed', mcp: {
      authenticateServer: async () => ({ authorizationUrl: null, error: null }), cancelServerAuthentication: async () => false,
      setServerEnabled: async () => {}, inheritServer: async () => {},
      snapshot: () => ({ phase: 'ready' as const, servers: [], skipped: [], paths: { project: 'p', global: 'g', claude: 'c' } }),
      reload: async () => { calls++; throw new Error('secret-internal-value'); },
    } },
  ] });
  assert.equal((await service.list())[0].phase, 'disabled');
  await assert.rejects(service.reload({ bindingId: 'foreign' }), /not found/i);
  assert.equal(calls, 0);
  const result = await service.reload({});
  assert.equal(calls, 1);
  assert.deepEqual(result, [{ bindingId: 'disabled', error: 'MCP is disabled for this runtime.' }, { bindingId: 'failed', error: 'MCP reload failed.' }]);
  assert.ok(!JSON.stringify(result).includes('secret-internal-value'));
});

test('transport cancellation releases the reload reply without pretending native work was cancelled', { timeout: 5000 }, async () => {
  let started!: () => void, finish!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; });
  const nativeWork = new Promise<void>(resolve => { finish = resolve; });
  let completed = false;
  const service = createMcpService({ signal: new AbortController().signal, assertActive() {}, sources: async () => [{
    bindingId: 'held', projectId: null, projectName: null, cwd: '/held', mcp: {
      authenticateServer: async () => ({ authorizationUrl: null, error: null }), cancelServerAuthentication: async () => false,
      setServerEnabled: async () => {}, inheritServer: async () => {},
      snapshot: () => ({ phase: 'reloading' as const, servers: [], skipped: [], paths: { project: 'p', global: 'g', claude: 'c' } }),
      reload: async () => { started(); await nativeWork; completed = true; },
    },
  }] });
  const request = new AbortController();
  const reply = service.reload({}, request.signal);
  await admitted; request.abort();
  await assert.rejects(reply, /no longer waiting/i);
  assert.equal(completed, false);
  finish(); await nativeWork;
});

test('native project server overrides refill same-scope managers without changing other projects', async () => {
  const calls: string[] = [];
  const source = (bindingId: string, nativeProject: string) => ({
    bindingId, projectId: bindingId, projectName: bindingId, cwd: `/${bindingId}`,
    mcp: {
      snapshot: () => ({ phase: 'ready' as const, servers: [{ name: 'docs', connected: true, toolCount: 0, toolNames: [], transport: 'stdio' as const }], skipped: [], paths: { project: nativeProject, global: '/global/mcp.json', claude: '/claude' } }),
      reload: async () => { calls.push(`reload:${bindingId}`); },
      authenticateServer: async () => ({ authorizationUrl: null, error: null }), cancelServerAuthentication: async () => false,
      setServerEnabled: async (name: string, enabled: boolean) => { calls.push(`${bindingId}:${name}:${enabled}`); },
      inheritServer: async (name: string) => { calls.push(`inherit:${bindingId}:${name}`); },
    },
  });
  const service = createMcpService({ signal: new AbortController().signal, assertActive() {}, sources: async () => [source('selected', '/same/mcp.json'), source('retained', '/same/mcp.json'), source('other', '/other/mcp.json')] });
  assert.deepEqual(await service.setServerEnabled({ bindingId: 'selected', server: 'docs', enabled: false }), [{ bindingId: 'selected', error: null }, { bindingId: 'retained', error: null }]);
  assert.deepEqual(calls, ['selected:docs:false', 'reload:retained']);
  await service.inheritServer({ bindingId: 'retained', server: 'docs' });
  assert.deepEqual(calls.slice(2), ['inherit:retained:docs', 'reload:selected']);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(service.setServerEnabled({ bindingId: 'selected', server: 'docs', enabled: true }, cancelled.signal), /no longer waiting/);
  assert.equal(calls.length, 4);
});


test('OAuth starts on the exact binding, keeps URLs out of peer snapshots, and cancellation reaches native work', async () => {
  const calls: string[] = [];
  let active = false;
  const mcp = {
    snapshot: () => ({ phase: 'ready' as const, servers: [{ name: 'docs', connected: false, authenticating: active, needsAuth: true, toolCount: 0, toolNames: [], transport: 'http' as const }], skipped: [], paths: { project: '/p/mcp.json', global: '/g/mcp.json', claude: '/p/claude' } }),
    reload: async () => {}, setServerEnabled: async () => {}, inheritServer: async () => {},
    authenticateServer: async (name: string) => { calls.push(`start:${name}`); active = true; return { authorizationUrl: 'https://auth.example/?state=LOCAL_ONLY', error: null }; },
    cancelServerAuthentication: async (name: string) => { calls.push(`cancel:${name}`); const previous = active; active = false; return previous; },
  };
  const service = createMcpService({ signal: new AbortController().signal, assertActive() {}, sources: async () => [
    { bindingId: 'selected', projectId: 'p', projectName: 'p', cwd: '/p', mcp },
  ] });
  await assert.rejects(service.authenticateServer({ bindingId: 'foreign', server: 'docs' }), /not found/i);
  const response = await service.authenticateServer({ bindingId: 'selected', server: 'docs' });
  assert.match(response.authorizationUrl!, /LOCAL_ONLY/);
  const peers = [service.watch(), service.watch()];
  for (const peer of peers) {
    const value = (await peer.next()).value!;
    assert.equal(value.rows[0]?.servers[0]?.authenticating, true);
    assert.doesNotMatch(JSON.stringify(value), /LOCAL_ONLY/);
  }
  assert.equal(await service.cancelServerAuthentication({ bindingId: 'selected', server: 'docs' }), true);
  for (const peer of peers) {
    assert.equal((await peer.next()).value!.rows[0]?.servers[0]?.authenticating, false);
    await peer.return();
  }
  assert.deepEqual(calls, ['start:docs', 'cancel:docs']);
});
