import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { TimelinePresentation } from '../timeline/TimelineView';
import { useNativeOptimisticMessages } from './useNativeOptimisticMessages';

const empty: TimelinePresentation = { rows: [], hiddenItems: [], hasOlderHistory: false, isLoadingOlderHistory: false, lastSeq: 1, pendingApprovalRequests: [], pendingUserInputRequests: [] };
it('retains accepted attempts across unrelated snapshots and replaces only canonical client IDs', () => {
  const { result, rerender } = renderHook(({ chatId, timeline }) => useNativeOptimisticMessages(chatId, timeline), { initialProps: { chatId: 'chat', timeline: empty } });
  act(() => {
    result.current.onOptimisticUserMessageStarted({ threadId: 'chat', clientRequestId: 'one', text: 'Same text', skillMentions: [] });
    result.current.onOptimisticUserMessageStarted({ threadId: 'chat', clientRequestId: 'two', text: 'Same text', skillMentions: [] });
  });
  expect(result.current.timeline?.rows).toHaveLength(2);
  act(() => result.current.onOptimisticUserMessageSent('one'));
  rerender({ chatId: 'chat', timeline: { ...empty, lastSeq: 2 } });
  expect(result.current.timeline?.rows).toHaveLength(2);
  const row = result.current.timeline!.rows[0];
  if (row.type !== 'item') throw new Error('Expected user item');
  const canonical: TimelinePresentation = { ...empty, rows: [{ ...row, key: 'native', item: { ...row.item, id: 'native', source: 'app_server' } }] };
  rerender({ chatId: 'chat', timeline: canonical });
  expect(result.current.timeline?.rows.map(row => row.key)).toEqual(['native', 'optimistic-user-two']);
  act(() => result.current.onOptimisticUserMessageSent('one'));
  expect(result.current.timeline?.rows).toHaveLength(2);
  act(() => result.current.onOptimisticUserMessageRemoved('two'));
  expect(result.current.timeline?.rows.map(row => row.key)).toEqual(['native']);
  rerender({ chatId: 'chat', timeline: empty });
  expect(result.current.timeline?.rows).toHaveLength(0);
});
it('does not leak attempts or late callbacks into a different chat', () => {
  const { result, rerender } = renderHook(({ chatId }) => useNativeOptimisticMessages(chatId, empty), { initialProps: { chatId: 'first' } });
  const started = result.current.onOptimisticUserMessageStarted;
  act(() => started({ threadId: 'first', clientRequestId: 'one', text: 'First chat', skillMentions: [] }));
  rerender({ chatId: 'second' });
  expect(result.current.timeline?.rows).toHaveLength(0);
  act(() => { started({ threadId: 'first', clientRequestId: 'late', text: 'Late', skillMentions: [] }); result.current.onOptimisticUserMessageSent('one'); });
  expect(result.current.timeline?.rows).toHaveLength(0);
  rerender({ chatId: 'first' });
  expect(result.current.timeline?.rows).toHaveLength(0);
});
