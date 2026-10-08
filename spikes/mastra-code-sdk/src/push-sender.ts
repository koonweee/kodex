import webPush, { type RequestOptions, type PushSubscription } from 'web-push';

export interface PushConfig { publicKey: string; privateKey: string; subject: string; recheckDelayMs: number }
export interface PushPayload { kind: 'unreadAgentMessage' | 'test'; title: string; body: string; route: string; threadId?: string }
export type PushSendOutcome = 'sent' | 'stale' | 'temporary';
export type PushSender = (subscription: PushSubscription, payload: PushPayload) => Promise<PushSendOutcome>;

/** Explicit environment input keeps disposable service tests independent of personal configuration. */
export function readPushConfig(env: NodeJS.ProcessEnv): PushConfig | null {
  const publicKey = env.KODEX_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.KODEX_VAPID_PRIVATE_KEY?.trim();
  const subject = env.KODEX_VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  const delay = Number(env.KODEX_NOTIFICATIONS_RECHECK_DELAY_MS ?? '2000');
  if (!Number.isSafeInteger(delay) || delay < 0) throw new Error('Invalid Push recheck delay.');
  // Delegate VAPID key/subject validation to the maintained implementation, without global configuration.
  webPush.getVapidHeaders('https://push.example.com', subject, publicKey, privateKey, 'aes128gcm');
  return { publicKey, privateKey, subject, recheckDelayMs: delay };
}

export function createPushSender(config: PushConfig, transport: Pick<RequestOptions, 'agent' | 'timeout'> = {}): PushSender {
  return async (subscription, payload) => {
    try {
      await webPush.sendNotification(subscription, JSON.stringify(payload), { vapidDetails: config, contentEncoding: 'aes128gcm',
        timeout: 30_000, ...transport });
      return 'sent';
    } catch (error) {
      const status = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
      return status === 404 || status === 410 ? 'stale' : 'temporary';
    }
  };
}
