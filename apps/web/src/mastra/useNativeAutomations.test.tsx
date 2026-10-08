import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useNativeAutomations } from './useNativeAutomations';
import { mastraClient, type ChatClient } from './client';
import { listAutomations, updateAutomation } from '../api/client';
import type { NativeAutomation, NativeAutomationInput } from './nativeAutomationTypes';

vi.mock('./client', () => ({ mastraClient: { watchAutomations: vi.fn(), createAutomation: vi.fn(), updateAutomation: vi.fn(), pauseAutomation: vi.fn(), resumeAutomation: vi.fn(), deleteAutomation: vi.fn() } }));
vi.mock('../api/client', async original => ({ ...await original<typeof import('../api/client')>(), listAutomations: vi.fn(), updateAutomation: vi.fn() }));
type Snapshot = Awaited<ReturnType<ChatClient['watchAutomations']>> extends AsyncIterable<infer T> ? T : never;
function stream() {
  let receive: ((value: IteratorResult<Snapshot>) => void) | undefined;
  return { publish(rows: NativeAutomation[], revision = 1) {
    if (!receive) throw new Error('Missing native consumer'); const next = receive; receive = undefined;
    next({ value: { epoch: '00000000-0000-0000-0000-000000000001', revision, rows }, done: false });
  }, iterable: (async function* () { while (true) { const next = await new Promise<IteratorResult<Snapshot>>(resolve => { receive = resolve; }); if (next.done) return; yield next.value; } })() };
}
const original: NativeAutomation = { id: 'schedule', name: 'Review', prompt: 'Original prompt', targetThreadId: 'chat', cron: '0 9 * * *', timezone: 'UTC', status: 'active', createdAt: 1, updatedAt: 1, nextFireAt: 2 };
const input: NativeAutomationInput = { name: original.name, prompt: original.prompt, targetThreadId: original.targetThreadId, cron: original.cron, timezone: original.timezone! };
afterEach(() => vi.resetAllMocks());

it('sends sparse captured-baseline changes including retarget, skips no-ops and refills without adopting command responses', async () => {
  const first = stream(), refill = stream();
  vi.mocked(mastraClient.watchAutomations).mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(refill.iterable);
  vi.mocked(mastraClient.updateAutomation).mockResolvedValue({ ...original, name: 'Command response only' });
  const hook = renderHook(() => useNativeAutomations(true));
  await waitFor(() => expect(mastraClient.watchAutomations).toHaveBeenCalledOnce());
  const peer = { ...original, prompt: 'Peer prompt', updatedAt: 3 };
  await act(async () => first.publish([peer]));
  await act(async () => { expect(await hook.result.current.update(original.id, input, original)).toEqual(peer); });
  expect(mastraClient.updateAutomation).not.toHaveBeenCalled();
  expect(mastraClient.watchAutomations).toHaveBeenCalledOnce();
  await act(async () => { await hook.result.current.update(original.id, { ...input, name: 'Local name', targetThreadId: 'cross-project-chat' }, original); });
  expect(mastraClient.updateAutomation).toHaveBeenCalledWith({ id: original.id, patch: { name: 'Local name', targetThreadId: 'cross-project-chat' } });
  await waitFor(() => expect(mastraClient.watchAutomations).toHaveBeenCalledTimes(2));
  expect(vi.mocked(mastraClient.watchAutomations).mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(hook.result.current.rows).toEqual([peer]);
  await act(async () => first.publish([{ ...original, name: 'Late old reply' }], 4));
  expect(hook.result.current.rows).toEqual([peer]);
  await act(async () => refill.publish([{ ...peer, name: 'Local name', targetThreadId: 'cross-project-chat' }], 1));
  expect(hook.result.current.rows[0]).toMatchObject({ name: 'Local name', prompt: 'Peer prompt', targetThreadId: 'cross-project-chat' });
  expect(listAutomations).not.toHaveBeenCalled(); expect(updateAutomation).not.toHaveBeenCalled();
});

it('lets two clients converge from independent authoritative snapshots after native creation and pause/resume/delete', async () => {
  const first = stream(), second = stream(), refills = [stream(), stream(), stream(), stream()];
  vi.mocked(mastraClient.watchAutomations).mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(second.iterable);
  for (const next of refills) vi.mocked(mastraClient.watchAutomations).mockResolvedValueOnce(next.iterable);
  vi.mocked(mastraClient.createAutomation).mockResolvedValue(original);
  vi.mocked(mastraClient.pauseAutomation).mockResolvedValue({ ...original, status: 'paused' });
  vi.mocked(mastraClient.resumeAutomation).mockResolvedValue(original);
  vi.mocked(mastraClient.deleteAutomation).mockResolvedValue({ id: original.id });
  const one = renderHook(() => useNativeAutomations(true)), two = renderHook(() => useNativeAutomations(true));
  await waitFor(() => expect(mastraClient.watchAutomations).toHaveBeenCalledTimes(2));
  await act(async () => { first.publish([]); second.publish([]); });
  await act(async () => { await one.result.current.create(input); });
  await waitFor(() => expect(mastraClient.watchAutomations).toHaveBeenCalledTimes(3));
  expect(one.result.current.rows).toEqual([]); expect(two.result.current.rows).toEqual([]);
  await act(async () => { refills[0].publish([original]); second.publish([original], 2); });
  expect(one.result.current.rows).toEqual(two.result.current.rows);
  await act(async () => { await one.result.current.pause(original.id); });
  await waitFor(() => expect(mastraClient.watchAutomations).toHaveBeenCalledTimes(4));
  expect(two.result.current.rows[0].status).toBe('active');
  await act(async () => { refills[1].publish([{ ...original, status: 'paused' }], 2); second.publish([{ ...original, status: 'paused' }], 3); });
  expect(one.result.current.rows[0].status).toBe('paused'); expect(two.result.current.rows[0].status).toBe('paused');
  await act(async () => { await one.result.current.resume(original.id); });
  await waitFor(() => expect(mastraClient.watchAutomations).toHaveBeenCalledTimes(5));
  await act(async () => refills[2].publish([original], 3));
  await act(async () => { await one.result.current.remove(original.id); });
  await waitFor(() => expect(mastraClient.watchAutomations).toHaveBeenCalledTimes(6));
  await act(async () => { refills[3].publish([], 4); second.publish([], 4); });
  expect(one.result.current.rows).toEqual([]); expect(two.result.current.rows).toEqual([]);
  expect(mastraClient.createAutomation).toHaveBeenCalledWith(input);
  expect(mastraClient.pauseAutomation).toHaveBeenCalledWith({ id: original.id });
  expect(mastraClient.resumeAutomation).toHaveBeenCalledWith({ id: original.id });
  expect(mastraClient.deleteAutomation).toHaveBeenCalledWith({ id: original.id });
  expect(listAutomations).not.toHaveBeenCalled();
});

it('does not watch while hidden and exposes native read/write errors without REST fallback or automatic mutation retry', async () => {
  vi.mocked(mastraClient.watchAutomations).mockRejectedValue(new Error('Native schedules unavailable'));
  vi.mocked(mastraClient.createAutomation).mockRejectedValue(new Error('Native cron rejected'));
  const hook = renderHook(enabled => useNativeAutomations(enabled), { initialProps: false });
  expect(mastraClient.watchAutomations).not.toHaveBeenCalled();
  hook.rerender(true);
  await waitFor(() => expect(hook.result.current.error).toBe('Native schedules unavailable'));
  expect(hook.result.current.isLoading).toBe(false);
  await act(async () => { await expect(hook.result.current.create(input)).rejects.toThrow('Native cron rejected'); });
  expect(mastraClient.createAutomation).toHaveBeenCalledOnce();
  expect(listAutomations).not.toHaveBeenCalled();
});
