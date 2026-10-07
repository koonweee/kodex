import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { os, type RouterClient } from '@orpc/server';
import { serveRouter } from '../src/server.js';

test('dedicated server serves typed RPC and rejects unfinished legacy routes without fallback', async () => {
  const router = { info: os.handler(() => ({ instanceId: 'fixture-instance' })) };
  const server = await serveRouter(router, 0);
  try {
    const client: RouterClient<typeof router> = createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
    assert.deepEqual(await client.info(), { instanceId: 'fixture-instance' });
    for (const route of ['/v1/capabilities', '/v1/threads', '/info', '/rpc/missing']) {
      const response = await fetch(`${server.url}${route}`);
      assert.equal(response.status, 404, route);
    }
  } finally { await server.close(); }
  await assert.rejects(fetch(`${server.url}/rpc/info`));
});
