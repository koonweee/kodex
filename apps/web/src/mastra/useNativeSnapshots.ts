import { useCallback, useEffect, useRef, useState } from 'react';
import { mastraClient, type CatalogSnapshot, type ChatSnapshot } from './client';
import { acceptsSnapshot } from './presentation';
import { errorMessageFrom } from '../shared/values';

export function useNativeSnapshots<T extends { epoch: string; revision: number }>(key: string | null, watch: (signal: AbortSignal) => Promise<AsyncIterable<T>>, onAccepted?: (snapshot: T) => void, onFailure?: () => void) {
  const [state, setState] = useState<{ key: string | null; snapshot: T | null; error: string | null }>({ key: null, snapshot: null, error: null });
  const stateRef = useRef(state);
  const [attempt, setAttempt] = useState(0);
  const activeSubscription = useRef<AbortController | null>(null);
  const retry = useCallback(() => {
    // Fence old replies immediately, before React flushes effect cleanup. A live
    // reply must not consume a newly requested history expansion.
    activeSubscription.current?.abort();
    setAttempt(value => value + 1);
  }, []);
  useEffect(() => {
    if (key === null) return;
    const lifetime = new AbortController();
    activeSubscription.current = lifetime;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let receivedInitial = false;
    const apply = (snapshot: T) => {
      if (lifetime.signal.aborted) return;
      const initial = !receivedInitial;
      const current = stateRef.current;
      // A connection's first full snapshot can expand history or include native
      // writes without an event. Revision is process-local coverage, not a DB version.
      const equalInitial = initial && current.snapshot?.epoch === snapshot.epoch && current.snapshot.revision === snapshot.revision;
      if (current.key !== key || acceptsSnapshot(current.snapshot, snapshot) || equalInitial) {
        receivedInitial = true;
        stateRef.current = { key, snapshot, error: null };
        setState(stateRef.current);
        onAccepted?.(snapshot);
      }
    };
    void (async () => {
      try {
        for await (const snapshot of await watch(lifetime.signal)) apply(snapshot);
        if (!lifetime.signal.aborted) throw new Error('Chat connection closed');
      } catch (failure) {
        if (lifetime.signal.aborted) return;
        const current = stateRef.current;
        stateRef.current = { key, snapshot: current.key === key ? current.snapshot : null, error: errorMessageFrom(failure) };
        setState(stateRef.current);
        onFailure?.();
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
  }, [attempt, key, watch, onAccepted, onFailure]);
  return { snapshot: state.key === key ? state.snapshot : null, error: state.key === key ? state.error : null, retry };
}
export function useNativeCatalog() {
  const watch = useCallback((signal: AbortSignal) => mastraClient.watchCatalog(undefined, { signal }), []);
  return useNativeSnapshots<CatalogSnapshot>('catalog', watch);
}
export function useNativeChat(chatId: string | null) {
  // History depth belongs to this pane's presentation; canonical snapshots own
  // every transcript row. A target change starts again at the native recent page.
  const historyRef = useRef({ chatId, earliest: null as string | null, older: false, loading: false });
  if (historyRef.current.chatId !== chatId) historyRef.current = { chatId, earliest: null, older: false, loading: false };
  const history = historyRef.current;
  const [loadingChat, setLoadingChat] = useState<string | null>(null);
  const watch = useCallback((signal: AbortSignal) => {
    history.loading = history.older;
    setLoadingChat(history.loading ? chatId : null);
    return mastraClient.watchChat({ chatId: chatId!, ...(history.earliest !== null ? { history: { earliest: history.earliest, ...(history.older ? { older: true } : {}) } } : {}) }, { signal });
  }, [chatId, history]);
  const onAccepted = useCallback((snapshot: ChatSnapshot) => {
    history.earliest = snapshot.history.earliest;
    history.older = false;
    history.loading = false;
    setLoadingChat(null);
  }, [history]);
  const onFailure = useCallback(() => { history.loading = false; setLoadingChat(null); }, [history]);
  const result = useNativeSnapshots<ChatSnapshot>(chatId, watch, onAccepted, onFailure);
  const loadOlderHistory = useCallback(() => {
    if (!chatId || history.loading || !result.snapshot?.history.hasOlder || history.earliest === null) return;
    history.older = true;
    history.loading = true;
    setLoadingChat(chatId);
    result.retry();
  }, [chatId, history, result.snapshot, result.retry]);
  return { ...result, loadOlderHistory, isLoadingOlderHistory: chatId !== null && loadingChat === chatId };
}
