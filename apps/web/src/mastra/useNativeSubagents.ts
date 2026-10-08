import { useCallback, useEffect, useState } from 'react';
import type { SubagentViewerEntry } from '../threads/SubagentViewerView';
import { mastraClient, type ChatClient } from './client';
import { useNativeHistorySnapshots } from './useNativeSnapshots';

export type NativeSubagentList = Awaited<ReturnType<ChatClient['listSubagents']>>;
type NativeSubagentSnapshot = Awaited<ReturnType<ChatClient['openSubagent']>>;
type History = NonNullable<Parameters<ChatClient['watchSubagents']>[0]['history']>;
export function nativeSubagentEntries(snapshot: NativeSubagentList | null) {
  const entries: (SubagentViewerEntry & { kind: 'invocation' | 'fork' | 'child'; nativeId: string })[] = [];
  for (const invocation of snapshot?.invocations ?? []) entries.push({ id: `invocation:${invocation.id}`, nativeId: invocation.id, kind: 'invocation',
    name: invocation.task ?? 'Subagent', preview: invocation.task ?? '', agentNickname: invocation.task ?? invocation.activity?.displayName, agentRole: invocation.agentType,
    status: invocation.status === 'running' ? 'active' : invocation.status === 'error' ? 'systemError' : invocation.status === 'unknown' ? 'notLoaded' : 'idle',
    canAcceptDirectInput: false });
  for (const fork of snapshot?.forks ?? []) entries.push({ id: `fork:${fork.id}`, nativeId: fork.id, kind: 'fork', name: fork.title, preview: fork.title,
    agentNickname: fork.title, agentRole: 'Fork history', status: 'notLoaded', canAcceptDirectInput: false });
  for (const child of snapshot?.children ?? []) entries.push({ id: `child:${child.id}`, nativeId: child.id, kind: 'child', name: child.title, preview: child.title,
    agentNickname: child.title, agentRole: 'Delegated child', status: child.active ? 'active' : 'notLoaded', canAcceptDirectInput: false });
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
export function useNativeSubagentHistory(chatId: string, selection: { kind: 'fork' | 'child'; id: string } | null) {
  const kind = selection?.kind, id = selection?.id;
  const read = useCallback((history: History | undefined, signal: AbortSignal) => mastraClient.watchSubagent({ chatId, kind: kind!, id: id!, ...(history ? { history } : {}) }, { signal }), [chatId, kind, id]);
  return useNativeHistorySnapshots<NativeSubagentSnapshot>(selection === null ? null : JSON.stringify([chatId, kind, id]), read);
}
