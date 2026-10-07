import { MantineProvider } from '@mantine/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import type { ChatSnapshot } from './client';
import type { ComposerDraftStore } from '../composer/useComposerDraftState';
import type { WorkspacePane } from '../workspace/paneTypes';
import { NativeThreadPane } from './NativeThreadPane';

const native = vi.hoisted(() => ({ snapshot: null as ChatSnapshot | null, useWorkspace: vi.fn(), rename: vi.fn(), registrations: vi.fn(), duplicate: vi.fn() }));
vi.mock('./useNativeSnapshots', () => ({ useNativeChat: () => ({ snapshot: native.snapshot, error: null }) }));
vi.mock('../workspace/WorkspaceProvider', () => ({ useWorkspace: () => native.useWorkspace() }));
vi.mock('../api/client', () => ({ renameThread: (...args: unknown[]) => native.rename(...args) }));
vi.mock('./NativeComposer', () => ({ NativeComposer: () => <div>Composer</div> }));
vi.mock('../timeline/TimelineView', () => ({ TimelineView: () => <div>Native timeline</div> }));
const pane: WorkspacePane = { id: 'pane', kind: 'thread', title: 'Chat title', target: { mode: 'existing', threadId: 'chat' } };
const context = createContext<Record<string, unknown>>({});
const stableActions = { onArchiveThread: vi.fn(), onPinThread: vi.fn(), onUnpinThread: vi.fn(), onSetThreadNotificationsEnabled: vi.fn() };
const stable = { errorMessage: null, setPaneThreadContext: vi.fn(), updatePane: vi.fn().mockResolvedValue(undefined), duplicatePane: native.duplicate, onShowMobileSidebar: vi.fn(), onImageOpen: vi.fn(), onMarkdownOpen: vi.fn(), threadActions: stableActions, showDebugEvents: false };
const onError = vi.fn();
function Harness({ children }: { children?: ReactNode }) {
  const [header, setHeader] = useState<ReactNode>(null);
  const setPaneHeaderActions = useCallback((id: string, actions: ReactNode | null) => { native.registrations(id, actions); setHeader(actions); }, []);
  // Header registration changes provider identity, just as the real workspace does.
  const value = useMemo(() => ({ ...stable, workspace: { activePaneId: 'pane' }, setPaneHeaderActions, header }), [header, setPaneHeaderActions]);
  return <MantineProvider><context.Provider value={value}><div aria-label="Workspace header">{header}</div>{children ?? <NativeThreadPane pane={pane} draftStore={{} as ComposerDraftStore} onError={onError} />}</context.Provider></MantineProvider>;
}
afterEach(() => { vi.clearAllMocks(); });
it('registers one workspace action menu, keeps it stable while streaming, and unregisters on removal', async () => {
  native.useWorkspace.mockImplementation(() => useContext(context));
  native.snapshot = { epoch: 'epoch', revision: 1, chat: { id: 'chat', projectId: 'project', cwd: '/project', title: 'Chat title' }, display: defaultDisplayState(), messages: [], error: null };
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
  native.snapshot = { epoch: 'epoch', revision: 1, chat: { id: 'chat', projectId: 'project', cwd: '/project', title: 'Native title' }, display: defaultDisplayState(), messages: [], error: null };
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
