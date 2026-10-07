import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { AuthStorage } from '@mastra/code-sdk/auth/index';
import { EventPublisher } from '@orpc/server';
import { readAccount, logoutAccount } from './account.js';
import { readAccountUsage } from './account-usage.js';

export type AccountSnapshot = ReturnType<typeof readAccount> & { epoch: string; revision: number };

/** Observe the native auth file; no second credential or account store. */
export function createAccountService(storage: AuthStorage, authPath: string, epoch: string) {
  const lifetime = new AbortController();
  const changes = new EventPublisher<{ changed: number }>({ maxBufferedEvents: 1 });
  let revision = 0;
  let previous: string | undefined;
  const invalidate = () => changes.publish('changed', ++revision);
  // Watch the directory so native atomic file replacement remains observable.
  const watcher = watch(dirname(authPath), { persistent: false }, (_event, name) => {
    if (name === null || name.toString() === basename(authPath)) invalidate();
  });
  watcher.on('error', () => lifetime.abort(new Error('Account observation stopped. Restart the gateway to resume account updates.')));
  function get(): AccountSnapshot {
    lifetime.signal.throwIfAborted();
    const account = readAccount(storage);
    const fingerprint = JSON.stringify(account);
    if (previous !== undefined && previous !== fingerprint) invalidate();
    previous = fingerprint;
    return { epoch, revision, ...account };
  }
  return {
    get,
    logout() { lifetime.signal.throwIfAborted(); logoutAccount(storage); invalidate(); return get(); },
    getUsage(signal?: AbortSignal) {
      lifetime.signal.throwIfAborted();
      return readAccountUsage(storage, { signal: AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]) });
    },
    async *watch(signal?: AbortSignal): AsyncGenerator<AccountSnapshot, void> {
      const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
      const subscription = changes.subscribe('changed', { signal: combined });
      try {
        let current = get();
        yield current;
        for await (const marker of subscription) {
          if (marker <= current.revision) continue;
          current = get();
          yield current;
        }
      } finally { await subscription.return(); }
    },
    dispose() { watcher.close(); lifetime.abort(); },
  };
}
