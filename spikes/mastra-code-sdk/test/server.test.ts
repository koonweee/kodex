import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { os, type as schemaType, type RouterClient } from '@orpc/server';
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


test('native multipart uploads accept file bytes beyond command limits while ordinary RPC stays bounded', async () => {
  let ordinaryCalls = 0;
  const router = {
    uploadFile: os.input(schemaType<{ file: File }>()).handler(async ({ input }) => {
      assert.ok(input.file instanceof File);
      return { name: input.file.name, type: input.file.type, size: input.file.size, first: new Uint8Array(await input.file.arrayBuffer())[0] };
    }),
    ordinary: os.input(schemaType<{ text: string }>()).handler(() => ++ordinaryCalls),
  };
  const server = await serveRouter(router, 0);
  try {
    const client: RouterClient<typeof router> = createORPCClient(new RPCLink({ url: `${server.url}/rpc` }));
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(42);
    assert.deepEqual(await client.uploadFile({ file: new File([bytes], 'sample.bin', { type: 'application/octet-stream' }) }),
      { name: 'sample.bin', type: 'application/octet-stream', size: bytes.length, first: 42 });
    await assert.rejects(client.ordinary({ text: 'x'.repeat(2 * 1024 * 1024) }));
    assert.equal(ordinaryCalls, 0);
    await assert.rejects(client.uploadFile({ file: new File([new Uint8Array(27 * 1024 * 1024)], 'oversized.bin') }));
  } finally { await server.close(); }
});
