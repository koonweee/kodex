import { useCallback } from 'react';
import { requestPwaUpdateCheck } from '../pwa/registerServiceWorker';
import { mastraClient } from './client';
import { useNativeSnapshots } from './useNativeSnapshots';

/** Full initial markers also check on reconnect, recovering missed deployments
 * and host restarts without periodic service-worker checks or chat activation. */
export function useNativeFrontendUpdates(instanceId: string | null) {
  const watch = useCallback((signal: AbortSignal) => mastraClient.watchFrontendUpdates(undefined, { signal }), []);
  const checkWorker = useCallback(() => { void requestPwaUpdateCheck().catch(() => undefined); }, []);
  useNativeSnapshots(instanceId, watch, checkWorker);
}
