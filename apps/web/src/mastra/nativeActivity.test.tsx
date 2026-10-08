import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ThreadListRow } from '../threads/ThreadSidebarRows';
import type { CatalogSnapshot } from './client';
import { chatListEntry } from './presentation';

it('shows shared sidebar activity only for the native chat that is running and clears it on a stop snapshot', () => {
  const first = { id: 'first', projectId: null, title: 'First chat', name: 'First chat', cwd: '/project', pinned: false, notificationsEnabled: true, isRunning: false };
  const second = { ...first, id: 'second', title: 'Second chat', name: 'Second chat' };
  const callbacks = { onArchiveThread: vi.fn(), onPinThread: vi.fn(), onSelectThread: vi.fn(), onThreadActionHoverChange: vi.fn(), onUnpinThread: vi.fn() };
  const pending = new Set<string>();
  const rows = (chats: CatalogSnapshot['chats']) => <MantineProvider env="test">{chats.map(chat => <section key={chat.id} aria-label={chat.title}>
    <ThreadListRow {...callbacks} approvals={[]} isSelected={false} pendingTitleThreadIds={pending}
      showThreadArchiveAction={false} thread={chatListEntry(chat)} />
  </section>)}</MantineProvider>;
  const view = render(rows([first, second]));
  expect(screen.queryByRole('status', { name: 'Thread in progress' })).not.toBeInTheDocument();
  view.rerender(rows([{ ...first, isRunning: true }, second]));
  expect(within(screen.getByRole('region', { name: 'First chat' })).getByRole('status', { name: 'Thread in progress' })).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Second chat' })).queryByRole('status')).not.toBeInTheDocument();
  view.rerender(rows([first, { ...second, isRunning: true }]));
  expect(within(screen.getByRole('region', { name: 'First chat' })).queryByRole('status')).not.toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Second chat' })).getByRole('status', { name: 'Thread in progress' })).toBeInTheDocument();
  view.rerender(rows([first, second]));
  expect(screen.queryByRole('status', { name: 'Thread in progress' })).not.toBeInTheDocument();
  expect(screen.queryByRole('img', { name: 'Unread completed agent turn' })).not.toBeInTheDocument();
});
