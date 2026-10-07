import { useCallback, useEffect, useState } from 'react';
import { mastraClient, type CatalogSnapshot, type ChatSnapshot } from './client';
import { acceptsSnapshot } from './presentation';
import { errorMessageFrom } from '../shared/values';

export function useNativeSnapshots<T extends { epoch: string; revision: number }>(key: string | null, watch: (signal: AbortSignal) => Promise<AsyncIterable<T>>) {
  const [state, setState] = useState<{ key: string | null; snapshot: T | null; error: string | null }>({ key: null, snapshot: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (key === null) return;
    const lifetime = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let receivedInitial = false;
    const apply = (snapshot: T) => {
      if (lifetime.signal.aborted) return;
      const initial = !receivedInitial;
      receivedInitial = true;
      setState(current => {
        // The first full snapshot of a new connection may include native writes
        // without an event. Revision is process-local coverage, not a DB version.
        const equalInitial = initial && current.snapshot?.epoch === snapshot.epoch && current.snapshot.revision === snapshot.revision;
        return current.key !== key || acceptsSnapshot(current.snapshot, snapshot) || equalInitial
          ? { key, snapshot, error: null } : current;
      });
    };
    void (async () => {
      try {
        for await (const snapshot of await watch(lifetime.signal)) apply(snapshot);
        if (!lifetime.signal.aborted) throw new Error('Chat connection closed');
      } catch (failure) {
        if (lifetime.signal.aborted) return;
        setState(current => ({ key, snapshot: current.key === key ? current.snapshot : null, error: errorMessageFrom(failure) }));
        timer = setTimeout(() => setAttempt(value => value + 1), 1000);
      }
    })();
    const reconnect = () => {
      if (document.visibilityState === 'hidden') return;
      lifetime.abort(); clearTimeout(timer); setAttempt(value => value + 1);
    };
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    return () => { lifetime.abort(); clearTimeout(timer); window.removeEventListener('online', reconnect); document.removeEventListener('visibilitychange', reconnect); };
  }, [attempt, key, watch]);
  return { snapshot: state.key === key ? state.snapshot : null, error: state.key === key ? state.error : null, retry: () => setAttempt(value => value + 1) };
}
export function useNativeCatalog() {
  const watch = useCallback((signal: AbortSignal) => mastraClient.watchCatalog(undefined, { signal }), []);
  return useNativeSnapshots<CatalogSnapshot>('catalog', watch);
}
export function useNativeChat(chatId: string | null) {
  const watch = useCallback((signal: AbortSignal) => mastraClient.watchChat({ chatId: chatId! }, { signal }), [chatId]);
  return useNativeSnapshots<ChatSnapshot>(chatId, watch);
}
