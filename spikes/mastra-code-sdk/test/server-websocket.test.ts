import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { EventPublisher, eventIterator, os, type as schemaType, type RouterClient } from '@orpc/server';
import { WebSocket as Ws } from 'ws';
import { serveRouter } from '../src/server.js';

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('WebSocket cancellation did not settle');
}
function fixture() {
  const active = new Set<number>();
  const events = new EventPublisher<{ update: number }>({ maxBufferedEvents: 1 });
  let mutations = 0;
  const router = {
    info: os.handler(() => ({ transport: 'native-orpc' })),
    mutate: os.handler(() => ++mutations),
    fail: os.handler(() => { throw new Error('FAKE_PROVIDER_SECRET'); }),
    watch: os.input(schemaType<{ id: number }>()).output(eventIterator(schemaType<{ id: number; revision: number }>())).handler(async function* ({ input, signal }) {
      const subscription = events.subscribe('update', { signal });
      active.add(input.id);
      try { yield { id: input.id, revision: 0 }; for await (const revision of subscription) yield { id: input.id, revision }; }
      finally { active.delete(input.id); await subscription.return(); }
    }),
  };
  return { router, active };
}

test('one native WebSocket multiplexes more than six live streams plus RPC and cancels on disconnect', { timeout: 10_000 }, async () => {
  const { router, active } = fixture();
  const server = await serveRouter(router, 0);
  const socket = new WebSocket(`${server.url.replace('http:', 'ws:')}/rpc`);
  const client: RouterClient<typeof router> = createORPCClient(new RPCLink({ websocket: socket }));
  const signals = Array.from({ length: 12 }, () => new AbortController());
  try {
    await once(socket, 'open');
    const streams = await Promise.all(signals.map((abort, id) => client.watch({ id }, { signal: abort.signal })));
    const initial = await Promise.all(streams.map(stream => stream.next()));
    assert.ok(initial.every(value => !value.done));
    assert.equal(active.size, 12);
    assert.deepEqual(await client.info(), { transport: 'native-orpc' });
    assert.equal(await client.mutate(), 1, 'mutation executes once while twelve iterators remain live');
    const http: RouterClient<typeof router> = createORPCClient(new HttpLink({ url: `${server.url}/rpc` }));
    assert.deepEqual(await http.info(), { transport: 'native-orpc' }, 'HTTP RPC remains available');
    signals[0]!.abort();
    await waitFor(() => active.size === 11);
    assert.equal(await client.mutate(), 2);
    socket.close();
    await new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
    await waitFor(() => active.size === 0);
  } finally { signals.forEach(signal => signal.abort()); socket.close(); await server.close(); }
});


test('server shutdown closes WebSocket peers and joins native iterator cancellation', { timeout: 10_000 }, async () => {
  const { router, active } = fixture();
  const server = await serveRouter(router, 0);
  const socket = new WebSocket(`${server.url.replace('http:', 'ws:')}/rpc`);
  try {
    await once(socket, 'open');
    const client: RouterClient<typeof router> = createORPCClient(new RPCLink({ websocket: socket }));
    const streams = await Promise.all(Array.from({ length: 8 }, (_, id) => client.watch({ id })));
    await Promise.all(streams.map(stream => stream.next()));
    assert.equal(active.size, 8);
    const disconnected = once(socket, 'close');
    await Promise.all([server.close(), server.close()]);
    await disconnected;
    assert.equal(active.size, 0, 'shutdown waits for server-side native finally blocks');
    await assert.rejects(client.mutate());
  } finally { socket.close(); await server.close(); }
});

async function rejectedUpgrade(url: string, origin: string) {
  const socket = new Ws(url, { headers: { Origin: origin } });
  socket.on('error', () => {});
  return new Promise<number | undefined>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
    socket.once('open', () => { socket.close(); reject(new Error('Unexpected WebSocket upgrade')); });
  });
}

test('WebSocket upgrades allow the same browser origin and reject foreign origins and non-RPC paths', { timeout: 10_000 }, async () => {
  const { router } = fixture();
  const server = await serveRouter(router, 0);
  const rpc = `${server.url.replace('http:', 'ws:')}/rpc`;
  const socket = new Ws(rpc, { headers: { Origin: server.url } });
  try {
    await once(socket, 'open');
    const closed = once(socket, 'close'); socket.close(); await closed;
    assert.equal(await rejectedUpgrade(rpc, 'https://untrusted.example'), 403);
    assert.equal(await rejectedUpgrade(`${rpc}/info`, server.url), 404);
  } finally { socket.terminate(); await server.close(); }
});

test('WebSocket payload limits and malformed frames close generically without logging raw data', { timeout: 10_000 }, async t => {
  const { router } = fixture();
  const server = await serveRouter(router, 0);
  const logged = t.mock.method(console, 'error', () => {});
  try {
    const rpc = `${server.url.replace('http:', 'ws:')}/rpc`;
    const malformed = new Ws(rpc);
    await once(malformed, 'open');
    const malformedClose = once(malformed, 'close');
    malformed.send('FAKE_PROVIDER_SECRET malformed JSON');
    const [code, reason] = await malformedClose;
    assert.equal(code, 1002); assert.equal(reason.toString(), 'Invalid RPC message');
    const oversized = new Ws(rpc);
    await once(oversized, 'open');
    const oversizedClose = once(oversized, 'close');
    oversized.send('x'.repeat(1_048_577));
    assert.equal((await oversizedClose)[0], 1009);
    const socket = new WebSocket(rpc);
    await once(socket, 'open');
    try {
      const client: RouterClient<typeof router> = createORPCClient(new RPCLink({ websocket: socket }));
      await assert.rejects(client.fail(), error => !String(error).includes('FAKE_PROVIDER_SECRET'));
    } finally { socket.close(); }
    assert.equal(logged.mock.callCount(), 0);
  } finally { await server.close(); }
});
