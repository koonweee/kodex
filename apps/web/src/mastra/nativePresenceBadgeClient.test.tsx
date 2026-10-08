import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { os, type as schemaType } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import type { ChatClient } from './client';
import { createNativePresenceBadgeClient } from './nativePresenceBadgeClient';
import { nativePresenceTransport } from './nativePresenceTransport';
import { useThreadViewPresence } from '../threads/useThreadViewPresence';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function server() {
  const replace = vi.fn().mockResolvedValue({ accepted: true });
  const badge = vi.fn().mockResolvedValue({ epoch: 'native', revision: 1, count: 3 });
  const handler = new RPCHandler({
    replaceChatPresence: os.input(schemaType<Parameters<ChatClient['replaceChatPresence']>[0]>()).handler(({ input }) => replace(input)),
    getUnreadBadge: os.handler(() => badge()),
  });
  const fetch = vi.fn(async (request: Request, init: RequestInit) => {
    const result = await handler.handle(new Request(request, init), { prefix: '/rpc' });
    return result.matched ? result.response : new Response('No native route', { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  return { replace, badge, fetch };
}
it('uses typed HTTP RPC for native badges and exit presence without a WebSocket or handwritten envelopes', async () => {
  const { replace, fetch } = server();
  const websocket = vi.fn(() => { throw new Error('No WebSocket'); }); vi.stubGlobal('WebSocket', websocket);
  const client = createNativePresenceBadgeClient(() => `${window.location.origin}/rpc`, true);
  expect(await client.getUnreadBadge()).toEqual({ epoch: 'native', revision: 1, count: 3 });
  await client.replaceChatPresence({ clientId: 'tab', visibleThreadIds: [] });
  expect(replace).toHaveBeenCalledWith({ clientId: 'tab', visibleThreadIds: [] });
  expect(fetch.mock.calls[1][1]).toMatchObject({ keepalive: true, cache: 'no-store' });
  expect(websocket).not.toHaveBeenCalled();
});
it('binds the shared presence lifecycle to native HTTP and clears the same tab with keepalive', async () => {
  const { replace, fetch } = server();
  renderHook(() => useThreadViewPresence({ enabled: true, threadIds: ['native-chat'], transport: nativePresenceTransport }));
  await waitFor(() => expect(replace).toHaveBeenCalledOnce());
  const input = replace.mock.calls[0][0];
  expect(input).toMatchObject({ clientId: expect.any(String), visibleThreadIds: ['native-chat'] });
  expect(fetch.mock.calls[0][1].keepalive).toBe(false);
  act(() => window.dispatchEvent(new Event('pagehide')));
  await waitFor(() => expect(replace).toHaveBeenCalledTimes(2));
  expect(replace).toHaveBeenLastCalledWith({ clientId: input.clientId, visibleThreadIds: [] });
  expect(fetch.mock.calls[1][1].keepalive).toBe(true);
  expect(fetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual(['/rpc/replaceChatPresence', '/rpc/replaceChatPresence']);
});
