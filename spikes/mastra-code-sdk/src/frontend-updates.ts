import { randomUUID } from 'node:crypto';
import { EventPublisher } from '@orpc/server';

export type FrontendUpdateSnapshot = { epoch: string; revision: number; buildRevision: string | null };

/** Host-owned deployment signal, independent of chat runtimes and storage.
 * Reconnect receives a full current marker; the browser checks its worker even
 * when a restarted host has no prior publication. This is not a build ledger. */
export function createFrontendUpdates() {
  const lifetime = new AbortController();
  const changes = new EventPublisher<{ changed: number }>({ maxBufferedEvents: 1 });
  let current: FrontendUpdateSnapshot = { epoch: randomUUID(), revision: 0, buildRevision: null };
  return {
    publish(buildRevision: string) {
      lifetime.signal.throwIfAborted();
      current = { ...current, revision: current.revision + 1, buildRevision };
      changes.publish('changed', current.revision);
      return { accepted: true as const };
    },
    async *watch(signal?: AbortSignal): AsyncGenerator<FrontendUpdateSnapshot, void> {
      const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
      const subscription = changes.subscribe('changed', { signal: combined });
      try {
        combined.throwIfAborted();
        let last = current;
        yield last;
        for await (const marker of subscription) {
          if (marker <= last.revision) continue;
          last = current;
          yield last;
        }
      } finally { await subscription.return(); }
    },
    dispose() { lifetime.abort(); },
  };
}
export type FrontendUpdates = ReturnType<typeof createFrontendUpdates>;
