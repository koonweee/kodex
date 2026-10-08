import { nativeQueueFixture, nativeSettingsFixture } from './testBuilders';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import type { ChatSnapshot } from './client';
import type { NativeSubagentList } from './useNativeSubagents';
import { NativeCatalogProvider } from './NativeCatalogContext';
import type { ComposerDraftStore } from '../composer/useComposerDraftState';
import type { WorkspacePane } from '../workspace/paneTypes';
import { NativeThreadPane } from './NativeThreadPane';

const native = vi.hoisted(() => ({ subagentError: null as string | null, retrySubagents: vi.fn(), subagents: null as NativeSubagentList | null, snapshot: null as ChatSnapshot | null, error: null as string | null, isLoadingOlderHistory: false, loadOlderHistory: vi.fn(), useWorkspace: vi.fn(), rename: vi.fn(), legacyRename: vi.fn(), registrations: vi.fn(), duplicate: vi.fn(), close: vi.fn(), watched: vi.fn() }));
vi.mock('./useNativeSnapshots', () => ({ useNativeChat: (id: string | null) => { native.watched(id); return { snapshot: id ? native.snapshot : null, error: native.error, isLoadingOlderHistory: native.isLoadingOlderHistory, loadOlderHistory: native.loadOlderHistory }; } }));
vi.mock('./useNativeSubagents', async importOriginal => ({
  ...await importOriginal<typeof import('./useNativeSubagents')>(),
  useNativeSubagents: () => {
    const [open, setOpen] = useState(false);
    const toggle = useCallback(() => setOpen(value => !value), []);
    return { snapshot: native.subagents, error: native.subagentError, open, toggle, selectedId: null, select: () => {}, retry: native.retrySubagents, isLoadingOlderHistory: false, loadOlderHistory: () => {} };
  },
  useNativeSubagentHistory: () => ({ snapshot: null, error: null, retry: () => {}, isLoadingOlderHistory: false, loadOlderHistory: () => {} }),
}));
vi.mock('../workspace/WorkspaceProvider', () => ({ useWorkspace: () => native.useWorkspace() }));
vi.mock('../api/client', () => ({ renameThread: (...args: unknown[]) => native.legacyRename(...args) }));
vi.mock('./NativeComposer', () => ({ NativeComposer: () => <div>Composer</div> }));
const pane: WorkspacePane = { id: 'pane', kind: 'thread', title: 'Chat title', target: { mode: 'existing', threadId: 'chat' } };
const context = createContext<Record<string, unknown>>({});
const stableActions = { onRenameThread: native.rename, onArchiveThread: vi.fn(), onPinThread: vi.fn(), onUnpinThread: vi.fn(), onSetThreadNotificationsEnabled: vi.fn() };
const stable = { closePane: native.close, errorMessage: null, setPaneThreadContext: vi.fn(), updatePane: vi.fn().mockResolvedValue(undefined), duplicatePane: native.duplicate, onShowMobileSidebar: vi.fn(), onImageOpen: vi.fn(), onMarkdownOpen: vi.fn(), threadActions: stableActions, showDebugEvents: false };
const onError = vi.fn();
function Harness({ children }: { children?: ReactNode }) {
  const [header, setHeader] = useState<ReactNode>(null);
  const setPaneHeaderActions = useCallback((id: string, actions: ReactNode | null) => { native.registrations(id, actions); setHeader(actions); }, []);
  // Header registration changes provider identity, just as the real workspace does.
  const value = useMemo(() => ({ ...stable, workspace: { activePaneId: 'pane' }, setPaneHeaderActions, header }), [header, setPaneHeaderActions]);
  return <MantineProvider env="test"><context.Provider value={value}><div aria-label="Workspace header">{header}</div>{children ?? <NativeThreadPane pane={pane} draftStore={{} as ComposerDraftStore} onError={onError} />}</context.Provider></MantineProvider>;
}
afterEach(() => { cleanup(); vi.clearAllMocks(); native.error = null; native.isLoadingOlderHistory = false; });
it('loads older native history, disables the pending action, and surfaces failures while preserving the timeline', async () => {
  native.useWorkspace.mockImplementation(() => useContext(context));
  native.snapshot = { epoch: 'epoch', revision: 1, chat: { id: 'chat', projectId: 'project', cwd: '/project', title: 'Chat title', name: 'Chat title', pinned: false, notificationsEnabled: true }, display: defaultDisplayState(), messages: [], error: null, goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(), history: { earliest: 'recent', hasOlder: true } };
  const view = render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Load older history' }));
  expect(native.loadOlderHistory).toHaveBeenCalledOnce();
  native.isLoadingOlderHistory = true;
  await act(async () => view.rerender(<Harness />));
  const loading = screen.getByRole('button', { name: 'Loading older history' });
  expect(loading).toBeDisabled();
  fireEvent.click(loading);
  expect(native.loadOlderHistory).toHaveBeenCalledOnce();
  native.isLoadingOlderHistory = false; native.error = 'History unavailable';
  await act(async () => view.rerender(<Harness />));
  expect(screen.getByRole('alert')).toHaveTextContent('History unavailable');
  expect(screen.getByRole('button', { name: 'Load older history' })).toBeEnabled();
  expect(screen.queryByLabelText('Loading chat')).not.toBeInTheDocument();
  native.error = null;
  native.snapshot = { ...native.snapshot, history: { earliest: 'oldest', hasOlder: false } };
  await act(async () => view.rerender(<Harness />));
  expect(screen.queryByRole('button', { name: 'Load older history' })).not.toBeInTheDocument();
});
it('registers one workspace action menu, keeps it stable while streaming, and unregisters on removal', async () => {
  native.useWorkspace.mockImplementation(() => useContext(context));
  native.snapshot = { epoch: 'epoch', revision: 1, chat: { id: 'chat', projectId: 'project', cwd: '/project', title: 'Chat title', name: 'Chat title', pinned: false, notificationsEnabled: true }, display: defaultDisplayState(), messages: [], error: null, goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(), history: { earliest: null, hasOlder: false } };
  const view = render(<Harness />);
  const header = screen.getByLabelText('Workspace header');
  expect(within(header).getByRole('button', { name: 'Thread actions' })).toBeInTheDocument();
  const section = screen.getByRole('region', { name: 'Chat title' });
  expect(within(section).getByRole('heading', { name: 'Chat title' })).toBeInTheDocument();
  expect(within(section).queryByRole('button', { name: 'Thread actions' })).not.toBeInTheDocument();
  expect(within(section).queryByRole('button', { name: 'Threads' })).not.toBeInTheDocument();
  expect(native.registrations).toHaveBeenCalledTimes(1);
  native.snapshot = { ...native.snapshot, revision: 2, chat: { ...native.snapshot.chat }, display: { ...native.snapshot.display, isRunning: true } };
  await act(async () => view.rerender(<Harness />));
  expect(native.registrations).toHaveBeenCalledTimes(1);
  fireEvent.click(within(header).getByRole('button', { name: 'Thread actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate pane' }));
  expect(native.duplicate).toHaveBeenCalledWith('pane');
  view.unmount();
  expect(native.registrations).toHaveBeenLastCalledWith('pane', null);
});
it('opens rename from the workspace header with the current title and preserves the command', async () => {
  native.useWorkspace.mockImplementation(() => useContext(context));
  native.snapshot = { epoch: 'epoch', revision: 1, chat: { id: 'chat', projectId: 'project', cwd: '/project', title: 'Native title', name: 'Native title', pinned: false, notificationsEnabled: true }, display: defaultDisplayState(), messages: [], error: null, goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(), history: { earliest: null, hasOlder: false } };
  native.rename.mockResolvedValue({});
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Thread actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename thread' }));
  const dialog = await screen.findByRole('dialog', { name: 'Rename thread' });
  expect(within(dialog).getByRole('textbox', { name: 'Thread name' })).toHaveValue('Native title');
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Thread name' }), { target: { value: 'Renamed' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
  await waitFor(() => expect(native.rename).toHaveBeenCalledWith('chat', 'Renamed'));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename thread' })).not.toBeInTheDocument());
});

it('renders pin and notification preferences only from canonical chat snapshots', async () => {
  native.useWorkspace.mockImplementation(() => useContext(context));
  native.snapshot = { epoch: 'epoch', revision: 1, chat: { id: 'chat', projectId: null, cwd: '/retained', title: 'Native title', name: 'Native title', pinned: true, notificationsEnabled: false }, display: defaultDisplayState(), messages: [], error: null, goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(), history: { earliest: null, hasOlder: false } };
  const view = render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Thread actions' }));
  expect(await screen.findByRole('menuitem', { name: 'Unpin thread' })).toBeInTheDocument();
  const notifications = await screen.findByRole('menuitem', { name: 'Notifications' });
  expect(notifications).toHaveAttribute('aria-checked', 'false');
  fireEvent.click(notifications);
  expect(stableActions.onSetThreadNotificationsEnabled).toHaveBeenCalledWith('chat', true);
  expect(notifications).toHaveAttribute('aria-checked', 'false');
  native.snapshot = { ...native.snapshot, revision: 2, chat: { ...native.snapshot.chat, pinned: false, notificationsEnabled: true } };
  await act(async () => view.rerender(<Harness />));
  expect(screen.getByRole('menuitem', { name: 'Notifications' })).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Pin thread' }));
  expect(stableActions.onPinThread).toHaveBeenCalledWith('chat');
});

it('keeps a rejected rename draft in the exact main form and validates blank names locally', async () => {
  native.useWorkspace.mockImplementation(() => useContext(context));
  native.snapshot = { epoch: 'epoch', revision: 1, chat: { id: 'chat', projectId: null, cwd: '/project', title: 'Original', name: 'Original', pinned: false, notificationsEnabled: true }, display: defaultDisplayState(), messages: [], error: null, goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(), history: { earliest: null, hasOlder: false } };
  native.rename.mockRejectedValue(new Error('Native rename failed'));
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Thread actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename thread' }));
  const dialog = await screen.findByRole('dialog', { name: 'Rename thread' });
  const input = within(dialog).getByRole('textbox', { name: 'Thread name' });
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  fireEvent.change(input, { target: { value: '   ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
  expect(await within(dialog).findByText('Thread name cannot be empty.')).toBeInTheDocument();
  expect(native.rename).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: ' My name ' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
  expect(await within(dialog).findByText('Native rename failed')).toBeInTheDocument();
  expect(input).toHaveValue(' My name ');
  expect(native.rename).toHaveBeenCalledWith('chat', 'My name');
  expect(native.legacyRename).not.toHaveBeenCalled();
  expect(screen.getByRole('region', { name: 'Original' })).toBeInTheDocument();
});

it('starts an unnamed chat rename with a blank name and keeps acknowledgments separate from watched titles', async () => {
  native.useWorkspace.mockImplementation(() => useContext(context));
  native.snapshot = { epoch: 'epoch', revision: 1, chat: { id: 'chat', projectId: null, cwd: '/project', title: 'First user preview', name: null, pinned: false, notificationsEnabled: true }, display: defaultDisplayState(), messages: [], error: null, goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(), history: { earliest: null, hasOlder: false } };
  let acknowledge!: () => void;
  native.rename.mockReturnValue(new Promise<void>(resolve => { acknowledge = resolve; }));
  const view = render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Thread actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename thread' }));
  const dialog = await screen.findByRole('dialog', { name: 'Rename thread' });
  const input = within(dialog).getByRole('textbox', { name: 'Thread name' });
  expect(input).toHaveValue(''); expect(input).toHaveAttribute('placeholder', 'First user preview');
  fireEvent.change(input, { target: { value: 'My name' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
  await waitFor(() => expect(native.rename).toHaveBeenCalledWith('chat', 'My name'));
  expect(input).toBeDisabled(); expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
  expect(native.rename).toHaveBeenCalledOnce();
  native.snapshot = { ...native.snapshot, revision: 2, chat: { ...native.snapshot.chat, title: 'Other client name', name: 'Other client name' } };
  await act(async () => view.rerender(<Harness />));
  expect(input).toHaveValue('My name');
  await act(async () => acknowledge());
  expect(screen.queryByRole('dialog', { name: 'Rename thread' })).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Other client name' })).toBeInTheDocument();
  expect(native.legacyRename).not.toHaveBeenCalled();
});

it('ignores a late rename failure after the pane changes chats', async () => {
  native.useWorkspace.mockImplementation(() => useContext(context));
  native.snapshot = { epoch: 'epoch', revision: 1, chat: { id: 'chat', projectId: null, cwd: '/project', title: 'Original', name: 'Original', pinned: false, notificationsEnabled: true }, display: defaultDisplayState(), messages: [], error: null, goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(), history: { earliest: null, hasOlder: false } };
  let reject!: (error: Error) => void;
  native.rename.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
  const view = render(<Harness><NativeThreadPane pane={pane} draftStore={{} as ComposerDraftStore} onError={onError} /></Harness>);
  fireEvent.click(screen.getByRole('button', { name: 'Thread actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename thread' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Thread name' }), { target: { value: 'Old draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  await waitFor(() => expect(native.rename).toHaveBeenCalled());
  native.snapshot = { ...native.snapshot, chat: { ...native.snapshot.chat, id: 'other', title: 'Other chat', name: 'Other chat' } };
  await act(async () => view.rerender(<Harness><NativeThreadPane pane={{ ...pane, target: { mode: 'existing', threadId: 'other' } }} draftStore={{} as ComposerDraftStore} onError={onError} /></Harness>));
  expect(screen.queryByRole('dialog', { name: 'Rename thread' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Thread actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename thread' }));
  await act(async () => reject(new Error('Obsolete rename error')));
  expect(screen.getByRole('textbox', { name: 'Thread name' })).toHaveValue('Other chat');
  expect(screen.queryByText('Obsolete rename error')).not.toBeInTheDocument();
  expect(onError).not.toHaveBeenCalled();
});

it('stops watching only after explicit authoritative archive state arrives', () => {
  native.useWorkspace.mockImplementation(() => useContext(context));
  native.snapshot = null;
  const catalog = { epoch: 'epoch', revision: 1, projects: [], chats: [], pinnedChatIds: [], archivedChatIds: [] as string[] };
  const view = render(<NativeCatalogProvider snapshot={catalog}><Harness /></NativeCatalogProvider>);
  expect(native.watched).toHaveBeenLastCalledWith('chat');
  expect(native.close).not.toHaveBeenCalled(); // Absence from inventory is not archive.
  view.rerender(<NativeCatalogProvider snapshot={{ ...catalog, revision: 2, archivedChatIds: ['other'] }}><Harness /></NativeCatalogProvider>);
  expect(native.close).not.toHaveBeenCalled();
  view.rerender(<NativeCatalogProvider snapshot={{ ...catalog, revision: 3, archivedChatIds: ['chat'] }}><Harness /></NativeCatalogProvider>);
  expect(native.watched).toHaveBeenLastCalledWith(null);
  expect(native.close).not.toHaveBeenCalled(); // Workspace owner closes mounted and unmounted panes together.
});

it('opens main subagent viewer from the pane header and preserves the parent composer', async () => {
  native.useWorkspace.mockImplementation(() => useContext(context));
  native.snapshot = { epoch: 'epoch', revision: 1, chat: { id: 'chat', projectId: null, cwd: '/project', title: 'Parent', name: 'Parent', pinned: false, notificationsEnabled: true }, display: defaultDisplayState(), messages: [], error: null, goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(), history: { earliest: null, hasOlder: false } };
  native.subagents = { epoch: 'epoch', revision: 1, chatId: 'chat', invocations: [{ id: 'child-call', agentType: 'explore', task: 'Inspect', modelId: null, forked: false, status: 'completed', result: 'Native child findings', activity: null }], forks: [], children: [], history: { earliest: null, hasOlder: false } };
  try {
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show subagents' }));
    const viewer = await screen.findByRole('complementary', { name: 'Subagent thread viewer' });
    expect(await within(viewer).findByText('Native child findings')).toBeVisible();
    expect(screen.getByText('Composer')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Hide subagents' }));
    expect(screen.queryByRole('complementary', { name: 'Subagent thread viewer' })).not.toBeInTheDocument();
  } finally { native.subagents = null; }
});

it('keeps the shared error viewer and reload action reachable when initial subagent discovery fails', async () => {
  native.useWorkspace.mockImplementation(() => useContext(context));
  native.subagents = null; native.subagentError = 'Native child inventory unavailable';
  try {
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show subagents' }));
    const viewer = await screen.findByRole('complementary', { name: 'Subagent thread viewer' });
    expect(within(viewer).getByText('Native child inventory unavailable')).toBeVisible();
    fireEvent.click(within(viewer).getByRole('button', { name: 'Reload subagents' }));
    expect(native.retrySubagents).toHaveBeenCalledOnce();
  } finally { native.subagentError = null; }
});

it('opens the inspector when only fresh delegated children exist', async () => {
  native.useWorkspace.mockImplementation(() => useContext(context));
  native.snapshot = { epoch: 'epoch', revision: 1, chat: { id: 'chat', projectId: null, cwd: '/project', title: 'Parent', name: 'Parent', pinned: false, notificationsEnabled: true }, display: defaultDisplayState(), messages: [], error: null, goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(), history: { earliest: null, hasOlder: false } };
  native.subagents = { epoch: 'epoch', revision: 1, chatId: 'chat', invocations: [], forks: [], children: [{ id: 'fresh', title: 'Fresh child', active: false }], history: { earliest: null, hasOlder: false } };
  try {
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show subagents' }));
    expect(await screen.findByRole('complementary', { name: 'Subagent thread viewer' })).toBeVisible();
    expect(screen.getByText('Composer')).toBeVisible();
  } finally { native.subagents = null; }
});
