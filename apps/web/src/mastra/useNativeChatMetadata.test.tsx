import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useNativeChatMetadata } from './useNativeChatMetadata';
const rpc = vi.hoisted(() => ({ setChatPinned: vi.fn(), setChatNotifications: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: rpc }));
afterEach(() => { vi.resetAllMocks(); });
it('keeps pins pending and sends explicit order intent without silently adding a target', async () => {
  let acknowledge!: () => void;
  rpc.setChatPinned.mockReturnValueOnce(new Promise<void>(resolve => { acknowledge = resolve; })).mockResolvedValue({ accepted: true });
  const hook = renderHook(() => useNativeChatMetadata('epoch', vi.fn()));
  await act(async () => { hook.result.current.pin('chat'); hook.result.current.pin('chat'); });
  expect(hook.result.current.pinPending).toBe(true);
  expect(rpc.setChatPinned).toHaveBeenCalledOnce();
  expect(rpc.setChatPinned).toHaveBeenCalledWith({ chatId: 'chat', pinned: true }, { signal: expect.any(AbortSignal) });
  await act(async () => acknowledge());
  expect(hook.result.current.pinPending).toBe(false);
  await act(async () => hook.result.current.movePinned('chat', null));
  expect(rpc.setChatPinned).toHaveBeenLastCalledWith({ chatId: 'chat', pinned: true, beforeChatId: null }, { signal: expect.any(AbortSignal) });
  await act(async () => hook.result.current.unpin('chat'));
  expect(rpc.setChatPinned).toHaveBeenLastCalledWith({ chatId: 'chat', pinned: false }, { signal: expect.any(AbortSignal) });
});
it('reports rejected commands once, releases pending state, and never retries automatically', async () => {
  const failure = new Error('Chat unavailable'); const onError = vi.fn();
  rpc.setChatPinned.mockRejectedValue(failure); rpc.setChatNotifications.mockRejectedValue(failure);
  const hook = renderHook(() => useNativeChatMetadata('epoch', onError));
  await act(async () => hook.result.current.pin('chat'));
  await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
  expect(hook.result.current.pinPending).toBe(false);
  await act(async () => hook.result.current.setNotifications('chat', false));
  expect(rpc.setChatNotifications).toHaveBeenCalledWith({ chatId: 'chat', enabled: false }, { signal: expect.any(AbortSignal) });
  expect(rpc.setChatPinned).toHaveBeenCalledOnce(); expect(rpc.setChatNotifications).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenCalledTimes(2);
});
it('aborts obsolete commands and ignores their errors after restart or removal', async () => {
  let reject!: (error: Error) => void;
  rpc.setChatPinned.mockImplementation((_input, _options) => new Promise((_resolve, fail) => { reject = fail; }));
  rpc.setChatNotifications.mockReturnValue(new Promise(() => {}));
  const onError = vi.fn(); const hook = renderHook(({ epoch }) => useNativeChatMetadata(epoch, onError), { initialProps: { epoch: 'old' } });
  await act(async () => hook.result.current.pin('chat'));
  const signal = rpc.setChatPinned.mock.calls[0][1].signal as AbortSignal;
  hook.rerender({ epoch: 'new' });
  expect(signal.aborted).toBe(true); expect(hook.result.current.pinPending).toBe(false);
  await act(async () => reject(new Error('Old request failed')));
  expect(onError).not.toHaveBeenCalled();
  await act(async () => hook.result.current.setNotifications('chat', true));
  const notificationSignal = rpc.setChatNotifications.mock.calls[0][1].signal as AbortSignal;
  hook.unmount(); expect(notificationSignal.aborted).toBe(true);
});

it('allows a newer explicit notification choice while the earlier reply remains pending', async () => {
  let firstReply!: () => void;
  rpc.setChatNotifications.mockReturnValueOnce(new Promise<void>(resolve => { firstReply = resolve; })).mockResolvedValue({ accepted: true });
  const hook = renderHook(() => useNativeChatMetadata('epoch', vi.fn()));
  await act(async () => hook.result.current.setNotifications('chat', false));
  // A canonical watch can show the first change before its command reply arrives.
  await act(async () => hook.result.current.setNotifications('chat', true));
  expect(rpc.setChatNotifications).toHaveBeenNthCalledWith(1, { chatId: 'chat', enabled: false }, { signal: expect.any(AbortSignal) });
  expect(rpc.setChatNotifications).toHaveBeenNthCalledWith(2, { chatId: 'chat', enabled: true }, { signal: expect.any(AbortSignal) });
  await act(async () => firstReply());
  expect(rpc.setChatNotifications).toHaveBeenCalledTimes(2);
});
