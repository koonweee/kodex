import { MantineProvider } from '@mantine/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { QueuePanel } from '../queuedInputs/QueuePanel';
import { useMastraQueue } from './useMastraQueue';
import { useNativeSnapshots } from './useNativeSnapshots';
import type { ChatSnapshot } from './client';
const rpc = vi.hoisted(() => ({ editQueued: vi.fn(), reorderQueued: vi.fn(), removeQueued: vi.fn(), steerQueued: vi.fn(), dismissQueued: vi.fn(), reconcileQueued: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: rpc }));
type Snapshot = ChatSnapshot['queue'];
const queued = (text = 'Original', revision = 1): Snapshot => ({ epoch: 'epoch', revision, nativeCount: 1, partial: false, rows: [{ id: 'row', nativeSignalId: 'native', status: 'queued', input: { text } }] });
const restore = vi.fn();
function Panel({ snapshot, label = 'client' }: { snapshot: Snapshot; label?: string }) {
  const queue = useMastraQueue('chat', snapshot, vi.fn(), vi.fn());
  return <section aria-label={label}><QueuePanel controller={queue} canRestoreText onRestoreText={restore} /></section>;
}
const wrap = (children: React.ReactNode) => <MantineProvider env="test">{children}</MantineProvider>;
afterEach(() => { vi.clearAllMocks(); });
it('keeps an edit pinned to its displayed queue version and preserves its text after another client changes the queue', async () => {
  rpc.editQueued.mockResolvedValue({ outcome: 'conflict', snapshot: queued('Other client edit', 2) });
  const view = render(wrap(<Panel snapshot={queued()} />));
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Queued message text'), { target: { value: 'My unsaved edit' } });
  view.rerender(wrap(<Panel snapshot={queued('Other client edit', 2)} />));
  await userEvent.click(screen.getByRole('button', { name: 'Save queued message' }));
  await waitFor(() => expect(rpc.editQueued).toHaveBeenCalledWith({ chatId: 'chat', epoch: 'epoch', revision: 1, id: 'row', input: { text: 'My unsaved edit' } }));
  expect(screen.getByLabelText('Queued message text')).toHaveValue('My unsaved edit');
  expect(screen.getByRole('dialog', { name: 'Edit queued message' })).toBeInTheDocument();
  expect(await screen.findByRole('alert', { name: 'Queue unavailable' })).toHaveTextContent('changed');
  await userEvent.click(screen.getByRole('button', { name: 'Reload queue' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save queued message' }));
  await waitFor(() => expect(rpc.editQueued).toHaveBeenCalledTimes(2));
  expect(rpc.editQueued.mock.lastCall?.[0].revision).toBe(1);
});
it('converges two watched clients and never lets an older mutation reply refill canonical queue state', async () => {
  let resolve!: (value: unknown) => void;
  rpc.removeQueued.mockReturnValue(new Promise(done => { resolve = done; }));
  const consumers: Array<(value: IteratorResult<Snapshot>) => void> = [];
  const watch = async (signal: AbortSignal) => ({ [Symbol.asyncIterator]() { return {
    next: () => new Promise<IteratorResult<Snapshot>>(done => {
      consumers.push(done);
      signal.addEventListener('abort', () => done({ value: undefined, done: true }), { once: true });
    }),
  }; } });
  function Client({ label }: { label: string }) {
    const state = useNativeSnapshots('chat', watch);
    return <Panel label={label} snapshot={state.snapshot ?? { ...queued(), rows: [] }} />;
  }
  render(wrap(<><Client label="first" /><Client label="second" /></>));
  await waitFor(() => expect(consumers).toHaveLength(2));
  await act(async () => { for (const done of consumers.splice(0)) done({ value: queued(), done: false }); });
  await userEvent.click(within(screen.getByRole('region', { name: 'first' })).getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(consumers).toHaveLength(2));
  await act(async () => { for (const done of consumers.splice(0)) done({ value: queued('New canonical input', 3), done: false }); });
  await act(async () => resolve({ outcome: 'applied', snapshot: { ...queued(), revision: 2, rows: [] } }));
  for (const name of ['first', 'second']) expect(within(screen.getByRole('region', { name })).getByText('New canonical input')).toBeInTheDocument();
});
it('restores uncertain saved input only after an explicit warning and does not resend or dismiss it', async () => {
  render(wrap(<Panel snapshot={{ ...queued(), rows: [{ ...queued().rows[0], status: 'uncertain' }] }} />));
  await userEvent.click(screen.getByRole('button', { name: 'Restore to composer' }));
  expect(screen.getByRole('dialog', { name: 'Restore saved input' })).toHaveTextContent('may already have been delivered');
  expect(restore).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Restore text' }));
  expect(restore).toHaveBeenCalledWith('Original');
  expect(rpc.dismissQueued).not.toHaveBeenCalled();

});

it('distinguishes recoverable input and confirms restoration without resubmitting', async () => {
  render(wrap(<Panel snapshot={{ ...queued(), rows: [{ ...queued().rows[0], status: 'recoverable', nativeSignalId: null }] }} />));
  expect(screen.getByText('Input not delivered')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Restore to composer' }));
  expect(screen.getByRole('dialog', { name: 'Restore saved input' })).toHaveTextContent('not admitted for delivery');
  expect(restore).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Restore text' }));
  expect(restore).toHaveBeenCalledWith('Original');
  expect(rpc.dismissQueued).not.toHaveBeenCalled();
});
it('submits one complete reorder with the displayed version and disables changes during native steering', async () => {
  const initial: Snapshot = { ...queued(), rows: [...queued().rows, { id: 'second', input: { text: 'Second' }, status: 'queued', nativeSignalId: 'native-second' }] };
  rpc.reorderQueued.mockResolvedValue({ outcome: 'applied', snapshot: initial });
  const view = render(wrap(<Panel snapshot={initial} />));
  const handle = within(screen.getAllByRole('group', { name: 'Queued message' })[1]).getByRole('button', { name: 'Reorder queued message' });
  handle.focus(); await userEvent.keyboard('{ArrowUp}');
  await waitFor(() => expect(rpc.reorderQueued).toHaveBeenCalledWith({ chatId: 'chat', epoch: 'epoch', revision: 1, ids: ['second', 'row'] }));
  const steering: Snapshot = { ...initial, revision: 2, rows: [{ ...initial.rows[0], status: 'steering' }, initial.rows[1]] };
  view.rerender(wrap(<Panel snapshot={steering} />));
  const first = screen.getAllByRole('group', { name: 'Queued message' })[0];
  expect(within(first).getByRole('button', { name: 'Edit' })).toBeDisabled();
  expect(within(first).getByRole('button', { name: 'Remove' })).toBeDisabled();
  for (const button of screen.getAllByRole('button', { name: 'Reorder queued message' })) expect(button).toBeDisabled();
});

it('keeps unresolved reconciliation recoverable and applies resolved receipt visibility only through canonical snapshots', async () => {
  const uncertain: Snapshot = { ...queued(), rows: [{ ...queued().rows[0], status: 'uncertain' }] };
  rpc.reconcileQueued.mockResolvedValue({ outcome: 'uncertain', snapshot: uncertain });
  const view = render(wrap(<Panel snapshot={uncertain} />));
  await userEvent.click(screen.getByRole('button', { name: 'Reconcile' }));
  await waitFor(() => expect(rpc.reconcileQueued).toHaveBeenCalledWith({ chatId: 'chat', epoch: 'epoch', revision: 1, id: 'row' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reconcile' })).toBeEnabled());
  expect(screen.getByText('Delivery uncertain')).toBeInTheDocument();
  expect(restore).not.toHaveBeenCalled();
  rpc.reconcileQueued.mockResolvedValue({ outcome: 'applied', snapshot: { ...uncertain, revision: 2, rows: [] } });
  await userEvent.click(screen.getByRole('button', { name: 'Reconcile' }));
  await waitFor(() => expect(rpc.reconcileQueued).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Delivery uncertain')).toBeInTheDocument();
  view.rerender(wrap(<Panel snapshot={{ ...uncertain, revision: 2, rows: [] }} />));
  expect(screen.queryByText('Delivery uncertain')).not.toBeInTheDocument();
  expect(restore).not.toHaveBeenCalled();
  expect(rpc.dismissQueued).not.toHaveBeenCalled();
});

it('cancels a drag after the watched queue version changes even when row IDs stay the same', async () => {
  const initial: Snapshot = { ...queued(), rows: [...queued().rows, { id: 'second', input: { text: 'Second' }, status: 'queued', nativeSignalId: 'native-second' }] };
  rpc.reorderQueued.mockResolvedValue({ outcome: 'applied', snapshot: initial });
  const view = render(wrap(<Panel snapshot={initial} />));
  const groups = screen.getAllByRole('group', { name: 'Queued message' });
  const list = groups[0].parentElement!;
  const bounds = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON() {} });
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(bounds(0, 100));
  groups.forEach((group, index) => vi.spyOn(group, 'getBoundingClientRect').mockReturnValue(bounds(index * 40, index * 40 + 40)));
  const handle = within(groups[1]).getByRole('button', { name: 'Reorder queued message' });
  Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
  const pointer = (type: string, y: number) => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: 20, clientY: y });
    fireEvent(handle, event);
  };
  pointer('pointerdown', 60); pointer('pointermove', 20);
  view.rerender(wrap(<Panel snapshot={{ ...initial, revision: 2, rows: [{ ...initial.rows[0], input: { text: 'Edited elsewhere' } }, initial.rows[1]] }} />));
  pointer('pointerup', 20);
  expect(rpc.reorderQueued).not.toHaveBeenCalled();
  pointer('pointerdown', 60); pointer('pointermove', 20); pointer('pointerup', 20);
  await waitFor(() => expect(rpc.reorderQueued).toHaveBeenCalledWith({ chatId: 'chat', epoch: 'epoch', revision: 2, ids: ['second', 'row'] }));
});

it('shows partial native coverage and disables edit/reorder while retaining exact-ID remove and steer', async () => {
  const snapshot: Snapshot = { ...queued(), partial: true, nativeCount: 3, rows: [...queued().rows, { id: 'second', input: { text: 'Second' }, status: 'queued', nativeSignalId: 'native-second' }] };
  render(wrap(<Panel snapshot={snapshot} />));
  expect(screen.getByText('Only part of the queue is shown. Reordering is unavailable.')).toBeInTheDocument();
  for (const group of screen.getAllByRole('group', { name: 'Queued message' })) {
    expect(within(group).getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(within(group).getByRole('button', { name: 'Reorder queued message' })).toBeDisabled();
    expect(within(group).getByRole('button', { name: 'Remove' })).toBeEnabled();
    expect(within(group).getByRole('button', { name: 'Steer' })).toBeEnabled();
  }
});

it('shows unknown native queue coverage even when no tracked rows can be displayed', () => {
  render(wrap(<Panel snapshot={{ ...queued(), rows: [], nativeCount: 2, partial: true }} />));
  expect(screen.getByText('Only part of the queue is shown. Reordering is unavailable.')).toBeInTheDocument();
});
