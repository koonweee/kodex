import type { SpikeProfile } from './profile.js';
import { openPushStore, publicPushDevice, type PushDeviceInput, type PushTerminalEvent } from './push-store.js';
import { createPushSender, type PushConfig, type PushPayload, type PushSender } from './push-sender.js';
export { readPushConfig } from './push-sender.js';
export type { PushConfig } from './push-sender.js';
export type { PushTerminalEvent } from './push-store.js';

export interface PushServiceOptions {
  config?: PushConfig | null;
  prepare(event: PushTerminalEvent): Promise<{ title: string } | null>;
  sender?: PushSender;
  now?: () => number;
  /** Zero disables automatic polling for deterministic tests; production polls each second. */
  pollIntervalMs?: number;
}

export async function openPushService(profile: SpikeProfile, options: PushServiceOptions) {
  const store = await openPushStore(profile);
  const config = options.config ?? null;
  const sender = options.sender ?? (config ? createPushSender(config) : null);
  const now = options.now ?? Date.now;
  const interval = options.pollIntervalMs ?? 1_000;
  let closing = false;
  let wake: (() => void) | undefined;
  let disposal: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  let processing: Promise<void> = Promise.resolve();
  const admitted = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error('Push service is closed.'));
    const promise = Promise.resolve().then(operation);
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  async function deliver() {
    if (!config || !sender) return;
    for (let index = 0; index < 10 && !closing; index++) {
      const job = await store.claim(now());
      if (!job) return;
      let temporary = false;
      let payload: PushPayload;
      try {
        if (job.event) {
          const prepared = await options.prepare(job.event);
          if (!prepared) { await store.finish(job.id, 'skipped', now()); continue; }
          payload = { kind: 'unreadAgentMessage', threadId: job.event.threadId, title: prepared.title,
            body: job.event.reason === 'error' ? 'The model run failed.' : job.event.reason === 'aborted' ? 'The model run stopped.' : 'Agent has a new message.',
            route: `/threads/${encodeURIComponent(job.event.threadId)}` };
        } else payload = { kind: 'test', title: 'Kodex test notification', body: 'Push notifications are working.', route: '/' };
        for (const subscription of await store.enabled()) {
          if (job.deliveredIds.includes(subscription.id)) continue;
          let outcome;
          try { outcome = await sender({ endpoint: subscription.endpoint, keys: subscription.keys }, payload); }
          catch { outcome = 'temporary'; }
          if (outcome === 'sent') await store.recordDelivered(job, subscription.id);
          else if (outcome === 'stale') await store.disable(subscription.endpoint, now());
          else temporary = true;
        }
      } catch { temporary = true; }
      await store.finish(job.id, temporary ? job.attempts < 3 ? 'pending' : 'failed' : 'sent',
        now() + Math.min(2 * job.attempts, 30) * 1_000);
    }
  }
  const processDue = () => admitted(() => {
    const result = processing.then(deliver);
    processing = result.catch(() => {});
    return result;
  });
  const worker = interval > 0 ? (async () => {
    while (!closing) {
      try { await processDue(); } catch { /* A later poll/restart refills the delivery outbox, never native state. */ }
      if (closing) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, interval);
        timer.unref();
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
  })() : Promise.resolve();
  return {
    status: () => admitted(async () => ({ configured: config !== null, subscriptionsEnabled: config !== null, vapidPublicKey: config?.publicKey ?? null })),
    current: ({ endpoint }: { endpoint: string }) => admitted(async () => {
      const subscription = await store.current(endpoint.trim());
      return { configured: config !== null, subscribed: subscription?.enabled ?? false, subscription: subscription ? publicPushDevice(subscription) : null };
    }),
    upsert: (input: PushDeviceInput) => admitted(async () => ({ subscription: publicPushDevice(await store.upsert({ ...input, endpoint: input.endpoint.trim() }, now())) })),
    disable: ({ endpoint }: { endpoint: string }) => admitted(async () => {
      const subscription = await store.disable(endpoint.trim(), now());
      return { subscription: subscription ? publicPushDevice(subscription) : null };
    }),
    remove: ({ subscriptionId }: { subscriptionId: string }) => admitted(async () => {
      const subscription = await store.remove(subscriptionId);
      return { subscription: subscription ? publicPushDevice(subscription) : null };
    }),
    test: () => admitted(async () => {
      const activeSubscriptionCount = (await store.enabled()).length;
      const deliveryIds = config && activeSubscriptionCount ? [await store.enqueue(null, now())] : [];
      return { configured: config !== null, activeSubscriptionCount, enqueued: deliveryIds.length > 0, deliveryIds };
    }),
    enqueueTerminal: (event: PushTerminalEvent) => admitted(async () => config ? store.enqueue(event, now() + config.recheckDelayMs) : null),
    processDue,
    dispose() {
      if (!disposal) {
        closing = true;
        wake?.();
        disposal = (async () => { await Promise.allSettled([...pending, worker]); await store.close(); })();
      }
      return disposal;
    },
  };
}
export type PushService = Awaited<ReturnType<typeof openPushService>>;
