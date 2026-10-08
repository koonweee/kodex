import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeShell } from './NativeShell';
import { DEFAULT_APPEARANCE_PREFERENCES } from '../theme/appearancePreferences';
import { AutomationsPane } from '../automations/AutomationsPane';
import type { KodexShellView } from '../shell/KodexShellView';
import { listAutomations, listAutomationRuns, updateAutomation } from '../api/client';
import type { NativeAutomation } from './nativeAutomationTypes';

const rpc = vi.hoisted(() => ({ watchAutomations: vi.fn(), watchAutomationRuns: vi.fn(), updateAutomation: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: rpc }));
vi.mock('./NativeHostBoundary', () => ({ useNativeHost: () => ({ instanceId: 'automations-fixture' }) }));
vi.mock('./useNativeAccount', () => ({ useNativeAccount: () => ({ error: null, logout: vi.fn() }) }));
vi.mock('./NativeAccountMenu', () => ({ NativeAccountMenu: () => null }));
vi.mock('./NativeThreadPane', () => ({ NativeThreadPane: () => null }));
vi.mock('./useNativeSnapshots', async original => ({ ...await original<typeof import('./useNativeSnapshots')>(), useNativeCatalog: () => ({
  snapshot: { epoch: 'catalog', revision: 1, projects: [], archivedChatIds: [], pinnedChatIds: [],
    chats: [{ id: 'native-chat', title: 'Native chat', projectId: null, cwd: '/project', pinned: false, notificationsEnabled: true }] }, error: null, retry: vi.fn(),
}) }));
vi.mock('../workspace/WorkspaceProvider', () => ({ WorkspaceProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('../api/client', async original => ({ ...await original<typeof import('../api/client')>(), listAutomations: vi.fn().mockResolvedValue([]), listAutomationRuns: vi.fn(), updateAutomation: vi.fn() }));
vi.mock('../shell/KodexShellView', () => ({ useNarrowThreadWorkspace: () => false,
  KodexShellView: ({ automationsPaneProps }: ComponentProps<typeof KodexShellView>) => <AutomationsPane {...automationsPaneProps} />,
}));
function stream() {
  let receive: ((value: IteratorResult<{ epoch: string; revision: number; rows: NativeAutomation[] }>) => void) | undefined;
  return { publish(rows: NativeAutomation[], revision = 1) { if (!receive) throw new Error('Missing consumer'); const next = receive; receive = undefined; next({ value: { epoch: 'stream', revision, rows }, done: false }); },
    iterable: (async function* () { while (true) { const next = await new Promise<IteratorResult<{ epoch: string; revision: number; rows: NativeAutomation[] }>>(resolve => { receive = resolve; }); if (next.done) return; yield next.value; } })() };
}
const saved: NativeAutomation = { id: 'native-automation', name: 'Calendar review', prompt: ' Original\n', targetThreadId: 'native-chat',
  cron: '15 14 * * 2', timezone: 'America/New_York', status: 'active', nextFireAt: Date.UTC(2026, 10, 3, 14, 15), createdAt: 1, updatedAt: 2 };
afterEach(() => { vi.resetAllMocks(); window.history.replaceState(null, '', '/'); });

it('wires the shared calendar editor and native run history, refilling sparse writes without legacy traffic', async () => {
  window.history.replaceState(null, '', '/automations');
  const first = stream(), refill = stream();
  rpc.watchAutomations.mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(refill.iterable);
  rpc.watchAutomationRuns.mockResolvedValue((async function* () { yield { epoch: 'runs', revision: 1, rows: [] }; await new Promise(() => undefined); })());
  rpc.updateAutomation.mockResolvedValue({ ...saved, name: 'Command response only' });
  render(<QueryClientProvider client={new QueryClient()}><MantineProvider env="test"><NativeShell colorSchemeId="oled-black" appearance={DEFAULT_APPEARANCE_PREFERENCES} onAppearanceModeChange={vi.fn()} onThemeChange={vi.fn()} /></MantineProvider></QueryClientProvider>);
  await waitFor(() => expect(rpc.watchAutomations).toHaveBeenCalledOnce());
  await act(async () => first.publish([saved]));
  await userEvent.click(screen.getByRole('row', { name: /Calendar review/ }));
  expect(await screen.findByRole('dialog', { name: 'Automation details' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Target thread' })).not.toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Cron expression' })).toHaveValue(saved.cron);
  await waitFor(() => expect(rpc.watchAutomationRuns).toHaveBeenCalledWith({ id: saved.id }, { signal: expect.any(AbortSignal) }));
  const name = screen.getByRole('textbox', { name: 'Name' });
  await userEvent.clear(name); await userEvent.type(name, 'Local calendar name');
  await act(async () => first.publish([{ ...saved, prompt: 'Peer prompt', updatedAt: 3 }], 2));
  expect(screen.getByLabelText('Automation prompt')).toHaveValue(saved.prompt);
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(rpc.updateAutomation).toHaveBeenCalledWith({ id: saved.id, patch: { name: 'Local calendar name' } }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('row', { name: /Calendar review/ })).toBeInTheDocument();
  expect(screen.queryByText('Command response only')).not.toBeInTheDocument();
  await waitFor(() => expect(rpc.watchAutomations).toHaveBeenCalledTimes(2));
  await act(async () => refill.publish([{ ...saved, name: 'Canonical calendar name', prompt: 'Peer prompt' }], 3));
  expect(screen.getByRole('row', { name: /Canonical calendar name/ })).toBeInTheDocument();
  expect(listAutomations).not.toHaveBeenCalled(); expect(listAutomationRuns).not.toHaveBeenCalled(); expect(updateAutomation).not.toHaveBeenCalled();
});
