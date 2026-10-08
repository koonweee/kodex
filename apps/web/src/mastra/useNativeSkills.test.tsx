import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useNativeSkills } from './useNativeSkills';

const rpc = vi.hoisted(() => ({ listSkills: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: rpc }));
const skill = (name: string) => ({ name, description: `${name} instructions`, path: `/skills/${name}/SKILL.md` });
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const scope = { chatId: 'chat', projectId: 'project', epoch: 'epoch', cwd: '/project', enabled: true };
afterEach(() => vi.resetAllMocks());
it('reads native skills for the chat and maps only supported display fields', async () => {
  rpc.listSkills.mockResolvedValue({ skills: [skill('review')] });
  const hook = renderHook(() => useNativeSkills(scope), { wrapper: wrapper() });
  await waitFor(() => expect(hook.result.current.skills).toEqual([{ ...skill('review'), enabled: true }]));
  expect(rpc.listSkills).toHaveBeenCalledWith({ chatId: 'chat' }, { signal: expect.any(AbortSignal) });
  expect(hook.result.current.error).toBeNull(); expect(hook.result.current.loading).toBe(false);
});
it('isolates draft projects and authoritative epoch/cwd changes while old requests settle', async () => {
  let finish!: (value: unknown) => void;
  rpc.listSkills.mockResolvedValueOnce({ skills: [skill('first')] })
    .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ skills: [skill('new-epoch')] })
    .mockResolvedValueOnce({ skills: [skill('new-cwd')] });
  const hook = renderHook(value => useNativeSkills(value), { initialProps: { ...scope, chatId: null as string | null }, wrapper: wrapper() });
  await waitFor(() => expect(hook.result.current.skills[0]?.name).toBe('first'));
  hook.rerender({ ...scope, chatId: null, projectId: 'other', cwd: '/other' });
  expect(hook.result.current.skills).toEqual([]); expect(hook.result.current.loading).toBe(true);
  await waitFor(() => expect(rpc.listSkills).toHaveBeenCalledTimes(2));
  const oldSignal = rpc.listSkills.mock.calls[1][1].signal as AbortSignal;
  hook.rerender({ ...scope, chatId: null, projectId: 'other', cwd: '/other', epoch: 'new-epoch' });
  expect(oldSignal.aborted).toBe(true);
  await waitFor(() => expect(hook.result.current.skills[0]?.name).toBe('new-epoch'));
  await act(async () => finish({ skills: [skill('late-old-project')] }));
  expect(hook.result.current.skills[0]?.name).toBe('new-epoch');
  hook.rerender({ ...scope, chatId: null, projectId: 'other', cwd: '/moved', epoch: 'new-epoch' });
  await waitFor(() => expect(hook.result.current.skills[0]?.name).toBe('new-cwd'));
  expect(rpc.listSkills.mock.calls.map(call => call[0])).toEqual([{ projectId: 'project' }, { projectId: 'other' }, { projectId: 'other' }, { projectId: 'other' }]);
});
it('returns an empty supplied catalog while disabled and surfaces native read errors without another source', async () => {
  rpc.listSkills.mockRejectedValue(new Error('Native skill catalog unavailable'));
  const hook = renderHook(value => useNativeSkills(value), { initialProps: { ...scope, enabled: false }, wrapper: wrapper() });
  expect(hook.result.current).toEqual({ skills: [], error: null, loading: false }); expect(rpc.listSkills).not.toHaveBeenCalled();
  hook.rerender(scope);
  await waitFor(() => expect(hook.result.current.error).toBe('Native skill catalog unavailable'));
  expect(hook.result.current.skills).toEqual([]); expect(hook.result.current.loading).toBe(false); expect(rpc.listSkills).toHaveBeenCalledOnce();
});
