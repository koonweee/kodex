import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSocketLink } from './socketLink';

interface Frame { i: string; t?: number; p?: { u?: string; b?: unknown } }
/** Keep the real oRPC serializer/peer. Only the browser transport is fake. */
class FixtureSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FixtureSocket[] = [];
  readyState = FixtureSocket.CONNECTING;
  readonly frames: Frame[] = [];
  openListeners = 0;
  constructor(readonly url: string | URL) { super(); FixtureSocket.instances.push(this); }
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (type === 'open') this.openListeners++;
    super.addEventListener(type, callback, options);
  }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (type === 'open') this.openListeners--;
    super.removeEventListener(type, callback, options);
  }
  send(data: string) {
    if (this.readyState !== FixtureSocket.OPEN) throw new Error('Socket not open');
    this.frames.push(JSON.parse(data) as Frame);
  }
  open() { this.readyState = FixtureSocket.OPEN; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = FixtureSocket.CLOSED; this.dispatchEvent(new Event('close')); }
  reply(frame: Frame, value: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ i: frame.i, p: { b: { json: value } } }) }));
  }
  get requests() { return this.frames.filter(frame => frame.t === undefined || frame.t === 1); }
  get aborts() { return this.frames.filter(frame => frame.t === 4); }
}
const options = (signal?: AbortSignal) => ({ context: {}, signal });
const endpoint = () => 'https://gateway.example/rpc';
beforeEach(() => { FixtureSocket.instances = []; vi.stubGlobal('WebSocket', FixtureSocket); });
afterEach(() => { for (const socket of FixtureSocket.instances) socket.close(); vi.unstubAllGlobals(); });

it('does not open a socket when the link or normal client module is initialized', async () => {
  createSocketLink(endpoint);
  await import('./client');
  expect(FixtureSocket.instances).toHaveLength(0);
});

it('shares one connecting and then open socket for concurrent requests and later calls', async () => {
  const link = createSocketLink(endpoint);
  const first = link.call(['info'], undefined, options());
  const second = link.call(['send'], { text: 'hello' }, options());
  expect(FixtureSocket.instances).toHaveLength(1);
  const socket = FixtureSocket.instances[0]!;
  expect(String(socket.url)).toBe('wss://gateway.example/rpc');
  expect(socket.requests).toHaveLength(0);
  socket.open();
  await vi.waitFor(() => expect(socket.requests).toHaveLength(2));
  socket.reply(socket.requests[0]!, 'first'); socket.reply(socket.requests[1]!, 'second');
  expect(await Promise.all([first, second])).toEqual(['first', 'second']);
  const third = link.call(['info'], undefined, options());
  await vi.waitFor(() => expect(socket.requests).toHaveLength(3));
  socket.reply(socket.requests[2]!, 'third'); expect(await third).toBe('third');
  expect(FixtureSocket.instances).toHaveLength(1);
});

it('does not connect or submit a pre-aborted call', async () => {
  const link = createSocketLink(endpoint); const controller = new AbortController(); controller.abort();
  await expect(async () => link.call(['send'], { text: 'never' }, options(controller.signal))).rejects.toBeDefined();
  expect(FixtureSocket.instances).toHaveLength(0);
});

it('never submits a mutation canceled while connecting; another pending call still uses that socket', async () => {
  const link = createSocketLink(endpoint); const controller = new AbortController();
  const cancelled = link.call(['send'], { text: 'never admitted' }, options(controller.signal));
  const caught = cancelled.catch(error => error);
  const other = link.call(['info'], undefined, options());
  const socket = FixtureSocket.instances[0]!;
  await vi.waitFor(() => expect(socket.openListeners).toBeGreaterThan(0));
  controller.abort(); socket.open();
  await vi.waitFor(() => expect(socket.requests.some(frame => frame.p?.u === '/info')).toBe(true));
  expect(socket.requests.map(frame => frame.p?.u)).toEqual(['/info']);
  socket.reply(socket.requests.find(frame => frame.p?.u === '/info')!, 'other');
  expect(await other).toBe('other'); expect(await caught).toBeDefined();
  expect(FixtureSocket.instances).toHaveLength(1);
});

it('cancels only the admitted request without closing the shared connection', async () => {
  const link = createSocketLink(endpoint); const controller = new AbortController();
  const cancelled = link.call(['watchChat'], { id: 'chat' }, options(controller.signal));
  const caught = cancelled.catch(error => error);
  const other = link.call(['info'], undefined, options()); const socket = FixtureSocket.instances[0]!;
  socket.open(); await vi.waitFor(() => expect(socket.requests).toHaveLength(2));
  const abandoned = socket.requests.find(frame => frame.p?.u === '/watchChat')!;
  controller.abort(); await vi.waitFor(() => expect(socket.aborts.some(frame => frame.i === abandoned.i)).toBe(true));
  expect(await caught).toBeDefined(); expect(socket.readyState).toBe(FixtureSocket.OPEN);
  socket.reply(socket.requests.find(frame => frame.p?.u === '/info')!, 'other'); expect(await other).toBe('other');
});

it('rejects disconnected in-flight work and reconnects only for a future explicit call, never replaying mutations', async () => {
  const link = createSocketLink(endpoint);
  const mutation = link.call(['send'], { text: 'accepted once' }, options()); const failure = mutation.catch(error => error);
  const old = FixtureSocket.instances[0]!; old.open(); await vi.waitFor(() => expect(old.requests).toHaveLength(1)); old.close();
  expect(await failure).toBeDefined(); expect(FixtureSocket.instances).toHaveLength(1);
  const refill = link.call(['info'], undefined, options()); const fresh = FixtureSocket.instances[1]!;
  fresh.open(); await vi.waitFor(() => expect(fresh.requests).toHaveLength(1));
  expect(fresh.requests.map(frame => frame.p?.u)).toEqual(['/info']);
  fresh.reply(fresh.requests[0]!, 'fresh'); expect(await refill).toBe('fresh');
  expect(old.requests).toHaveLength(1);
});

it('a failed opening handshake settles pending calls without background reconnect or replay', async () => {
  const link = createSocketLink(endpoint);
  const pending = link.call(['send'], { text: 'not sent' }, options()); const failure = pending.catch(error => error);
  const old = FixtureSocket.instances[0]!;
  await vi.waitFor(() => expect(old.openListeners).toBeGreaterThan(0));
  old.dispatchEvent(new Event('error')); old.close();
  expect(await failure).toBeDefined(); expect(old.requests).toHaveLength(0); expect(FixtureSocket.instances).toHaveLength(1);
  const retry = link.call(['info'], undefined, options()); const fresh = FixtureSocket.instances[1]!;
  fresh.open(); await vi.waitFor(() => expect(fresh.requests).toHaveLength(1)); fresh.reply(fresh.requests[0]!, 'retry');
  expect(await retry).toBe('retry');
});

it('settles connection-time cancellation immediately without waiting for that shared socket to open', async () => {
  const link = createSocketLink(endpoint); const controller = new AbortController();
  const pending = link.call(['send'], { text: 'never sent' }, options(controller.signal));
  const failure = pending.catch(error => error); const socket = FixtureSocket.instances[0]!;
  controller.abort(); expect(await failure).toBeDefined();
  expect(socket.readyState).toBe(FixtureSocket.CONNECTING); expect(socket.frames).toHaveLength(0);
  expect(socket.openListeners).toBe(0);
});

it('settles a handshake error before close arrives, without automatically opening another connection', async () => {
  const link = createSocketLink(endpoint); const pending = link.call(['info'], undefined, options());
  const failure = pending.catch(error => error); const socket = FixtureSocket.instances[0]!;
  socket.dispatchEvent(new Event('error')); expect(await failure).toBeDefined();
  expect(socket.requests).toHaveLength(0); expect(FixtureSocket.instances).toHaveLength(1);
});

it('a future call replaces a closing socket while each old call remains bound to its original connection', async () => {
  const link = createSocketLink(() => 'http://gateway.example/rpc');
  const mutation = link.call(['send'], { text: 'old request' }, options()); const failed = mutation.catch(error => error);
  const old = FixtureSocket.instances[0]!; old.open();
  await vi.waitFor(() => expect(old.requests).toHaveLength(1));
  old.readyState = FixtureSocket.CLOSING;
  const refill = link.call(['info'], undefined, options()); const fresh = FixtureSocket.instances[1]!;
  expect(String(fresh.url)).toBe('ws://gateway.example/rpc');
  fresh.open(); old.close();
  expect(await failed).toBeDefined();
  await vi.waitFor(() => expect(fresh.requests).toHaveLength(1));
  expect(fresh.requests.map(frame => frame.p?.u)).toEqual(['/info']);
  fresh.reply(fresh.requests[0]!, 'fresh'); expect(await refill).toBe('fresh');
});
