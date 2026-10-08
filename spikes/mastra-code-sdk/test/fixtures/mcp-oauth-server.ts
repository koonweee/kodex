import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// Disposable local OAuth/resource fixture. Never used by product code.
export async function startOAuthFixture() {
  const counts = { unauthorized: 0, authorize: 0, token: 0, refresh: 0, initialize: 0, list: 0, call: 0 };
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const tokens = new Set<string>();
  let revision = 'before';
  let origin = '';
  let resourceGate: { entered(): void; released: Promise<void> } | undefined;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, origin);
      const json = (status: number, data: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(data));
      };
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        json(200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['probe'], bearer_methods_supported: ['header'] });
        return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        json(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['probe'] });
        return;
      }
      if (url.pathname === '/authorize') {
        counts.authorize++;
        assert.equal(url.searchParams.get('client_id'), 'fixture-client');
        assert.equal(url.searchParams.get('response_type'), 'code');
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        const redirect = url.searchParams.get('redirect_uri')!;
        const code = `fixture-code-${counts.authorize}`;
        codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect });
        const callback = new URL(redirect);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        callback.searchParams.set('iss', origin);
        response.writeHead(302, { Location: callback.href }); response.end();
        return;
      }
      if (url.pathname === '/token') {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const params = new URLSearchParams(body);
        if (params.get('grant_type') === 'refresh_token') counts.refresh++;
        else {
          const code = codes.get(params.get('code')!);
          assert.ok(code, 'issued code required');
          assert.equal(params.get('redirect_uri'), code.redirect);
          assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), code.challenge, 'native client uses matching PKCE verifier');
          codes.delete(params.get('code')!);
        }
        counts.token++;
        const token = `fixture-access-${counts.token}`;
        tokens.add(token);
        json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: 'fixture-refresh', scope: 'probe' });
        return;
      }
      if (url.pathname !== '/mcp') { json(404, { error: 'not_found' }); return; }
      if (resourceGate) {
        const gate = resourceGate; resourceGate = undefined;
        gate.entered(); await gate.released;
      }
      const bearer = request.headers.authorization?.replace(/^Bearer /, '');
      if (!bearer || !tokens.has(bearer)) {
        counts.unauthorized++;
        response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="probe"`);
        json(401, { error: 'invalid_token' }); return;
      }
      if (request.method === 'DELETE') { response.writeHead(204); response.end(); return; }
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const rpc = JSON.parse(body) as { id?: string | number; method: string; params?: { protocolVersion?: string; name?: string } };
      if (rpc.id === undefined) { response.writeHead(202); response.end(); return; }
      let result: unknown;
      switch (rpc.method) {
        case 'initialize':
          counts.initialize++;
          result = { protocolVersion: rpc.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture-oauth', version: '1' } }; break;
        case 'ping': result = {}; break;
        case 'tools/list':
          counts.list++;
          result = { tools: [{ name: `probe_${revision}`, description: 'Local authenticated witness', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }; break;
        case 'tools/call':
          counts.call++;
          assert.equal(rpc.params!.name, `probe_${revision}`);
          result = { content: [{ type: 'text', text: `AUTHENTICATED_${revision}` }] }; break;
        default: json(200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }); return;
      }
      json(200, { jsonrpc: '2.0', id: rpc.id, result });
    } catch (error) {
      response.writeHead(500); response.end('Fixture assertion failed');
      process.stderr.write(`${String(error)}\n`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, counts, holdNextResource() {
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    resourceGate = { entered, released };
    return { entered: observed, release };
  }, setRevision(value: string) { revision = value; }, async close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
