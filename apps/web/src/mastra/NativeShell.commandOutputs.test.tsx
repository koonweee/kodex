import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import { TimelineItemRenderer } from '../timeline/renderers';
import type { KodexShellView } from '../shell/KodexShellView';
import { DEFAULT_APPEARANCE_PREFERENCES } from '../theme/appearancePreferences';
import { NativeShell } from './NativeShell';
import type { ChatSnapshot } from './client';
import { timelinePresentation } from './presentation';
import { nativeQueueFixture, nativeReadStateFixture, nativeSettingsFixture } from './testBuilders';
import { useNativeChat } from './useNativeSnapshots';

const rpc = vi.hoisted(() => ({ watchChat: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: rpc }));
vi.mock('./NativeHostBoundary', () => ({ useNativeHost: () => ({ instanceId: 'outputs-fixture' }) }));
vi.mock('./useNativeAccount', () => ({ useNativeAccount: () => ({ snapshot: null, usage: null, error: null, logoutPending: false, logout: vi.fn() }) }));
vi.mock('./NativeThreadPane', () => ({ NativeThreadPane: () => null }));
vi.mock('./useNativeSnapshots', async original => ({ ...await original<typeof import('./useNativeSnapshots')>(), useNativeCatalog: () => ({
  snapshot: { epoch: 'catalog', revision: 1, projects: [], chats: [], archivedChatIds: [], pinnedDescendants: [], pinnedChatIds: [] },
  error: null, retry: vi.fn(),
}) }));
vi.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({ workspace: { panes: [], activePaneId: null }, paneThreadContextsById: {} }),
  WorkspaceProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../shell/KodexShellView', () => ({ KodexShellView: ({ workspaceSidebarProps }: ComponentProps<typeof KodexShellView>) =>
  <>{workspaceSidebarProps.accountMenu}<CommandHistory /></>,
}));
vi.mock('./nativePresenceTransport', () => ({ nativePresenceTransport: { replace: async () => ({ accepted: true }), sendOnExit: () => true } }));
vi.mock('./useNativeUnreadBadge', () => ({ useNativeUnreadBadge: vi.fn() }));

function CommandHistory() {
  const { snapshot } = useNativeChat('native-chat');
  const items = snapshot ? timelinePresentation(snapshot).rows.flatMap(row => row.type === 'activity' ? row.items : row.type === 'item' ? [row.item] : []) : [];
  return <>{items.map(item => <TimelineItemRenderer key={item.id} item={item} />)}</>;
}
function snapshot(): ChatSnapshot {
  return { epoch: 'native', revision: 1, chat: { bindingId: 'binding', id: 'native-chat', title: 'Native chat', name: null, cwd: '/project', projectId: null, pinned: false, notificationsEnabled: true },
    readState: nativeReadStateFixture(), error: null, display: defaultDisplayState(), prompts: [], settings: nativeSettingsFixture(), queue: nativeQueueFixture(), goal: null,
    history: { earliest: null, hasOlder: false }, messages: [{ id: 'answer', role: 'assistant', createdAt: new Date(0), content: { format: 2, parts: [{ type: 'tool-invocation', toolInvocation: {
      toolCallId: 'shell', toolName: 'execute_command', state: 'result', args: { command: 'exit 7' }, result: 'Exit code: 7',
    } }] } }] };
}
function shell() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MantineProvider env="test">
    <NativeShell colorSchemeId="oled-black" appearance={DEFAULT_APPEARANCE_PREFERENCES} onAppearanceModeChange={vi.fn()} onThemeChange={vi.fn()} />
  </MantineProvider></QueryClientProvider>);
}
afterEach(() => { cleanup(); vi.clearAllMocks(); window.history.replaceState(null, '', '/'); });

it('toggles retained native outputs per tab without restarting history reads or inventing command success', async () => {
  rpc.watchChat.mockImplementation(async (_input, { signal }: { signal: AbortSignal }) => (async function* () {
    yield snapshot();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  })());
  const first = shell(), second = shell();
  const one = within(first.container), two = within(second.container);
  await waitFor(() => expect(rpc.watchChat).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getAllByText('Finished')).toHaveLength(2));
  expect(one.getByText('$ exit 7')).toBeInTheDocument();
  expect(one.queryByText('Exit code: 7')).not.toBeInTheDocument();
  expect(two.queryByText('Exit code: 7')).not.toBeInTheDocument();
  await userEvent.click(one.getByRole('button', { name: 'Account settings' }));
  const toggle = await one.findByRole('menuitemcheckbox', { name: 'Show command outputs' });
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  await userEvent.click(toggle);
  expect(one.getByText('Exit code: 7')).toBeInTheDocument();
  expect(two.queryByText('Exit code: 7')).not.toBeInTheDocument();
  expect(one.queryByText('Success')).not.toBeInTheDocument();
  expect(one.getByText('Finished')).toBeInTheDocument();
  expect(rpc.watchChat).toHaveBeenCalledTimes(2);
  const enabled = await one.findByRole('menuitemcheckbox', { name: 'Show command outputs' });
  expect(enabled).toHaveAttribute('aria-checked', 'true');
  await userEvent.click(enabled);
  expect(one.queryByText('Exit code: 7')).not.toBeInTheDocument();
  expect(one.getByText('$ exit 7')).toBeInTheDocument();
  expect(rpc.watchChat).toHaveBeenCalledTimes(2);
});
