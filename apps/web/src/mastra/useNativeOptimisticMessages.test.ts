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

function canonicalRow(id: string, kind = 'assistant_message', clientId?: string): TimelinePresentation['rows'][number] {
  return { type: 'item', key: id, displayOrder: 0, turnId: null, turnKey: id, item: {
    id, kind, clientId, text: id, displayOrder: 0, turnId: null, debugEvents: [], payload: {}, status: 'completed',
  } };
}
it('keeps an idle send before new native activity until its canonical user message arrives', () => {
  const prior = canonicalRow('previous-answer');
  const start = { ...empty, rows: [prior] };
  const { result, rerender } = renderHook(({ timeline }) => useNativeOptimisticMessages('chat', timeline), { initialProps: { timeline: start } });
  act(() => result.current.onOptimisticUserMessageStarted({ threadId: 'chat', clientRequestId: 'new', text: 'Next request', skillMentions: [] }));
  const activity = canonicalRow('new-activity', 'dynamic_tool_call');
  rerender({ timeline: { ...start, rows: [prior, activity], lastSeq: 2 } });
  expect(result.current.timeline?.rows.map(row => row.key)).toEqual(['previous-answer', 'optimistic-user-new', 'new-activity']);
  act(() => result.current.onOptimisticUserMessageSent('new'));
  rerender({ timeline: { ...start, rows: [canonicalRow('older-history'), prior, activity], lastSeq: 3 } });
  expect(result.current.timeline?.rows.map(row => row.key)).toEqual(['older-history', 'previous-answer', 'optimistic-user-new', 'new-activity']);
  const user = canonicalRow('native-user', 'user_message', 'new');
  rerender({ timeline: { ...start, rows: [prior, user, activity], lastSeq: 4 } });
  expect(result.current.timeline?.rows.map(row => row.key)).toEqual(['previous-answer', 'native-user', 'new-activity']);
});
it('keeps multiple pending sends ordered when an earlier one becomes canonical', () => {
  const { result, rerender } = renderHook(({ timeline }) => useNativeOptimisticMessages('chat', timeline), { initialProps: { timeline: empty } });
  act(() => {
    result.current.onOptimisticUserMessageStarted({ threadId: 'chat', clientRequestId: 'one', text: 'First', skillMentions: [] });
    result.current.onOptimisticUserMessageStarted({ threadId: 'chat', clientRequestId: 'two', text: 'Second', skillMentions: [] });
  });
  const activity = canonicalRow('activity', 'dynamic_tool_call');
  rerender({ timeline: { ...empty, rows: [activity], lastSeq: 2 } });
  expect(result.current.timeline?.rows.map(row => row.key)).toEqual(['optimistic-user-one', 'optimistic-user-two', 'activity']);
  rerender({ timeline: { ...empty, rows: [canonicalRow('native-one', 'user_message', 'one'), activity], lastSeq: 3 } });
  expect(result.current.timeline?.rows.map(row => row.key)).toEqual(['native-one', 'optimistic-user-two', 'activity']);
});
