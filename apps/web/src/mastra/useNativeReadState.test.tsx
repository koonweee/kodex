import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import type { ChatSnapshot } from './client';
import { useNativeReadState } from './useNativeReadState';

const rpc = vi.hoisted(() => ({ markChatSeen: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: rpc }));
type ReadSnapshot = Pick<ChatSnapshot, 'chat' | 'readState' | 'display' | 'messages'>;
function snapshot(): ReadSnapshot {
  return { chat: { id: 'chat', bindingId: 'binding', projectId: null, cwd: '/project', title: 'Chat', name: null, pinned: false, notificationsEnabled: true },
    readState: { epoch: 'native-epoch', revision: 4, head: { runId: 'run', messageId: 'answer', reason: 'complete' }, seen: false },
    display: defaultDisplayState(), messages: [{ id: 'answer', role: 'assistant', createdAt: new Date(0), content: { format: 2, parts: [{ type: 'text', text: 'Answer' }] } }] };
}
const handlers = { onRefresh: vi.fn(), onError: vi.fn() };
function visibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
}
beforeEach(() => { visibility('visible'); rpc.markChatSeen.mockResolvedValue({ outcome: 'accepted', state: { ...snapshot().readState, seen: true } }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); visibility('visible'); });

it('acknowledges an exact native assistant head only in a visible pane and foreground document', async () => {
  const current = snapshot();
  const view = renderHook(({ isVisible }) => useNativeReadState({ snapshot: current, isVisible, ...handlers }), { initialProps: { isVisible: false } });
  expect(rpc.markChatSeen).not.toHaveBeenCalled();
  act(() => visibility('hidden'));
  view.rerender({ isVisible: true });
  expect(rpc.markChatSeen).not.toHaveBeenCalled();
  act(() => visibility('visible'));
  await waitFor(() => expect(rpc.markChatSeen).toHaveBeenCalledWith({ chatId: 'chat', epoch: 'native-epoch', revision: 4, runId: 'run' }));
  view.rerender({ isVisible: true });
  expect(rpc.markChatSeen).toHaveBeenCalledOnce();
  expect(current.readState.seen).toBe(false);
});

it('requires a native head and a visible assistant or terminal notice, never inferring a head from idle presentation', async () => {
  const current = { ...snapshot(), display: { ...defaultDisplayState(), isRunning: true } };
  const view = renderHook(({ value }) => useNativeReadState({ snapshot: value, isVisible: true, ...handlers }), { initialProps: { value: { ...current, display: defaultDisplayState(), readState: { ...current.readState, head: null } } as ReadSnapshot } });
  view.rerender({ value: { ...current, readState: { ...current.readState, seen: null } } });
  view.rerender({ value: { ...current, readState: { ...current.readState, seen: true } } });
  view.rerender({ value: { ...current, readState: { ...current.readState, head: { ...current.readState.head!, messageId: null } } } });
  view.rerender({ value: { ...current, messages: [{ ...current.messages[0], role: 'user' }] } });
  view.rerender({ value: { ...current, messages: [{ ...current.messages[0], id: 'old-answer' }] } });
  expect(rpc.markChatSeen).not.toHaveBeenCalled();
  const display = defaultDisplayState(); display.currentMessage = current.messages[0] as NonNullable<typeof display.currentMessage>;
  view.rerender({ value: { ...current, display, messages: [] } });
  await waitFor(() => expect(rpc.markChatSeen).toHaveBeenCalledOnce());
});

it('refills on conflict without retrying the same head and accepts a newer canonical head', async () => {
  const current = snapshot();
  rpc.markChatSeen.mockResolvedValueOnce({ outcome: 'conflict', state: current.readState });
  const view = renderHook(({ value }) => useNativeReadState({ snapshot: value, isVisible: true, ...handlers }), { initialProps: { value: current } });
  await waitFor(() => expect(handlers.onRefresh).toHaveBeenCalledOnce());
  view.rerender({ value: { ...current } });
  expect(rpc.markChatSeen).toHaveBeenCalledOnce();
  view.rerender({ value: { ...current, readState: { ...current.readState, revision: 5, head: { runId: 'next', messageId: 'answer', reason: 'aborted' } } } });
  await waitFor(() => expect(rpc.markChatSeen).toHaveBeenLastCalledWith({ chatId: 'chat', epoch: 'native-epoch', revision: 5, runId: 'next' }));
});

it('allows foreground recovery after transport failure without changing authoritative seen state', async () => {
  const current = snapshot();
  rpc.markChatSeen.mockRejectedValueOnce(new TypeError('Offline'));
  renderHook(() => useNativeReadState({ snapshot: current, isVisible: true, ...handlers }));
  await waitFor(() => expect(handlers.onError).toHaveBeenCalledOnce());
  expect(rpc.markChatSeen).toHaveBeenCalledOnce();
  act(() => visibility('hidden')); act(() => visibility('visible'));
  await waitFor(() => expect(rpc.markChatSeen).toHaveBeenCalledTimes(2));
  expect(current.readState.seen).toBe(false);
});

it.each(['selection', 'unmount', 'epoch'] as const)('ignores late failures after %s changes', async change => {
  const current = snapshot(); let fail!: (error: Error) => void;
  rpc.markChatSeen.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const view = renderHook(({ value }) => useNativeReadState({ snapshot: value, isVisible: true, ...handlers }), { initialProps: { value: current } });
  await waitFor(() => expect(rpc.markChatSeen).toHaveBeenCalledOnce());
  if (change === 'unmount') view.unmount();
  else view.rerender({ value: change === 'selection' ? { ...current, chat: { ...current.chat, id: 'other', bindingId: 'other-binding' }, readState: { ...current.readState, head: null } } : { ...current, readState: { ...current.readState, epoch: 'restart', head: null } } });
  await act(async () => fail(new Error('Old failure')));
  expect(handlers.onError).not.toHaveBeenCalled(); expect(handlers.onRefresh).not.toHaveBeenCalled();
});

it('allows recovery on a fresh canonical snapshot with the same read tuple without retrying on render alone', async () => {
  const current = snapshot();
  rpc.markChatSeen.mockRejectedValueOnce(new TypeError('Offline'));
  const view = renderHook(({ value }) => useNativeReadState({ snapshot: value, isVisible: true, ...handlers }), { initialProps: { value: current } });
  await waitFor(() => expect(handlers.onError).toHaveBeenCalledOnce());
  view.rerender({ value: current });
  expect(rpc.markChatSeen).toHaveBeenCalledOnce();
  view.rerender({ value: { ...current } });
  await waitFor(() => expect(rpc.markChatSeen).toHaveBeenCalledTimes(2));
});

it('does not refill a replacement chat when a stale acknowledgment returns a conflict', async () => {
  const current = snapshot(); let finish!: () => void;
  rpc.markChatSeen.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ outcome: 'conflict', state: current.readState }); }));
  const view = renderHook(({ value }) => useNativeReadState({ snapshot: value, isVisible: true, ...handlers }), { initialProps: { value: current } });
  await waitFor(() => expect(rpc.markChatSeen).toHaveBeenCalledOnce());
  view.rerender({ value: { ...current, chat: { ...current.chat, id: 'other', bindingId: 'next' }, readState: { ...current.readState, head: null } } });
  await act(async () => finish());
  expect(handlers.onRefresh).not.toHaveBeenCalled(); expect(handlers.onError).not.toHaveBeenCalled();
});
