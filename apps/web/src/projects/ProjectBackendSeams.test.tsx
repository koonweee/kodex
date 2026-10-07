import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectCreateDialog } from './ProjectCreateDialog';
import { ProjectEditor } from './ProjectEditor';
import { createProject, listDirectories, updateProject, deleteProject } from '../api/client';
const publish = vi.hoisted(() => vi.fn());
vi.mock('../workspace/WorkspaceProvider', () => ({ useWorkspace: () => ({ publishThreadPaneTimelineAction: publish }) }));
vi.mock('../api/client', () => ({ createProject: vi.fn(), listDirectories: vi.fn(), updateProject: vi.fn(), deleteProject: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); });
const project = { id: 'project', name: 'Research', roots: [{ path: '/home/example/Research' }] };
function wrap(children: React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return <QueryClientProvider client={client}><MantineProvider env="test">{children}</MantineProvider></QueryClientProvider>;
}
it('uses injected directory/create operations, derives the name, and retains the creation key across an explicit retry', async () => {
  const load = vi.fn(async (path?: string) => ({ path: path ?? '/home/example', parentPath: path ? '/home/example' : null,
    directories: path ? [] : [{ name: 'Research', path: project.roots[0].path }] }));
  const create = vi.fn().mockRejectedValueOnce(new Error('Reply lost')).mockResolvedValue(project);
  const created = vi.fn(); const closed = vi.fn();
  render(wrap(<ProjectCreateDialog onClose={closed} onCreated={created} onCreate={create} directoryLoader={load} directoryQueryScope="native" />));
  await userEvent.click(await screen.findByRole('button', { name: 'Research' }));
  await waitFor(() => expect(screen.getByText(project.roots[0].path)).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: 'Use this directory' }));
  await userEvent.click(screen.getByRole('button', { name: 'Add project' }));
  await screen.findByText('Reply lost');
  await userEvent.click(screen.getByRole('button', { name: 'Add project' }));
  await waitFor(() => expect(created).toHaveBeenCalledWith(project));
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0][0]).toEqual({ name: 'Research', roots: project.roots, idempotencyKey: expect.any(String) });
  expect(create.mock.calls[1][0]).toEqual(create.mock.calls[0][0]);
  expect(closed).toHaveBeenCalledOnce();
  expect(createProject).not.toHaveBeenCalled(); expect(listDirectories).not.toHaveBeenCalled();
});
it('uses injected sparse updates and retains zero/multiple root editing without calling the old backend', async () => {
  const update = vi.fn().mockResolvedValue(undefined); const remove = vi.fn();
  render(wrap(<ProjectEditor project={project} onDeleted={vi.fn()} actions={{ update, remove }} />));
  fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), { target: { value: 'Renamed' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save project' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ name: 'Renamed' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('Research'));
  fireEvent.change(screen.getByLabelText('Root directories'), { target: { value: '' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save project' }));
  await waitFor(() => expect(update).toHaveBeenNthCalledWith(2, { roots: [] }));
  await waitFor(() => expect(screen.getByLabelText('Root directories')).toHaveValue(project.roots[0].path));
  fireEvent.change(screen.getByLabelText('Root directories'), { target: { value: '/first\n/second' } });
  await userEvent.click(screen.getByRole('button', { name: 'Save project' }));
  await waitFor(() => expect(update).toHaveBeenNthCalledWith(3, { roots: [{ path: '/first' }, { path: '/second' }] }));
  expect(updateProject).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
});
it('preserves edited text after a canonical refill and an authoritative rejected update', async () => {
  const oldUpdate = vi.fn();
  const freshUpdate = vi.fn().mockRejectedValue(new Error('Project no longer exists.'));  const remove = vi.fn(); const client = new QueryClient();
  const view = render(wrap(<ProjectEditor project={project} onDeleted={vi.fn()} actions={{ update: oldUpdate, remove }} />, client));
  fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), { target: { value: 'My edit' } });
  view.rerender(wrap(<ProjectEditor project={{ ...project, name: 'Other client name' }} onDeleted={vi.fn()} actions={{ update: freshUpdate, remove }} />, client));
  await userEvent.click(screen.getByRole('button', { name: 'Save project' }));
  await screen.findByText('Project no longer exists.');
  expect(freshUpdate).toHaveBeenCalledWith({ name: 'My edit' });
  expect(oldUpdate).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('My edit');
});
it('retains the deletion confirmation and calls only the injected removal', async () => {
  const remove = vi.fn().mockResolvedValue(undefined); const deleted = vi.fn();
  render(wrap(<ProjectEditor project={project} onDeleted={deleted} actions={{ update: vi.fn(), remove }} />));
  await userEvent.click(screen.getByRole('button', { name: 'Delete project' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete Research?' });
  expect(dialog).toHaveTextContent('Its chats will remain available without a project. Files are unchanged.');
  expect(remove).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));
  await waitFor(() => expect(deleted).toHaveBeenCalledOnce());
  expect(remove).toHaveBeenCalledOnce(); expect(deleteProject).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
});
