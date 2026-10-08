import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeShell } from './NativeShell';
import type { CatalogSnapshot } from './client';
import { DEFAULT_APPEARANCE_PREFERENCES } from '../theme/appearancePreferences';
import { createMemoryWorkspacePaneStore } from '../workspace/paneStore';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import type { WorkspaceSidebar } from '../threads/WorkspaceSidebar';
import type { NativeThreadPane } from './NativeThreadPane';

const state = vi.hoisted(() => ({ snapshot: null as CatalogSnapshot | null }));
vi.mock('./client', () => ({ mastraClient: {} }));
vi.mock('./NativeHostBoundary', () => ({ useNativeHost: () => ({ instanceId: 'descendant-fixture' }) }));
vi.mock('./useNativeAccount', () => ({ useNativeAccount: () => ({ error: null, logout: vi.fn() }) }));
vi.mock('./NativeAccountMenu', () => ({ NativeAccountMenu: () => null }));
vi.mock('./useNativeSnapshots', async original => ({ ...await original<typeof import('./useNativeSnapshots')>(),
  useNativeCatalog: () => ({ snapshot: state.snapshot, error: null, retry: vi.fn() }),
}));
vi.mock('./NativeThreadPane', () => ({ NativeThreadPane: ({ pane }: ComponentProps<typeof NativeThreadPane>) =>
  <output aria-label="Native thread pane">{pane.kind === 'thread' && pane.target.mode === 'existing' ? `${pane.target.threadId}:${pane.title}` : 'draft'}</output>,
}));
vi.mock('../threads/WorkspaceSidebar', () => ({ WorkspaceSidebar: (props: ComponentProps<typeof WorkspaceSidebar>) => <>
  <section aria-label="Pinned rows">{props.pinnedThreads.map(row => <button key={row.id} onClick={() => props.onSelectPinnedThread(row.id)}>{row.name}</button>)}</section>
  <output aria-label="Ordinary chats">{props.chatThreads.map(row => row.id).join(',')}</output>
  <output aria-label="Project chats">{Object.values(props.threadsByProjectId).flat().map(row => row.id).join(',')}</output>
  <output aria-label="Selected project">{props.selectedProjectId}</output>
</> }));
vi.mock('../workspace/WorkspaceShell', () => ({ WorkspaceShell: () => {
  const { workspace, renderThreadPane } = useWorkspace();
  const active = workspace.panes.find(pane => pane.id === workspace.activePaneId);
  return active ? renderThreadPane?.(active, null) : null;
} }));
function catalog(): CatalogSnapshot {
  const base = { projectId: 'project', cwd: '/project', pinned: true, notificationsEnabled: true };
  return { epoch: 'native', revision: 1, projects: [{ id: 'project', name: 'Project', roots: ['/project'] }], archivedChatIds: [],
    chats: [{ ...base, id: 'parent', title: 'Parent', name: 'Parent', isRunning: false }], pinnedChatIds: ['fork', 'parent', 'child'],
    pinnedDescendants: [
      { ...base, id: 'fork', title: 'Fork preview', name: null, kind: 'fork', rootChatId: 'parent', parentThreadId: 'child' },
      { ...base, id: 'child', title: 'Child preview', name: null, kind: 'child', rootChatId: 'parent', parentThreadId: 'parent' },
    ],
  };
}
function shell(restored = false) {
  if (!restored) window.history.replaceState(null, '', '/threads/parent');
  state.snapshot = catalog();
  const store = createMemoryWorkspacePaneStore({ schemaVersion: 1, dockviewLayout: null,
    activePaneId: restored ? 'saved-child' : 'saved-parent',
    panes: restored ? [
      { id: 'saved-child', kind: 'thread', target: { mode: 'existing', threadId: 'child' }, title: 'Child saved title' },
      { id: 'saved-fork', kind: 'thread', target: { mode: 'existing', threadId: 'fork' }, title: 'Fork saved title' },
      { id: 'saved-parent', kind: 'thread', target: { mode: 'existing', threadId: 'parent' }, title: 'Parent' },
    ] : [{ id: 'saved-parent', kind: 'thread', target: { mode: 'existing', threadId: 'parent' }, title: 'Parent' }],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = () => <QueryClientProvider client={client}><MantineProvider env="test"><NativeShell workspacePaneStore={store}
    colorSchemeId="oled-black" appearance={DEFAULT_APPEARANCE_PREFERENCES} onAppearanceModeChange={vi.fn()} onThemeChange={vi.fn()} /></MantineProvider></QueryClientProvider>;
  const view = render(content());
  return { store, refresh: () => view.rerender(content()) };
}
afterEach(() => { cleanup(); state.snapshot = null; window.history.replaceState(null, '', '/'); });
const pinnedTitles = () => [...screen.getByRole('region', { name: 'Pinned rows' }).querySelectorAll('button')].map(button => button.textContent);

it('opens pinned child and fork using native panes and preserves ordinary inventory isolation', async () => {
  const { store } = shell();
  expect(pinnedTitles()).toEqual(['Fork preview', 'Parent', 'Child preview']);
  expect(screen.getByLabelText('Ordinary chats').textContent).toBe('');
  expect(screen.getByLabelText('Project chats')).toHaveTextContent('parent');
  fireEvent.click(screen.getByRole('button', { name: 'Child preview' }));
  await waitFor(() => expect(screen.getByLabelText('Native thread pane')).toHaveTextContent('child:Child preview'));
  expect(window.location.pathname).toBe('/threads/child');
  expect(screen.getByLabelText('Selected project')).toHaveTextContent('project');
  fireEvent.click(screen.getByRole('button', { name: 'Fork preview' }));
  await waitFor(() => expect(screen.getByLabelText('Native thread pane')).toHaveTextContent('fork:Fork preview'));
  expect(store.getState().panes.filter(pane => pane.kind === 'thread').map(pane => pane.target.mode === 'existing' ? pane.target.threadId : null)).toEqual(['parent', 'child', 'fork']);
});

it('refills descendant pinned title/order from canonical catalog without adding project/chat rows', () => {
  const { refresh } = shell();
  const current = state.snapshot!;
  state.snapshot = { ...current, revision: 2, pinnedChatIds: ['child', 'fork', 'parent'],
    pinnedDescendants: current.pinnedDescendants.map(row => row.id === 'child' ? { ...row, title: 'Peer renamed child', name: 'Peer renamed child' } : row) };
  refresh();
  expect(pinnedTitles()).toEqual(['Peer renamed child', 'Fork preview', 'Parent']);
  expect(screen.getByLabelText('Project chats')).toHaveTextContent('parent');
  expect(screen.getByLabelText('Project chats')).not.toHaveTextContent('child');
});

it('restores a descendant deep link and closes panes only on explicit native archive identities', async () => {
  window.history.replaceState(null, '', '/threads/child');
  const { store, refresh } = shell(true);
  await waitFor(() => expect(store.getState().activePaneId).toBe('saved-child'));
  expect(screen.getByLabelText('Selected project')).toHaveTextContent('project');
  const current = state.snapshot!;
  state.snapshot = { ...current, revision: 2, pinnedDescendants: [], pinnedChatIds: ['parent'] }; refresh();
  expect(store.getState().panes).toHaveLength(3);
  state.snapshot = { ...state.snapshot, revision: 3, archivedChatIds: ['child', 'fork'] }; refresh();
  await waitFor(() => expect(store.getState().panes.map(pane => pane.id)).toEqual(['saved-parent']));
  expect(window.location.pathname).toBe('/threads/parent');
});
