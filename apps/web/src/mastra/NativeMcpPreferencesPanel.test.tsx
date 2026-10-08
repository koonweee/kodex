import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { ChatClient } from './client';
import { NativeMcpPreferencesPanel } from './NativeMcpPreferencesPanel';

type Inventory = Awaited<ReturnType<ChatClient['nativeMcpWatch']>> extends AsyncIterable<infer T> ? T : never;
type Runtime = Inventory['rows'][number];
type ActiveRuntime = Exclude<Runtime, { phase: 'disabled' }>;
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeAll(() => Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }));
afterAll(() => { if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); });
const rpc = vi.hoisted(() => ({ nativeMcpWatch: vi.fn(), nativeMcpReload: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: rpc }));
function stream() {
  let consume: ((value: IteratorResult<Inventory>) => void) | undefined;
  return { publish(value: Inventory) {
    if (!consume) throw new Error('No MCP inventory consumer');
    const next = consume; consume = undefined; next({ value, done: false });
  }, iterable: { [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<Inventory>>(resolve => { consume = resolve; }) }; } } };
}
function runtime(bindingId: string, override: Partial<ActiveRuntime> = {}): ActiveRuntime {
  return { bindingId, projectId: bindingId === 'a' ? 'project' : null, projectName: bindingId === 'a' ? 'Project' : null,
    cwd: `/${bindingId}`, phase: 'ready', paths: { project: `/${bindingId}/.kodex-mastra-spike/mcp.json`, global: '/home/.kodex-mastra-spike/mcp.json', claude: `/${bindingId}/.claude/settings.local.json` },
    servers: [{ name: 'docs', connected: true, toolCount: 1, toolNames: [`docs_lookup_${bindingId}`], transport: 'stdio' }], skipped: [], ...override };
}
function inventory(rows: Runtime[], revision = 1): Inventory { return { epoch: '00000000-0000-4000-8000-000000000000', revision, rows }; }
function panel() {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MantineProvider env="test"><NativeMcpPreferencesPanel /></MantineProvider>
  </QueryClientProvider>;
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('keeps inventory authoritative across clients, selects immutable bindings and reloads all runtimes', async () => {
  const one = stream(), two = stream(), refill = stream();
  rpc.nativeMcpWatch.mockResolvedValueOnce(one.iterable).mockResolvedValueOnce(two.iterable).mockResolvedValueOnce(refill.iterable);
  let acknowledge!: () => void;
  rpc.nativeMcpReload.mockImplementation(() => new Promise(resolve => { acknowledge = () => resolve([{ bindingId: 'a', error: null }, { bindingId: 'b', error: null }]); }));
  render(<><section aria-label="Client one">{panel()}</section><section aria-label="Client two">{panel()}</section></>);
  await waitFor(() => expect(rpc.nativeMcpWatch).toHaveBeenCalledTimes(2));
  expect(screen.getAllByText('Loading MCP servers')).toHaveLength(2);
  const first = within(screen.getByRole('region', { name: 'Client one' }));
  const second = within(screen.getByRole('region', { name: 'Client two' }));
  await act(async () => { one.publish(inventory([runtime('a'), runtime('b')])); two.publish(inventory([runtime('a'), runtime('b')])); });
  expect(first.getByText('docs_lookup_a')).toBeInTheDocument();
  expect(first.getByText('/a/.kodex-mastra-spike/mcp.json')).toBeInTheDocument();
  await userEvent.click(first.getByRole('textbox', { name: 'Runtime' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Standalone · /b' }));
  expect(first.getByText('docs_lookup_b')).toBeInTheDocument();
  expect(first.queryByText('docs_lookup_a')).not.toBeInTheDocument();
  expect(second.getByText('docs_lookup_a')).toBeInTheDocument();
  await userEvent.click(first.getByRole('button', { name: 'Reload MCP servers' }));
  expect(rpc.nativeMcpReload).toHaveBeenCalledWith({});
  expect(first.getByRole('button', { name: 'Reload MCP servers' })).toBeDisabled();
  expect(second.getByText('docs_lookup_a')).toBeInTheDocument();
  await act(async () => acknowledge());
  await waitFor(() => expect(rpc.nativeMcpWatch).toHaveBeenCalledTimes(3));
  expect(first.getByText('docs_lookup_b')).toBeInTheDocument();
  const changed = [runtime('a', { servers: [{ name: 'docs', connected: false, toolCount: 0, toolNames: [], transport: 'http', needsAuth: true, error: 'Authentication required' }] }), runtime('b', { servers: [] })];
  await act(async () => { refill.publish(inventory(changed, 2)); two.publish(inventory(changed, 2)); });
  expect(first.getByText('No MCP servers configured')).toBeInTheDocument();
  expect(first.queryByText('docs_lookup_b')).not.toBeInTheDocument();
  expect(second.getAllByText('Authentication required').length).toBeGreaterThan(0);
  expect(second.queryByText('docs_lookup_a')).not.toBeInTheDocument();
  expect(second.queryByText('No tools reported')).not.toBeInTheDocument();
});

it('distinguishes native initialization, disabled integration, skipped definitions and discovery failure from empty inventory', async () => {
  const source = stream(); rpc.nativeMcpWatch.mockResolvedValue(source.iterable);
  render(panel()); await waitFor(() => expect(rpc.nativeMcpWatch).toHaveBeenCalledOnce());
  await act(async () => source.publish(inventory([runtime('a', { phase: 'initializing', servers: [] })])));
  expect(screen.getByText('Initializing')).toBeInTheDocument();
  expect(screen.queryByText('No MCP servers configured')).not.toBeInTheDocument();
  await act(async () => source.publish(inventory([{ ...runtime('a'), phase: 'disabled', paths: null, servers: [], skipped: [] }], 2)));
  expect(screen.getByText('MCP is disabled for this runtime.')).toBeInTheDocument();
  expect(screen.queryByText('No MCP servers configured')).not.toBeInTheDocument();
  await act(async () => source.publish(inventory([runtime('a', { phase: 'failed', servers: [], skipped: [{ name: 'broken', reason: 'Unsupported transport' }] })], 3)));
  expect(screen.getByText('Failed')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('broken: Unsupported transport');
  expect(screen.queryByText('No MCP servers configured')).not.toBeInTheDocument();
});

it.each(['rejected', 'partial'] as const)('preserves watched inventory on %s reload errors and exposes no unsupported definition or authentication actions', async outcome => {
  const source = stream(); rpc.nativeMcpWatch.mockResolvedValue(source.iterable);
  if (outcome === 'rejected') rpc.nativeMcpReload.mockRejectedValue(new Error('Reload unavailable'));
  else rpc.nativeMcpReload.mockResolvedValue([{ bindingId: 'a', error: 'Reload unavailable' }]);
  render(panel()); await waitFor(() => expect(rpc.nativeMcpWatch).toHaveBeenCalledOnce());
  await act(async () => source.publish(inventory([runtime('a')])));
  await userEvent.click(screen.getByRole('button', { name: 'Reload MCP servers' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Reload unavailable');
  expect(screen.getByText('docs_lookup_a')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Add server|Edit|Log in|Remove|Disable/ })).not.toBeInTheDocument();
  expect(screen.getByText(/Edit server definitions in these files/)).toBeInTheDocument();
  expect(screen.getByText(/Resource browsing is not available/)).toBeInTheDocument();
});
