import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeShell } from './NativeShell';
import { DEFAULT_APPEARANCE_PREFERENCES } from '../theme/appearancePreferences';
import { createMemoryWorkspacePaneStore } from '../workspace/paneStore';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import type { WorkspaceSidebar } from '../threads/WorkspaceSidebar';

const archive = vi.hoisted(() => ({ ids: [] as string[], command: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: { archiveChat: archive.command } }));
vi.mock('./NativeHostBoundary', () => ({ useNativeHost: () => ({ instanceId: 'routing-fixture' }) }));
vi.mock('./useNativeAccount', () => ({ useNativeAccount: () => ({ error: null, logout: () => undefined }) }));
vi.mock('./NativeAccountMenu', () => ({ NativeAccountMenu: () => null }));
vi.mock('./NativeThreadPane', () => ({ NativeThreadPane: () => null }));
vi.mock('./useNativeSnapshots', async actual => ({ ...await actual<typeof import('./useNativeSnapshots')>(), useNativeCatalog: () => ({
  snapshot: { epoch: 'routing', revision: 1, projects: [{ id: 'project', name: 'Project', roots: ['/fixture'] }], archivedChatIds: archive.ids, pinnedChatIds: [],
    chats: ['a', 'b'].map(id => ({ id, title: id.toUpperCase(), projectId: null, cwd: '/fixture', pinned: false, notificationsEnabled: true })) },
  error: null, retry: () => undefined,
}) }));
vi.mock('../projects/ProjectPane', () => ({ ProjectPane: () => <h1>Project settings</h1> }));
vi.mock('../threads/WorkspaceSidebar', () => ({
  WorkspaceSidebar: (props: ComponentProps<typeof WorkspaceSidebar>) => <>
    <output aria-label="Selected sidebar chat">{props.selectedThreadId}</output>
    <button onClick={() => props.onSelectChatThread('b')}>Select chat B</button>
    <button onClick={() => props.onSelectProjectSettings('project')}>Open project settings</button>
  </>,
}));
vi.mock('../workspace/WorkspaceShell', () => ({ WorkspaceShell: WorkspaceProbe }));
function WorkspaceProbe() {
  const { workspace, focusPane, threadActions, errorMessage } = useWorkspace();
  return <>
    <button onClick={() => threadActions.onArchiveThread?.('a')}>Archive A</button><output aria-label="Workspace error">{errorMessage}</output>
    <output aria-label="Active workspace pane">{workspace.activePaneId}</output>
    <button onClick={() => focusPane('pane-a')}>Focus pane A</button>
    <button onClick={() => focusPane('pane-b')}>Focus pane B</button>
  </>;
}
function shell(activePaneId: 'pane-a' | 'pane-b') {
  const store = createMemoryWorkspacePaneStore({
    schemaVersion: 1, dockviewLayout: null, activePaneId,
    panes: ['a', 'b'].map(id => ({ id: `pane-${id}`, kind: 'thread', target: { mode: 'existing', threadId: id }, title: id.toUpperCase() })),
  });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = () => <QueryClientProvider client={queries}><MantineProvider env="test">
    <NativeShell workspacePaneStore={store} colorSchemeId="oled-black" appearance={DEFAULT_APPEARANCE_PREFERENCES}
      onAppearanceModeChange={() => undefined} onThemeChange={() => undefined} />
  </MantineProvider></QueryClientProvider>;
  const view = render(content());
  return { view, store, refresh: () => view.rerender(content()) };
}
afterEach(() => { archive.ids = []; archive.command.mockReset(); cleanup(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

it('settles a deep link against different restored focus without inserting that focus into browser history', async () => {
  window.history.replaceState(null, '', '/threads/a');
  const push = vi.spyOn(window.history, 'pushState');
  const { store } = shell('pane-b');
  await waitFor(() => expect(store.getState().activePaneId).toBe('pane-a'));
  expect(window.location.pathname).toBe('/threads/a');
  expect(screen.getByLabelText('Selected sidebar chat')).toHaveTextContent('a');
  expect(push.mock.calls.map(call => call[2])).not.toContain('/threads/b');
});

it('keeps explicit pane focus and browser back/forward requests separate', async () => {
  window.history.replaceState(null, '', '/threads/a');
  const push = vi.spyOn(window.history, 'pushState');
  const { store } = shell('pane-a');
  await waitFor(() => expect(store.getState().activePaneId).toBe('pane-a'));
  fireEvent.click(screen.getByRole('button', { name: 'Focus pane B' }));
  await waitFor(() => expect(window.location.pathname).toBe('/threads/b'));
  expect(store.getState().activePaneId).toBe('pane-b');
  expect(push).not.toHaveBeenCalled();
  // Supply the destination URL and the browser notification consumed by the
  // shell; this does not replace the real-browser two-tab/reload validation.
  await act(async () => {
    window.history.replaceState(null, '', '/threads/a');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await waitFor(() => expect(store.getState().activePaneId).toBe('pane-a'));
  expect(window.location.pathname).toBe('/threads/a');
  await act(async () => {
    window.history.replaceState(null, '', '/threads/b');
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new Event('focus'));
  });
  await waitFor(() => expect(store.getState().activePaneId).toBe('pane-b'));
  expect(window.location.pathname).toBe('/threads/b');
  await act(async () => {
    window.history.replaceState(null, '', '/projects/project');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(await screen.findByRole('heading', { name: 'Project settings' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/projects/project');
  await act(async () => {
    window.history.replaceState(null, '', '/threads/a');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await waitFor(() => expect(store.getState().activePaneId).toBe('pane-a'));
  expect(window.location.pathname).toBe('/threads/a');
  fireEvent.click(screen.getByRole('button', { name: 'Select chat B' }));
  await waitFor(() => expect(store.getState().activePaneId).toBe('pane-b'));
  expect(window.location.pathname).toBe('/threads/b');
  expect(push).toHaveBeenCalledOnce();
  expect(push.mock.calls[0]?.[2]).toBe('/threads/b');
  expect(store.getState().panes).toHaveLength(2);
});

it('does not let restored hidden workspace focus replace an initial project route', async () => {
  window.history.replaceState(null, '', '/projects/project');
  shell('pane-b');
  expect(await screen.findByRole('heading', { name: 'Project settings' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/projects/project');
  expect(screen.queryByLabelText('Active workspace pane')).not.toBeInTheDocument();
});

it('removes inactive archived panes from persisted workspace even when no thread pane is mounted', async () => {
  window.history.replaceState(null, '', '/projects/project');
  const { store, refresh } = shell('pane-b');
  expect(store.getState().panes).toHaveLength(2);
  archive.ids = ['a']; refresh();
  await waitFor(() => expect(store.getState().panes.map(pane => pane.id)).toEqual(['pane-b']));
  expect(window.location.pathname).toBe('/projects/project');
});

it('keeps panes on rejected native archive and closes only after explicit archive state', async () => {
  window.history.replaceState(null, '', '/threads/a');
  const { store, refresh } = shell('pane-a');
  archive.command.mockRejectedValueOnce(new Error('Native teardown failed')).mockResolvedValueOnce({ accepted: true });
  fireEvent.click(screen.getByRole('button', { name: 'Archive A' }));
  await waitFor(() => expect(screen.getByLabelText('Workspace error')).toHaveTextContent('Native teardown failed'));
  expect(store.getState().panes).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Archive A' }));
  await waitFor(() => expect(archive.command).toHaveBeenCalledTimes(2));
  expect(store.getState().panes).toHaveLength(2);
  archive.ids = ['a']; refresh();
  await waitFor(() => expect(store.getState().panes.map(pane => pane.id)).toEqual(['pane-b']));
  expect(window.location.pathname).toBe('/threads/b');
});

// Shell workflow fixtures do not exercise platform presence/badges.
vi.mock('./nativePresenceTransport', () => ({ nativePresenceTransport: { replace: async () => ({ accepted: true }), sendOnExit: () => true } }));
vi.mock('./useNativeUnreadBadge', () => ({ useNativeUnreadBadge: vi.fn() }));
