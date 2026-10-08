import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import type { ComposerDraftStore } from '../composer/useComposerDraftState';
import type { WorkspacePane } from '../workspace/paneTypes';
import type { ChatSnapshot } from './client';
import { NativeThreadPane } from './NativeThreadPane';
import { nativeQueueFixture, nativeSettingsFixture } from './testBuilders';
const native = vi.hoisted(() => ({ snapshot: null as ChatSnapshot | null, error: null as string | null, adornment: vi.fn(), actions: vi.fn(), seen: vi.fn(), context: vi.fn(), visiblePaneIds: [] as string[], noop: vi.fn() }));
vi.mock('./client', () => ({ mastraClient: { markChatSeen: native.seen } }));
vi.mock('./useNativeSnapshots', () => ({ useNativeChat: () => ({ snapshot: native.snapshot, error: native.error, retry: native.noop, loadOlderHistory: native.noop, isLoadingOlderHistory: false }) }));
vi.mock('./useNativeSubagents', () => ({ useNativeSubagents: () => ({ snapshot: null, error: null, open: false, toggle: native.noop, retry: native.noop }) }));
vi.mock('./NativeComposer', () => ({ NativeComposer: ({ ready }: { ready: boolean }) => <button disabled={!ready}>Send draft</button> }));
vi.mock('../workspace/WorkspaceProvider', () => ({ useWorkspace: () => ({
  workspace: { activePaneId: 'one' }, visiblePaneIds: native.visiblePaneIds, errorMessage: null, setPaneThreadContext: native.context,
  setPaneHeaderActions: native.actions, setPaneHeaderAdornment: native.adornment,
  updatePane: native.noop, duplicatePane: native.noop, onImageOpen: native.noop, onMarkdownOpen: native.noop,
  onShowMobileSidebar: native.noop, threadActions: {}, showDebugEvents: false,
}) }));
const pane: WorkspacePane = { id: 'one', kind: 'thread', title: 'Chat', target: { mode: 'existing', threadId: 'chat' } };
function snapshot(): ChatSnapshot {
  return { epoch: 'epoch', revision: 1, readState: { epoch: 'native', revision: 0, head: null, seen: null }, chat: { bindingId: 'binding', id: 'chat', projectId: null, cwd: '/project', title: 'Chat', name: null, pinned: false, notificationsEnabled: true }, display: defaultDisplayState(), messages: [
    { id: 'answer', role: 'assistant', createdAt: new Date(0), content: { format: 2, parts: [{ type: 'text', text: 'Retained native answer' }] } },
  ], error: null, prompts: [], goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(), history: { earliest: null, hasOlder: false } };
}
const draftStore = {} as ComposerDraftStore;
function panes(two = false, first = pane) {
  return <MantineProvider env="test"><NativeThreadPane pane={first} draftStore={draftStore} onError={native.noop} />{two && <NativeThreadPane pane={{ ...pane, id: 'two' }} draftStore={draftStore} onError={native.noop} />}</MantineProvider>;
}
afterEach(() => { cleanup(); vi.clearAllMocks(); native.snapshot = null; native.error = null; native.visiblePaneIds = []; });
it('shows the shared initial skeleton and header progress until snapshot readiness, preserving a retained timeline on failure', async () => {
  const view = render(panes());
  expect(screen.getByRole('status', { name: 'Loading thread timeline' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: 'Send draft' })).toBeDisabled();
  expect(native.adornment).toHaveBeenLastCalledWith('one', expect.anything());
  native.snapshot = snapshot(); await act(async () => view.rerender(panes()));
  expect(screen.queryByRole('status', { name: 'Loading thread timeline' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send draft' })).toBeEnabled();
  expect(native.adornment).toHaveBeenLastCalledWith('one', null);
  expect(screen.getByText('Retained native answer')).toBeInTheDocument();
  native.error = 'Connection interrupted'; await act(async () => view.rerender(panes()));
  expect(screen.getByRole('alert')).toHaveTextContent('Connection interrupted');
  expect(screen.getByText('Retained native answer')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send draft' })).toBeEnabled();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  view.unmount(); expect(native.adornment).toHaveBeenLastCalledWith('one', null);
});
it('does not show initial progress or disable input for a draft pane', () => {
  render(panes(false, { ...pane, target: { mode: 'draft', projectId: null } }));
  expect(screen.queryByRole('status')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Send draft' })).toBeEnabled();
  expect(native.adornment).toHaveBeenLastCalledWith('one', null);
});
it('uses shared scroll measurements for pane-local fades and clears them when the target changes', async () => {
  native.snapshot = snapshot(); const view = render(panes(true));
  const scrollers = [...view.container.querySelectorAll<HTMLDivElement>('.kodex-thread-pane-scroll')];
  for (const scroller of scrollers) Object.defineProperties(scroller, { clientHeight: { configurable: true, value: 100 }, scrollHeight: { configurable: true, value: 1000 } });
  const frames = [...view.container.querySelectorAll('.kodex-thread-scroll-frame')];
  await act(async () => { scrollers[0].scrollTop = 400; fireEvent.wheel(scrollers[0]); fireEvent.scroll(scrollers[0]); });
  await waitFor(() => expect(frames[0]).toHaveAttribute('data-overflow-above', 'true'));
  expect(frames[0]).toHaveAttribute('data-overflow-below', 'true');
  expect(frames[1]).not.toHaveAttribute('data-overflow-above'); expect(frames[1]).not.toHaveAttribute('data-overflow-below');
  await act(async () => { scrollers[0].scrollTop = 900; fireEvent.scroll(scrollers[0]); });
  expect(frames[0]).toHaveAttribute('data-overflow-above', 'true'); expect(frames[0]).not.toHaveAttribute('data-overflow-below');
  native.snapshot = null; await act(async () => view.rerender(panes(false, { ...pane, target: { mode: 'existing', threadId: 'other' } })));
  const frame = view.container.querySelector('.kodex-thread-scroll-frame');
  expect(frame).not.toHaveAttribute('data-overflow-above'); expect(frame).not.toHaveAttribute('data-overflow-below');
});

it('marks every actually visible pane, even when inactive, and derives pane title unread state from native heads', async () => {
  native.snapshot = { ...snapshot(), readState: { epoch: 'native', revision: 1, head: { runId: 'run', messageId: 'answer', reason: 'complete' }, seen: false } };
  native.seen.mockResolvedValue({ outcome: 'accepted', state: { ...native.snapshot.readState, seen: true } });
  const view = render(panes(true));
  expect(native.seen).not.toHaveBeenCalled();
  expect(native.context).toHaveBeenCalledWith('one', expect.objectContaining({ indicatorState: 'unread' }));
  expect(native.context).toHaveBeenCalledWith('two', expect.objectContaining({ indicatorState: 'unread' }));
  native.visiblePaneIds = ['two'];
  await act(async () => view.rerender(panes(true)));
  await waitFor(() => expect(native.seen).toHaveBeenCalledOnce());
  expect(native.seen).toHaveBeenCalledWith({ chatId: 'chat', epoch: 'native', revision: 1, runId: 'run' });
  expect(native.context).not.toHaveBeenCalledWith('two', expect.objectContaining({ indicatorState: null }));
  native.snapshot = { ...native.snapshot, readState: { ...native.snapshot.readState, revision: 2, seen: true } };
  await act(async () => view.rerender(panes(true)));
  expect(native.context).toHaveBeenCalledWith('two', expect.objectContaining({ indicatorState: null }));
});

it.each([
  ['complete', 'Run completed.', 'missing-answer'],
  ['aborted', 'Run stopped.', 'answer'],
  ['error', 'The model run failed. Please try again.', null],
] as const)('renders a native %s notice as the exact read witness when no assistant answer is available', async (reason, text, messageId) => {
  native.snapshot = { ...snapshot(), readState: { epoch: 'native', revision: 1, head: { runId: 'run', messageId, reason }, seen: false },
    messages: [{ ...snapshot().messages[0], role: 'user' }], error: reason === 'error' ? text : null };
  native.visiblePaneIds = ['one'];
  native.seen.mockResolvedValue({ outcome: 'accepted', state: { ...native.snapshot.readState, seen: true } });
  const view = render(panes());
  expect(screen.getByRole('alert')).toHaveTextContent(text);
  expect(screen.getAllByText(text)).toHaveLength(1);
  await waitFor(() => expect(native.seen).toHaveBeenCalledWith({ chatId: 'chat', epoch: 'native', revision: 1, runId: 'run' }));
  native.snapshot = { ...native.snapshot, readState: { ...native.snapshot.readState, revision: 2, seen: true } };
  await act(async () => view.rerender(panes()));
  expect(screen.getByRole('alert')).toHaveTextContent(text);
  expect(native.seen).toHaveBeenCalledOnce();
});

it('hides an old native terminal notice during a new run and never consumes a matching user row as an assistant witness', async () => {
  const base = snapshot();
  native.snapshot = { ...base, display: { ...base.display, isRunning: true, currentMessage: { ...base.messages[0], role: 'user' } },
    messages: [{ ...base.messages[0], role: 'user' }], readState: { epoch: 'native', revision: 1, head: { runId: 'old-run', messageId: 'answer', reason: 'aborted' }, seen: false } };
  native.visiblePaneIds = ['one'];
  native.seen.mockResolvedValue({ outcome: 'accepted', state: { ...native.snapshot.readState, seen: true } });
  const view = render(panes());
  expect(screen.queryByText('Run stopped.')).not.toBeInTheDocument();
  expect(native.seen).not.toHaveBeenCalled();
  native.snapshot = { ...native.snapshot, display: { ...native.snapshot.display, isRunning: false } };
  await act(async () => view.rerender(panes()));
  expect(screen.getByRole('alert')).toHaveTextContent('Run stopped.');
  await waitFor(() => expect(native.seen).toHaveBeenCalledWith({ chatId: 'chat', epoch: 'native', revision: 1, runId: 'old-run' }));
});

it('preserves independent connection errors alongside the native error notice and shows no notice for an unknown head', async () => {
  native.snapshot = { ...snapshot(), messages: [], error: 'The model run failed. Please try again.', readState: { epoch: 'native', revision: 1, head: { runId: 'run', messageId: null, reason: 'error' }, seen: true } };
  native.error = 'Connection interrupted';
  const view = render(panes());
  expect(screen.getAllByRole('alert')).toHaveLength(2);
  expect(screen.getByText('Connection interrupted')).toBeInTheDocument();
  expect(screen.getAllByText('The model run failed. Please try again.')).toHaveLength(1);
  native.error = null;
  native.snapshot = { ...snapshot(), messages: [] };
  await act(async () => view.rerender(panes()));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(native.seen).not.toHaveBeenCalled();
});
