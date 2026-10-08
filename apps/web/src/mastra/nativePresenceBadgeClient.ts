import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ChatClient } from './client';

type PresenceBadgeClient = Pick<ChatClient, 'replaceChatPresence' | 'getUnreadBadge'>;
type NativeUnreadBadge = Awaited<ReturnType<PresenceBadgeClient['getUnreadBadge']>>;

// Worker-safe: only typed HTTP oRPC, with an explicit endpoint supplied by its
// owner. Exit presence uses fetch keepalive instead of handwritten RPC/beacons.
export function createNativePresenceBadgeClient(url: () => string, keepalive = false): PresenceBadgeClient {
  return createORPCClient(new RPCLink({ url,
    fetch: (request, init) => fetch(request, { ...init, keepalive, cache: 'no-store' }),
  }));
}

export function validNativeUnreadBadge(snapshot: NativeUnreadBadge): boolean {
  return typeof snapshot.epoch === 'string' && Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0
    && (snapshot.count === null || Number.isSafeInteger(snapshot.count) && snapshot.count >= 0);
}
