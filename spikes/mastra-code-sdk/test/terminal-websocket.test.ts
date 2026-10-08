import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { connectTerminalSocket, type TerminalSocketManager } from '../src/terminal-websocket.js';

const frame = (data: Buffer, variant: number) => Buffer.concat([data, Buffer.from([variant])]);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: TestContext, early = false) {
  const writes: Array<{ id: string; data: Buffer }> = [], sizes: Array<{ id: string; cols: number; rows: number }> = [];
  const attached = new Set<string>(), detached: string[] = [];
  const callbacks = new Map<string, { data: (data: Buffer) => void; exit: () => void }>();
  const changed = deferred<void>();
  let failAttach = false, failWrite = false, failResize = false;
  const manager: TerminalSocketManager = {
    attach(id, listener) {
      if (failAttach) throw new Error('/private/terminal/startup');
      attached.add(id); callbacks.set(id, listener);
      if (early) listener.data(Buffer.from('EARLY_LIVE'));
      return { history: Buffer.from('REPLAY 🧪'), detach: () => { detached.push(id); callbacks.delete(id); } };
    },
    write(id, data) { if (failWrite) throw new Error('/private/terminal/stdin'); writes.push({ id, data: Buffer.from(data) }); changed.resolve(); },
    resize(id, cols, rows) { if (failResize) throw new Error('/private/terminal/resize'); sizes.push({ id, cols, rows }); changed.resolve(); },
  };
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 1024 });
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
  let connected = deferred<WebSocket>();
  server.on('connection', socket => { const id = `terminal-${attached.size + 1}`; connectTerminalSocket(socket, id, manager); connected.resolve(socket); });
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    for (const client of clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  async function open() {
    connected = deferred<WebSocket>();
    const client = new WebSocket(`ws://127.0.0.1:${port}`); clients.push(client);
    const received: Array<{ data: Buffer; binary: boolean }> = [];
    const waiters: Array<{ count: number; done: () => void }> = [];
    client.on('error', () => {});
    client.on('message', (data: RawData, binary) => {
      received.push({ data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), binary });
      for (const waiter of waiters) if (received.length >= waiter.count) waiter.done();
    });
    const closed = once(client, 'close');
    await once(client, 'open'); const socket = await connected.promise;
    return { client, socket, received, closed, socketClosed: new Promise<void>(done => socket.once('close', () => done())),
      messages(count: number) { return received.length >= count ? Promise.resolve() : new Promise<void>(done => { waiters.push({ count, done }); }); } };
  }
  return { open, attached, detached, callbacks, writes, sizes, changed: changed.promise,
    set failAttach(value: boolean) { failAttach = value; }, set failWrite(value: boolean) { failWrite = value; }, set failResize(value: boolean) { failResize = value; } };
}

test('terminal socket replays bytes before live output and carries raw stdin and shared native resize', { timeout: 5000 }, async t => {
  const f = await fixture(t, true), connection = await f.open();
  assert.equal(f.attached.size, 1);
  await connection.messages(2);
  assert.deepEqual(connection.received, [{ data: Buffer.from('REPLAY 🧪'), binary: true }, { data: Buffer.from('EARLY_LIVE'), binary: true }]);
  const live = Buffer.from([0xff, 0xc3, 0xa9]); f.callbacks.get('terminal-1')!.data(live);
  await connection.messages(3); assert.deepEqual(connection.received[2], { data: live, binary: true });
  connection.client.send(Buffer.from([0]));
  connection.client.send(frame(Buffer.from([0xff, 0, 0xc3, 0xa9]), 1));
  await f.changed; assert.deepEqual(f.writes, [{ id: 'terminal-1', data: Buffer.from([0xff, 0, 0xc3, 0xa9]) }]);
  const resized = once(connection.client, 'message');
  // Echo from the fixture is only an ordering witness after actual handler resize.
  connection.socket.on('message', () => { if (f.sizes.length) connection.socket.send('RESIZED'); });
  connection.client.send(frame(Buffer.from(JSON.stringify({ cols: 65535, rows: 1 })), 255));
  await resized; assert.deepEqual(f.sizes, [{ id: 'terminal-1', cols: 65535, rows: 1 }]);
  connection.client.close(); await connection.closed; await connection.socketClosed;
  assert.deepEqual(f.detached, ['terminal-1']);
});


test('malformed suffix frames and invalid resize payloads close only their attachment with a protocol error', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const invalid = [Buffer.alloc(0), frame(Buffer.from('payload'), 0), Buffer.from([2]),
    ...['', '{', 'null', '[]', '{}', '{"rows":1,"cols":"80"}', '{"rows":0,"cols":80}', '{"rows":-1,"cols":80}',
      '{"rows":1.5,"cols":80}', '{"rows":24,"cols":65536}', '{"rows":24,"cols":null}'].map(value => frame(Buffer.from(value), 255)),
    frame(Buffer.concat([Buffer.from('{"rows":24,"cols":80,"ignored":"'), Buffer.from([0xff]), Buffer.from('"}')]), 255),
    frame(Buffer.from('\ufeff{"rows":24,"cols":80}'), 255)];
  for (const bytes of invalid) {
    const connection = await f.open();
    assert.equal(f.attached.size, f.detached.length + 1);
    connection.client.send(bytes);
    const [code] = await connection.closed; await connection.socketClosed;
    assert.equal(code, 1002);
    assert.ok(connection.received.some(message => !message.binary && message.data.toString().startsWith('terminal protocol error:')));
  }
  assert.equal(f.writes.length, 0); assert.equal(f.sizes.length, 0);
  assert.equal(f.detached.length, invalid.length);
  assert.equal(new Set(f.detached).size, invalid.length, 'each attachment detaches exactly once');
});

test('native terminal exit replays retained bytes then closes and detaches without killing through the transport', { timeout: 5000 }, async t => {
  const f = await fixture(t), connection = await f.open();
  assert.equal(f.attached.size, 1); await connection.messages(1);
  f.callbacks.get('terminal-1')!.exit();
  const [code] = await connection.closed; await connection.socketClosed;
  assert.equal(code, 1000);
  assert.deepEqual(connection.received, [{ data: Buffer.from('REPLAY 🧪'), binary: true }, { data: Buffer.from('terminal exited'), binary: false }]);
  assert.deepEqual(f.detached, ['terminal-1']);
});

test('missing attachments and write or resize errors use bounded public diagnostics and close safely', { timeout: 5000 }, async t => {
  for (const operation of ['attach', 'write', 'resize'] as const) {
    const f = await fixture(t); f.failAttach = operation === 'attach'; f.failWrite = operation === 'write'; f.failResize = operation === 'resize';
    const connection = await f.open();
    if (operation === 'write') connection.client.send(frame(Buffer.from('input'), 1));
    if (operation === 'resize') connection.client.send(frame(Buffer.from('{"cols":80,"rows":24}'), 255));
    const [code] = await connection.closed; await connection.socketClosed;
    assert.equal(code, 1011);
    const messages = connection.received.filter(message => !message.binary).map(message => message.data.toString());
    assert.deepEqual(messages, [operation === 'attach' ? 'terminal unavailable' : operation === 'write' ? 'terminal stdin closed' : 'terminal resize failed']);
    assert.equal(messages.join('').includes('/private'), false);
    assert.equal(f.detached.length, operation === 'attach' ? 0 : 1);
  }
});

test('an actual ws payload error detaches its view while another terminal socket remains usable', { timeout: 5000 }, async t => {
  const f = await fixture(t), first = await f.open(), peer = await f.open();
  assert.equal(f.attached.size, 2); await first.messages(1); await peer.messages(1);
  first.client.send(Buffer.alloc(2048));
  const [code] = await first.closed; await first.socketClosed; assert.equal(code, 1009);
  assert.deepEqual(f.detached, ['terminal-1']);
  assert.equal(peer.client.readyState, WebSocket.OPEN);
  peer.client.send(frame(Buffer.from('still usable'), 1)); await f.changed;
  assert.deepEqual(f.writes, [{ id: 'terminal-2', data: Buffer.from('still usable') }]);
  f.callbacks.get('terminal-2')!.data(Buffer.from('PEER_OUTPUT')); await peer.messages(2);
  assert.deepEqual(peer.received[1], { data: Buffer.from('PEER_OUTPUT'), binary: true });
  peer.client.close(); await peer.closed; await peer.socketClosed;
  assert.deepEqual(f.detached, ['terminal-1', 'terminal-2']);
});

test('a paused reader has bounded output backlog and reconnect guidance while another socket remains usable', { timeout: 5000 }, async t => {
  const f = await fixture(t), slow = await f.open(), peer = await f.open();
  await slow.messages(1); await peer.messages(1);
  slow.client.pause();
  const chunk = Buffer.alloc(64 * 1024, 1);
  for (let index = 0; index < 256; index++) f.callbacks.get('terminal-1')!.data(chunk);
  assert.equal(slow.socket.readyState, WebSocket.CLOSING, 'backlog overflow stops accepting more terminal output');
  assert.ok(slow.socket.bufferedAmount <= 8 * 1024 * 1024 + 1024, 'queued bytes stay bounded including the public close diagnostic');
  assert.equal(peer.client.readyState, WebSocket.OPEN);
  f.callbacks.get('terminal-2')!.data(Buffer.from('PEER_CONTINUES')); await peer.messages(2);
  assert.deepEqual(peer.received[1], { data: Buffer.from('PEER_CONTINUES'), binary: true });
  peer.client.send(frame(Buffer.from('peer input'), 1)); await f.changed;
  assert.deepEqual(f.writes, [{ id: 'terminal-2', data: Buffer.from('peer input') }]);
  slow.client.resume();
  const [code] = await slow.closed; await slow.socketClosed; assert.equal(code, 1013);
  assert.ok(slow.received.some(message => !message.binary && message.data.toString() === 'terminal output lagged; reconnect to replay history'));
  assert.deepEqual(f.detached, ['terminal-1']);
});
