import { useCallback, useEffect, useState } from 'react';
import type { SubagentViewerEntry } from '../threads/SubagentViewerView';
import { mastraClient, type ChatClient } from './client';
import { useNativeHistorySnapshots } from './useNativeSnapshots';

export type NativeSubagentList = Awaited<ReturnType<ChatClient['listSubagents']>>;
type NativeSubagentSnapshot = Awaited<ReturnType<ChatClient['openSubagent']>>;
type History = NonNullable<Parameters<ChatClient['watchSubagents']>[0]['history']>;
export function nativeSubagentEntries(snapshot: NativeSubagentList | null) {
  const entries: (SubagentViewerEntry & { kind: 'invocation' | 'fork'; nativeId: string })[] = [];
  for (const invocation of snapshot?.invocations ?? []) entries.push({ id: `invocation:${invocation.id}`, nativeId: invocation.id, kind: 'invocation',
    name: invocation.task ?? 'Subagent', preview: invocation.task ?? '', agentNickname: invocation.task ?? invocation.activity?.displayName, agentRole: invocation.agentType,
    status: invocation.status === 'running' ? 'active' : invocation.status === 'error' ? 'systemError' : invocation.status === 'unknown' ? 'notLoaded' : 'idle',
    canAcceptDirectInput: false });
  for (const fork of snapshot?.forks ?? []) entries.push({ id: `fork:${fork.id}`, nativeId: fork.id, kind: 'fork', name: fork.title, preview: fork.title,
    agentNickname: fork.title, agentRole: 'Fork history', status: 'notLoaded', canAcceptDirectInput: false });
  return entries;
}
export function useNativeSubagents(chatId: string | null) {
  const read = useCallback((history: History | undefined, signal: AbortSignal) => mastraClient.watchSubagents({ chatId: chatId!, ...(history ? { history } : {}) }, { signal }), [chatId]);
  const inventory = useNativeHistorySnapshots<NativeSubagentList>(chatId, read);
  const [open, setOpen] = useState(false);
  const [selectedId, select] = useState<string | null>(null);
  useEffect(() => { setOpen(false); select(null); }, [chatId]);
  const toggle = useCallback(() => setOpen(value => !value), []);
  return { ...inventory, open, toggle, selectedId, select };
}
export function useNativeFork(chatId: string, forkId: string | null) {
  const read = useCallback((history: History | undefined, signal: AbortSignal) => mastraClient.watchSubagent({ chatId, kind: 'fork', id: forkId!, ...(history ? { history } : {}) }, { signal }), [chatId, forkId]);
  return useNativeHistorySnapshots<NativeSubagentSnapshot>(forkId === null ? null : JSON.stringify([chatId, forkId]), read);
}
