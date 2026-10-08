import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeShell } from './NativeShell';
import { DEFAULT_APPEARANCE_PREFERENCES } from '../theme/appearancePreferences';
import { useNativeCatalogSnapshot } from './NativeCatalogContext';
import type { CatalogSnapshot } from './client';
import { PinnedThreadsSidebar } from '../threads/PinnedThreadsSidebar';
import { ThreadActionsMenu } from '../panes/thread/ThreadActionsMenu';
import type { KodexShellView } from '../shell/KodexShellView';
import type { WorkspaceProvider } from '../workspace/WorkspaceProvider';
import { listPinnedThreads, setThreadPinned, setThreadNotificationsEnabled } from '../api/client';

const rpc = vi.hoisted(() => ({ watchCatalog: vi.fn(), setChatPinned: vi.fn(), setChatNotifications: vi.fn(), archiveChat: vi.fn() }));
const actionsContext = createContext<NonNullable<ComponentProps<typeof WorkspaceProvider>['threadActions']>>({});
vi.mock('./client', () => ({ mastraClient: rpc }));
vi.mock('./NativeHostBoundary', () => ({ useNativeHost: () => ({ instanceId: 'instance' }) }));
vi.mock('./useNativeAccount', () => ({ useNativeAccount: () => ({ error: null, logout: vi.fn() }) }));
vi.mock('./NativeAccountMenu', () => ({ NativeAccountMenu: () => null }));
vi.mock('./NativeThreadPane', () => ({ NativeThreadPane: () => null }));
vi.mock('../workspace/WorkspaceProvider', () => ({ useWorkspace: () => ({ workspace: { panes: [] }, closeThreadPanes: vi.fn() }), WorkspaceProvider: ({ children, threadActions, errorMessage }: { children: ReactNode; threadActions: ComponentProps<typeof WorkspaceProvider>['threadActions']; errorMessage: string | null }) =>
  <actionsContext.Provider value={threadActions ?? {}}>{errorMessage ? <div role="alert">{errorMessage}</div> : null}{children}</actionsContext.Provider>,
}));
vi.mock('../api/client', async importOriginal => ({ ...await importOriginal<typeof import('../api/client')>(), listPinnedThreads: vi.fn(), setThreadPinned: vi.fn(), setThreadNotificationsEnabled: vi.fn() }));
vi.mock('../shell/KodexShellView', () => ({ useNarrowThreadWorkspace: () => false,
  KodexShellView: ({ workspaceSidebarProps: sidebar }: ComponentProps<typeof KodexShellView>) => {
    const actions = useContext(actionsContext); const catalog = useNativeCatalogSnapshot();
    return <>
      <PinnedThreadsSidebar collapsed={false} onToggle={vi.fn()} searchQuery="" approvals={[]} hoveredThreadActionId={null} pendingTitleThreadIds={new Set()} selectedThreadId={null}
        threads={sidebar.pinnedThreads} pinPending={sidebar.pinPending} onMovePinnedThread={sidebar.onMovePinnedThread}
        onPinThread={sidebar.onPinThread} onUnpinThread={sidebar.onUnpinThread} onSelectThread={vi.fn()} onArchiveThread={vi.fn()} onThreadActionHoverChange={vi.fn()} />
      <ThreadActionsMenu thread={catalog?.chats.find(chat => chat.id === 'a') ?? null} threadId="a" pinPending={actions.pinPending}
        onDuplicatePane={vi.fn()} onRenameThread={vi.fn()} onArchiveThread={actions.onArchiveThread} onPinThread={actions.onPinThread} onUnpinThread={actions.onUnpinThread} onSetThreadNotificationsEnabled={actions.onSetThreadNotificationsEnabled} />
    </>;
  },
}));
function stream() {
  let next: ((value: IteratorResult<CatalogSnapshot>) => void) | undefined;
  return { publish(value: CatalogSnapshot) { if (!next) throw new Error('No catalog consumer'); const consume = next; next = undefined; consume({ value, done: false }); },
    iterable: { [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<CatalogSnapshot>>(resolve => { next = resolve; }) }; } } };
}
function catalog(revision = 1, ids = ['b', 'c'], notificationsEnabled = true): CatalogSnapshot {
  return { epoch: 'epoch', revision, projects: [], archivedChatIds: [], pinnedChatIds: ids, chats: ['a', 'b', 'c'].map(id => ({ id, title: id.toUpperCase(), name: id.toUpperCase(), projectId: null, cwd: '/retained', pinned: ids.includes(id), notificationsEnabled: id === 'a' ? notificationsEnabled : true, isRunning: false })) };
}
function shell() {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MantineProvider env="test"><NativeShell colorSchemeId="oled-black" appearance={DEFAULT_APPEARANCE_PREFERENCES} onAppearanceModeChange={vi.fn()} onThemeChange={vi.fn()} /></MantineProvider></QueryClientProvider>;
}
const rowTitles = (client: ReturnType<typeof within>) => within(client.getByRole('group', { name: 'Pinned' })).getAllByRole('button', { name: /^[ABC]$/ }).map(row => row.textContent);
afterEach(() => { vi.resetAllMocks(); });
it('keeps pin/order/preferences canonical across two clients and uses actual main pinned order controls', async () => {
  const first = stream(); const second = stream();
  rpc.watchCatalog.mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(second.iterable);
  let acknowledge!: () => void;
  rpc.setChatPinned.mockReturnValueOnce(new Promise<void>(resolve => { acknowledge = resolve; })).mockResolvedValue({ accepted: true });
  rpc.setChatNotifications.mockResolvedValue({ accepted: true });
  render(<><section aria-label="Client one">{shell()}</section><section aria-label="Client two">{shell()}</section></>);
  await waitFor(() => expect(rpc.watchCatalog).toHaveBeenCalledTimes(2));
  await act(async () => { first.publish(catalog()); second.publish(catalog()); });
  const one = within(screen.getByRole('region', { name: 'Client one' })); const two = within(screen.getByRole('region', { name: 'Client two' }));
  await userEvent.click(one.getByRole('button', { name: 'Thread actions' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Pin thread' }));
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  await waitFor(() => expect(rpc.setChatPinned).toHaveBeenCalledWith({ chatId: 'a', pinned: true }, { signal: expect.any(AbortSignal) }));
  expect(one.getAllByRole('button', { name: 'Unpin thread' }).every(button => button.hasAttribute('disabled'))).toBe(true);
  expect(rowTitles(one)).toEqual(['B', 'C']); expect(rowTitles(two)).toEqual(['B', 'C']);
  await act(async () => acknowledge());
  expect(rowTitles(one)).toEqual(['B', 'C']); expect(rowTitles(two)).toEqual(['B', 'C']);
  await act(async () => { first.publish(catalog(2, ['b', 'c', 'a'])); second.publish(catalog(2, ['b', 'c', 'a'])); });
  expect(rowTitles(one)).toEqual(['B', 'C', 'A']); expect(rowTitles(two)).toEqual(['B', 'C', 'A']);
  await userEvent.click(one.getByRole('button', { name: 'Thread actions for B' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Move down' }));
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  await waitFor(() => expect(one.getByRole('button', { name: 'Thread actions for B' })).toHaveFocus());
  await waitFor(() => expect(rpc.setChatPinned).toHaveBeenLastCalledWith({ chatId: 'b', pinned: true, beforeChatId: 'a' }, { signal: expect.any(AbortSignal) }));
  expect(rowTitles(two)).toEqual(['B', 'C', 'A']);
  await act(async () => { first.publish(catalog(3, ['c', 'b', 'a'])); second.publish(catalog(3, ['c', 'b', 'a'])); });
  expect(rowTitles(one)).toEqual(['C', 'B', 'A']); expect(rowTitles(two)).toEqual(['C', 'B', 'A']);
  await userEvent.click(one.getByRole('button', { name: 'Thread actions' }));
  const notification = await screen.findByRole('menuitem', { name: 'Notifications' });
  expect(notification).toHaveAttribute('aria-checked', 'true');
  await userEvent.click(notification);
  await waitFor(() => expect(rpc.setChatNotifications).toHaveBeenCalledWith({ chatId: 'a', enabled: false }, { signal: expect.any(AbortSignal) }));
  expect(notification).toHaveAttribute('aria-checked', 'true');
  await act(async () => { first.publish(catalog(4, ['c', 'b', 'a'], false)); second.publish(catalog(4, ['c', 'b', 'a'], false)); });
  expect(notification).toHaveAttribute('aria-checked', 'false');
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  await waitFor(() => expect(one.getByRole('button', { name: 'Thread actions' })).toHaveFocus());
  await userEvent.click(two.getByRole('button', { name: 'Thread actions' }));
  expect(await screen.findByRole('menuitem', { name: 'Notifications' })).toHaveAttribute('aria-checked', 'false');
  expect(rpc.watchCatalog).toHaveBeenCalledTimes(2);
  expect(listPinnedThreads).not.toHaveBeenCalled(); expect(setThreadPinned).not.toHaveBeenCalled(); expect(setThreadNotificationsEnabled).not.toHaveBeenCalled();
});
it('preserves canonical pin membership when a native command is rejected and displays the error', async () => {
  const source = stream(); rpc.watchCatalog.mockResolvedValue(source.iterable);
  rpc.setChatPinned.mockRejectedValue(new Error('Chat no longer exists'));
  render(shell()); await waitFor(() => expect(rpc.watchCatalog).toHaveBeenCalledOnce());
  await act(async () => source.publish(catalog()));
  await userEvent.click(screen.getByRole('button', { name: 'Thread actions' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Pin thread' }));
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  expect(await screen.findByRole('alert')).toHaveTextContent('Chat no longer exists');
  expect(screen.getAllByRole('button', { name: 'Unpin thread' }).every(button => !button.hasAttribute('disabled'))).toBe(true);
  expect(rowTitles(within(document.body))).toEqual(['B', 'C']); expect(rpc.setChatPinned).toHaveBeenCalledOnce();
});

it('archives through the native command and lets canonical inventory remove the saved chat', async () => {
  const source = stream(); rpc.watchCatalog.mockResolvedValue(source.iterable);
  rpc.archiveChat.mockResolvedValue({ accepted: true });
  render(shell()); await waitFor(() => expect(rpc.watchCatalog).toHaveBeenCalledOnce());
  await act(async () => source.publish(catalog(1, ['a', 'b'])));
  await userEvent.click(screen.getByRole('button', { name: 'Thread actions' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive thread' }));
  await waitFor(() => expect(rpc.archiveChat).toHaveBeenCalledWith({ chatId: 'a' }));
  expect(rowTitles(within(document.body))).toEqual(['A', 'B']);
  const updated = catalog(2, ['b']); updated.chats = updated.chats.filter(chat => chat.id !== 'a'); updated.archivedChatIds = ['a'];
  await act(async () => source.publish(updated));
  expect(rowTitles(within(document.body))).toEqual(['B']);
});
