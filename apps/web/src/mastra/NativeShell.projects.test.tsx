import { nativeReadStateFixture } from './testBuilders';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeShell } from './NativeShell';
import { DEFAULT_APPEARANCE_PREFERENCES } from '../theme/appearancePreferences';
import { useNativeCatalogSnapshot } from './NativeCatalogContext';
import type { CatalogSnapshot } from './client';
import { ProjectPane } from '../projects/ProjectPane';
import type { KodexShellView } from '../shell/KodexShellView';
import { createProject, updateProject, deleteProject, moveProject, listDirectories } from '../api/client';

const rpc = vi.hoisted(() => ({ watchCatalog: vi.fn(), listDirectories: vi.fn(), createProject: vi.fn(), updateProject: vi.fn(), deleteProject: vi.fn(), moveProjectBefore: vi.fn() }));
const workspace = vi.hoisted(() => ({ workspace: { panes: [], activePaneId: null }, paneThreadContextsById: {}, openDraftThreadPane: vi.fn().mockResolvedValue(undefined), publishThreadPaneTimelineAction: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: rpc }));
vi.mock('./NativeHostBoundary', () => ({ useNativeHost: () => ({ instanceId: 'instance' }) }));
vi.mock('./useNativeAccount', () => ({ useNativeAccount: () => ({ error: null, logout: vi.fn() }) }));
vi.mock('./NativeAccountMenu', () => ({ NativeAccountMenu: () => null }));
vi.mock('./NativeThreadPane', () => ({ NativeThreadPane: () => null }));
vi.mock('../workspace/WorkspaceProvider', () => ({ WorkspaceProvider: ({ children }: { children: ReactNode }) => children, useWorkspace: () => workspace }));
vi.mock('../api/client', async importOriginal => ({ ...await importOriginal<typeof import('../api/client')>(),
  listPinnedThreads: vi.fn().mockResolvedValue({ threads: [] }), createProject: vi.fn(), updateProject: vi.fn(), deleteProject: vi.fn(), moveProject: vi.fn(), listDirectories: vi.fn(),
}));
vi.mock('../shell/KodexShellView', () => ({ useNarrowThreadWorkspace: () => false,
  KodexShellView: ({ workspaceSidebarProps: sidebar, projectPaneProps: pane }: ComponentProps<typeof KodexShellView>) => {
    // An actual consumer below the shell shares its watch; it does not subscribe.
    const catalog = useNativeCatalogSnapshot();
    return <>
      <output aria-label="Catalog projects">{catalog?.projects.map(project => `${project.name}:${project.roots.join(',')}`).join('|')}</output>
      <output aria-label="Standalone chats">{sidebar.chatThreads.map(chat => chat.id).join(',')}</output>
      <button onClick={sidebar.onCreateProject}>Create project</button>
      <button onClick={() => sidebar.onMoveProject('project', null)}>Move project</button>
      <ProjectPane {...pane} />
    </>;
  },
}));
function stream() {
  let next: ((value: IteratorResult<CatalogSnapshot>) => void) | undefined;
  return { publish(value: CatalogSnapshot) { if (!next) throw new Error('No catalog consumer'); const consume = next; next = undefined; consume({ value, done: false }); },
    iterable: { [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<CatalogSnapshot>>(resolve => { next = resolve; }) }; } } };
}
const project = { id: 'project', name: 'Research', roots: ['/home/Research'] };
const catalog = (revision = 1): CatalogSnapshot => ({ epoch: 'epoch', revision, projects: [project], archivedChatIds: [], pinnedDescendants: [], pinnedChatIds: [], chats: [{ bindingId: 'binding', readState: nativeReadStateFixture(), id: 'chat', title: 'Chat', name: 'Chat', projectId: 'project', cwd: '/home/Research', pinned: false, notificationsEnabled: true, isRunning: false }] });
function shell() {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MantineProvider env="test"><NativeShell colorSchemeId="oled-black" appearance={DEFAULT_APPEARANCE_PREFERENCES} onAppearanceModeChange={vi.fn()} onThemeChange={vi.fn()} /></MantineProvider></QueryClientProvider>;
}
afterEach(() => { vi.clearAllMocks(); window.history.replaceState(null, '', '/'); });
it('uses native directory creation and waits for the canonical catalog before presenting the new project', async () => {
  window.history.replaceState(null, '', '/');
  const source = stream(); rpc.watchCatalog.mockResolvedValue(source.iterable);
  rpc.listDirectories.mockImplementation(async (input: { path?: string }) => ({ path: input.path ?? '/home', homePath: '/home', parentPath: input.path ? '/home' : null, directories: input.path ? [] : [{ name: 'Research', path: '/home/Research' }] }));
  rpc.createProject.mockResolvedValue(project);
  render(shell());
  await waitFor(() => expect(rpc.watchCatalog).toHaveBeenCalledOnce());
  await act(async () => source.publish({ ...catalog(), projects: [], chats: [] }));
  await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Research' }));
  await userEvent.click(screen.getByRole('button', { name: 'Use this directory' }));
  await userEvent.click(screen.getByRole('button', { name: 'Add project' }));
  await waitFor(() => expect(rpc.createProject).toHaveBeenCalledWith({ createKey: expect.any(String), path: '/home/Research' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByLabelText('Catalog projects')).toBeEmptyDOMElement();
  expect(workspace.openDraftThreadPane).toHaveBeenCalledWith('project');
  await act(async () => source.publish(catalog(2)));
  expect(screen.getByLabelText('Catalog projects')).toHaveTextContent('Research:/home/Research');
  expect(createProject).not.toHaveBeenCalled(); expect(listDirectories).not.toHaveBeenCalled();
  expect(rpc.watchCatalog).toHaveBeenCalledOnce();
});
it('converges two clients through canonical sparse edits, order changes, and detached membership', async () => {
  window.history.replaceState(null, '', '/projects/project');
  const first = stream(); const second = stream();
  rpc.watchCatalog.mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(second.iterable);
  rpc.updateProject.mockResolvedValue({ ...project, name: 'Shared', roots: ['/home/Changed'] });
  rpc.moveProjectBefore.mockResolvedValue({ accepted: true }); rpc.deleteProject.mockResolvedValue({ accepted: true });
  render(<><section aria-label="Client one">{shell()}</section><section aria-label="Client two">{shell()}</section></>);
  await waitFor(() => expect(rpc.watchCatalog).toHaveBeenCalledTimes(2));
  const other = { id: 'other', name: 'Other', roots: ['/home/Other'] };
  const initial = { ...catalog(), projects: [project, other] };
  await act(async () => { first.publish(initial); second.publish(initial); });
  const one = within(screen.getByRole('region', { name: 'Client one' })); const two = within(screen.getByRole('region', { name: 'Client two' }));
  fireEvent.change(one.getByRole('textbox', { name: 'Project name' }), { target: { value: 'Shared' } });
  fireEvent.change(one.getByLabelText('Root directories'), { target: { value: '/home/Changed' } });
  await userEvent.click(one.getByRole('button', { name: 'Save project' }));
  await waitFor(() => expect(rpc.updateProject).toHaveBeenCalledWith({ projectId: 'project', patch: { name: 'Shared', roots: ['/home/Changed'] } }));
  expect(two.getByRole('textbox', { name: 'Project name' })).toHaveValue('Research');
  const changed = { ...catalog(2), projects: [{ ...project, name: 'Shared', roots: ['/home/Changed'] }, other] };
  await act(async () => { first.publish(changed); second.publish(changed); });
  expect(two.getByRole('textbox', { name: 'Project name' })).toHaveValue('Shared'); expect(two.getByLabelText('Root directories')).toHaveValue('/home/Changed');
  await userEvent.click(one.getByRole('button', { name: 'Move project' }));
  await waitFor(() => expect(rpc.moveProjectBefore).toHaveBeenCalledWith({ projectId: 'project', beforeId: null }));
  expect(two.getByLabelText('Catalog projects')).toHaveTextContent('Shared:/home/Changed|Other:/home/Other');
  const ordered = { ...changed, revision: 3, projects: [other, changed.projects[0]] };
  await act(async () => { first.publish(ordered); second.publish(ordered); });
  expect(two.getByLabelText('Catalog projects')).toHaveTextContent('Other:/home/Other|Shared:/home/Changed');
  await userEvent.click(one.getByRole('button', { name: 'Delete project' }));
  await userEvent.click(within(screen.getByRole('dialog', { name: 'Delete Shared?' })).getByRole('button', { name: 'Delete project' }));
  await waitFor(() => expect(rpc.deleteProject).toHaveBeenCalledWith({ projectId: 'project' }));
  expect(two.getByLabelText('Catalog projects')).toHaveTextContent('Shared');
  const deleted = { ...catalog(4), projects: [other], chats: [{ ...catalog().chats[0], projectId: null }] };
  await act(async () => { first.publish(deleted); second.publish(deleted); });
  expect(two.getByLabelText('Catalog projects')).toHaveTextContent('Other:/home/Other'); expect(two.getByLabelText('Catalog projects')).not.toHaveTextContent('Shared'); expect(two.getByLabelText('Standalone chats')).toHaveTextContent('chat');
  expect(updateProject).not.toHaveBeenCalled(); expect(moveProject).not.toHaveBeenCalled(); expect(deleteProject).not.toHaveBeenCalled();
  expect(rpc.watchCatalog).toHaveBeenCalledTimes(2);
});
