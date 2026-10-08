import { getApiBaseUrl } from '../api/client';
import type { ThreadViewPresenceTransport } from '../threads/useThreadViewPresence';
import { createNativePresenceBadgeClient } from './nativePresenceBadgeClient';

const client = createNativePresenceBadgeClient(() => `${getApiBaseUrl()}/rpc`);
const exitClient = createNativePresenceBadgeClient(() => `${getApiBaseUrl()}/rpc`, true);
export const nativePresenceTransport: ThreadViewPresenceTransport = {
  replace: request => client.replaceChatPresence(request),
  sendOnExit: request => {
    void exitClient.replaceChatPresence(request).catch(() => {
      // Presence is ephemeral; missed cleanup expires in the gateway.
    });
    return true;
  },
};
