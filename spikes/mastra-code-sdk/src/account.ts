import type { AuthStorage } from '@mastra/code-sdk/auth/index';
import { CHATGPT_PROVIDER } from './auth.js';

/** Public account projection. Never spread a native account: it includes tokens. */
export function readAccount(storage: AuthStorage) {
  storage.reload();
  const credential = storage.get(CHATGPT_PROVIDER);
  const active = storage.getActiveAccount(CHATGPT_PROVIDER);
  const authenticated = credential?.type === 'oauth'
    && typeof credential.access === 'string' && credential.access.length > 0
    && typeof credential.refresh === 'string' && credential.refresh.length > 0;
  if (!authenticated || !active) return { authenticated: false as const, account: null };
  const expiry = credential.expires;
  const validExpiry = Number.isFinite(expiry) && Math.abs(expiry) <= 8.64e15;
  return {
    authenticated: true as const,
    account: {
      id: active.id,
      label: active.label,
      expiresAt: validExpiry ? new Date(expiry).toISOString() : null,
      needsRefresh: !validExpiry || expiry <= Date.now(),
    },
  };
}

/** Use the runtime's native AuthStorage instance so future runs see logout too. */
export function logoutAccount(storage: AuthStorage) {
  storage.reload();
  storage.logout(CHATGPT_PROVIDER);
  return readAccount(storage);
}
