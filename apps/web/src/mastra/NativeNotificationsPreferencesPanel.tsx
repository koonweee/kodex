import { useNotificationsPreferencesPanel, type NotificationsPreferencesTransport } from '../preferences/NotificationsPreferencesPanel';
import { mastraClient } from './client';

const transport: NotificationsPreferencesTransport = {
  status: signal => mastraClient.push.status(undefined, { signal }),
  current: (endpoint, signal) => mastraClient.push.current({ endpoint }, { signal }),
  async upsert(subscription) {
    const value = subscription.toJSON();
    const endpoint = value.endpoint, auth = value.keys?.auth, p256dh = value.keys?.p256dh;
    if (!endpoint || !auth || !p256dh) throw new Error('Push subscription is missing endpoint or keys');
    return mastraClient.push.upsert({ endpoint, keys: { auth, p256dh }, userAgent: navigator.userAgent });
  },
  disable: endpoint => mastraClient.push.disable({ endpoint }),
  test: () => mastraClient.push.test(),
  statusKey: ['mastra', 'push', 'status'],
  currentKey: ['mastra', 'push', 'current-device'],
  refillOnFocus: true,
};

// The native shell owns this hook throughout preference navigation.
export function useNativeNotificationsPreferencesPanel(enabled: boolean) {
  return useNotificationsPreferencesPanel(enabled, transport);
}
