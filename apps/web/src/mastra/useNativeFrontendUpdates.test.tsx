import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatClient } from './client';
import { useNativeFrontendUpdates } from './useNativeFrontendUpdates';

const rpc = vi.hoisted(() => ({ watchFrontendUpdates: vi.fn(), checkWorker: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: rpc }));
vi.mock('../pwa/registerServiceWorker', () => ({ requestPwaUpdateCheck: rpc.checkWorker }));
type Snapshot = Awaited<ReturnType<ChatClient['watchFrontendUpdates']>> extends AsyncIterable<infer T> ? T : never;
function stream() {
  let consume: ((value: IteratorResult<Snapshot>) => void) | undefined;
  return {
    publish(value: Snapshot) { if (!consume) throw new Error('No native update consumer'); const next = consume; consume = undefined; next({ value, done: false }); },
    iterable: { [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<Snapshot>>(resolve => { consume = resolve; }) }; } },
  };
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('checks on native frontend publication and reconnect, ignoring an abandoned stream', async () => {
  rpc.checkWorker.mockResolvedValue(undefined);
  const first = stream(), reconnected = stream();
  rpc.watchFrontendUpdates.mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(reconnected.iterable);
  const hook = renderHook(() => useNativeFrontendUpdates('host'));
  await waitFor(() => expect(rpc.watchFrontendUpdates).toHaveBeenCalledOnce());
  const initial = { epoch: 'host-lifetime', revision: 0, buildRevision: null };
  await act(async () => first.publish(initial));
  expect(rpc.checkWorker).toHaveBeenCalledTimes(1);
  await act(async () => first.publish({ ...initial, revision: 1, buildRevision: 'next-build' }));
  expect(rpc.checkWorker).toHaveBeenCalledTimes(2);
  await act(async () => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(rpc.watchFrontendUpdates).toHaveBeenCalledTimes(2));
  expect(rpc.watchFrontendUpdates.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => first.publish({ ...initial, revision: 2, buildRevision: 'abandoned-build' }));
  expect(rpc.checkWorker).toHaveBeenCalledTimes(2);
  await act(async () => reconnected.publish({ ...initial, revision: 1, buildRevision: 'next-build' }));
  expect(rpc.checkWorker).toHaveBeenCalledTimes(3);
  hook.unmount();
  expect(rpc.watchFrontendUpdates.mock.calls[1][1].signal.aborted).toBe(true);
});
it('waits for native identity and contains worker-check failure without losing later update checks', async () => {
  rpc.checkWorker.mockRejectedValueOnce(new Error('Worker temporarily unavailable')).mockResolvedValue(undefined);
  const native = stream(); rpc.watchFrontendUpdates.mockResolvedValue(native.iterable);
  const hook = renderHook(({ id }) => useNativeFrontendUpdates(id), { initialProps: { id: null as string | null } });
  expect(rpc.watchFrontendUpdates).not.toHaveBeenCalled();
  hook.rerender({ id: 'host' });
  await waitFor(() => expect(rpc.watchFrontendUpdates).toHaveBeenCalledOnce());
  await act(async () => native.publish({ epoch: 'host', revision: 0, buildRevision: null }));
  await act(async () => native.publish({ epoch: 'host', revision: 1, buildRevision: 'build' }));
  expect(rpc.checkWorker).toHaveBeenCalledTimes(2);
});
