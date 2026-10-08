import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { ORPCError, os, type as schemaType, type RouterClient } from '@orpc/server';
import { ChatFilePreviewError } from '../src/chat-file-previews.js';
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


test('native file URL serves unwrapped bytes, validates requests and contains backend failures', async () => {
  const calls: unknown[] = [];
  const server = await serveRouter({}, 0, { async previewFile(input) {
    calls.push(input);
    if (input.chatId === 'missing') throw new ORPCError('NOT_FOUND');
    if (input.path === 'invalid.md') throw new ChatFilePreviewError(415);
    if (input.path === 'failure') throw new Error('private provider credential');
    return { bytes: Buffer.from('# Native preview'), contentType: 'text/markdown; charset=utf-8', contentDisposition: 'attachment; filename="notes.md"' };
  } });
  const route = '/v1/threads/chat%20id/files/preview?path=folder%2Fnotes.md';
  try {
    const response = await fetch(server.url + route);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '# Native preview');
    assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="notes.md"');
    assert.equal(response.headers.get('cache-control'), 'private');
    assert.equal(response.headers.get('content-length'), '16');
    assert.deepEqual(calls, [{ chatId: 'chat id', path: 'folder/notes.md' }]);
    for (const [url, init, status] of [
      ['/v1/threads/chat/files/preview', undefined, 400],
      ['/v1/threads/%zz/files/preview?path=x', undefined, 400],
      [route, { method: 'POST' }, 405],
      ['/v1/threads/missing/files/preview?path=x', undefined, 404],
      ['/v1/threads/chat/files/preview?path=invalid.md', undefined, 415],
      ['/v1/threads/chat/files/preview?path=failure', undefined, 500],
    ] as const) {
      const result = await fetch(server.url + url, init);
      assert.equal(result.status, status);
      assert.doesNotMatch(await result.text(), /credential|provider/);
    }
    assert.equal(calls.length, 4, 'invalid HTTP requests do not reach native lookup');
  } finally { await server.close(); }
});
