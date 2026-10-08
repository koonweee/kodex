import { ORPCError } from '@orpc/server';
import { openPushService, type PushService } from './push-service.js';
import type { NativeCompletion } from './chat-read-state.js';
import type { SpikeProfile } from './profile.js';

export type ChatPushOptions = Omit<Parameters<typeof openPushService>[1], 'prepare'>;

/** Web Push owns its outbox, never native conversation/read state. Admissions
 * captured before shutdown finish before the transport closes its database. */
export function createChatPush({ profile, options, prepare, open = openPushService }: {
  profile: SpikeProfile;
  options?: ChatPushOptions;
  prepare: Parameters<typeof openPushService>[1]['prepare'];
  open?: typeof openPushService;
}) {
  let owner: Promise<PushService> | undefined, closing: Promise<void> | undefined;
  let stopped = false;
  const pending = new Set<Promise<unknown>>();
  async function get() {
    if (stopped) throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'Notifications are shutting down.' });
    return owner ??= open(profile, { ...options, config: options?.config ?? null, prepare });
  }
  return {
    get,
    capture(event: NativeCompletion) {
      if (stopped || !options?.config) return;
      const operation = get().then(service => service.enqueueTerminal(event));
      pending.add(operation);
      void operation.catch(() => {
        // Do not let delivery storage errors fail the native turn or log keys.
        console.error('Unable to queue a native chat notification.');
      }).finally(() => pending.delete(operation));
    },
    dispose() {
      if (closing) return closing;
      stopped = true;
      return closing = (async () => {
        await Promise.allSettled(pending);
        if (owner) await owner.then(service => service.dispose(), () => {});
      })();
    },
  };
}
