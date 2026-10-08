import { ORPCError } from '@orpc/server';
import type { ChatIdentity } from './product-registry.js';

export type ChatPresenceSelection = { clientId: string; visibleThreadIds: string[] };
export function validChatPresence(value: unknown): value is ChatPresenceSelection {
  if (typeof value !== 'object' || !value || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const validId = (id: unknown): id is string => typeof id === 'string' && Boolean(id.trim()) && id.length <= 256 && !id.includes('\0');
  return Object.keys(input).every(key => key === 'clientId' || key === 'visibleThreadIds')
    && validId(input.clientId) && Array.isArray(input.visibleThreadIds) && input.visibleThreadIds.every(validId);
}

/** Browser foreground leases are ephemeral transport state, independent of seen.
 * The resolver supplies native bindings under the chat lifecycle admission. */
export function createChatPresence(options: {
  resolveVisible: (ids: string[], apply: (identities: ChatIdentity[]) => void) => Promise<void>;
  now?: () => number;
}) {
  const clients = new Map<string, { expiresAt: number; identities: ChatIdentity[] }>();
  const admissions = new Map<string, symbol>();
  const now = options.now ?? Date.now;
  let disposed = false;
  const assertActive = () => { if (disposed) throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'Chat presence is shutting down.' }); };
  function prune() { const current = now(); for (const [id, lease] of clients) if (lease.expiresAt < current) clients.delete(id); }
  return {
    async replace(input: ChatPresenceSelection) {
      assertActive();
      if (!validChatPresence(input)) throw new ORPCError('BAD_REQUEST', { message: 'Invalid chat presence.' });
      const clientId = input.clientId.trim(), ids = [...new Set(input.visibleThreadIds.map(id => id.trim()))];
      const admission = Symbol(); admissions.set(clientId, admission);
      prune();
      try {
        if (ids.length === 0) clients.delete(clientId); // Clear wins synchronously, without native reads.
        else await options.resolveVisible(ids, identities => {
          assertActive();
          if (admissions.get(clientId) === admission) clients.set(clientId, { identities: identities.map(identity => ({ ...identity })), expiresAt: now() + 30_000 });
        });
        assertActive();
        return { accepted: true as const };
      } finally { if (admissions.get(clientId) === admission) admissions.delete(clientId); }
    },
    // Internal delivery-eligibility seam; not a public gateway route or seen API.
    isViewed(bindingId: string, threadId: string) {
      prune();
      return [...clients.values()].some(lease => lease.identities.some(identity => identity.bindingId === bindingId && identity.threadId === threadId));
    },
    forget(bindingId: string, threadIds: string[]) {
      const removed = new Set(threadIds);
      for (const [clientId, lease] of clients) {
        lease.identities = lease.identities.filter(identity => identity.bindingId !== bindingId || !removed.has(identity.threadId));
        if (!lease.identities.length) clients.delete(clientId);
      }
    },
    dispose() { disposed = true; clients.clear(); admissions.clear(); },
  };
}
