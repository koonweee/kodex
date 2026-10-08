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
const rpc = vi.hoisted(() => ({ nativeMcpWatch: vi.fn(), nativeMcpReload: vi.fn(), nativeMcpSetServerEnabled: vi.fn(), nativeMcpInheritServer: vi.fn() }));
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
  expect(screen.queryByRole('button', { name: /Add server|Edit|Log in|Remove/ })).not.toBeInTheDocument();
  expect(screen.getByText(/Edit server definitions in these files/)).toBeInTheDocument();
  expect(screen.getByText(/Resource browsing is not available/)).toBeInTheDocument();
});


it('captures the selected binding for disable and converges both clients only through native inventory', async () => {
  const one = stream(), two = stream(), refill = stream();
  rpc.nativeMcpWatch.mockResolvedValueOnce(one.iterable).mockResolvedValueOnce(two.iterable).mockResolvedValueOnce(refill.iterable);
  let acknowledge!: () => void;
  rpc.nativeMcpSetServerEnabled.mockImplementation(() => new Promise(resolve => { acknowledge = () => resolve([{ bindingId: 'a', error: null }]); }));
  render(<><section aria-label="Client one">{panel()}</section><section aria-label="Client two">{panel()}</section></>);
  await waitFor(() => expect(rpc.nativeMcpWatch).toHaveBeenCalledTimes(2));
  await act(async () => { one.publish(inventory([runtime('a'), runtime('b')])); two.publish(inventory([runtime('a'), runtime('b')])); });
  const first = within(screen.getByRole('region', { name: 'Client one' }));
  const second = within(screen.getByRole('region', { name: 'Client two' }));
  await userEvent.click(first.getByRole('button', { name: 'Disable' }));
  expect(rpc.nativeMcpSetServerEnabled).toHaveBeenCalledWith({ bindingId: 'a', server: 'docs', enabled: false });
  expect(first.getByRole('button', { name: 'Disable' })).toBeDisabled();
  expect(second.getByRole('button', { name: 'Disable' })).toBeEnabled();
  await userEvent.click(first.getByRole('textbox', { name: 'Runtime' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Standalone · /b' }));
  expect(first.getByRole('button', { name: 'Disable' })).toBeEnabled();
  await act(async () => acknowledge());
  await waitFor(() => expect(rpc.nativeMcpWatch).toHaveBeenCalledTimes(3));
  expect(second.getByRole('button', { name: 'Disable' })).toBeEnabled();
  const changed = [runtime('a', { servers: [{ name: 'docs', connected: false, disabled: true, disabledScope: 'project', projectOverride: 'disabled', globalDefault: 'enabled', toolCount: 0, toolNames: [], transport: 'stdio' }] }), runtime('b')];
  await act(async () => { refill.publish(inventory(changed, 2)); two.publish(inventory(changed, 2)); });
  expect(second.getByRole('button', { name: 'Enable' })).toBeEnabled();
  expect(second.getByRole('button', { name: 'Use global default' })).toBeEnabled();
  expect(first.getByRole('button', { name: 'Disable' })).toBeEnabled();
  await userEvent.click(first.getByRole('textbox', { name: 'Runtime' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Project · /a' }));
  expect(first.getByRole('button', { name: 'Enable' })).toBeEnabled();
  expect(first.getByText('Disabled for this project')).toBeInTheDocument();
  await userEvent.click(first.getByRole('button', { name: 'Enable' }));
  expect(rpc.nativeMcpSetServerEnabled).toHaveBeenLastCalledWith({ bindingId: 'a', server: 'docs', enabled: true });
});

it('clears a native project override without claiming that the global kill switch can be overridden', async () => {
  const source = stream(), refill = stream();
  rpc.nativeMcpWatch.mockResolvedValueOnce(source.iterable).mockResolvedValueOnce(refill.iterable);
  rpc.nativeMcpInheritServer.mockResolvedValue([{ bindingId: 'a', error: null }]);
  render(panel()); await waitFor(() => expect(rpc.nativeMcpWatch).toHaveBeenCalledOnce());
  await act(async () => source.publish(inventory([runtime('a', { servers: [{ name: 'docs', connected: false, disabled: true, disabledScope: 'global', globalKillSwitch: true, projectOverride: 'enabled', globalDefault: 'enabled', toolCount: 0, toolNames: [], transport: 'stdio' }] })])));
  expect(screen.getByRole('button', { name: 'Enable' })).toBeDisabled();
  expect(screen.getByText('MCP is disabled globally; project settings cannot enable it.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Use global default' }));
  expect(rpc.nativeMcpInheritServer).toHaveBeenCalledWith({ bindingId: 'a', server: 'docs' });
  await waitFor(() => expect(rpc.nativeMcpWatch).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', { name: 'Enable' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Use global default' })).toBeInTheDocument();
  await act(async () => refill.publish(inventory([runtime('a')], 2)));
  expect(screen.getByRole('button', { name: 'Disable' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Use global default' })).not.toBeInTheDocument();
  expect(screen.queryByText('MCP is disabled globally; project settings cannot enable it.')).not.toBeInTheDocument();
});

it.each(['rejected', 'partial'] as const)('keeps %s update errors attached to the captured runtime and server', async outcome => {
  const source = stream(), refill = stream();
  rpc.nativeMcpWatch.mockResolvedValueOnce(source.iterable).mockResolvedValueOnce(refill.iterable);
  let finish!: () => void;
  rpc.nativeMcpSetServerEnabled.mockImplementation(() => new Promise((resolve, reject) => {
    finish = () => outcome === 'rejected' ? reject(new Error('Update unavailable')) : resolve([{ bindingId: 'a', error: 'Update unavailable' }]);
  }));
  render(panel()); await waitFor(() => expect(rpc.nativeMcpWatch).toHaveBeenCalledOnce());
  const a = runtime('a'); a.servers.push({ ...a.servers[0], name: 'other', toolNames: ['other_lookup'] });
  await act(async () => source.publish(inventory([a, runtime('b')])));
  await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
  await userEvent.click(screen.getByRole('button', { name: /^other / }));
  expect(screen.getByRole('button', { name: 'Disable' })).toBeEnabled();
  await act(async () => finish());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('textbox', { name: 'Runtime' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Standalone · /b' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('textbox', { name: 'Runtime' }));
  await userEvent.click(await screen.findByRole('option', { name: 'Project · /a' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Update unavailable');
  expect(screen.getByRole('button', { name: 'Disable' })).toBeEnabled();
});
