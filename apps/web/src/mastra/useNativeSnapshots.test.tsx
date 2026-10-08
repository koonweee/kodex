import { nativeReadStateFixture, nativeQueueFixture, nativeSettingsFixture } from './testBuilders';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSnapshot } from './client';
import { useNativeChat } from './useNativeSnapshots';

const rpc = vi.hoisted(() => ({ watchChat: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: rpc }));

function stream() {
  let failNext: ((error: unknown) => void) | null = null;
  let yieldNext: ((value: IteratorResult<ChatSnapshot>) => void) | null = null;
  return {
    fail(error: unknown) { if (!failNext) throw new Error("No awaiting consumer"); failNext(error); },
    publish(value: ChatSnapshot) { if (!yieldNext) throw new Error('No awaiting consumer'); const consumer = yieldNext; yieldNext = null; consumer({ value, done: false }); },
    iterable: { [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<ChatSnapshot>>((resolve, reject) => { yieldNext = resolve; failNext = reject; }) }; } },
  };
}
function snapshot(epoch: string, revision: number, title: string): ChatSnapshot {
  return { readState: nativeReadStateFixture(), epoch, revision, chat: { bindingId: 'binding', pinned: false, notificationsEnabled: true, id: 'chat', projectId: 'project', cwd: '/project', title, name: title }, error: null, prompts: [], goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(),
    history: { earliest: null, hasOlder: false }, display: defaultDisplayState(), messages: [] };
}
afterEach(() => { rpc.watchChat.mockReset(); });
describe('native chat snapshot subscription', () => {
  it('retains the visible snapshot while expanding, accepts equal-revision history, and reconnects at the returned boundary', async () => {
    const first = stream(); const older = stream(); const reconnect = stream();
    rpc.watchChat.mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(older.iterable).mockResolvedValueOnce(reconnect.iterable);
    const hook = renderHook(() => useNativeChat('chat'));
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(1));
    const initial = { ...snapshot('same', 4, 'Recent'), history: { earliest: 'recent', hasOlder: true } };
    await act(async () => first.publish(initial));
    await act(async () => { hook.result.current.loadOlderHistory(); hook.result.current.loadOlderHistory(); });
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(2));
    expect(rpc.watchChat.mock.calls[1][0]).toEqual({ chatId: 'chat', history: { earliest: 'recent', older: true } });
    expect(hook.result.current.snapshot).toBe(initial);
    expect(hook.result.current.isLoadingOlderHistory).toBe(true);
    await act(async () => older.publish({ ...initial, revision: 3, history: { earliest: 'stale', hasOlder: false } }));
    expect(hook.result.current.snapshot).toBe(initial);
    expect(hook.result.current.isLoadingOlderHistory).toBe(true);
    const expanded = { ...initial, history: { earliest: 'older', hasOlder: false }, messages: [{ id: 'old', role: 'user' as const, createdAt: new Date(0), content: { format: 2 as const, parts: [{ type: 'text' as const, text: 'Older input' }] } }] };
    await act(async () => older.publish(expanded));
    expect(hook.result.current.snapshot).toBe(expanded);
    expect(hook.result.current.isLoadingOlderHistory).toBe(false);
    await act(async () => first.publish({ ...initial, revision: 5 }));
    expect(hook.result.current.snapshot).toBe(expanded);
    await act(async () => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(3));
    expect(rpc.watchChat.mock.calls[2][0]).toEqual({ chatId: 'chat', history: { earliest: 'older' } });
    await act(async () => reconnect.publish({ ...expanded, messages: [] }));
    expect(hook.result.current.snapshot?.messages).toEqual([]);
  });
  it('surfaces expansion failures without dropping rows and retries the same request until canonical data arrives', async () => {
    const first = stream(); const failed = stream(); const recovered = stream();
    rpc.watchChat.mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(failed.iterable).mockResolvedValueOnce(recovered.iterable);
    const hook = renderHook(() => useNativeChat('chat'));
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(1));
    const initial = { ...snapshot('same', 4, 'Retained'), history: { earliest: 'recent', hasOlder: true } };
    await act(async () => first.publish(initial));
    await act(async () => hook.result.current.loadOlderHistory());
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(2));
    await act(async () => failed.fail(new Error('History unavailable')));
    expect(hook.result.current.error).toBe('History unavailable');
    expect(hook.result.current.snapshot).toBe(initial);
    expect(hook.result.current.isLoadingOlderHistory).toBe(false);
    await act(async () => hook.result.current.retry());
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(3));
    expect(rpc.watchChat.mock.calls[2][0]).toEqual({ chatId: 'chat', history: { earliest: 'recent', older: true } });
    expect(hook.result.current.isLoadingOlderHistory).toBe(true);
    await act(async () => recovered.publish({ ...initial, history: { earliest: 'older', hasOlder: false } }));
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.isLoadingOlderHistory).toBe(false);
  });
  it('resets history depth on target changes and ignores old expansion replies', async () => {
    const first = stream(); const older = stream(); const other = stream();
    rpc.watchChat.mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(older.iterable).mockResolvedValueOnce(other.iterable);
    const hook = renderHook(({ id }) => useNativeChat(id), { initialProps: { id: 'chat' } });
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(1));
    const initial = { ...snapshot('same', 4, 'Recent'), history: { earliest: 'recent', hasOlder: true } };
    await act(async () => first.publish(initial));
    await act(async () => hook.result.current.loadOlderHistory());
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(2));
    hook.rerender({ id: 'other' });
    expect(hook.result.current.snapshot).toBeNull();
    expect(hook.result.current.isLoadingOlderHistory).toBe(false);
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(3));
    expect(rpc.watchChat.mock.calls[2][0]).toEqual({ chatId: 'other' });
    await act(async () => older.publish({ ...initial, history: { earliest: 'old', hasOlder: false } }));
    expect(hook.result.current.snapshot).toBeNull();
    await act(async () => other.publish({ ...snapshot('same', 0, 'Other'), chat: { ...initial.chat, id: 'other' } }));
    expect(hook.result.current.snapshot?.chat.id).toBe('other');
    await act(async () => hook.result.current.loadOlderHistory());
    expect(rpc.watchChat).toHaveBeenCalledTimes(3);
  });
  it('does not let an old live reply erase an explicit older-history request before effect cleanup', async () => {
    const first = stream(); const expanded = stream();
    rpc.watchChat.mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(expanded.iterable);
    const hook = renderHook(() => useNativeChat('chat'));
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(1));
    const initial = { ...snapshot('same', 4, 'Chat'), history: { earliest: 'recent', hasOlder: true } };
    await act(async () => first.publish(initial));
    await act(async () => {
      hook.result.current.loadOlderHistory();
      first.publish({ ...initial, revision: 5 });
      await Promise.resolve();
    });
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(2));
    expect(rpc.watchChat.mock.calls[1][0]).toEqual({ chatId: 'chat', history: { earliest: 'recent', older: true } });
    expect(hook.result.current.isLoadingOlderHistory).toBe(true);
    await act(async () => expanded.publish({ ...initial, revision: 5, history: { earliest: 'older', hasOlder: false } }));
    expect(hook.result.current.snapshot?.history.earliest).toBe('older');
  });
  it('keeps history depth independent in two panes while each converges from its own canonical watch', async () => {
    const first = stream(); const second = stream(); const expanded = stream(); const firstReconnect = stream(); const secondReconnect = stream();
    rpc.watchChat.mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(second.iterable).mockResolvedValueOnce(expanded.iterable)
      .mockResolvedValueOnce(firstReconnect.iterable).mockResolvedValueOnce(secondReconnect.iterable);
    const hook = renderHook(() => ({ first: useNativeChat('chat'), second: useNativeChat('chat') }));
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(2));
    const initial = { ...snapshot('same', 4, 'Same chat'), history: { earliest: 'recent', hasOlder: true } };
    await act(async () => { first.publish(initial); second.publish(initial); });
    await act(async () => hook.result.current.first.loadOlderHistory());
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(3));
    expect(hook.result.current.second.isLoadingOlderHistory).toBe(false);
    await act(async () => expanded.publish({ ...initial, history: { earliest: 'older', hasOlder: true } }));
    expect(hook.result.current.second.snapshot?.history.earliest).toBe('recent');
    await act(async () => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(5));
    expect(rpc.watchChat.mock.calls[3][0]).toEqual({ chatId: 'chat', history: { earliest: 'older' } });
    expect(rpc.watchChat.mock.calls[4][0]).toEqual({ chatId: 'chat', history: { earliest: 'recent' } });
    await act(async () => {
      firstReconnect.publish({ ...initial, revision: 5, chat: { ...initial.chat, title: 'Changed elsewhere' }, history: { earliest: 'older', hasOlder: true } });
      secondReconnect.publish({ ...initial, revision: 5, chat: { ...initial.chat, title: 'Changed elsewhere' } });
    });
    expect(hook.result.current.first.snapshot?.chat.title).toBe('Changed elsewhere');
    expect(hook.result.current.second.snapshot?.chat.title).toBe('Changed elsewhere');
  });
  it('aborts old subscriptions on foreground recovery and fences their late replies', async () => {
    const first = stream(); const second = stream(); const signals: AbortSignal[] = [];
    rpc.watchChat.mockImplementationOnce((_input, options) => { signals.push(options.signal); return Promise.resolve(first.iterable); })
      .mockImplementationOnce((_input, options) => { signals.push(options.signal); return Promise.resolve(second.iterable); });
    const hook = renderHook(() => useNativeChat('chat'));
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(1));
    await act(async () => first.publish(snapshot('old', 9, 'Before restart')));
    expect(hook.result.current.snapshot?.chat.title).toBe('Before restart');
    await act(async () => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(true);
    await act(async () => second.publish(snapshot('new', 0, 'After restart')));
    await act(async () => first.publish(snapshot('old', 10, 'Late old reply')));
    expect(hook.result.current.snapshot?.chat.title).toBe('After restart');
    expect(hook.result.current.snapshot?.epoch).toBe('new');
    hook.unmount(); expect(signals[1].aborted).toBe(true);
  });
  it('clears disconnect errors and accepts fresh initial data at an unchanged revision', async () => {
    const first = stream(); const next = stream();
    rpc.watchChat.mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(next.iterable);
    const hook = renderHook(() => useNativeChat('chat'));
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(1));
    await act(async () => first.publish(snapshot('same', 4, 'Before disconnect')));
    await act(async () => first.fail(new Error('Disconnected')));
    expect(hook.result.current.error).toBe('Disconnected');
    await act(async () => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(2));
    await act(async () => next.publish(snapshot('same', 4, 'Native title refreshed')));
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.snapshot?.chat.title).toBe('Native title refreshed');
  });
  it('drops older same-epoch snapshots and clears old chat data when the pane changes target', async () => {
    const first = stream(); const next = stream();
    rpc.watchChat.mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(next.iterable);
    const hook = renderHook(({ id }) => useNativeChat(id), { initialProps: { id: 'chat' } });
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(1));
    await act(async () => first.publish(snapshot('same', 4, 'Fresh')));
    await act(async () => first.publish(snapshot('same', 3, 'Stale')));
    expect(hook.result.current.snapshot?.chat.title).toBe('Fresh');
    hook.rerender({ id: 'other' });
    expect(hook.result.current.snapshot).toBeNull();
    await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(2));
    await act(async () => next.publish({ ...snapshot('other', 0, 'Other'), chat: { bindingId: 'binding', pinned: false, notificationsEnabled: true, id: 'other', title: 'Other', name: 'Other', cwd: '/project', projectId: 'project' } }));
    expect(hook.result.current.snapshot?.chat.id).toBe('other');
  });
});
