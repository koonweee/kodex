import { MantineProvider } from '@mantine/core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatClient } from './client';
import { NativeSubagentViewer } from './NativeSubagentViewer';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';

const rpc = vi.hoisted(() => ({ watchSubagent: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: rpc }));
const invocation = { id: 'call', agentType: 'explore', task: 'Inspect files', modelId: null, forked: false, status: 'running' as const, result: null,
  activity: { agentType: 'explore', task: 'Inspect files', status: 'running' as const, toolCalls: [{ name: 'view', isError: false }], textDelta: 'Looking at the files' } };
const inventory: Awaited<ReturnType<ChatClient['listSubagents']>> = { epoch: 'epoch', revision: 1, chatId: 'parent', invocations: [invocation], forks: [], children: [], history: { earliest: null, hasOlder: false } };
const props = { chatId: 'parent', inventory, selectedId: 'invocation:call', onSelect: vi.fn(), error: null, onReload: vi.fn(), loadingMore: false, onLoadMore: vi.fn(), onImageOpen: vi.fn(), showDebug: false };
afterEach(() => { cleanup(); rpc.watchSubagent.mockReset(); });
it('uses the shared read-only viewer for live activity and saved results without activating an ordinary child', async () => {
  const view = render(<MantineProvider><NativeSubagentViewer {...props} /></MantineProvider>);
  expect(screen.getByRole('complementary', { name: 'Subagent thread viewer' })).toBeVisible();
  expect(screen.getByText('Read-only')).toBeVisible();
  expect(await screen.findByText('Looking at the files')).toBeVisible();
  expect(screen.getByText('view')).toBeVisible();
  expect(rpc.watchSubagent).not.toHaveBeenCalled();
  view.rerender(<MantineProvider><NativeSubagentViewer {...props} inventory={{ ...inventory, revision: 2, invocations: [{ ...invocation, status: 'completed', result: 'Saved child findings', activity: null }] }} /></MantineProvider>);
  expect(await screen.findByText('Saved child findings')).toBeVisible();
  expect(screen.queryByText('Looking at the files')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: /message/i })).not.toBeInTheDocument();
  expect(rpc.watchSubagent).not.toHaveBeenCalled();
});
it('reads selected native fork history and fences replies after switching back to an ordinary invocation', async () => {
  let publish!: (value: IteratorResult<Awaited<ReturnType<ChatClient['openSubagent']>>>) => void;
  rpc.watchSubagent.mockResolvedValue({ [Symbol.asyncIterator]() { return { next: () => new Promise(resolve => { publish = resolve; }) }; } });
  const withFork = { ...inventory, forks: [{ id: 'fork', title: 'Fork history' }] };
  const view = render(<MantineProvider><NativeSubagentViewer {...props} inventory={withFork} selectedId="fork:fork" /></MantineProvider>);
  await waitFor(() => expect(rpc.watchSubagent).toHaveBeenCalledTimes(1));
  expect(rpc.watchSubagent.mock.calls[0][0]).toEqual({ chatId: 'parent', kind: 'fork', id: 'fork' });
  const saved = { epoch: 'epoch', revision: 1, chatId: 'parent', kind: 'fork' as const, id: 'fork', invocation: null, messages: [{ id: 'answer', role: 'assistant' as const, createdAt: new Date(0), content: { format: 2 as const, parts: [{ type: 'text' as const, text: 'Saved fork answer' }] } }], history: { earliest: null, hasOlder: false } };
  await act(async () => publish({ value: saved, done: false }));
  expect(await screen.findByText('Saved fork answer')).toBeVisible();
  view.rerender(<MantineProvider><NativeSubagentViewer {...props} inventory={withFork} /></MantineProvider>);
  expect(rpc.watchSubagent.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => publish({ value: { ...saved, revision: 2 }, done: false }));
  expect(screen.queryByText('Saved fork answer')).not.toBeInTheDocument();
  expect(await screen.findByText('Looking at the files')).toBeVisible();
});

it('shows an initial fork failure without a permanent loading indicator and recovers on reload', async () => {
  const snapshot = { epoch: 'epoch', revision: 1, chatId: 'parent', kind: 'fork' as const, id: 'fork', invocation: null, messages: [], history: { earliest: null, hasOlder: false } };
  rpc.watchSubagent.mockRejectedValueOnce(new Error('Fork read unavailable')).mockResolvedValueOnce({
    async *[Symbol.asyncIterator]() { yield snapshot; await new Promise(() => {}); },
  });
  render(<MantineProvider><NativeSubagentViewer {...props} inventory={{ ...inventory, forks: [{ id: 'fork', title: 'Fork history' }] }} selectedId="fork:fork" /></MantineProvider>);
  expect(await screen.findByText('Fork read unavailable')).toBeVisible();
  expect(screen.queryByText('Loading subagent')).not.toBeInTheDocument();
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.click(screen.getByRole('button', { name: 'Reload subagents' }));
  await waitFor(() => expect(rpc.watchSubagent).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText('Fork read unavailable')).not.toBeInTheDocument());
});


it('observes delegated child live display and saved history read-only, keeping fork and child identities separate', async () => {
  const pending: Array<(value: IteratorResult<Awaited<ReturnType<ChatClient['openSubagent']>>>) => void> = [];
  rpc.watchSubagent.mockImplementation(async () => ({ [Symbol.asyncIterator]() {
    return { next: () => new Promise(resolve => { pending.push(resolve); }) };
  } }));
  const withChild = { ...inventory, children: [{ id: 'same', title: 'Inspect workspace', active: true }], forks: [{ id: 'same', title: 'Older fork' }] };
  const view = render(<MantineProvider><NativeSubagentViewer {...props} inventory={withChild} selectedId="child:same" /></MantineProvider>);
  await waitFor(() => expect(rpc.watchSubagent).toHaveBeenCalledTimes(1));
  expect(rpc.watchSubagent.mock.calls[0][0]).toEqual({ chatId: 'parent', kind: 'child', id: 'same' });
  expect(screen.getByText('Read-only')).toBeVisible();
  expect(screen.getByText('Active')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Subagent' })).toHaveValue('Inspect workspace [Delegated child]');
  const saved = { epoch: 'epoch', revision: 1, chatId: 'parent', kind: 'child' as const, id: 'same', invocation: null,
    messages: [{ id: 'saved', role: 'assistant' as const, createdAt: new Date(0), content: { format: 2 as const, parts: [{ type: 'text' as const, text: 'Saved delegated findings' }] } }],
    display: { ...defaultDisplayState(), isRunning: true, currentMessage: { id: 'live', role: 'assistant' as const, createdAt: new Date(1), content: { format: 2 as const, parts: [{ type: 'text' as const, text: 'Inspecting workspace now' }] } } },
    history: { earliest: null, hasOlder: false } };
  await act(async () => pending.shift()!({ value: saved, done: false }));
  expect(await screen.findByText('Saved delegated findings')).toBeVisible();
  expect(await screen.findByText('Inspecting workspace now')).toBeVisible();
  expect(screen.queryByRole('textbox', { name: /message/i })).not.toBeInTheDocument();
  view.rerender(<MantineProvider><NativeSubagentViewer {...props} inventory={{ ...withChild, children: [{ ...withChild.children[0], active: false }] }} selectedId="child:same" /></MantineProvider>);
  expect(screen.getByText('Not loaded')).toBeVisible();
  view.rerender(<MantineProvider><NativeSubagentViewer {...props} inventory={withChild} selectedId="fork:same" /></MantineProvider>);
  await waitFor(() => expect(rpc.watchSubagent).toHaveBeenCalledTimes(2));
  expect(rpc.watchSubagent.mock.calls[0][1].signal.aborted).toBe(true);
  expect(rpc.watchSubagent.mock.calls[1][0]).toEqual({ chatId: 'parent', kind: 'fork', id: 'same' });
  await act(async () => pending.shift()!({ value: { ...saved, revision: 2 }, done: false }));
  expect(screen.queryByText('Saved delegated findings')).not.toBeInTheDocument();
  expect(screen.queryByText('Inspecting workspace now')).not.toBeInTheDocument();
});
