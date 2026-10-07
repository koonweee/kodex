import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { NativeAccountMenu } from './NativeAccountMenu';
import type { useNativeAccount } from './useNativeAccount';

function renderMenu(state: ReturnType<typeof useNativeAccount>) {
  const actions = { onSelectAutomations: vi.fn(), onOpenPreferences: vi.fn(), onShowDebugEventsChange: vi.fn() };
  const element = (value: typeof state) => <MantineProvider env="test"><NativeAccountMenu state={value} {...actions} showDebugEvents={false} /></MantineProvider>;
  const view = render(element(state));
  return { ...actions, rerenderState(value: typeof state) { view.rerender(element(value)); } };
}
it('uses the native label/avatar and existing quota formatter without inventing an email', async () => {
  const logout = vi.fn();
  const actions = renderMenu({ snapshot: { epoch: 'epoch', revision: 1, authenticated: true, account: { id: 'native', label: 'Dev account', expiresAt: null, needsRefresh: false } }, error: null, logoutPending: false, logout,
    usage: { accountId: 'native', observedAt: new Date(0).toISOString(), primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 0 }, secondary: { usedPercent: 36, windowDurationMins: 10080, resetsAt: 0 } } });
  expect(screen.getByRole('button', { name: 'Account settings' })).toHaveTextContent('D');
  fireEvent.click(screen.getByRole('button', { name: 'Account settings' }));
  expect(await screen.findByText('5h 82% left')).toBeInTheDocument();
  expect(screen.getByText('7d 64% left')).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: 'Automations' })).toBeInTheDocument();
  expect(screen.getByRole('menuitemcheckbox', { name: 'Show debug events' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Preferences' }));
  expect(actions.onOpenPreferences).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Account settings' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Logout' }));
  expect(logout).toHaveBeenCalledOnce();
});
it('keeps Sign in visible and opens guidance for this instance dedicated profile', async () => {
  renderMenu({ snapshot: { epoch: 'epoch', revision: 1, authenticated: false, account: null }, usage: null, error: null, logoutPending: false, logout: vi.fn() });
  fireEvent.click(screen.getByRole('button', { name: 'Account settings' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign in with ChatGPT' }));
  expect(await screen.findByRole('dialog', { name: 'Sign in with ChatGPT' })).toBeInTheDocument();
  expect(screen.getByText(/this instance.*dedicated profile/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog', { name: 'Sign in with ChatGPT' })).not.toBeInTheDocument();
});

it('closes CLI guidance when a canonical native snapshot reports sign-in from another client', async () => {
  const state: ReturnType<typeof useNativeAccount> = { snapshot: { epoch: 'epoch', revision: 1, authenticated: false, account: null }, usage: null, error: null, logoutPending: false, logout: vi.fn() };
  const view = renderMenu(state);
  fireEvent.click(screen.getByRole('button', { name: 'Account settings' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign in with ChatGPT' }));
  expect(await screen.findByRole('dialog', { name: 'Sign in with ChatGPT' })).toBeInTheDocument();
  view.rerenderState({ ...state, snapshot: { epoch: 'epoch', revision: 2, authenticated: true, account: { id: 'native', label: 'Dev account', expiresAt: null, needsRefresh: false } } });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sign in with ChatGPT' })).not.toBeInTheDocument());
});
