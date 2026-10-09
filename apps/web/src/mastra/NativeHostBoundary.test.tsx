import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeHostBoundary } from './NativeHostBoundary';

const rpc = vi.hoisted(() => ({ info: vi.fn(), observeUpdates: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: rpc }));
vi.mock('./useNativeFrontendUpdates', () => ({ useNativeFrontendUpdates: rpc.observeUpdates }));
vi.mock('../pwa/PwaLifecycle', () => ({ PwaLifecycle: () => <button>Update available</button> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('keeps shared PWA update controls available while native bootstrap fails and observes the connected host after retry', async () => {
  rpc.info.mockRejectedValueOnce(new Error('Native host unavailable')).mockResolvedValueOnce({ instanceId: 'native-host' });
  render(<NativeHostBoundary queryClient={new QueryClient()}><div>Workspace ready</div></NativeHostBoundary>);
  expect(screen.getByRole('button', { name: 'Update available' })).toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('Native host unavailable');
  expect(screen.getByRole('button', { name: 'Update available' })).toBeInTheDocument();
  expect(rpc.observeUpdates).toHaveBeenLastCalledWith(null);
  fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
  await screen.findByText('Workspace ready');
  await waitFor(() => expect(rpc.observeUpdates).toHaveBeenLastCalledWith('native-host'));
  expect(screen.queryByRole('button', { name: 'Update available' })).not.toBeInTheDocument();
});
