import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultDisplayState } from '../../../../spikes/mastra-code-sdk/node_modules/@mastra/core/dist/agent-controller/index.js';
import type { ComposerDraftStore } from '../composer/useComposerDraftState';
import type { WorkspacePane } from '../workspace/paneTypes';
import type { ChatSnapshot } from './client';
import { NativeThreadPane } from './NativeThreadPane';
import { nativeQueueFixture, nativeSettingsFixture } from './testBuilders';
const native = vi.hoisted(() => ({ snapshot: null as ChatSnapshot | null, error: null as string | null, adornment: vi.fn(), actions: vi.fn(), noop: vi.fn() }));
vi.mock('./useNativeSnapshots', () => ({ useNativeChat: () => ({ snapshot: native.snapshot, error: native.error, retry: native.noop, loadOlderHistory: native.noop, isLoadingOlderHistory: false }) }));
vi.mock('./useNativeSubagents', () => ({ useNativeSubagents: () => ({ snapshot: null, error: null, open: false, toggle: native.noop, retry: native.noop }) }));
vi.mock('./NativeComposer', () => ({ NativeComposer: ({ ready }: { ready: boolean }) => <button disabled={!ready}>Send draft</button> }));
vi.mock('../workspace/WorkspaceProvider', () => ({ useWorkspace: () => ({
  workspace: { activePaneId: 'one' }, errorMessage: null, setPaneThreadContext: native.noop,
  setPaneHeaderActions: native.actions, setPaneHeaderAdornment: native.adornment,
  updatePane: native.noop, duplicatePane: native.noop, onImageOpen: native.noop, onMarkdownOpen: native.noop,
  onShowMobileSidebar: native.noop, threadActions: {}, showDebugEvents: false,
}) }));
const pane: WorkspacePane = { id: 'one', kind: 'thread', title: 'Chat', target: { mode: 'existing', threadId: 'chat' } };
function snapshot(): ChatSnapshot {
  return { epoch: 'epoch', revision: 1, chat: { id: 'chat', projectId: null, cwd: '/project', title: 'Chat', name: null, pinned: false, notificationsEnabled: true }, display: defaultDisplayState(), messages: [
    { id: 'answer', role: 'assistant', createdAt: new Date(0), content: { format: 2, parts: [{ type: 'text', text: 'Retained native answer' }] } },
  ], error: null, prompts: [], goal: null, queue: nativeQueueFixture(), settings: nativeSettingsFixture(), history: { earliest: null, hasOlder: false } };
}
const draftStore = {} as ComposerDraftStore;
function panes(two = false, first = pane) {
  return <MantineProvider env="test"><NativeThreadPane pane={first} draftStore={draftStore} onError={native.noop} />{two && <NativeThreadPane pane={{ ...pane, id: 'two' }} draftStore={draftStore} onError={native.noop} />}</MantineProvider>;
}
afterEach(() => { cleanup(); vi.clearAllMocks(); native.snapshot = null; native.error = null; });
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
