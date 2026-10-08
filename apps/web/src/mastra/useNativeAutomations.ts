import { useCallback } from 'react';
import { mastraClient, type ChatClient } from './client';
import type { NativeAutomation, NativeAutomationInput } from './nativeAutomationTypes';
import { useNativeSnapshots } from './useNativeSnapshots';

type AutomationsSnapshot = Awaited<ReturnType<ChatClient['watchAutomations']>> extends AsyncIterable<infer T> ? T : never;
const editableFields = ['name', 'prompt', 'targetThreadId', 'cron', 'timezone'] as const;

export function useNativeAutomations(enabled: boolean) {
  const watch = useCallback((signal: AbortSignal) => mastraClient.watchAutomations(undefined, { signal }), []);
  const view = useNativeSnapshots<AutomationsSnapshot>(enabled ? 'automations' : null, watch);
  const command = useCallback(async <T,>(operation: () => Promise<T>) => {
    const result = await operation();
    // Command acknowledgments never replace the canonical watched rows.
    view.retry();
    return result;
  }, [view.retry]);
  const create = useCallback((input: NativeAutomationInput) => command(() => mastraClient.createAutomation(input)), [command]);
  const update = useCallback((id: string, input: NativeAutomationInput, original: NativeAutomation) => {
    const patch: Partial<NativeAutomationInput> = {};
    for (const key of editableFields) if (input[key] !== original[key]) patch[key] = input[key];
    if (Object.keys(patch).length === 0) return Promise.resolve(view.snapshot?.rows.find(row => row.id === id) ?? original);
    return command(() => mastraClient.updateAutomation({ id, patch }));
  }, [command, view.snapshot]);
  const pause = useCallback((id: string) => command(() => mastraClient.pauseAutomation({ id })), [command]);
  const resume = useCallback((id: string) => command(() => mastraClient.resumeAutomation({ id })), [command]);
  const remove = useCallback(async (id: string) => { await command(() => mastraClient.deleteAutomation({ id })); }, [command]);
  return { rows: view.snapshot?.rows ?? [], error: view.error, isLoading: enabled && !view.snapshot && !view.error,
    retry: view.retry, create, update, pause, resume, remove };
}
