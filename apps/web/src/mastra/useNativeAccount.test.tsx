import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useNativeAccount } from './useNativeAccount';
import type { ChatClient } from './client';

type Account = Awaited<ReturnType<ChatClient['getAccount']>>;
const rpc = vi.hoisted(() => ({ watchAccount: vi.fn(), getAccountUsage: vi.fn(), logoutAccount: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: rpc }));
function stream() {
  let consumer: ((value: IteratorResult<Account>) => void) | undefined;
  return { publish(value: Account) { if (!consumer) throw new Error('No account consumer'); consumer({ value, done: false }); consumer = undefined; }, iterable: { [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<Account>>(resolve => { consumer = resolve; }) }; } } };
}
function account(id: string | null, revision = 1): Account {
  return { epoch: 'epoch', revision, authenticated: id !== null, account: id ? { id, label: `Account ${id}`, expiresAt: null, needsRefresh: false } : null } as Account;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useNativeAccount(), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}
function usage(accountId: string, usedPercent: number) { return { accountId, observedAt: new Date(0).toISOString(), primary: { usedPercent, windowDurationMins: 300, resetsAt: 0 }, secondary: null }; }
afterEach(() => { vi.clearAllMocks(); });
it('does not request provider usage for a fresh unauthenticated profile', async () => {
  const source = stream(); rpc.watchAccount.mockResolvedValue(source.iterable);
  const hook = mount();
  await waitFor(() => expect(rpc.watchAccount).toHaveBeenCalledOnce());
  await act(async () => source.publish(account(null)));
  expect(hook.result.current.snapshot?.authenticated).toBe(false);
  expect(rpc.getAccountUsage).not.toHaveBeenCalled();
});
it('aborts old usage and ignores its late reply after another native account becomes current', async () => {
  const source = stream(); rpc.watchAccount.mockResolvedValue(source.iterable);
  let releaseOld!: (value: unknown) => void; const signals: AbortSignal[] = [];
  rpc.getAccountUsage.mockImplementationOnce((_input, options) => { signals.push(options.signal); return new Promise(resolve => { releaseOld = resolve; }); })
    .mockResolvedValueOnce(usage('B', 20));
  const hook = mount();
  await waitFor(() => expect(rpc.watchAccount).toHaveBeenCalled());
  await act(async () => source.publish(account('A')));
  await waitFor(() => expect(rpc.getAccountUsage).toHaveBeenCalledOnce());
  await act(async () => source.publish(account('B', 2)));
  await waitFor(() => expect(hook.result.current.usage?.accountId).toBe('B'));
  expect(signals[0].aborted).toBe(true);
  await act(async () => releaseOld(usage('A', 99)));
  expect(hook.result.current.usage?.primary?.usedPercent).toBe(20);
  expect(hook.result.current.snapshot?.account?.id).toBe('B');
});
it('fences logout errors when same-account relogin arrives without an intermediate signed-out snapshot', async () => {
  const source = stream(); rpc.watchAccount.mockResolvedValue(source.iterable); rpc.getAccountUsage.mockResolvedValue(null);
  let rejectOld!: (value: unknown) => void; let signal!: AbortSignal;
  rpc.logoutAccount.mockImplementation((_input, options) => { signal = options.signal; return new Promise((_resolve, reject) => { rejectOld = reject; }); });
  const hook = mount();
  await waitFor(() => expect(rpc.watchAccount).toHaveBeenCalled());
  await act(async () => source.publish(account('A')));
  await act(async () => hook.result.current.logout());
  expect(hook.result.current.snapshot?.authenticated).toBe(true);
  expect(hook.result.current.logoutPending).toBe(true);
  // Coalesced native file notifications may skip the signed-out observation.
  await act(async () => source.publish(account('A', 3)));
  expect(signal.aborted).toBe(true);
  await act(async () => rejectOld(new Error('Old logout failed')));
  expect(hook.result.current.snapshot?.authenticated).toBe(true);
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.logoutPending).toBe(false);
});
it('does not treat a logout acknowledgment as a canonical account snapshot', async () => {
  const source = stream(); rpc.watchAccount.mockResolvedValue(source.iterable); rpc.getAccountUsage.mockResolvedValue(null); rpc.logoutAccount.mockResolvedValue(account(null, 99));
  const hook = mount();
  await waitFor(() => expect(rpc.watchAccount).toHaveBeenCalled());
  await act(async () => source.publish(account('A')));
  await act(async () => hook.result.current.logout());
  expect(hook.result.current.snapshot?.account?.id).toBe('A');
  expect(hook.result.current.snapshot?.revision).toBe(1);
  await act(async () => source.publish(account(null, 2)));
  expect(hook.result.current.snapshot?.authenticated).toBe(false);
});
