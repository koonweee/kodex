import { useCallback, useEffect, useRef, useState } from 'react';
import type { OptimisticUserMessageCallbacks } from '../composer/useComposerOrchestration';
import type { TimelinePresentation } from '../timeline/TimelineView';
import type { TimelineRow } from '../timeline/state';

type Message = Parameters<NonNullable<OptimisticUserMessageCallbacks['onOptimisticUserMessageStarted']>>[0] & { sent: boolean; timestampMs: number };

export function useNativeOptimisticMessages(chatId: string | null, canonical: TimelinePresentation | null) {
  const [pending, setPending] = useState<Message[]>([]);
  const currentChat = useRef(chatId);
  currentChat.current = chatId;
  useEffect(() => { setPending(messages => messages.length ? [] : messages); }, [chatId]);
  useEffect(() => {
    const ids = new Set(canonical?.rows.flatMap(row => row.type === 'item' && row.item.kind === 'user_message' && row.item.clientId ? [row.item.clientId] : []));
    setPending(messages => messages.some(message => ids.has(message.clientRequestId)) ? messages.filter(message => !ids.has(message.clientRequestId)) : messages);
  }, [canonical]);
  const onOptimisticUserMessageStarted = useCallback((message: Omit<Message, 'sent' | 'timestampMs'>) => {
    if (message.threadId !== currentChat.current) return;
    setPending(messages => [...messages, { ...message, sent: false, timestampMs: Date.now() }]);
  }, []);
  const onOptimisticUserMessageSent = useCallback((id: string) => {
    setPending(messages => messages.map(message => message.clientRequestId === id ? { ...message, sent: true } : message));
  }, []);
  const onOptimisticUserMessageRemoved = useCallback((id: string) => {
    setPending(messages => messages.filter(message => message.clientRequestId !== id));
  }, []);
  const ids = new Set(canonical?.rows.flatMap(row => row.type === 'item' && row.item.kind === 'user_message' && row.item.clientId ? [row.item.clientId] : []));
  const lastOrder = canonical?.rows.at(-1)?.displayOrder ?? 0;
  const rows: TimelineRow[] = pending.filter(message => message.threadId === chatId && !ids.has(message.clientRequestId)).map((message, index) => {
    const id = `optimistic-user-${message.clientRequestId}`;
    const displayOrder = lastOrder + index + 1;
    return { type: 'item', key: id, displayOrder, turnId: null, turnKey: `optimistic-${message.threadId}`, item: {
      id, clientId: message.clientRequestId, kind: 'user_message', text: message.text, skillMentions: message.skillMentions,
      source: 'optimistic', status: 'running', confirmationState: message.sent ? 'sent' : 'sending',
      displayOrder, timestampMs: message.timestampMs, turnId: null, payload: {}, debugEvents: [],
    } };
  });
  return { timeline: canonical && rows.length ? { ...canonical, rows: [...canonical.rows, ...rows] } : canonical,
    onOptimisticUserMessageStarted, onOptimisticUserMessageSent, onOptimisticUserMessageRemoved };
}
