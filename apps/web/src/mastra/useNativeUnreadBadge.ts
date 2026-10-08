import { useEffect, useEffectEvent, useRef } from 'react';
import { getApiBaseUrl } from '../api/client';
import { setKodexAppBadge } from '../notifications/browserBadge';
import type { CatalogSnapshot } from './client';
import { createNativePresenceBadgeClient, validNativeUnreadBadge } from './nativePresenceBadgeClient';

const client = createNativePresenceBadgeClient(() => `${getApiBaseUrl()}/rpc`);
export function useNativeUnreadBadge(catalog: Pick<CatalogSnapshot, 'epoch' | 'revision'> | null) {
  const request = useRef<AbortController | null>(null);
  const observed = useRef<{ epoch: string; revision: number } | null>(null);
  const refresh = useEffectEvent(() => {
    if (document.visibilityState !== 'visible') return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    void client.getUnreadBadge(undefined, { signal: controller.signal }).then(snapshot => {
      if (controller.signal.aborted || request.current !== controller || !validNativeUnreadBadge(snapshot)) return;
      const previous = observed.current;
      if (previous?.epoch === snapshot.epoch && previous.revision > snapshot.revision) return;
      // Unknown inventory advances observation, but never clears the OS badge.
      observed.current = { epoch: snapshot.epoch, revision: snapshot.revision };
      if (snapshot.count !== null) void setKodexAppBadge(snapshot.count);
    }).catch(() => {
      // Gateway/native inventory failure preserves the existing badge.
    });
  });
  useEffect(() => { refresh(); }, [catalog]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      request.current?.abort();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
}
