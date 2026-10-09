import { useCallback, useEffect, useRef, useState } from 'react';
import type { OptimisticUserMessageCallbacks } from '../composer/useComposerOrchestration';
import type { TimelinePresentation } from '../timeline/TimelineView';
import type { TimelineRow } from '../timeline/state';

type Input = Parameters<NonNullable<OptimisticUserMessageCallbacks['onOptimisticUserMessageStarted']>>[0];
type Message = Input & { sent: boolean; timestampMs: number; afterRows: ReadonlySet<string>; afterClients: ReadonlySet<string> };

export function useNativeOptimisticMessages(chatId: string | null, canonical: TimelinePresentation | null) {
  const [pending, setPending] = useState<Message[]>([]);
  const currentChat = useRef(chatId);
  currentChat.current = chatId;
  const currentCanonical = useRef(canonical);
  currentCanonical.current = canonical;
  useEffect(() => { setPending(messages => messages.length ? [] : messages); }, [chatId]);
  useEffect(() => {
    const ids = new Set(canonical?.rows.flatMap(row => row.type === 'item' && row.item.kind === 'user_message' && row.item.clientId ? [row.item.clientId] : []));
    setPending(messages => messages.some(message => ids.has(message.clientRequestId)) ? messages.filter(message => !ids.has(message.clientRequestId)) : messages);
  }, [canonical]);
  const onOptimisticUserMessageStarted = useCallback((message: Input) => {
    if (message.threadId !== currentChat.current) return;
    // Capture the visible boundary once. New native activity must not move the
    // pending user bubble down while native input persistence catches up.
    const afterRows = new Set(currentCanonical.current?.rows.map(row => row.key));
    const timestampMs = Date.now();
    setPending(messages => [...messages, { ...message, sent: false, timestampMs, afterRows,
      afterClients: new Set(messages.filter(prior => prior.threadId === message.threadId).map(prior => prior.clientRequestId)),
    }]);
  }, []);
  const onOptimisticUserMessageSent = useCallback((id: string) => {
    setPending(messages => messages.map(message => message.clientRequestId === id ? { ...message, sent: true } : message));
  }, []);
  const onOptimisticUserMessageRemoved = useCallback((id: string) => {
    setPending(messages => messages.filter(message => message.clientRequestId !== id));
  }, []);
  const ids = new Set(canonical?.rows.flatMap(row => row.type === 'item' && row.item.kind === 'user_message' && row.item.clientId ? [row.item.clientId] : []));
  const visiblePending = pending.filter(message => message.threadId === chatId && !ids.has(message.clientRequestId));
  const rows = [...(canonical?.rows ?? [])];
  for (const message of visiblePending) {
    let index = 0;
    rows.forEach((row, rowIndex) => {
      if (message.afterRows.has(row.key) || row.type === 'item' && row.item.clientId !== undefined && message.afterClients.has(row.item.clientId)) index = rowIndex + 1;
    });
    const id = `optimistic-user-${message.clientRequestId}`;
    const before = rows[index - 1]?.displayOrder ?? -1;
    const after = rows[index]?.displayOrder ?? before + 2;
    const displayOrder = (before + after) / 2;
    const row: TimelineRow = { type: 'item', key: id, displayOrder, turnId: null, turnKey: `optimistic-${message.threadId}`, item: {
      id, clientId: message.clientRequestId, kind: 'user_message', text: message.text, skillMentions: message.skillMentions,
      source: 'optimistic', status: 'running', confirmationState: message.sent ? 'sent' : 'sending',
      displayOrder, timestampMs: message.timestampMs, turnId: null, payload: {}, debugEvents: [],
    } };
    rows.splice(index, 0, row);
  }
  return { timeline: canonical && visiblePending.length ? { ...canonical, rows } : canonical,
    onOptimisticUserMessageStarted, onOptimisticUserMessageSent, onOptimisticUserMessageRemoved };
}
