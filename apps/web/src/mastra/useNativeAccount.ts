import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessageFrom } from '../shared/values';
import { mastraClient, type ChatClient } from './client';
import { useNativeSnapshots } from './useNativeSnapshots';

type AccountSnapshot = Awaited<ReturnType<ChatClient['getAccount']>>;
export function useNativeAccount() {
  const watch = useCallback((signal: AbortSignal) => mastraClient.watchAccount(undefined, { signal }), []);
  const account = useNativeSnapshots<AccountSnapshot>('account', watch);
  const snapshot = account.snapshot;
  const id = snapshot?.authenticated ? snapshot.account?.id ?? null : null;
  // Revision fences same-account logout/relogin and native credential refreshes.
  const scope = snapshot && id ? JSON.stringify([snapshot.epoch, id, snapshot.revision]) : null;
  const usage = useQuery({ queryKey: ['mastra', 'account-usage', scope], enabled: scope !== null, retry: false,
    queryFn: async ({ signal }) => {
      const value = await mastraClient.getAccountUsage(undefined, { signal });
      if (value && value.accountId !== id) throw new Error('Account changed while reading usage.');
      return value;
    },
  });
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const command = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [logoutState, setLogoutState] = useState<{ scope: string; pending: boolean; error: string | null } | null>(null);
  useEffect(() => {
    generation.current++;
    return () => { generation.current++; command.current?.abort(); };
  }, [scope]);
  const logout = useCallback(() => {
    if (scope === null || (logoutState?.scope === scope && logoutState.pending)) return;
    command.current?.abort();
    const controller = new AbortController();
    command.current = controller;
    const attempt = generation.current;
    const current = () => !controller.signal.aborted && activeScope.current === scope && generation.current === attempt;
    setLogoutState({ scope, pending: true, error: null });
    void mastraClient.logoutAccount(undefined, { signal: controller.signal }).then(() => {
      // The command acknowledgment never replaces canonical watchAccount state.
      if (current()) setLogoutState({ scope, pending: false, error: null });
    }).catch(error => {
      if (current()) setLogoutState({ scope, pending: false, error: errorMessageFrom(error) });
    });
  }, [scope, logoutState]);
  const logoutError = logoutState?.scope === scope ? logoutState.error : null;
  return { snapshot, usage: scope !== null && usage.data?.accountId === id ? usage.data : null,
    error: account.error ?? logoutError ?? (scope !== null && usage.error ? errorMessageFrom(usage.error) : null),
    logoutPending: Boolean(logoutState?.scope === scope && logoutState.pending), logout };
}
