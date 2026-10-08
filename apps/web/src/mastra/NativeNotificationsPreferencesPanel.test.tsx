import { MantineProvider } from '@mantine/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKodexQueryClient } from '../api/queryClient';
import { useNativeNotificationsPreferencesPanel } from './NativeNotificationsPreferencesPanel';

const native = vi.hoisted(() => ({ status: vi.fn(), current: vi.fn(), upsert: vi.fn(), disable: vi.fn(), test: vi.fn() }));
const legacy = vi.hoisted(() => ({ getNotificationStatus: vi.fn(), getCurrentPushSubscriptionStatus: vi.fn(), upsertPushSubscription: vi.fn(), deleteCurrentPushSubscription: vi.fn(), sendTestNotification: vi.fn() }));
const pwa = vi.hoisted(() => ({ getServiceWorkerRegistration: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: { push: native } }));
vi.mock('../api/client', async original => ({ ...await original<typeof import('../api/client')>(), ...legacy }));
vi.mock('../pwa/registerServiceWorker', async original => ({ ...await original<typeof import('../pwa/registerServiceWorker')>(), ...pwa }));
let restore: () => void;
let subscribed: boolean;
let browserSubscription: PushSubscription | null;
let subscription: PushSubscription;
const events: string[] = [];
function host(label = 'device') {
  const client = createKodexQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  function Harness() {
    const [enabled, setEnabled] = useState(true);
    const panel = useNativeNotificationsPreferencesPanel(enabled);
    return <section aria-label={label}><button onClick={() => setEnabled(value => !value)}>Switch section</button>{enabled ? panel : <p>Appearance</p>}</section>;
  }
  const view = render(<MantineProvider><QueryClientProvider client={client}><Harness /></QueryClientProvider></MantineProvider>);
  return { ...view, region: within(screen.getByRole('region', { name: label })) };
}
beforeEach(() => {
  vi.clearAllMocks(); events.length = 0; subscribed = false;
  const original = ['Notification', 'PushManager'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const worker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
  const notification = Object.assign(vi.fn(), { permission: 'granted', requestPermission: vi.fn().mockResolvedValue('granted') });
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: notification });
  Object.defineProperty(globalThis, 'PushManager', { configurable: true, value: function PushManager() {} });
  subscription = { endpoint: 'https://push.example/shared-device', unsubscribe: vi.fn(async () => { events.push('unsubscribe'); browserSubscription = null; return true; }), toJSON: () => ({ endpoint: 'https://push.example/shared-device', keys: { p256dh: 'public-key', auth: 'auth-key' } }) } as unknown as PushSubscription;
  browserSubscription = subscription;
  const registration = { pushManager: { getSubscription: vi.fn(async () => browserSubscription), subscribe: vi.fn(async () => { browserSubscription = subscription; return subscription; }) } };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn().mockResolvedValue(registration) } });
  pwa.getServiceWorkerRegistration.mockResolvedValue(registration);
  native.status.mockResolvedValue({ configured: true, subscriptionsEnabled: true, vapidPublicKey: 'AQIDBA' });
  native.current.mockImplementation(async () => ({ configured: true, subscribed, subscription: null }));
  native.upsert.mockImplementation(async () => { events.push('upsert'); subscribed = true; return { subscription: null }; });
  native.disable.mockImplementation(async () => { events.push('disable'); subscribed = false; return { subscription: null }; });
  native.test.mockResolvedValue({ configured: true, activeSubscriptionCount: 1, enqueued: true, deliveryIds: ['delivery'] });
  restore = () => {
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    if (worker) Object.defineProperty(navigator, 'serviceWorker', worker); else Reflect.deleteProperty(navigator, 'serviceWorker');
  };
});
afterEach(() => restore());

describe('native Notifications preferences', () => {
  it('enables, tests and disables through native ownership without legacy requests', async () => {
    const user = userEvent.setup(), view = host();
    await waitFor(() => expect(view.region.getByRole('button', { name: 'Enable' })).toBeEnabled());
    await user.click(view.region.getByRole('button', { name: 'Enable' }));
    expect(await view.region.findByText('Notifications enabled.')).toBeVisible();
    expect(native.upsert).toHaveBeenCalledWith({ endpoint: subscription.endpoint, keys: { p256dh: 'public-key', auth: 'auth-key' }, userAgent: navigator.userAgent });
    await user.click(view.region.getByRole('button', { name: 'Test' }));
    expect(await view.region.findByText('Test notification sent.')).toBeVisible();
    await user.click(view.region.getByRole('button', { name: 'Disable' }));
    expect(await view.region.findByText('Notifications disabled.')).toBeVisible();
    expect(events).toEqual(['upsert', 'disable', 'unsubscribe']);
    expect(native.disable).toHaveBeenCalledWith({ endpoint: subscription.endpoint });
    for (const call of Object.values(legacy)) expect(call).not.toHaveBeenCalled();
  });
  it('refills two independent clients of the same endpoint after a peer disable', async () => {
    subscribed = true;
    // Retain the browser endpoint to prove canonical server disable, including
    // the accepted case where local unsubscribe cannot remove it.
    vi.mocked(subscription.unsubscribe).mockResolvedValue(false);
    const user = userEvent.setup(), first = host('first'), second = host('second');
    await waitFor(() => expect(first.region.getByRole('button', { name: 'Disable' })).toBeEnabled());
    await waitFor(() => expect(second.region.getByRole('button', { name: 'Disable' })).toBeEnabled());
    await user.click(first.region.getByRole('button', { name: 'Disable' }));
    expect(await first.region.findByText('Notifications disabled.')).toBeVisible();
    const reads = native.current.mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(second.region.getByRole('button', { name: 'Disable' })).toBeDisabled());
    expect(second.region.getByRole('button', { name: 'Enable' })).toBeEnabled();
    expect(native.disable).toHaveBeenCalledTimes(1);
    expect(native.current.mock.calls.length).toBeGreaterThan(reads);
    expect(native.current.mock.calls.filter(([input]) => input.endpoint === subscription.endpoint).length).toBeGreaterThanOrEqual(2);
  });
  it('submits the same endpoint from two clients without a browser-owned subscription ID', async () => {
    const user = userEvent.setup(), first = host('first'), second = host('second');
    for (const view of [first, second]) await waitFor(() => expect(view.region.getByRole('button', { name: 'Enable' })).toBeEnabled());
    await user.click(first.region.getByRole('button', { name: 'Enable' }));
    expect(await first.region.findByText('Notifications enabled.')).toBeVisible();
    await user.click(second.region.getByRole('button', { name: 'Enable' }));
    expect(await second.region.findByText('Notifications enabled.')).toBeVisible();
    expect(native.upsert).toHaveBeenCalledTimes(2);
    expect(native.upsert.mock.calls[0][0]).toEqual(native.upsert.mock.calls[1][0]);
    expect(native.upsert.mock.calls[0][0].endpoint).toBe(subscription.endpoint);
  });
  it('refills canonical endpoint state when returning to Notifications after a peer change', async () => {
    subscribed = true;
    const user = userEvent.setup(), view = host();
    await waitFor(() => expect(view.region.getByRole('button', { name: 'Disable' })).toBeEnabled());
    await user.click(view.region.getByRole('button', { name: 'Switch section' }));
    subscribed = false; // The peer disables server delivery while this panel is hidden.
    await user.click(view.region.getByRole('button', { name: 'Switch section' }));
    await waitFor(() => expect(view.region.getByRole('button', { name: 'Enable' })).toBeEnabled());
    expect(view.region.getByRole('button', { name: 'Disable' })).toBeDisabled();
  });
  it('keeps an admitted mutation alive while changing sections', async () => {
    let finish!: () => void;
    native.upsert.mockImplementation(() => new Promise(resolve => { finish = () => { subscribed = true; resolve({ subscription: null }); }; }));
    const user = userEvent.setup(), view = host();
    await waitFor(() => expect(view.region.getByRole('button', { name: 'Enable' })).toBeEnabled());
    await user.click(view.region.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(native.upsert).toHaveBeenCalled());
    try {
      await user.click(view.region.getByRole('button', { name: 'Switch section' }));
      await user.click(view.region.getByRole('button', { name: 'Switch section' }));
      expect(view.region.getByRole('button', { name: 'Enable' })).toBeDisabled();
      await act(async () => { finish(); });
      expect(await view.region.findByText('Notifications enabled.')).toBeVisible();
    } finally { finish?.(); }
  });
});
