import { MantineProvider } from '@mantine/core';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeAutomationRuns } from './NativeAutomationRuns';
import { mastraClient, type ChatClient } from './client';
import { listAutomationRuns } from '../api/client';
import type { NativeAutomationRun } from './nativeAutomationTypes';

vi.mock('./client', () => ({ mastraClient: { watchAutomationRuns: vi.fn() } }));
vi.mock('../api/client', async actual => ({ ...await actual<typeof import('../api/client')>(), listAutomationRuns: vi.fn() }));
type Snapshot = Awaited<ReturnType<ChatClient['watchAutomationRuns']>> extends AsyncIterable<infer T> ? T : never;
function stream() {
  let receive: ((value: IteratorResult<Snapshot>) => void) | null = null;
  return { publish(value: Snapshot) { if (!receive) throw new Error('Missing consumer'); const next = receive; receive = null; next({ value, done: false }); },
    iterable: (async function* () {
      while (true) {
        const next = await new Promise<IteratorResult<Snapshot>>(resolve => { receive = resolve; });
        if (next.done) return;
        yield next.value;
      }
    })() };
}
const run: NativeAutomationRun = { id: 'trigger', scheduleId: 'automation', runId: 'native-run', actualFireAt: 1000, scheduledFireAt: 1000, outcome: 'failed', error: 'Native delivery error' };
afterEach(() => vi.resetAllMocks());

it('projects native outcomes from canonical watches and refreshes without legacy reads or resending', async () => {
  const first = stream(), refreshed = stream();
  vi.mocked(mastraClient.watchAutomationRuns).mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(refreshed.iterable);
  render(<MantineProvider env="test"><NativeAutomationRuns automationId="automation" /></MantineProvider>);
  expect(screen.getByText('Loading runs…')).toBeInTheDocument();
  await waitFor(() => expect(mastraClient.watchAutomationRuns).toHaveBeenCalledOnce());
  await act(async () => first.publish({ epoch: '00000000-0000-0000-0000-000000000001', revision: 1, rows: [run] }));
  expect(screen.getByText('Failed', { exact: true })).toBeInTheDocument();
  expect(screen.getByText(run.error!)).toBeInTheDocument();
  expect(screen.getByText(/independently of model completion/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Refresh runs' }));
  await waitFor(() => expect(mastraClient.watchAutomationRuns).toHaveBeenCalledTimes(2));
  expect(vi.mocked(mastraClient.watchAutomationRuns).mock.calls[0][1]?.signal?.aborted).toBe(true);
  await act(async () => refreshed.publish({ epoch: '00000000-0000-0000-0000-000000000002', revision: 1, rows: [{ ...run, outcome: 'delivered', error: undefined }] }));
  expect(screen.getByText('Delivered', { exact: true })).toBeInTheDocument();
  expect(screen.queryByText('Native delivery error')).not.toBeInTheDocument();
  expect(listAutomationRuns).not.toHaveBeenCalled();
});

it('clears prior-scope history and ignores late replies after changing the selected automation', async () => {
  const first = stream(), second = stream();
  vi.mocked(mastraClient.watchAutomationRuns).mockResolvedValueOnce(first.iterable).mockResolvedValueOnce(second.iterable);
  const view = render(<MantineProvider env="test"><NativeAutomationRuns automationId="automation" /></MantineProvider>);
  await waitFor(() => expect(mastraClient.watchAutomationRuns).toHaveBeenCalledOnce());
  await act(async () => first.publish({ epoch: '00000000-0000-0000-0000-000000000001', revision: 1, rows: [run] }));
  view.rerender(<MantineProvider env="test"><NativeAutomationRuns automationId="other" /></MantineProvider>);
  expect(screen.queryByText('Failed', { exact: true })).not.toBeInTheDocument();
  await waitFor(() => expect(mastraClient.watchAutomationRuns).toHaveBeenCalledTimes(2));
  await act(async () => first.publish({ epoch: '00000000-0000-0000-0000-000000000001', revision: 2, rows: [run] }));
  expect(screen.queryByText('Failed', { exact: true })).not.toBeInTheDocument();
  await act(async () => second.publish({ epoch: '00000000-0000-0000-0000-000000000003', revision: 1, rows: [] }));
  expect(screen.getByText('No runs recorded.')).toBeInTheDocument();
  expect(listAutomationRuns).not.toHaveBeenCalled();
});

it('shows native workflow delivery state beside published triggers without treating acceptance as a completed model answer', async () => {
  const source = stream();
  vi.mocked(mastraClient.watchAutomationRuns).mockResolvedValueOnce(source.iterable);
  render(<MantineProvider env="test"><NativeAutomationRuns automationId="automation" /></MantineProvider>);
  await waitFor(() => expect(mastraClient.watchAutomationRuns).toHaveBeenCalledOnce());
  const failed = { ...run, outcome: 'published' as const, deliveryStatus: 'failed' as const, error: 'Native workflow input was rejected' };
  await act(async () => source.publish({ epoch: '00000000-0000-0000-0000-000000000001', revision: 1, rows: [failed] }));
  expect(screen.getByText('Published')).toBeInTheDocument();
  expect(screen.getByText('Delivery: failed')).toBeInTheDocument();
  expect(screen.getByText(failed.error)).toBeInTheDocument();
  const accepted = { ...failed, deliveryStatus: 'success' as const, error: undefined };
  await act(async () => source.publish({ epoch: '00000000-0000-0000-0000-000000000001', revision: 2, rows: [accepted] }));
  expect(screen.getByText('Input accepted')).toBeInTheDocument();
  expect(screen.queryByText(failed.error)).not.toBeInTheDocument();
  expect(screen.getByText(/independently of model completion/)).toBeInTheDocument();
  expect(listAutomationRuns).not.toHaveBeenCalled();
});
