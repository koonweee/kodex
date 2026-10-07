import { nativeQueueFixture, nativeSettingsFixture } from './testBuilders';
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
  return { epoch, revision, chat: { id: 'chat', projectId: 'project', cwd: '/project', title }, error: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(),
    display: defaultDisplayState(), messages: [] };
}
afterEach(() => { rpc.watchChat.mockReset(); });
describe('native chat snapshot subscription', () => {
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
    await act(async () => next.publish({ ...snapshot('other', 0, 'Other'), chat: { id: 'other', title: 'Other', cwd: '/project', projectId: 'project' } }));
    expect(hook.result.current.snapshot?.chat.id).toBe('other');
  });
});
