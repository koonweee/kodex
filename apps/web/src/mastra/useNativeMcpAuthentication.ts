import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessageFrom } from '../shared/values';
import { mastraClient, type ChatClient } from './client';

type Inventory = Awaited<ReturnType<ChatClient['nativeMcpWatch']>> extends AsyncIterable<infer T> ? T : never;
type Snapshot = Pick<Inventory, 'epoch' | 'revision'>;
type NativeServer = Inventory['rows'][number]['servers'][number];
type AuthInput = Parameters<ChatClient['nativeMcpAuthenticate']>[0];
type AuthResult = Awaited<ReturnType<ChatClient['nativeMcpAuthenticate']>>;
type AuthAction = { kind: 'start' | 'cancel'; input: AuthInput; generation: number; snapshot: Snapshot | null };
type LocalResult = AuthResult & { target: string; snapshot: Snapshot | null };
const targetKey = (input: AuthInput) => JSON.stringify([input.bindingId, input.server]);

export function useNativeMcpAuthentication(bindingId: string | null, server: NativeServer | undefined, snapshot: Snapshot | null, refresh: () => void) {
  const input = bindingId && server ? { bindingId, server: server.name } : null;
  const target = input ? targetKey(input) : null;
  const currentTarget = useRef(target);
  currentTarget.current = target;
  const generation = useRef(0);
  const [result, setResult] = useState<LocalResult | null>(null);
  const isCurrent = (action: AuthAction) => action.generation === generation.current && targetKey(action.input) === currentTarget.current;
  const request = useMutation({
    mutationFn: async (action: AuthAction) => {
      if (action.kind === 'start') return mastraClient.nativeMcpAuthenticate(action.input);
      await mastraClient.nativeMcpCancelAuthentication(action.input);
      return null;
    },
    onSuccess: (response, action) => {
      if (action.kind === 'cancel' && isCurrent(action)) refresh();
      if (response && isCurrent(action)) setResult({ ...response, target: targetKey(action.input), snapshot: action.snapshot });
    },
    onError: (error, action) => {
      if (isCurrent(action)) setResult({ authorizationUrl: null, error: errorMessageFrom(error), target: targetKey(action.input), snapshot: action.snapshot });
    },
  });
  const clear = useCallback(() => {
    generation.current++;
    setResult(null);
    request.reset();
  }, [request.reset]);
  useEffect(() => {
    clear();
    return () => { generation.current++; };
  }, [target, clear]);
  useEffect(() => {
    if (!result?.authorizationUrl || !snapshot || !result.snapshot || result.target !== target) return;
    // A URL may arrive before the polling watch observes native authentication.
    // Compare with dispatch so a terminal observation before the URL also retires it.
    // Inventory changes may conservatively retire a link without an attempt identity.
    const later = snapshot.epoch !== result.snapshot.epoch || snapshot.revision > result.snapshot.revision;
    if (later && !server?.authenticating) setResult(null);
  }, [result, target, snapshot?.epoch, snapshot?.revision, server?.authenticating]);
  function dispatch(kind: AuthAction['kind']) {
    if (!input) return;
    clear();
    const baseline = snapshot ? { epoch: snapshot.epoch, revision: snapshot.revision } : null;
    request.mutate({ kind, input, generation: generation.current, snapshot: baseline });
  }
  const selected = result?.target === target;
  const pending = request.isPending && request.variables && isCurrent(request.variables);
  return {
    authorizationUrl: selected ? result.authorizationUrl : null,
    error: selected && !server?.cancelled ? result.error : null,
    starting: Boolean(pending && request.variables?.kind === 'start'),
    cancelling: Boolean(pending && request.variables?.kind === 'cancel'),
    start: () => dispatch('start'), cancel: () => dispatch('cancel'), clear,
  };
}
